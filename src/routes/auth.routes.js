import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env.js';
import { User, Student, Institution } from '../models/core.js';
import {
  signAccess, signRefresh, hashToken, setRefreshCookie, clearRefreshCookie,
  readRefreshCookie, authenticate,
} from '../middleware/auth.js';
import { wrap, unauthorized, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { audit } from '../middleware/audit.js';

const r = Router();

/* ============================================================
   SIGN-IN THROTTLING, KEYED TO THE ACCOUNT AND NOT ONLY THE ADDRESS

   Keyed on the address alone this was wrong in both directions.

   A hall of three hundred candidates sits behind one NAT and shares
   one address, so twenty attempts covered the whole room: a few
   mistyped passwords locked everybody else out of their own
   examination. That is a denial of service the examination cell
   inflicts on itself at nine in the morning.

   And it barely slowed an attacker, who has more than one address
   and only one account to guess at.

   Keying on the identifier as well as the address fixes both. Each
   account gets its own budget wherever the attempts come from, and a
   crowded hall no longer shares one. The identifier is lower-cased
   so that padding it with capitals does not mint a fresh budget. */
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const who = String(req.body?.regNo || req.body?.email || '').trim().toLowerCase();
    return who ? `id:${who}` : `ip:${req.ip}`;
  },
  message: { error: 'Too many sign-in attempts for this account. Try again in a few minutes.' },
});

/* A second limiter, on the address, far looser. One machine working
   through a list of register numbers would slip past the per-account
   limit entirely, since every guess is a different account. */
const loginSourceLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts from this network. Try again in a few minutes.' },
});

/* Identifies ONE sign-in, as distinct from one account. It goes into
   both tokens and is carried through every refresh, so a session
   keeps its identity for as long as it lives. An examination in
   progress is pinned to one of these — see attempt.routes.js. */
const newSessionId = () => crypto.randomBytes(12).toString('hex');

const staffLogin = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

const studentLogin = z.object({
  regNo: z.string().min(1, 'Enter your register number'),
  password: z.string().min(1, 'Enter your password'),
});

/* ---------------- staff sign in ---------------- */
r.post('/login', loginSourceLimiter, loginLimiter, wrap(async (req, res) => {
  const { email, password } = parse(staffLogin, req.body);

  const user = await User.findOne({ email: email.toLowerCase() })
    .select('+passwordHash').populate('roleIds');

  if (!user || user.status !== 'active') throw unauthorized('Email or password is incorrect');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw unauthorized('Email or password is incorrect');

  const payload = { sub: String(user._id), kind: 'staff', inst: String(user.institutionId), sid: newSessionId() };
  const access = signAccess(payload);
  const refresh = signRefresh(payload);

  user.refreshTokenHash = hashToken(refresh);
  user.lastLoginAt = new Date();
  await user.save();

  setRefreshCookie(res, refresh, 'staff');

  const institution = await Institution.findById(user.institutionId).lean();

  res.json({
    accessToken: access,
    actor: {
      kind: 'staff',
      id: String(user._id),
      name: user.name,
      email: user.email,
      employeeId: user.employeeId,
      departmentId: user.departmentId,
      roles: (user.roleIds || []).map((x) => ({ id: String(x._id), name: x.name, scope: x.scope })),
      permissions: [...new Set((user.roleIds || []).flatMap((x) => x.permissions || []))],
      mustResetPassword: user.mustResetPassword,
    },
    institution: institution && {
      id: String(institution._id),
      name: institution.name,
      shortName: institution.shortName,
      settings: institution.settings,
      licence: institution.licence,
    },
  });
}));

/* ---------------- student sign in ---------------- */
r.post('/student/login', loginSourceLimiter, loginLimiter, wrap(async (req, res) => {
  const { regNo, password } = parse(studentLogin, req.body);

  const student = await Student.findOne({ regNo: regNo.trim() })
    .select('+passwordHash').populate('batchId');

  if (!student || student.status !== 'active') throw unauthorized('Register number or password is incorrect');

  const ok = student.passwordHash && await bcrypt.compare(password, student.passwordHash);
  if (!ok) throw unauthorized('Register number or password is incorrect');

  const payload = { sub: String(student._id), kind: 'student', inst: String(student.institutionId), sid: newSessionId() };
  const access = signAccess(payload);
  const refresh = signRefresh(payload);

  student.refreshTokenHash = hashToken(refresh);
  await student.save();
  setRefreshCookie(res, refresh, 'student');

  const institution = await Institution.findById(student.institutionId).lean();

  res.json({
    accessToken: access,
    actor: {
      kind: 'student',
      id: String(student._id),
      name: student.name,
      regNo: student.regNo,
      email: student.email,
      batch: student.batchId ? { id: String(student.batchId._id), label: student.batchId.label } : null,
    },
    institution: institution && {
      id: String(institution._id),
      name: institution.name,
      shortName: institution.shortName,
    },
  });
}));

/* ---------------- refresh ----------------
   Rotates the refresh token on every use. A stolen token is
   therefore usable once at most before the real session breaks
   and the theft becomes visible.                              */
r.post('/refresh', wrap(async (req, res) => {
  /* The client names the session it wants, so a browser holding both
     a staff and a student session refreshes the right one. */
  const want = req.body?.kind === 'student' ? 'student'
    : req.body?.kind === 'staff' ? 'staff'
    : undefined;

  const token = readRefreshCookie(req, want);
  if (!token) throw unauthorized('Session expired');

  let claims;
  try {
    claims = jwt.verify(token, env.refreshSecret);
  } catch {
    clearRefreshCookie(res, want);
    throw unauthorized('Session expired');
  }

  if (want && claims.kind !== want) {
    throw unauthorized('Session expired');
  }

  const Model = claims.kind === 'student' ? Student : User;
  const doc = await Model.findById(claims.sub).select('+refreshTokenHash');

  if (!doc || doc.refreshTokenHash !== hashToken(token)) {
    clearRefreshCookie(res, claims.kind);
    throw unauthorized('Session expired');
  }

  /* The same session id, deliberately. Minting a new one here would
     unpin a candidate's examination from their session every fifteen
     minutes, which is to say it would switch the check off. */
  const payload = { sub: claims.sub, kind: claims.kind, inst: claims.inst, sid: claims.sid };
  const access = signAccess(payload);
  const nextRefresh = signRefresh(payload);

  doc.refreshTokenHash = hashToken(nextRefresh);
  await doc.save();
  setRefreshCookie(res, nextRefresh, claims.kind);

  res.json({ accessToken: access, kind: claims.kind });
}));

/* ---------------- sign out ---------------- */
r.post('/logout', wrap(async (req, res) => {
  const want = req.body?.kind === 'student' ? 'student'
    : req.body?.kind === 'staff' ? 'staff' : undefined;

  const token = readRefreshCookie(req, want);
  if (token) {
    try {
      const claims = jwt.verify(token, env.refreshSecret);
      const Model = claims.kind === 'student' ? Student : User;
      await Model.findByIdAndUpdate(claims.sub, { $unset: { refreshTokenHash: 1 } });
      clearRefreshCookie(res, claims.kind);
    } catch { clearRefreshCookie(res, want); }
  } else {
    clearRefreshCookie(res, want);
  }
  res.json({ ok: true });
}));

/* ---------------- who am I ---------------- */
r.get('/me', authenticate, wrap(async (req, res) => {
  const institution = await Institution.findById(req.actor.institutionId).lean();
  res.json({
    actor: {
      ...req.actor,
      permissions: [...req.actor.permissions],
    },
    institution: institution && {
      id: String(institution._id),
      name: institution.name,
      shortName: institution.shortName,
      settings: institution.settings,
      licence: institution.licence,
    },
  });
}));

/* ---------------- change password ---------------- */
const changeSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string()
    .min(8, 'Use at least 8 characters')
    .regex(/[a-z]/, 'Include a lower case letter')
    .regex(/[A-Z]/, 'Include an upper case letter')
    .regex(/[0-9]/, 'Include a number'),
});

r.post('/password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = parse(changeSchema, req.body);
  const Model = req.actor.kind === 'student' ? Student : User;

  const doc = await Model.findById(req.actor.id).select('+passwordHash');
  if (!doc) throw unauthorized();

  const ok = await bcrypt.compare(currentPassword, doc.passwordHash || '');
  if (!ok) throw badRequest('Your current password is incorrect');

  doc.passwordHash = await bcrypt.hash(newPassword, 12);
  if ('mustResetPassword' in doc) doc.mustResetPassword = false;
  await doc.save();

  await audit(req, { action: 'auth.password_changed', entity: Model.modelName, entityId: doc._id });
  res.json({ ok: true });
}));

export default r;

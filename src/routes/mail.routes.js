/* ============================================================
   OUTGOING MAIL, AS THE EXAMINATION CELL SEES IT

   "Did the candidates actually get told?" is the question this
   screen exists to answer, and before it existed the honest answer
   was that nobody could say. Several hundred messages leave because
   somebody pressed a menu item; where they went has to be visible.

   The webhook at the end is the one unauthenticated route here. It
   is how a provider reports a bounce or a complaint, and it is
   guarded by a shared secret rather than a session, because the
   caller is Amazon rather than a person.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { MailMessage, MailSuppression } from '../models/mail.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest, forbidden } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { queueMail, processQueue, suppress, render } from '../services/mail.js';
import { env, mailConfigured } from '../config/env.js';

const r = Router();

/* ============================================================
   THE PROVIDER'S WEBHOOK — no session, by necessity

   Mounted before authenticate. A bounce notification arrives from
   the provider, not from a signed-in person, so it is authorised by
   a secret in the path instead. Without MAIL_WEBHOOK_SECRET set the
   route refuses everything, which is the right default: an open
   endpoint that writes to the suppression list would let anyone stop
   mail reaching a candidate.
   ============================================================ */
r.post('/hooks/:secret', wrap(async (req, res) => {
  const expected = process.env.MAIL_WEBHOOK_SECRET || '';
  if (!expected || req.params.secret !== expected) {
    throw forbidden('Not a recognised notification endpoint');
  }

  /* SNS asks to be confirmed before it will deliver anything. */
  const type = req.body?.Type || req.body?.eventType || req.body?.notificationType;
  if (type === 'SubscriptionConfirmation') {
    console.log('[mail] SNS subscription confirmation received. Confirm at:', req.body.SubscribeURL);
    return res.json({ ok: true, confirm: req.body.SubscribeURL });
  }

  /* SES wraps its payload in an SNS envelope as a JSON string. */
  let payload = req.body;
  if (typeof payload?.Message === 'string') {
    try { payload = JSON.parse(payload.Message); } catch { /* use as it came */ }
  }

  const kind = payload?.eventType || payload?.notificationType;
  const recipients = [
    ...(payload?.bounce?.bouncedRecipients || []),
    ...(payload?.complaint?.complainedRecipients || []),
  ].map((x) => x.emailAddress).filter(Boolean);

  if (!recipients.length) return res.json({ ok: true, noted: 0 });

  /* A transient bounce is the provider saying "try later", not "this
     address is dead" — suppressing on one would lose a candidate who
     was merely over quota that morning. */
  const permanent = payload?.bounce?.bounceType === 'Permanent' || kind === 'Complaint';
  if (!permanent) return res.json({ ok: true, noted: recipients.length, suppressed: 0 });

  let suppressed = 0;
  for (const email of recipients) {
    /* The institution is found from the message that was sent to
       that address, since the provider knows nothing about tenants. */
    // eslint-disable-next-line no-await-in-loop
    const last = await MailMessage.findOne({ to: String(email).toLowerCase() })
      .sort({ createdAt: -1 }).select('institutionId').lean();
    if (!last) continue;
    // eslint-disable-next-line no-await-in-loop
    await suppress({
      institutionId: last.institutionId,
      email,
      reason: kind === 'Complaint' ? 'Marked as spam by the recipient' : 'Permanent bounce',
      note: 'Reported by the mail provider.',
    });
    suppressed += 1;
  }

  res.json({ ok: true, noted: recipients.length, suppressed });
}));

/* ============================================================
   EVERYTHING BELOW IS A SIGNED-IN STAFF ROUTE
   ============================================================ */
r.use(authenticate);

const MAIL_PERMS = ['settings:view', 'exam:publish', 'result:approve'];

r.get('/', can(...MAIL_PERMS), wrap(async (req, res) => {
  const q = { ...tenant(req) };
  if (req.query.status) q.status = req.query.status;
  if (req.query.template) q.template = req.query.template;
  if (req.query.from || req.query.to) {
    q.createdAt = {};
    if (req.query.from) q.createdAt.$gte = new Date(`${req.query.from}T00:00:00`);
    if (req.query.to) q.createdAt.$lte = new Date(`${req.query.to}T23:59:59.999`);
  }
  if (req.query.q) {
    const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    q.$or = [{ to: re }, { toName: re }, { subject: re }];
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));

  const [rows, total, byStatus, suppressed] = await Promise.all([
    MailMessage.find(q).sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit)
      .select('to toName subject template status attempts lastError sentAt createdAt notBefore')
      .lean(),
    MailMessage.countDocuments(q),
    MailMessage.aggregate([
      { $match: { institutionId: tenantId(req) } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    MailSuppression.countDocuments(tenant(req)),
  ]);

  const counts = { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0 };
  for (const row of byStatus) counts[row._id] = row.n;

  res.json({
    mail: rows.map((m) => ({ ...m, id: String(m._id) })),
    page, limit, total,
    pages: Math.max(1, Math.ceil(total / limit)),
    counts,
    suppressedAddresses: suppressed,
    /* Whether anything is actually being sent, which is the first
       thing to check when the log looks wrong. */
    configured: mailConfigured(),
    sender: mailConfigured() ? `${env.smtp.fromName} <${env.smtp.from}>` : null,
  });
}));

/* `tenant()` returns a String, which find() casts and aggregate()
   does not — the guard script watches for exactly this. */
function tenantId(req) {
  const { Types } = MailMessage.base;
  return new Types.ObjectId(String(req.actor.institutionId));
}

/* Sending a failed message again. The commonest real cause is a
   mail server that was down for an hour, and re-queueing beats
   asking the office to notify a whole cohort a second time. */
r.post('/:id/retry', can('settings:edit', 'exam:publish'), wrap(async (req, res) => {
  const row = await MailMessage.findOne({ _id: req.params.id, ...tenant(req) });
  if (!row) throw notFound('That message could not be found');
  if (row.status === 'sent') throw badRequest('That message was already sent.');

  const blocked = await MailSuppression.findOne({ ...tenant(req), email: row.to }).lean();
  if (blocked) {
    throw badRequest(
      `${row.to} is on the suppression list (${blocked.reason}).`,
      { suppression: 'Clear the address first if you believe it now works.' },
    );
  }

  row.status = 'queued';
  row.attempts = 0;
  row.lastError = null;
  row.notBefore = new Date();
  await row.save();

  await audit(req, { action: 'mail.retried', entity: 'MailMessage', entityId: row._id,
    after: { to: row.to, template: row.template } });

  res.json({ ok: true, status: row.status });
}));

/* Everything that failed, back in the queue in one press. */
r.post('/retry-failed', can('settings:edit', 'exam:publish'), wrap(async (req, res) => {
  const blockedList = await MailSuppression.find(tenant(req)).select('email').lean();
  const blocked = blockedList.map((x) => x.email);

  const out = await MailMessage.updateMany(
    { ...tenant(req), status: 'failed', to: { $nin: blocked } },
    { $set: { status: 'queued', attempts: 0, lastError: null, notBefore: new Date() } },
  );

  await audit(req, { action: 'mail.retried_all', entity: 'MailMessage',
    after: { requeued: out.modifiedCount, skippedSuppressed: blocked.length } });

  res.json({ requeued: out.modifiedCount, skippedSuppressed: blocked.length });
}));

/* A test message, to the person pressing the button. The fastest way
   to find out whether SMTP is configured correctly, and the first
   thing anyone will want on the morning of a deployment. */
r.post('/test', can('settings:edit', 'settings:view'), wrap(async (req, res) => {
  const { to } = parse(z.object({ to: z.string().email('Enter a valid address') }), req.body);

  const queued = await queueMail({
    institutionId: req.actor.institutionId,
    to,
    toName: req.actor.name,
    template: 'submission_ack',
    relatedKind: 'other',
    queuedBy: req.actor.id,
    data: {
      studentName: req.actor.name,
      subjectTitle: 'Test message', subjectCode: 'TEST',
      examTitle: 'ExamProbe delivery test',
      date: new Date().toISOString().slice(0, 10),
      regNo: '—',
      submittedAt: new Date().toLocaleString('en-IN'),
      answered: 0, totalQuestions: 0, sheetPages: 0,
      reference: 'TEST-MESSAGE',
    },
  });

  if (!queued) throw badRequest('That address is on the suppression list.');

  /* Sent now rather than on the next tick, because somebody is
     watching their inbox. */
  const out = await processQueue({ limit: 5 });

  res.json({
    ok: true,
    configured: mailConfigured(),
    ...out,
    message: mailConfigured()
      ? `A test message is on its way to ${to}.`
      : 'SMTP is not configured, so the message was recorded and logged rather than sent.',
  });
}));

/* ---------------- the suppression list ---------------- */

r.get('/suppressions', can(...MAIL_PERMS), wrap(async (req, res) => {
  const rows = await MailSuppression.find(tenant(req)).sort({ createdAt: -1 }).limit(500).lean();
  res.json({
    suppressions: rows.map((x) => ({
      id: String(x._id), email: x.email, reason: x.reason, note: x.note, at: x.createdAt,
    })),
  });
}));

r.delete('/suppressions/:id', can('settings:edit'), wrap(async (req, res) => {
  const row = await MailSuppression.findOneAndDelete({ _id: req.params.id, ...tenant(req) });
  if (!row) throw notFound('That address is not on the list');

  await audit(req, { action: 'mail.suppression_cleared', entity: 'MailSuppression',
    before: { email: row.email, reason: row.reason } });

  res.json({ ok: true, email: row.email });
}));

/* A preview of what a template actually looks like, so nobody has to
   send a real one to find out. */
r.get('/preview/:template', can(...MAIL_PERMS), wrap(async (req, res) => {
  const samples = {
    exam_notice: {
      studentName: 'Arun Kumar', subjectTitle: 'Organizational Behavior', subjectCode: 'MBA1101',
      examTitle: 'Internal Assessment I', date: '2026-11-18',
      dateLong: 'Wednesday, 18 November 2026', reportingTime: '09:45', startTime: '10:00',
      durationMinutes: 90, totalMarks: 50, room: 'Room 1', portalUrl: env.appUrl,
    },
    submission_ack: {
      studentName: 'Arun Kumar', subjectTitle: 'Organizational Behavior', subjectCode: 'MBA1101',
      examTitle: 'Internal Assessment I', date: '2026-11-18', regNo: '41720104031',
      submittedAt: '18 Nov 2026, 11:28', answered: 18, totalQuestions: 19,
      sheetPages: 4, reference: 'AP-7K3M9Q',
    },
    qc_invite: {
      staffName: 'Dr A Ananth', stage: 'qc1',
      stageBlurb: 'Please check every question in this upload.',
      subjectTitle: 'Organizational Behavior', subjectCode: 'MBA1101',
      batchLabel: 'I Year MBA — Section A', questionCount: 40,
      requestedBy: 'Examination cell', link: `${env.appUrl}/qc/example`,
    },
  };

  const sample = samples[req.params.template];
  if (!sample) throw notFound('No such template');

  const { subject, html } = render(req.params.template, sample);
  res.json({ template: req.params.template, subject, html });
}));

export default r;

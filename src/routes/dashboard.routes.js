import { Router } from 'express';
import { Exam, Attempt, Room, Audit } from '../models/exam.js';
import { Institution } from '../models/core.js';
import { authenticate, can, tenant, resolveScope } from '../middleware/auth.js';
import { wrap } from '../utils/http.js';
import { VIOLATION_CATALOGUE } from '../utils/grading.js';
import { examStartAt } from '../utils/time.js';

const r = Router();
r.use(authenticate);

r.get('/', can('exam:view'), wrap(async (req, res) => {
  const t = tenant(req);
  const scope = await resolveScope(req.actor);

  const examFilter = { ...t };
  if (scope) examFilter.subjectId = { $in: scope.subjectIds };

  const weekAhead = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const weekBack  = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

  const [exams, institution] = await Promise.all([
    Exam.find({ ...examFilter, date: { $gte: weekBack, $lte: weekAhead } })
      .populate('subjectId', 'code title')
      .populate('batchIds', 'label')
      .sort({ date: 1, startTime: 1 }).lean(),
    Institution.findById(req.actor.institutionId).lean(),
  ]);

  const ids = exams.map((e) => e._id);
  const agg = await Attempt.aggregate([
    { $match: { examId: { $in: ids } } },
    { $group: {
      _id: null,
      scheduled: { $sum: 1 },
      inProgress: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
      submitted:  { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
      flagged:    { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
      pendingEval:{ $sum: { $cond: [{ $eq: ['$evaluation.state', 'pending'] }, 1, 0] } },
    } },
  ]);
  const s = agg[0] || {};

  const live = exams.find((e) => e.status === 'live');
  let liveDetail = null;
  if (live) {
    const [stats, rooms] = await Promise.all([
      Attempt.aggregate([
        { $match: { examId: live._id } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          present: { $sum: { $cond: [{ $in: ['$status', ['in_progress', 'submitted', 'flagged']] }, 1, 0] } },
          submitted: { $sum: { $cond: [{ $eq: ['$status', 'submitted'] }, 1, 0] } },
          flagged: { $sum: { $cond: [{ $gt: ['$flagScore', 0] }, 1, 0] } },
        } },
      ]),
      Room.countDocuments({ examId: live._id }),
    ]);
    const st = stats[0] || {};
    const startAt = examStartAt(live);
    liveDetail = {
      id: String(live._id),
      title: live.title, code: live.code,
      batches: (live.batchIds || []).map((b) => b.label),
      startTime: live.startTime, durationMinutes: live.durationMinutes,
      elapsedMinutes: Math.max(0, Math.floor((Date.now() - startAt) / 60000)),
      rooms, ...st,
    };
  }

  // recent proctoring events across live examinations
  const recentAttempts = await Attempt.find({ ...t, 'violations.0': { $exists: true } })
    .populate('studentId', 'name regNo')
    .sort({ updatedAt: -1 }).limit(12).lean();

  const feed = [];
  for (const a of recentAttempts) {
    for (const v of a.violations.slice(-2)) {
      feed.push({
        at: v.at,
        student: a.studentId ? { name: a.studentId.name, regNo: a.studentId.regNo } : null,
        type: VIOLATION_CATALOGUE[v.type]?.label || v.type,
        severity: v.severity,
      });
    }
  }
  feed.sort((x, y) => new Date(y.at) - new Date(x.at));

  res.json({
    metrics: {
      examsThisWeek: exams.length,
      candidatesScheduled: s.scheduled || 0,
      sittingNow: s.inProgress || 0,
      flagged: s.flagged || 0,
      awaitingEvaluation: s.pendingEval || 0,
    },
    live: liveDetail,
    exams: exams.slice(0, 6).map((e) => ({
      id: String(e._id), title: e.title, code: e.code,
      batches: (e.batchIds || []).map((b) => b.label),
      date: e.date, startTime: e.startTime, status: e.status,
    })),
    feed: feed.slice(0, 8),
    licence: institution?.licence || null,
  });
}));

/* The audit log. Now that every staff mutation lands here and not
   only the ones a route remembered to record, this has to be
   filterable and paged — an examination week puts tens of thousands
   of rows in front of whoever is answering a question about one of
   them. */
r.get('/audit', can('settings:view', 'result:approve'), wrap(async (req, res) => {
  const q = { ...tenant(req) };

  if (req.query.actorId) q.actorId = req.query.actorId;
  if (req.query.entity) q.entity = req.query.entity;
  if (req.query.method) q.method = String(req.query.method).toUpperCase();
  if (req.query.failedOnly === 'true') q.status = { $gte: 400 };

  if (req.query.from || req.query.to) {
    q.at = {};
    if (req.query.from) q.at.$gte = new Date(`${req.query.from}T00:00:00`);
    if (req.query.to) q.at.$lte = new Date(`${req.query.to}T23:59:59.999`);
  }

  /* Free text runs over the action, the path and the actor's name —
     the three things somebody actually remembers. Escaped, because an
     unescaped bracket from the search box is a crash. */
  if (req.query.q) {
    const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(safe, 'i');
    q.$or = [{ action: re }, { path: re }, { actorName: re }, { entity: re }];
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));

  const [rows, total, actors] = await Promise.all([
    Audit.find(q).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Audit.countDocuments(q),
    Audit.distinct('actorName', tenant(req)),
  ]);

  res.json({
    audit: rows.map((a) => ({ ...a, id: String(a._id) })),
    page, limit, total,
    pages: Math.max(1, Math.ceil(total / limit)),
    actors: actors.filter(Boolean).sort(),
  });
}));

export default r;

/* ============================================================
   BULK EXAMINATION SCHEDULING

   Fifty subjects over a dozen classes, created one paper at a time,
   is a week of work and near-certain clashes. The office uploads a
   spreadsheet instead.

   The order here is the whole design:

     PREVIEW  reads the sheet, matches every row against the
              institution's own records, finds the clashes, and
              stores the result. NOTHING is created.

     EDIT     the cell corrects what the sheet got wrong, in place.
              Every edit re-runs the whole analysis, because fixing
              one date can create a clash somewhere else.

     APPLY    only then are papers, rooms and duties created, and
              only for rows with no blocking problem left.

   Creating fifty papers from a sheet with one wrong date is a day of
   unpicking. A preview costs nothing.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { Exam, Question, Room, ScheduleDraft } from '../models/exam.js';
import { Department, Batch, Subject, Student, User, Mapping, Institution } from '../models/core.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { examStartAt, DEFAULT_TIMEZONE } from '../utils/time.js';
import {
  analyse, rowIsReady, planRooms, pickStaff, overlaps, patternTotal, explainAssignment,
} from '../services/bulkSchedule.js';
import { assemblePaper } from '../services/qc.js';
import { publishMany, examsFor } from '../services/publishExam.js';

const r = Router();
r.use(authenticate);

const rowSchema = z.object({
  date: z.any().optional(), startTime: z.any().optional(), durationMinutes: z.any().optional(),
  departmentCode: z.any().optional(), programme: z.any().optional(), year: z.any().optional(),
  section: z.any().optional(), academicYear: z.any().optional(),
  subjectCode: z.any().optional(), subjectTitle: z.any().optional(),
  examType: z.any().optional(), pattern: z.any().optional(),
  totalMarks: z.any().optional(), passMark: z.any().optional(),
  roomCapacity: z.any().optional(),
  invigilatorEmail: z.any().optional(), evaluatorEmail: z.any().optional(),
  notes: z.any().optional(),
}).passthrough();

const sectionSchema = z.object({
  key: z.string(), title: z.string().optional(), type: z.string(),
  count: z.number(), marksEach: z.number(),
  answerCount: z.number().optional(), choiceMode: z.string().optional(),
  instruction: z.string().optional(),
});

/* Everything the analysis needs to know about the institution.
   Gathered once per preview rather than per row — fifty rows against
   a hundred subjects is five thousand lookups done badly. */
async function gatherContext(req) {
  const t = tenant(req);
  const [departments, batches, subjects, staff, institution, existingExams, rolls, bank] =
    await Promise.all([
      Department.find(t).select('name code').lean(),
      Batch.find(t).select('label programme year section academicYear semester departmentId').lean(),
      Subject.find(t).select('code title semester departmentId').lean(),
      User.find({ ...t, status: 'active' }).select('name email departmentId').lean(),
      Institution.findById(req.actor.institutionId).lean(),
      Exam.find({ ...t, status: { $nin: ['published', 'closed'] } })
        .select('code date startTime durationMinutes batchIds').lean(),
      Student.aggregate([
        { $match: { institutionId: institutionObjectId(req), status: 'active' } },
        { $group: { _id: '$batchId', n: { $sum: 1 } } },
      ]),
      Question.aggregate([
        { $match: { institutionId: institutionObjectId(req), examId: null, status: 'approved' } },
        { $group: { _id: { s: '$subjectId', sec: '$section', t: '$type', m: '$marks' }, n: { $sum: 1 } } },
      ]),
    ]);

  const students = new Map(rolls.map((x) => [String(x._id), x.n]));

  /* subjectId -> Map('A:mcq:1' -> 12). The key is what the pattern
     asks for, so a shortfall is one lookup rather than a scan. */
  const bankCounts = new Map();
  for (const row of bank) {
    const sid = String(row._id.s);
    if (!bankCounts.has(sid)) bankCounts.set(sid, new Map());
    bankCounts.get(sid).set(`${row._id.sec}:${row._id.t}:${row._id.m}`, row.n);
  }

  return {
    departments: departments.map((d) => ({ id: String(d._id), code: d.code, name: d.name })),
    batches: batches.map((b) => ({
      id: String(b._id), label: b.label, programme: b.programme, year: b.year,
      section: b.section, academicYear: b.academicYear, semester: b.semester,
      departmentId: String(b.departmentId),
    })),
    subjects: subjects.map((s) => ({
      id: String(s._id), code: s.code, title: s.title, semester: s.semester,
      departmentId: String(s.departmentId),
    })),
    staff: staff.map((u) => ({ id: String(u._id), name: u.name, email: u.email })),
    existingExams: existingExams.map((e) => ({
      code: e.code, date: e.date, startTime: e.startTime,
      durationMinutes: e.durationMinutes, batchIds: (e.batchIds || []).map(String),
    })),
    students,
    bankCounts,
    settings: {
      dayStart: institution?.settings?.dayStart || '08:00',
      dayEnd: institution?.settings?.dayEnd || '18:00',
      roomCapacity: institution?.settings?.roomCapacity || 30,
      timezone: institution?.settings?.timezone || DEFAULT_TIMEZONE,
    },
  };
}

/* tenant() hands back a String, which find() casts and aggregate()
   does not — the same trap the route guard watches for. */
function institutionObjectId(req) {
  const { Types } = Exam.base;
  return new Types.ObjectId(String(req.actor.institutionId));
}

const toPatternMap = (patterns) => new Map(
  Object.entries(patterns || {}).map(([name, v]) => [name, v]),
);

/* ---------------- preview ---------------- */

r.post('/preview', can('schedule:create', 'exam:create'), wrap(async (req, res) => {
  const body = parse(z.object({
    fileName: z.string().max(200).optional(),
    rows: z.array(rowSchema).min(1).max(500),
    patterns: z.record(z.object({ sections: z.array(sectionSchema).min(1) })),
  }), req.body);

  const context = await gatherContext(req);
  const { rows, summary } = analyse({
    rows: body.rows,
    patterns: toPatternMap(body.patterns),
    context,
  });

  const draft = await ScheduleDraft.create({
    ...tenant(req),
    fileName: body.fileName,
    uploadedBy: req.actor.id,
    uploadedByName: req.actor.name,
    rows, patterns: body.patterns, summary,
  });

  await audit(req, {
    action: 'schedule.bulk_previewed', entity: 'ScheduleDraft', entityId: draft._id,
    after: { fileName: body.fileName, rows: rows.length, ready: summary.ready, blocked: summary.blocked },
  });

  res.status(201).json({ draftId: String(draft._id), rows, summary });
}));

r.get('/drafts', can('schedule:view', 'exam:view'), wrap(async (req, res) => {
  const drafts = await ScheduleDraft.find(tenant(req))
    .select('fileName uploadedByName status summary createdAt appliedAt createdExamIds')
    .sort({ createdAt: -1 }).limit(25).lean();
  res.json({
    drafts: drafts.map((d) => ({
      id: String(d._id), fileName: d.fileName, by: d.uploadedByName,
      status: d.status, summary: d.summary,
      createdAt: d.createdAt, appliedAt: d.appliedAt,
      created: (d.createdExamIds || []).length,
    })),
  });
}));

r.get('/drafts/:id', can('schedule:view', 'exam:view'), wrap(async (req, res) => {
  const draft = await ScheduleDraft.findOne({ _id: req.params.id, ...tenant(req) }).lean();
  if (!draft) throw notFound('That schedule could not be found');
  res.json({
    draftId: String(draft._id),
    fileName: draft.fileName,
    status: draft.status,
    rows: draft.rows, summary: draft.summary,
    outcome: draft.outcome || [],
  });
}));

/* ---------------- editing a row in the preview ----------------

   Every edit re-runs the WHOLE analysis, not just the row that
   changed. Moving one paper to clear a clash can create another two
   rows down, and an engine that only rechecked what was touched
   would hand the office a preview that said it was clean. */
r.patch('/drafts/:id/rows/:index', can('schedule:create', 'exam:create'), wrap(async (req, res) => {
  const draft = await ScheduleDraft.findOne({ _id: req.params.id, ...tenant(req) });
  if (!draft) throw notFound('That schedule could not be found');
  if (draft.status !== 'draft') throw badRequest('This schedule has already been applied.');

  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= draft.rows.length) {
    throw badRequest('There is no such row in this schedule');
  }

  const patch = parse(rowSchema, req.body);
  const rawRows = draft.rows.map((row, i) => (
    i === index ? { ...row.raw, ...patch } : row.raw
  ));

  const context = await gatherContext(req);
  const { rows, summary } = analyse({
    rows: rawRows, patterns: toPatternMap(draft.patterns), context,
  });

  draft.rows = rows;
  draft.summary = summary;
  draft.markModified('rows');
  draft.markModified('summary');
  await draft.save();

  res.json({ rows, summary });
}));

r.delete('/drafts/:id/rows/:index', can('schedule:create', 'exam:create'), wrap(async (req, res) => {
  const draft = await ScheduleDraft.findOne({ _id: req.params.id, ...tenant(req) });
  if (!draft) throw notFound('That schedule could not be found');
  if (draft.status !== 'draft') throw badRequest('This schedule has already been applied.');

  const index = Number(req.params.index);
  const rawRows = draft.rows.filter((_, i) => i !== index).map((row) => row.raw);
  if (!rawRows.length) throw badRequest('That would leave the schedule empty. Discard it instead.');

  const context = await gatherContext(req);
  const { rows, summary } = analyse({
    rows: rawRows, patterns: toPatternMap(draft.patterns), context,
  });

  draft.rows = rows; draft.summary = summary;
  draft.markModified('rows'); draft.markModified('summary');
  await draft.save();

  res.json({ rows, summary });
}));

/* ---------------- applying ----------------

   Only rows with no blocking problem are created. A row with a
   warning is created — a Sunday paper or a thin question bank is the
   office's call, not ours — and a row with an error is skipped and
   reported.
   ------------------------------------------------------------ */
r.post('/drafts/:id/apply', can('schedule:create', 'exam:create'), wrap(async (req, res) => {
  const draft = await ScheduleDraft.findOne({ _id: req.params.id, ...tenant(req) });
  if (!draft) throw notFound('That schedule could not be found');
  if (draft.status === 'applied') throw badRequest('This schedule has already been created.');

  const { only, publish } = parse(z.object({
    only: z.array(z.number()).optional(),
    /* Publishing creates an attempt per candidate and reserves a
       licence for each, so it is never implied. The office asks for
       it, having seen what would be created. */
    publish: z.boolean().default(false),
  }), req.body);
  const context = await gatherContext(req);

  const wanted = draft.rows.filter((row) => rowIsReady(row)
    && (!only || only.includes(row.index)));

  if (!wanted.length) {
    throw badRequest('No row in this schedule is ready to be created. Correct the problems first.');
  }

  /* Duties already committed in this run, so two papers created from
     the same sheet cannot be given the same invigilator. Seeded from
     what the calendar already holds. */
  const busyBy = new Map();
  const loadBy = new Map();
  const existingRooms = await Room.find({ ...tenant(req) })
    .select('invigilatorId startAt endAt examId').populate('examId', 'date startTime durationMinutes').lean();
  for (const room of existingRooms) {
    if (!room.invigilatorId || !room.examId) continue;
    const key = String(room.invigilatorId);
    if (!busyBy.has(key)) busyBy.set(key, []);
    busyBy.get(key).push({
      date: room.examId.date,
      startTime: room.examId.startTime,
      durationMinutes: room.examId.durationMinutes,
    });
    loadBy.set(key, (loadBy.get(key) || 0) + 1);
  }

  const outcome = [];
  const createdIds = [];

  for (const row of wanted) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const made = await createOne({ req, row, context, busyBy, loadBy });
      createdIds.push(made.examId);
      outcome.push({ index: row.index, ok: true, ...made });
    } catch (e) {
      outcome.push({ index: row.index, ok: false, error: e.message });
    }
  }

  /* Publishing in the same breath, when asked. Papers short of
     questions are refused by the conflict check rather than published
     incomplete, and the result says which. */
  let published = null;
  if (publish && createdIds.length) {
    const exams = await examsFor(createdIds, req.actor.institutionId);
    published = await publishMany(exams, { institutionId: req.actor.institutionId });
    for (const o of outcome) {
      const p = published.outcome.find((x) => String(x.examId) === String(o.examId));
      if (p) o.published = p.ok ? true : (p.reason || false);
      if (p && !p.ok && p.conflicts?.length) o.publishBlockedBy = p.conflicts.map((c) => c.message);
    }
  }

  draft.status = outcome.some((o) => o.ok) ? 'applied' : 'draft';
  draft.appliedAt = new Date();
  draft.createdExamIds = createdIds;
  draft.outcome = outcome;
  draft.markModified('outcome');
  await draft.save();

  await audit(req, {
    action: 'schedule.bulk_applied', entity: 'ScheduleDraft', entityId: draft._id,
    after: {
      created: createdIds.length,
      failed: outcome.filter((o) => !o.ok).length,
      skipped: draft.rows.length - wanted.length,
      published: published?.published ?? 0,
    },
  });

  res.json({
    created: createdIds.length,
    failed: outcome.filter((o) => !o.ok).length,
    skipped: draft.rows.length - wanted.length,
    published: published?.published ?? 0,
    publishBlocked: published?.blocked ?? 0,
    candidates: published?.candidates ?? 0,
    outcome,
  });
}));

/* One paper, its rooms, its invigilators and its evaluator. */
async function createOne({ req, row, context, busyBy, loadBy }) {
  const { batch, subject, pattern } = row.resolved;
  const sections = pattern.sections.map((s) => ({
    key: s.key,
    title: s.title || `Part ${s.key}`,
    type: s.type,
    count: s.count,
    marksEach: s.marksEach,
    answerCount: s.answerCount,
    choiceMode: s.choiceMode,
    instruction: s.instruction,
  }));

  const built = patternTotal(sections);
  if (built !== row.totalMarks) {
    throw new Error(`Pattern adds up to ${built}, not ${row.totalMarks}`);
  }

  const exam = await Exam.create({
    ...tenant(req),
    subjectId: subject.id,
    batchIds: [batch.id],
    title: `${subject.title} — ${labelFor(row.examType)}`,
    code: subject.code,
    type: row.examType,
    date: row.date,
    startTime: row.startTime,
    timezone: context.settings.timezone,
    durationMinutes: row.durationMinutes,
    totalMarks: row.totalMarks,
    passMark: row.passMark,
    blueprint: { sections },
    status: 'draft',
    createdBy: req.actor.id,
  });

  /* Rooms, split evenly across the roll. */
  const students = await Student.find({
    ...tenant(req), batchId: batch.id, status: 'active',
  }).sort({ regNo: 1 }).select('_id').lean();

  const capacity = row.resolved.roomCapacity || context.settings.roomCapacity;
  const plan = planRooms({ studentCount: students.length, capacity });
  const startAt = examStartAt(exam);
  const endAt = new Date(startAt.getTime() + exam.durationMinutes * 60000);
  const slot = { date: row.date, startTime: row.startTime, durationMinutes: row.durationMinutes };

  /* Whoever may invigilate, preferring this department. A named
     invigilator on the sheet takes the first room. */
  const pool = context.staff;
  const rooms = [];
  let cursor = 0;
  const assignments = [];

  for (const p of plan) {
    const slice = students.slice(cursor, cursor + p.seats);
    cursor += p.seats;

    const named = p.index === 1 ? row.resolved.invigilator : null;
    const chosen = named && !(busyBy.get(String(named.id)) || []).some((b) => overlaps(slot, b))
      ? named
      : pickStaff({ candidates: pool, slot, busyBy, loadBy });

    if (chosen) {
      const key = String(chosen.id);
      if (!busyBy.has(key)) busyBy.set(key, []);
      busyBy.get(key).push(slot);
      loadBy.set(key, (loadBy.get(key) || 0) + 1);
      assignments.push(explainAssignment(chosen, {
        reason: named && chosen.id === named.id ? 'named on the sheet' : 'available',
        load: (loadBy.get(key) || 1) - 1,
      }));
    }

    rooms.push({
      ...tenant(req), examId: exam._id,
      name: `Room ${p.index}`,
      capacity,
      startAt, endAt,
      invigilatorId: chosen?.id,
      studentIds: slice.map((s) => s._id),
    });
  }

  if (rooms.length) await Room.insertMany(rooms);

  /* The paper itself, drawn from the approved bank.

     Without this the scheduler produced fifty papers with the right
     pattern and no questions in any of them, and each one still had
     to be assembled by hand — which is most of the work it was meant
     to remove. Drawn to the pattern exactly: a part takes only
     questions of its own type and marks, and never more than its
     count. */
  const paper = await drawPaper({ req, exam, sections });

  /* The evaluator comes from the subject mapping, which is what the
     institution already uses to say who teaches what. Carried on the
     paper rather than applied now: an evaluator belongs to a script,
     and no script exists until the paper is published. */
  const mapped = await Mapping.find({
    ...tenant(req), subjectId: subject.id, batchId: batch.id, kind: 'subject_staff',
  }).select('staffId').lean();

  const evaluatorId = row.resolved.evaluator?.id
    || (mapped.length ? String(mapped[0].staffId) : null);

  if (evaluatorId) {
    exam.defaultEvaluatorId = evaluatorId;
    await exam.save();
  }

  return {
    questionsDrawn: paper.drawn,
    questionsShort: paper.short,
    examId: exam._id,
    code: exam.code,
    date: exam.date,
    startTime: exam.startTime,
    batch: batch.label,
    subject: `${subject.code} — ${subject.title}`,
    rooms: rooms.length,
    students: students.length,
    unstaffedRooms: rooms.filter((x) => !x.invigilatorId).length,
    invigilators: assignments,
    evaluatorId,
    evaluator: evaluatorId
      ? (context.staff.find((s) => String(s.id) === String(evaluatorId))?.name || 'assigned')
      : null,
  };
}


/* Draws one paper from the approved bank.

   The same matching the quality check uses, so a bank that passed QC2
   for a pattern will fill that pattern here — if the two disagreed,
   QC2 would be certifying something the scheduler could not build.

   A part that cannot be filled is reported rather than quietly left
   short: the paper is still created, because the cell may be about to
   upload the questions, but the preview and the result both say so
   and the paper cannot be published until it is complete. */
async function drawPaper({ req, exam, sections }) {
  const bank = await Question.find({
    ...tenant(req), examId: null, status: 'approved', subjectId: exam.subjectId,
  }).sort({ createdAt: 1 }).lean();

  const { picked, shortfalls } = assemblePaper({
    blueprint: { sections },
    questions: bank,
    pick: (eligible, n) => eligible.slice(0, n),
  });

  if (!picked.length) {
    return { drawn: 0, short: shortfalls.reduce((n, s) => n + (s.needed - s.available), 0) };
  }

  const parts = new Map(sections.map((s) => [s.key, s]));
  const nextOrder = {};
  const copies = picked.map((q) => {
    const { _id, createdAt, updatedAt, status, reviewedBy, reviewedAt, reviewNote,
            submittedAt, usedCount, lastUsedAt, uploadId, ...rest } = q;
    const order = (nextOrder[q.section] = (nextOrder[q.section] || 0) + 1) - 1;
    const part = parts.get(q.section);
    return {
      ...rest,
      examId: exam._id,
      sourceId: _id,
      setLabel: 'A',
      order,
      /* Drawn into an either/or part, a question is paired with its
         neighbour — "1 or 2, 3 or 4". The same opening position the
         builder takes. */
      choiceGroup: part?.choiceMode === 'either_or' ? String(Math.floor(order / 2) + 1) : undefined,
      marks: part.marksEach,
      status: 'approved',
    };
  });

  await Question.insertMany(copies);
  await Question.updateMany(
    { _id: { $in: picked.map((q) => q._id) } },
    { $inc: { usedCount: 1 }, $set: { lastUsedAt: new Date() } },
  );

  return {
    drawn: copies.length,
    short: shortfalls.reduce((n, s) => n + (s.needed - s.available), 0),
  };
}

const labelFor = (type) => ({
  internal: 'Internal Assessment',
  model: 'Model Examination',
  end_semester: 'End Semester Examination',
}[type] || 'Examination');


/* Publishing the papers a draft created, after the fact.

   The office may well want to look at fifty newly created papers
   before several thousand attempts and licence reservations come into
   being. So apply can publish, and so can this — the same service
   either way. */
r.post('/drafts/:id/publish', can('exam:publish', 'schedule:publish'), wrap(async (req, res) => {
  const draft = await ScheduleDraft.findOne({ _id: req.params.id, ...tenant(req) });
  if (!draft) throw notFound('That schedule could not be found');
  if (!draft.createdExamIds?.length) {
    throw badRequest('This schedule has not created any examinations yet.');
  }

  const exams = await examsFor(draft.createdExamIds, req.actor.institutionId);
  const drafts = exams.filter((e) => e.status === 'draft');
  if (!drafts.length) {
    throw badRequest('Every examination from this schedule has already been published.');
  }

  const out = await publishMany(drafts, { institutionId: req.actor.institutionId });

  await audit(req, {
    action: 'schedule.bulk_published', entity: 'ScheduleDraft', entityId: draft._id,
    after: { published: out.published, blocked: out.blocked, candidates: out.candidates },
  });

  res.json(out);
}));

r.post('/drafts/:id/discard', can('schedule:create', 'exam:create'), wrap(async (req, res) => {
  const draft = await ScheduleDraft.findOne({ _id: req.params.id, ...tenant(req) });
  if (!draft) throw notFound('That schedule could not be found');
  if (draft.status === 'applied') throw badRequest('This schedule has already been created.');
  draft.status = 'discarded';
  await draft.save();
  res.json({ ok: true });
}));

export default r;

/* ============================================================
   QUALITY CHECK ON AN UPLOADED QUESTION BANK

   Two kinds of route live here and they are authorised differently.

   The management routes — create a run, list them, read the gate —
   are ordinary signed-in staff routes.

   The RUN routes are reached by a token in the address, from a window
   the checker opened from their invitation. No session, deliberately:
   the point of the exercise is to sit the questions the way a
   candidate does, in a window of its own, without the portal's
   navigation around it and without anything being proctored. The
   token names one run, expires with it, and can do nothing else.
   ============================================================ */
import { Router } from 'express';
import { z } from 'zod';
import { Question, QuestionUpload, Exam, ScheduleDraft } from '../models/exam.js';
import { Subject, Batch, User, Institution } from '../models/core.js';
import { QcRun, QC_ISSUE_KINDS } from '../models/qc.js';
import { authenticate, can, tenant } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { wrap, notFound, badRequest, forbidden } from '../utils/http.js';
import { parse } from '../utils/validate.js';
import { sanitiseAnswerHtml } from '../utils/sanitise.js';
import { shape } from './qbank.routes.js';
import { queueMail } from '../services/mail.js';
import { env } from '../config/env.js';
import {
  newToken, assemblePaper, markResponse, summarise, shortfallMessage, STAGE_BLURB,
} from '../services/qc.js';

const r = Router();
const now = () => new Date();

/* Questions that live in the bank rather than on a paper. */
const BANK = { examId: null };

/* ============================================================
   THE RUN ITSELF — reached by token, no session
   ============================================================ */

async function loadRun(token) {
  const run = await QcRun.findOne({ token });
  if (!run) throw notFound('This quality-check link is not valid. Ask for a fresh one.');
  if (run.status === 'passed' || run.status === 'failed') {
    throw forbidden('This quality check has already been completed.');
  }
  return run;
}

/* The paper under check. Never includes the answer key — the checker
   must answer from their own knowledge of the subject, or the whole
   exercise proves nothing. The key is applied when they answer. */
function forChecker(q) {
  return {
    id: String(q._id),
    section: q.section,
    type: q.type,
    order: q.order,
    text: q.text,
    marks: q.marks,
    options: (q.options || []).map((o) => ({ key: o.key, text: o.text })),
    multiSelect: q.multiSelect,
    unit: q.unit,
    difficulty: q.difficulty,
  };
}

r.get('/run/:token', wrap(async (req, res) => {
  const run = await loadRun(req.params.token);

  const [questions, subject, batch] = await Promise.all([
    Question.find({ _id: { $in: run.questionIds } }).lean(),
    Subject.findById(run.subjectId).select('code title').lean(),
    run.batchId ? Batch.findById(run.batchId).select('label').lean() : null,
  ]);

  const byId = new Map(questions.map((q) => [String(q._id), q]));
  const ordered = run.questionIds.map((id) => byId.get(String(id))).filter(Boolean);

  if (run.status === 'pending') {
    run.status = 'in_progress';
    run.startedAt = now();
    await run.save();
  }

  res.json({
    run: {
      id: String(run._id),
      stage: run.stage,
      blurb: STAGE_BLURB[run.stage],
      status: run.status,
      assignedToName: run.assignedToName,
      requestedByName: run.requestedByName,
      startedAt: run.startedAt,
      blueprint: run.stage === 'qc2' ? run.blueprint : null,
      shortfalls: run.shortfalls || [],
      shortfallMessage: shortfallMessage(run.shortfalls || []),
    },
    subject: subject && { code: subject.code, title: subject.title },
    batch: batch && { label: batch.label },
    questions: ordered.map(forChecker),
    responses: (run.responses || []).map((x) => ({
      questionId: String(x.questionId),
      selected: x.selected, text: x.text, html: x.html,
      awarded: x.awarded, outOf: x.outOf, autoMarked: x.autoMarked,
    })),
    issues: (run.issues || []).map((i) => ({
      questionId: String(i.questionId), kind: i.kind, note: i.note, at: i.at,
    })),
    issueKinds: QC_ISSUE_KINDS,
  });
}));

/* Answering one question. Marked immediately with the examination's
   own grader and the mark returned, because seeing the mark is the
   point — a question that reads correctly and marks wrongly is
   invisible until this moment. */
r.patch('/run/:token/answer/:questionId', wrap(async (req, res) => {
  const run = await loadRun(req.params.token);

  if (!run.questionIds.some((id) => String(id) === String(req.params.questionId))) {
    throw notFound('That question is not part of this quality check');
  }

  const body = parse(z.object({
    selected: z.array(z.string()).optional(),
    text: z.string().max(20000).optional(),
    html: z.string().max(200000).optional(),
  }), req.body);

  const question = await Question.findById(req.params.questionId).lean();
  if (!question) throw notFound('Question not found');

  const clean = { ...body, html: body.html === undefined ? undefined : sanitiseAnswerHtml(body.html) };
  const marked = markResponse(question, clean);

  let row = run.responses.find((x) => String(x.questionId) === String(question._id));
  if (!row) {
    run.responses.push({ questionId: question._id });
    row = run.responses[run.responses.length - 1];
  }
  Object.assign(row, clean, {
    awarded: marked.awarded,
    outOf: marked.outOf,
    autoMarked: marked.autoMarked,
  });
  await run.save();

  res.json({
    ok: true,
    awarded: marked.awarded,
    outOf: marked.outOf,
    autoMarked: marked.autoMarked,
    /* The checker gave what they believe is the right answer. On an
       objective question, anything short of full marks is the finding
       this exercise exists to surface. */
    looksWrong: marked.autoMarked && Number(marked.awarded) !== Number(marked.outOf),
    correctOptions: marked.autoMarked ? question.correctOptions || [] : undefined,
    acceptedAnswers: question.type === 'fib' ? question.acceptedAnswers || [] : undefined,
  });
}));

/* Flagging a problem with a question. */
r.post('/run/:token/issue/:questionId', wrap(async (req, res) => {
  const run = await loadRun(req.params.token);
  const { kind, note } = parse(z.object({
    kind: z.enum(QC_ISSUE_KINDS),
    note: z.string().max(1000).optional(),
  }), req.body);

  if (!run.questionIds.some((id) => String(id) === String(req.params.questionId))) {
    throw notFound('That question is not part of this quality check');
  }

  run.issues = (run.issues || []).filter(
    (i) => !(String(i.questionId) === String(req.params.questionId) && i.kind === kind),
  );
  run.issues.push({ questionId: req.params.questionId, kind, note, at: now() });
  await run.save();

  res.json({ ok: true, issues: run.issues.length });
}));

r.delete('/run/:token/issue/:questionId', wrap(async (req, res) => {
  const run = await loadRun(req.params.token);
  run.issues = (run.issues || []).filter(
    (i) => String(i.questionId) !== String(req.params.questionId),
  );
  await run.save();
  res.json({ ok: true, issues: run.issues.length });
}));

/* Closing the run. The checker decides; the system states what it
   found and what it would advise, but does not overrule them — a
   spelling note on one question need not block a whole upload, and
   the person who read every question is better placed to say so. */
r.post('/run/:token/finish', wrap(async (req, res) => {
  const run = await loadRun(req.params.token);
  const { verdict, note } = parse(z.object({
    verdict: z.enum(['passed', 'failed']),
    note: z.string().max(2000).optional(),
  }), req.body);

  const questions = await Question.find({ _id: { $in: run.questionIds } }).lean();
  const summary = summarise({ questions, responses: run.responses, issues: run.issues });

  /* A QC2 run on a paper the bank could not fill cannot be passed:
     the thing being certified does not exist. */
  if (verdict === 'passed' && run.stage === 'qc2' && (run.shortfalls || []).length) {
    throw badRequest(
      'This paper could not be assembled in full, so it cannot be passed.',
      { shortfalls: shortfallMessage(run.shortfalls) },
    );
  }

  run.status = verdict;
  run.submittedAt = now();
  run.verdictNote = note;
  await run.save();

  res.json({ ok: true, status: run.status, summary });
}));

/* ============================================================
   MANAGEMENT — ordinary signed-in staff routes
   ============================================================ */
r.use(authenticate);

/* What stands between this upload and approval. */
r.get('/uploads/:uploadId', can('question:view'), wrap(async (req, res) => {
  const upload = await QuestionUpload.findOne({ _id: req.params.uploadId, ...tenant(req) })
    .populate('subjectId', 'code title').lean();
  if (!upload) throw notFound('That upload could not be found');

  const gate = await QcRun.gateFor(req.actor.institutionId, upload._id);
  const runs = await QcRun.find({ ...tenant(req), uploadId: upload._id })
    .sort({ createdAt: 1 }).lean();

  res.json({
    upload: {
      id: String(upload._id),
      label: upload.label,
      count: upload.count,
      subject: upload.subjectId && {
        id: String(upload.subjectId._id),
        code: upload.subjectId.code,
        title: upload.subjectId.title,
      },
    },
    gate: {
      qc1Passed: gate.qc1Passed,
      qc2Passed: gate.qc2Passed,
      mayApprove: gate.mayApprove,
      openIssues: gate.openIssues,
    },
    runs: runs.map((x) => ({
      id: String(x._id),
      stage: x.stage,
      status: x.status,
      assignedToName: x.assignedToName,
      requestedByName: x.requestedByName,
      startedAt: x.startedAt,
      submittedAt: x.submittedAt,
      questions: (x.questionIds || []).length,
      issues: (x.issues || []).length,
      shortfalls: x.shortfalls || [],
      /* The link is shown once, to whoever may start the run. It is
         the credential, so it is never put in a list of many. */
      link: x.status === 'pending' || x.status === 'in_progress'
        ? `${env.appUrl}/qc/${x.token}` : null,
    })),
  });
}));


/* The patterns this institution already has to hand, so QC2 can be
   run against one without a paper existing yet.

   Drawn from two places the cell has already filled in: the papers
   it has built, and the Patterns sheet of any schedule it has
   uploaded. Nothing new to maintain. */
r.get('/patterns', can('question:view'), wrap(async (req, res) => {
  const [exams, drafts] = await Promise.all([
    Exam.find({ ...tenant(req), 'blueprint.sections.0': { $exists: true } })
      .select('title code blueprint subjectId totalMarks').sort({ createdAt: -1 }).limit(40)
      .populate('subjectId', 'code title').lean(),
    ScheduleDraft.find(tenant(req)).select('patterns fileName createdAt')
      .sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  const out = [];
  for (const e of exams) {
    out.push({
      source: 'exam',
      id: String(e._id),
      name: e.title,
      note: `${e.subjectId?.code || e.code} · ${e.totalMarks} marks`,
      sections: e.blueprint.sections,
    });
  }

  const seen = new Set();
  for (const d of drafts) {
    for (const [name, p] of Object.entries(d.patterns || {})) {
      if (seen.has(name) || !p?.sections?.length) continue;
      seen.add(name);
      out.push({
        source: 'schedule',
        id: `draft:${d._id}:${name}`,
        name,
        note: `From ${d.fileName || 'an uploaded schedule'}`,
        sections: p.sections,
      });
    }
  }

  res.json({ patterns: out });
}));

/* Starting a stage. */
r.post('/uploads/:uploadId/runs', can('question:approve', 'question:edit'), wrap(async (req, res) => {
  const { stage, assignedTo, batchId, examId, blueprint: given, notify } = parse(z.object({
    stage: z.enum(['qc1', 'qc2']),
    assignedTo: z.string().optional(),
    batchId: z.string().optional(),
    /* QC2 needs a pattern. Three ways to give it one, in the order
       they are looked for: a paper named here, a pattern handed over
       directly (from an uploaded schedule, or typed), or the most
       recent paper for the subject.

       The second exists because requiring an exam first was a
       chicken and egg: a bank is checked BEFORE the term's papers
       are built, which is the whole point of checking it. */
    examId: z.string().optional(),
    blueprint: z.object({
      name: z.string().optional(),
      sections: z.array(z.object({
        key: z.string(), title: z.string().optional(), type: z.enum(['mcq', 'fib', 'desc']),
        count: z.number().int().positive(), marksEach: z.number().positive(),
        answerCount: z.number().int().positive().optional(),
        choiceMode: z.enum(['best_n', 'any_n', 'either_or']).optional(),
        instruction: z.string().optional(),
      })).min(1),
    }).optional(),
    notify: z.boolean().default(true),
  }), req.body);

  const upload = await QuestionUpload.findOne({ _id: req.params.uploadId, ...tenant(req) }).lean();
  if (!upload) throw notFound('That upload could not be found');

  const questions = await Question.find({
    ...tenant(req), ...BANK, uploadId: upload._id,
  }).sort({ section: 1, order: 1 }).lean();

  if (!questions.length) {
    throw badRequest('There are no questions left in this upload to check.');
  }

  /* Whether the two stages may be done by the same person is the
     examination cell's decision, not ours. Off by default, because
     the client asked for one login to be able to do both. */
  const institution = await Institution.findById(req.actor.institutionId)
    .select('settings.qcRequiresTwoStaff').lean();
  if (institution?.settings?.qcRequiresTwoStaff && assignedTo) {
    const other = await QcRun.findOne({
      ...tenant(req), uploadId: upload._id,
      stage: stage === 'qc1' ? 'qc2' : 'qc1',
      assignedTo,
    }).lean();
    if (other) {
      throw badRequest(
        'This institution requires the two quality checks to be done by different staff.',
        { assignedTo: 'This person has already done the other stage for this upload.' },
      );
    }
  }

  let questionIds = questions.map((q) => q._id);
  let blueprint;
  let shortfalls = [];

  if (stage === 'qc2') {
    /* The pattern the subject will actually sit. */
    let source = given?.sections?.length ? given : null;

    if (!source) {
      const exam = examId
        ? await Exam.findOne({ _id: examId, ...tenant(req) }).lean()
        : await Exam.findOne({ ...tenant(req), subjectId: upload.subjectId })
          .sort({ createdAt: -1 }).lean();
      if (exam?.blueprint?.sections?.length) {
        source = { name: exam.title, sections: exam.blueprint.sections };
      }
    }

    if (!source) {
      throw badRequest(
        'QC2 checks the paper pattern, so it needs a pattern to check against.',
        { examId: 'Choose an existing paper for this subject, or a pattern from an '
          + 'uploaded schedule.' },
      );
    }

    blueprint = { name: source.name || 'Pattern', sections: source.sections };
    const out = assemblePaper({
      blueprint,
      questions,
      /* Spread across units where the bank allows it, so a pattern
         filled entirely from one unit is visible as such rather than
         hidden by taking the first N. */
      pick: (eligible, n) => spreadByUnit(eligible).slice(0, n),
    });
    questionIds = out.picked.map((q) => q._id);
    shortfalls = out.shortfalls;
  }

  const staff = assignedTo
    ? await User.findOne({ _id: assignedTo, ...tenant(req) }).select('name email').lean()
    : null;

  const run = await QcRun.create({
    ...tenant(req),
    uploadId: upload._id,
    subjectId: upload.subjectId,
    batchId: batchId || undefined,
    stage,
    token: newToken(),
    assignedTo: staff?._id,
    assignedToName: staff?.name,
    requestedBy: req.actor.id,
    requestedByName: req.actor.name,
    questionIds,
    blueprint,
    shortfalls,
  });

  const link = `${env.appUrl}/qc/${run.token}`;

  if (notify && staff?.email) {
    const subject = await Subject.findById(upload.subjectId).select('code title').lean();
    const batch = run.batchId ? await Batch.findById(run.batchId).select('label').lean() : null;
    await queueMail({
      institutionId: req.actor.institutionId,
      to: staff.email,
      toName: staff.name,
      template: 'qc_invite',
      relatedKind: 'qc',
      relatedId: run._id,
      queuedBy: req.actor.id,
      data: {
        staffName: staff.name,
        stage,
        stageBlurb: STAGE_BLURB[stage],
        subjectTitle: subject?.title || '',
        subjectCode: subject?.code || '',
        batchLabel: batch?.label || '—',
        questionCount: questionIds.length,
        requestedBy: req.actor.name,
        link,
      },
    });
  }

  await audit(req, {
    action: `qbank.${stage}_started`, entity: 'QuestionUpload', entityId: upload._id,
    after: { stage, assignedTo: staff?.name, questions: questionIds.length, shortfalls: shortfalls.length },
  });

  res.status(201).json({
    run: { id: String(run._id), stage, status: run.status, link },
    shortfalls,
    shortfallMessage: shortfallMessage(shortfalls),
  });
}));

/* The findings, for whoever has to act on them. */
r.get('/runs/:id', can('question:view'), wrap(async (req, res) => {
  const run = await QcRun.findOne({ _id: req.params.id, ...tenant(req) }).lean();
  if (!run) throw notFound('That quality check could not be found');

  const questions = await Question.find({ _id: { $in: run.questionIds } }).lean();
  const byId = new Map(questions.map((q) => [String(q._id), q]));

  res.json({
    run: {
      id: String(run._id),
      stage: run.stage, status: run.status,
      assignedToName: run.assignedToName,
      requestedByName: run.requestedByName,
      startedAt: run.startedAt, submittedAt: run.submittedAt,
      verdictNote: run.verdictNote,
      shortfalls: run.shortfalls || [],
    },
    summary: summarise({ questions, responses: run.responses, issues: run.issues }),
    /* The whole question travels with each finding, in the shape the
       question bank uses. A finding that says only "question 14 is
       keyed wrong" leaves somebody hunting for question 14; this way
       the correction opens from the finding itself. */
    issues: (run.issues || []).map((i) => {
      const q = byId.get(String(i.questionId));
      return {
        questionId: String(i.questionId),
        kind: i.kind, note: i.note, at: i.at,
        section: q?.section, order: q?.order,
        text: q?.text?.slice(0, 160),
        question: q ? shape(q) : null,
      };
    }),

    /* Questions the checker answered correctly and the system marked
       down. Not flagged by hand — nobody has to notice them — but
       they are the finding this exercise exists to produce, so they
       are reported beside the ones that were. */
    misMarked: (run.responses || [])
      .filter((x) => {
        const q = byId.get(String(x.questionId));
        if (!q || !['mcq', 'fib'].includes(q.type)) return false;
        const answered = (x.selected || []).length || (x.text || '').trim();
        return answered && Number(x.awarded) !== Number(q.marks);
      })
      .map((x) => {
        const q = byId.get(String(x.questionId));
        return {
          questionId: String(x.questionId),
          section: q.section, order: q.order,
          text: q.text?.slice(0, 160),
          awarded: x.awarded, outOf: q.marks,
          gave: (x.selected || []).join(', ') || x.text,
          expected: q.type === 'mcq'
            ? (q.correctOptions || []).join(', ')
            : (q.acceptedAnswers || []).join(', '),
          question: shape(q),
        };
      }),
  });
}));

/* Spreads a list across its units, round robin, so a pattern is not
   filled from whichever unit happens to sort first. A bank with no
   units recorded comes back in its original order. */
export function spreadByUnit(questions) {
  const groups = new Map();
  for (const q of questions) {
    const key = q.unit || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  if (groups.size <= 1) return [...questions];

  const buckets = [...groups.values()];
  const out = [];
  for (let i = 0; out.length < questions.length; i += 1) {
    for (const b of buckets) if (b[i]) out.push(b[i]);
    if (i > questions.length) break;          // guard against a malformed bucket
  }
  return out;
}

export default r;

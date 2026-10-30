import { Exam, Room, Attempt } from '../models/exam.js';
import { Institution, Mapping } from '../models/core.js';
import { examStartAt } from '../utils/time.js';
import { collectConflicts } from './examConflicts.js';

/* ============================================================
   PUBLISHING A PAPER

   One implementation, used by the single publish and by the bulk
   scheduler. Publishing is the moment a paper stops being a plan: it
   creates an attempt for every candidate in every room, reserves a
   licence for each, and seals the paper until its start.

   It is also where the EVALUATOR is applied. An evaluator belongs to
   a script, and scripts do not exist until this moment — which is why
   choosing one during bulk scheduling could not do anything until
   now. The intended evaluator is carried on the paper as
   `defaultEvaluatorId` and stamped onto every attempt here.
   ============================================================ */

export async function publishExam(exam, { institutionId, force = false } = {}) {
  if (exam.status !== 'draft') {
    return { ok: false, reason: 'already_published', status: exam.status };
  }

  const conflicts = await collectConflicts(exam, institutionId);
  const blocking = conflicts.filter((c) => c.blocking);
  if (blocking.length && !force) {
    return { ok: false, reason: 'conflicts', conflicts: blocking };
  }

  const rooms = await Room.find({ examId: exam._id }).lean();
  const startAt = examStartAt(exam);

  /* Who marks these scripts. The paper's own choice if bulk
     scheduling or the cell made one; otherwise whoever is mapped to
     this subject for this class, which is the record the institution
     already keeps of who teaches what. */
  const evaluatorId = exam.defaultEvaluatorId
    || await evaluatorFromMapping(exam, institutionId);

  const sets = exam.randomisation?.paperSets?.length ? exam.randomisation.paperSets : ['A'];
  const attempts = [];
  for (const room of rooms) {
    for (const sid of room.studentIds) {
      attempts.push({
        institutionId,
        examId: exam._id, roomId: room._id, studentId: sid,
        status: 'not_started',
        setLabel: sets[attempts.length % sets.length],
        ...(evaluatorId ? {
          evaluation: {
            state: 'pending',
            evaluatorId,
            allocatedAt: new Date(),
          },
        } : {}),
      });
    }
  }

  await Attempt.insertMany(attempts, { ordered: false }).catch((e) => {
    if (e.code !== 11000) throw e;    // re-publish of an existing set
  });

  exam.status = 'scheduled';
  exam.publishedAt = new Date();
  exam.sealedUntil = startAt;
  await exam.save();

  await Institution.findByIdAndUpdate(institutionId, {
    $inc: { 'licence.reserved': attempts.length },
  });

  return {
    ok: true,
    status: exam.status,
    candidates: attempts.length,
    rooms: rooms.length,
    evaluatorId: evaluatorId ? String(evaluatorId) : null,
    warnings: conflicts.filter((c) => !c.blocking),
    forced: Boolean(blocking.length && force),
  };
}

/* The staff member mapped to this subject for this class. Several
   mappings is normal where a subject is taught in sections; the first
   by identifier is taken so the same paper allocates the same way
   twice over. */
export async function evaluatorFromMapping(exam, institutionId) {
  const mapped = await Mapping.find({
    institutionId,
    subjectId: exam.subjectId,
    batchId: { $in: exam.batchIds },
    kind: 'subject_staff',
  }).select('staffId').sort({ staffId: 1 }).lean();

  return mapped.length ? mapped[0].staffId : null;
}

/* Publishing a set of papers, one at a time rather than in a
   transaction. Fifty papers where the twelfth has a clash should
   publish the other forty-nine and say which one did not — stopping
   at the first failure would leave the office with no idea how far it
   had got. */
export async function publishMany(exams, { institutionId, force = false } = {}) {
  const outcome = [];
  for (const exam of exams) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await publishExam(exam, { institutionId, force });
      outcome.push({
        examId: String(exam._id), code: exam.code, date: exam.date, startTime: exam.startTime,
        ...out,
      });
    } catch (e) {
      outcome.push({
        examId: String(exam._id), code: exam.code,
        ok: false, reason: 'error', error: e.message,
      });
    }
  }
  return {
    published: outcome.filter((o) => o.ok).length,
    blocked: outcome.filter((o) => !o.ok).length,
    candidates: outcome.reduce((n, o) => n + (o.candidates || 0), 0),
    outcome,
  };
}

/* Loads the papers a bulk draft created, for publishing together. */
export async function examsFor(ids, institutionId) {
  if (!ids?.length) return [];
  return Exam.find({ _id: { $in: ids }, institutionId });
}

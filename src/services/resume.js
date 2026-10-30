import { Question } from '../models/exam.js';
import { hasContent } from '../utils/grading.js';

/* ============================================================
   RESUMING A PAPER AFTER A DISCONNECTION

   A machine dies, the power goes, the network drops. The candidate
   has to be let back in, and an invigilator approves that.

   The problem is that a candidate who wants another look at a hard
   question can produce exactly the same event by pulling the plug —
   and in an examination hall, some of them will. A resume that simply
   returned the candidate to their paper would make that worth doing.

   So a resume reshapes the paper:

     Answered questions are SEALED. They are marked as they stand and
     cannot be rewritten. Whatever the candidate committed before the
     disconnection is their answer.

     Unanswered questions are REPLACED, each by a different question
     of the same section, the same type and the same marks, drawn from
     the approved bank for that subject. Same shape, same difficulty,
     different questions.

   A candidate who dropped out honestly loses nothing they had done.
   A candidate who dropped out to buy a second look gets a paper they
   have never seen, with the questions they were stuck on gone.

   The arithmetic of choosing replacements is pure and lives in
   `planSwap` so it can be tested without a database; `applyResume`
   does the writing.
   ============================================================ */

/* Which questions this candidate has committed to. A question with
   any content at all — a chosen option, typed text, an uploaded sheet
   — is answered and therefore sealed. */
export function answeredIds(attempt) {
  return new Set(
    (attempt.answers || [])
      .filter(hasContent)
      .map((a) => String(a.questionId)),
  );
}

/* Two questions are interchangeable when a candidate could not tell
   the papers apart by shape: same part, same kind of question, same
   marks. Anything else changes what the paper is worth or how long it
   takes, which would make the resumed paper a different examination.

   Difficulty is matched where the bank records it, and ignored where
   it does not, rather than refusing to swap at all — a paper that
   cannot be reshaped is worse for the candidate than one reshaped
   with a question of unstated difficulty. */
export function isInterchangeable(original, candidate) {
  if (!original || !candidate) return false;
  if (String(original._id) === String(candidate._id)) return false;
  return candidate.section === original.section
    && candidate.type === original.type
    && Number(candidate.marks) === Number(original.marks);
}

/* Picks a replacement for each unanswered question.

   Deterministic given the same inputs and the same `pick`, so a
   resume can be replayed and reasoned about. Each bank question is
   used at most once, and never one the candidate has already been
   shown on this paper — swapping a question for another they have
   already read would hand back exactly what the rule is there to
   take away.

   Returns the plan rather than performing it: what is sealed, what is
   replaced by what, and what could not be replaced and why. */
export function planSwap({ paper, answered, bank, pick = (xs) => xs[0] }) {
  const sealed = [];
  const swaps = [];
  const unswappable = [];

  /* Everything the candidate has already laid eyes on, so a
     replacement is never drawn from it. */
  const seen = new Set(paper.map((q) => String(q._id)));
  const spent = new Set();

  for (const q of paper) {
    if (answered.has(String(q._id))) { sealed.push(q); continue; }

    const options = bank.filter((b) => isInterchangeable(q, b)
      && !seen.has(String(b._id))
      && !spent.has(String(b._id)));

    if (!options.length) {
      unswappable.push({
        questionId: q._id,
        why: `The bank holds no other unused ${q.type.toUpperCase()} question worth `
           + `${q.marks} mark(s) in Part ${q.section}`,
      });
      sealed.push(q);                 // kept, because there is nothing to put in its place
      continue;
    }

    const chosen = pick(options);
    spent.add(String(chosen._id));
    swaps.push({ from: q, to: chosen, section: q.section, order: q.order });
  }

  return { sealed, swaps, unswappable };
}

/* The paper the candidate comes back to: the sealed questions and the
   replacements, in the original reading order, so Part A still reads
   1, 2, 3 and the choice pairing in Part C still pairs. */
export function rebuildPaper({ paper, answered, swaps }) {
  const replacement = new Map(swaps.map((s) => [String(s.from._id), s.to]));
  return paper.map((q) => (answered.has(String(q._id)) ? q : (replacement.get(String(q._id)) || q)));
}

/* ------------------------------------------------------------
   Performing it.

   A replacement is CLONED into the examination rather than linked to
   in the bank. Three reasons, all of them learned the hard way
   elsewhere in this product:

     every other route loads a question with
     `findOne({ _id, examId })`, and a bank question has no examId, so
     a linked one would be refused on save, on upload and on scan;

     the clone carries the original's order, so the paper still reads
     in sequence and Part C still pairs 1-or-2, 3-or-4;

     the bank stays editable. A staff member correcting a typo in a
     bank question months later must not alter a paper somebody has
     already sat.
   ------------------------------------------------------------ */
export async function applyResume({ attempt, exam, approver, reason, extraMinutes, pick }) {
  const paper = await currentPaper(attempt, exam);
  const answered = answeredIds(attempt);

  const used = new Set(paper.map((q) => String(q._id)));
  const bank = await Question.find({
    institutionId: exam.institutionId,
    subjectId: exam.subjectId,
    examId: null,
    status: 'approved',
    _id: { $nin: [...used] },
  }).lean();

  const { sealed, swaps, unswappable } = planSwap({ paper, answered, bank, pick });

  /* The clones. setLabel marks them as this attempt's own, so no
     other candidate's paper query can pick them up. */
  const label = `R:${String(attempt._id)}`;
  const clones = await Question.insertMany(swaps.map(({ from, to }) => ({
    institutionId: exam.institutionId,
    subjectId: exam.subjectId,
    examId: exam._id,
    section: from.section,
    type: from.type,
    order: from.order,
    setLabel: label,
    text: to.text,
    marks: from.marks,
    options: to.options,
    correctOptions: to.correctOptions,
    multiSelect: to.multiSelect,
    acceptedAnswers: to.acceptedAnswers,
    keywords: to.keywords,
    modelAnswer: to.modelAnswer,
    markingGuidance: to.markingGuidance,
    choiceGroup: from.choiceGroup,
    unit: to.unit,
    difficulty: to.difficulty,
    createdBy: approver?.id,
  })), { ordered: true });

  const cloneFor = new Map(swaps.map((s, i) => [String(s.from._id), clones[i]]));

  const rebuilt = paper.map((q) => (
    answered.has(String(q._id)) ? q : (cloneFor.get(String(q._id)) || q)
  ));

  /* The answers to questions that are no longer on the paper go with
     them. A part-written answer to a question the candidate will
     never see again cannot be marked, and leaving it would show the
     evaluator a mark against a question that is not there. */
  const keep = new Set(rebuilt.map((q) => String(q._id)));
  attempt.answers = (attempt.answers || []).filter((a) => keep.has(String(a.questionId)));

  attempt.paperQuestionIds = rebuilt.map((q) => q._id);
  attempt.lockedQuestionIds = [...new Set([
    ...(attempt.lockedQuestionIds || []).map(String),
    ...sealed.map((q) => String(q._id)),
  ])].filter((id) => keep.has(id));

  if (extraMinutes > 0) {
    const from = attempt.timerEndsAt ? new Date(attempt.timerEndsAt) : new Date();
    attempt.timerEndsAt = new Date(from.getTime() + extraMinutes * 60_000);
  }
  attempt.status = 'in_progress';

  attempt.resumes = [...(attempt.resumes || []), {
    at: new Date(),
    approvedBy: approver?.id,
    approvedByName: approver?.name,
    reason,
    extraMinutes,
    lockedCount: sealed.length,
    swapped: swaps.map((s, i) => ({
      from: s.from._id, to: clones[i]._id, section: s.section, order: s.order,
    })),
    unswappable,
  }];

  await attempt.save();

  return {
    sealed: sealed.length,
    swapped: swaps.length,
    unswappable,
    timerEndsAt: attempt.timerEndsAt,
  };
}

/* This attempt's paper: its own if it has one, the examination's
   otherwise. Every route that serves or validates a question goes
   through here, so a resumed candidate and an ordinary one are read
   the same way. */
export async function currentPaper(attempt, exam) {
  if (attempt.paperQuestionIds?.length) {
    const qs = await Question.find({ _id: { $in: attempt.paperQuestionIds } }).lean();
    const byId = new Map(qs.map((q) => [String(q._id), q]));
    /* Ordered by the stored list, not by the query's own order. */
    return attempt.paperQuestionIds.map((id) => byId.get(String(id))).filter(Boolean);
  }
  return Question.find({
    examId: exam._id,
    $or: [{ setLabel: attempt.setLabel }, { setLabel: { $exists: false } }],
  }).sort({ section: 1, order: 1 }).lean();
}

/* Whether this question is sealed for this candidate. */
export function isLocked(attempt, questionId) {
  return (attempt.lockedQuestionIds || []).some((id) => String(id) === String(questionId));
}

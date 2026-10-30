import crypto from 'node:crypto';
import { gradeMcq, gradeFib, suggestDescriptive } from '../utils/grading.js';

/* ============================================================
   ASSEMBLING AND MARKING A QUALITY-CHECK RUN

   The pure half of the quality check: which questions a QC2 paper is
   built from, and what each answer is worth. Both are here, with no
   database, because both are the sort of arithmetic that is wrong
   silently — a paper short of questions that still renders, or a mark
   that differs from the one the real examination will award.

   The marking MUST be the same code the examination uses. A quality
   check that marked by its own rules would certify a bank that then
   marked differently on the day, which is worse than no check at all.
   ============================================================ */

export const newToken = () => crypto.randomBytes(24).toString('base64url');

/* ------------------------------------------------------------
   QC2: build a real paper from the pattern.

   The point of this stage is not to re-read the questions — QC1 did
   that. It is to find out whether the bank can actually produce the
   paper the subject is going to use, which QC1 cannot tell you
   because QC1 never counts anything.

   A bank with seven usable MCQs where the pattern needs ten reads
   perfectly, passes QC1, and fails on the morning of the examination.
   ------------------------------------------------------------ */
export function assemblePaper({ blueprint, questions, pick = (xs, n) => xs.slice(0, n) }) {
  const picked = [];
  const shortfalls = [];

  for (const section of blueprint.sections || []) {
    /* A question belongs to this section of the pattern only if its
       part, its type and its marks all match. Marks matter: a 15-mark
       descriptive question cannot stand in for a 10-mark one without
       changing what the paper is worth. */
    const eligible = questions.filter((q) => q.section === section.key
      && q.type === section.type
      && Number(q.marks) === Number(section.marksEach));

    const need = Number(section.count) || 0;
    const take = pick(eligible, need);

    if (take.length < need) {
      shortfalls.push({
        section: section.key,
        type: section.type,
        marksEach: section.marksEach,
        needed: need,
        available: eligible.length,
      });
    }

    take.slice(0, need).forEach((q, i) => picked.push({ ...q, order: i + 1 }));
  }

  return { picked, shortfalls };
}

/* Whether the assembled paper is usable at all. A paper the bank
   cannot fill is a failed check, not a paper to sit. */
export const canSit = (shortfalls) => shortfalls.length === 0;

/* A sentence an examination cell can act on. */
export function shortfallMessage(shortfalls) {
  if (!shortfalls.length) return null;
  return shortfalls.map((s) => (
    `Part ${s.section} needs ${s.needed} ${s.type.toUpperCase()} question(s) worth `
    + `${s.marksEach} mark(s); the bank holds ${s.available}`
  )).join('. ');
}

/* ------------------------------------------------------------
   Marking one quality-check answer.

   Objective questions are marked by the examination's own grader, so
   the figure shown to the checker is the figure a candidate would
   receive. Descriptive questions have no objective mark, so the
   keyword suggestion is shown instead and labelled as a suggestion —
   the checker is verifying that the model answer and keywords were
   carried across, not that an essay scores a particular number.
   ------------------------------------------------------------ */
export function markResponse(question, response) {
  const outOf = Number(question.marks) || 0;

  if (question.type === 'mcq') {
    const { awarded } = gradeMcq(question, response);
    return { awarded, outOf, autoMarked: true };
  }
  if (question.type === 'fib') {
    const { awarded } = gradeFib(question, response);
    return { awarded, outOf, autoMarked: true };
  }

  const { suggested, coverage } = suggestDescriptive(question, response);
  return {
    awarded: suggested,
    outOf,
    autoMarked: false,
    coverage,
  };
}

/* ------------------------------------------------------------
   Reading a finished run.

   The checker answers every question correctly — they are checking
   the paper, not sitting it — so anything that did NOT score full
   marks on an objective question is a finding. That is the test for
   "after evaluation marks will show correct": the checker knows the
   right answer, gave it, and the system disagreed.
   ------------------------------------------------------------ */
export function summarise({ questions, responses, issues }) {
  const byId = new Map(questions.map((q) => [String(q._id), q]));
  const seen = new Map((responses || []).map((r) => [String(r.questionId), r]));

  let answered = 0;
  let objective = 0;
  let fullMarks = 0;
  const markMismatches = [];

  for (const q of questions) {
    const r = seen.get(String(q._id));
    if (!r) continue;

    const hasAnswer = Boolean(
      (r.selected && r.selected.length) || (r.text && r.text.trim()) || (r.html && r.html.trim()),
    );
    if (hasAnswer) answered += 1;

    if (q.type === 'mcq' || q.type === 'fib') {
      objective += 1;
      if (hasAnswer) {
        if (Number(r.awarded) === Number(q.marks)) fullMarks += 1;
        else {
          markMismatches.push({
            questionId: String(q._id),
            awarded: r.awarded,
            outOf: q.marks,
          });
        }
      }
    }
  }

  const byKind = {};
  for (const i of issues || []) byKind[i.kind] = (byKind[i.kind] || 0) + 1;

  return {
    total: questions.length,
    answered,
    unanswered: questions.length - answered,
    objective,
    fullMarks,
    markMismatches,
    issues: (issues || []).length,
    issuesByKind: byKind,
    /* What a checker is advised to do. A run with findings may still
       be passed — a spelling note on one question need not block a
       whole upload — but the default is stated. */
    advice: (issues || []).length || markMismatches.length ? 'fix' : 'pass',
  };
}

/* The two stages, described in the words the invitation uses. */
export const STAGE_BLURB = {
  qc1: 'Every question in this upload is shown in order. Answer each one as a candidate '
     + 'would, giving the answer you believe is correct, and check that the mark awarded '
     + 'matches. Flag anything that is cut off, misspelt, keyed to the wrong option or '
     + 'outside the syllabus.',
  qc2: 'This is the paper as it will actually be set, assembled from the subject\'s question '
     + 'pattern. Check that it reads as a complete paper, that the parts and marks come to '
     + 'the right total, and that the questions are spread across the syllabus rather than '
     + 'bunched in one unit.',
};

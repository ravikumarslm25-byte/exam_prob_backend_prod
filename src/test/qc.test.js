/* ============================================================
   QUALITY CHECK

   Two things here are worth testing and one of them is the reason the
   feature exists.

   The ordinary one: QC2 builds a real paper from the pattern, and has
   to say so honestly when the bank cannot fill it. A paper that comes
   back three questions short but renders perfectly is exactly the
   failure this stage is meant to catch.

   The real one: the check marks with the EXAMINATION's grader. A
   quality check that marked by rules of its own would certify a bank
   that then marked differently on the day — worse than no check.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assemblePaper, markResponse, summarise, canSit, shortfallMessage, newToken,
} from '../services/qc.js';
import { spreadByUnit } from '../routes/qc.routes.js';
import { gradeMcq } from '../utils/grading.js';

const mcq = (id, over = {}) => ({
  _id: id, section: 'A', type: 'mcq', marks: 1,
  text: `Q${id}`, options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }],
  correctOptions: ['A'], ...over,
});
const fib = (id, over = {}) => ({
  _id: id, section: 'B', type: 'fib', marks: 2, text: `Q${id}`,
  acceptedAnswers: ['mumbai'], ...over,
});
const desc = (id, over = {}) => ({
  _id: id, section: 'C', type: 'desc', marks: 15, text: `Q${id}`,
  keywords: [{ term: 'motivation', weight: 1 }], ...over,
});

const blueprint = {
  sections: [
    { key: 'A', type: 'mcq', count: 3, marksEach: 1 },
    { key: 'B', type: 'fib', count: 2, marksEach: 2 },
    { key: 'C', type: 'desc', count: 2, marksEach: 15 },
  ],
};

/* ---------------- assembling the QC2 paper ---------------- */

test('a bank that can fill the pattern produces the whole paper', () => {
  const questions = [
    mcq('a1'), mcq('a2'), mcq('a3'), mcq('a4'),
    fib('b1'), fib('b2'),
    desc('c1'), desc('c2'), desc('c3'),
  ];
  const { picked, shortfalls } = assemblePaper({ blueprint, questions });
  assert.equal(picked.length, 3 + 2 + 2);
  assert.deepEqual(shortfalls, []);
  assert.ok(canSit(shortfalls));
});

test('a bank short of questions says exactly where and by how much', () => {
  /* The failure QC1 cannot see: every question reads perfectly, and
     there are only two of them where the paper needs three. */
  const questions = [mcq('a1'), mcq('a2'), fib('b1'), fib('b2'), desc('c1'), desc('c2')];
  const { picked, shortfalls } = assemblePaper({ blueprint, questions });

  assert.equal(picked.length, 6);
  assert.equal(shortfalls.length, 1);
  assert.deepEqual(shortfalls[0], {
    section: 'A', type: 'mcq', marksEach: 1, needed: 3, available: 2,
  });
  assert.ok(!canSit(shortfalls));
  assert.match(shortfallMessage(shortfalls), /Part A needs 3 MCQ question\(s\) worth 1 mark\(s\); the bank holds 2/);
});

test('a question of the wrong marks cannot stand in for one of the right marks', () => {
  const questions = [
    mcq('a1'), mcq('a2'), mcq('a3'),
    fib('b1'), fib('b2'),
    desc('c1'), desc('c2', { marks: 10 }),      // 10-mark question in a 15-mark slot
  ];
  const { shortfalls } = assemblePaper({ blueprint, questions });
  assert.equal(shortfalls.length, 1);
  assert.equal(shortfalls[0].section, 'C');
  assert.equal(shortfalls[0].available, 1);
});

test('an empty bank reports every section short rather than an empty paper', () => {
  const { picked, shortfalls } = assemblePaper({ blueprint, questions: [] });
  assert.equal(picked.length, 0);
  assert.equal(shortfalls.length, 3);
});

test('the assembled paper numbers its questions from one within each part', () => {
  const questions = [mcq('a1'), mcq('a2'), mcq('a3'), fib('b1'), fib('b2'), desc('c1'), desc('c2')];
  const { picked } = assemblePaper({ blueprint, questions });
  assert.deepEqual(picked.filter((q) => q.section === 'A').map((q) => q.order), [1, 2, 3]);
  assert.deepEqual(picked.filter((q) => q.section === 'B').map((q) => q.order), [1, 2]);
});

/* ---------------- marking uses the examination's own grader ---------------- */

test('a correct multiple choice answer scores full marks, exactly as the examination would', () => {
  const q = mcq('a1');
  const response = { selected: ['A'] };
  const out = markResponse(q, response);
  assert.equal(out.awarded, gradeMcq(q, response).awarded, 'QC must mark like the examination');
  assert.equal(out.awarded, 1);
  assert.equal(out.autoMarked, true);
});

test('an answer key pointing at the wrong option shows up as a lost mark', () => {
  /* The bug this whole feature exists to catch: the question reads
     perfectly, the checker gives the right answer, and the system
     awards nothing because the key is wrong. */
  const broken = mcq('a1', { correctOptions: ['B'] });
  const out = markResponse(broken, { selected: ['A'] });
  assert.equal(out.awarded, 0);
  assert.notEqual(out.awarded, out.outOf, 'the mismatch is the finding');
});

test('a fill in the blanks answer is marked by the examination rules', () => {
  assert.equal(markResponse(fib('b1'), { text: 'Mumbai' }).awarded, 2, 'case is tolerated');
  assert.equal(markResponse(fib('b1'), { text: 'Delhi' }).awarded, 0);
});

test('a descriptive answer is a suggestion, never an automatic mark', () => {
  const out = markResponse(desc('c1'), { text: 'motivation theory' });
  assert.equal(out.autoMarked, false);
  assert.equal(out.outOf, 15);
});

/* ---------------- reading the run ---------------- */

const questions = [mcq('a1'), mcq('a2'), fib('b1')];

test('a clean run advises passing', () => {
  const s = summarise({
    questions,
    responses: [
      { questionId: 'a1', selected: ['A'], awarded: 1 },
      { questionId: 'a2', selected: ['A'], awarded: 1 },
      { questionId: 'b1', text: 'mumbai', awarded: 2 },
    ],
    issues: [],
  });
  assert.equal(s.answered, 3);
  assert.equal(s.fullMarks, 3);
  assert.equal(s.markMismatches.length, 0);
  assert.equal(s.advice, 'pass');
});

test('a question that marked wrongly is reported even with nothing flagged by hand', () => {
  const s = summarise({
    questions,
    responses: [
      { questionId: 'a1', selected: ['A'], awarded: 0 },     // checker was right, system was not
      { questionId: 'a2', selected: ['A'], awarded: 1 },
      { questionId: 'b1', text: 'mumbai', awarded: 2 },
    ],
    issues: [],
  });
  assert.equal(s.markMismatches.length, 1);
  assert.equal(s.markMismatches[0].questionId, 'a1');
  assert.equal(s.advice, 'fix');
});

test('an unanswered question is counted, not silently passed over', () => {
  const s = summarise({
    questions,
    responses: [{ questionId: 'a1', selected: ['A'], awarded: 1 }],
    issues: [],
  });
  assert.equal(s.answered, 1);
  assert.equal(s.unanswered, 2);
});

test('flagged issues are counted and grouped by kind', () => {
  const s = summarise({
    questions,
    responses: [],
    issues: [
      { questionId: 'a1', kind: 'spelling' },
      { questionId: 'a2', kind: 'spelling' },
      { questionId: 'b1', kind: 'out_of_syllabus' },
    ],
  });
  assert.equal(s.issues, 3);
  assert.deepEqual(s.issuesByKind, { spelling: 2, out_of_syllabus: 1 });
  assert.equal(s.advice, 'fix');
});

/* ---------------- spreading across the syllabus ---------------- */

test('a pattern is filled across units rather than from whichever sorts first', () => {
  const pool = [
    mcq('u1a', { unit: 'I' }), mcq('u1b', { unit: 'I' }), mcq('u1c', { unit: 'I' }),
    mcq('u2a', { unit: 'II' }), mcq('u2b', { unit: 'II' }),
    mcq('u3a', { unit: 'III' }),
  ];
  const first3 = spreadByUnit(pool).slice(0, 3).map((q) => q.unit);
  assert.deepEqual([...new Set(first3)].sort(), ['I', 'II', 'III'],
    'the first three questions should come from three different units');
});

test('a bank with no units recorded keeps its own order', () => {
  const pool = [mcq('a1'), mcq('a2'), mcq('a3')];
  assert.deepEqual(spreadByUnit(pool).map((q) => String(q._id)), ['a1', 'a2', 'a3']);
});

test('spreading never loses or duplicates a question', () => {
  const pool = [
    mcq('a', { unit: 'I' }), mcq('b', { unit: 'I' }), mcq('c', { unit: 'II' }),
    mcq('d', { unit: 'III' }), mcq('e', { unit: 'III' }), mcq('f', { unit: 'III' }),
  ];
  const out = spreadByUnit(pool).map((q) => String(q._id));
  assert.equal(out.length, pool.length);
  assert.equal(new Set(out).size, pool.length);
});

/* ---------------- the link ---------------- */

test('a run token is long, random and URL safe', () => {
  const a = newToken();
  assert.ok(a.length >= 30);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(a, newToken());
});

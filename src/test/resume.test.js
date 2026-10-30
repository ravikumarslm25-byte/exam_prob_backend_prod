/* ============================================================
   RESUMING AFTER A DISCONNECTION

   The rule has two halves and both have to be exactly right.

   Too lenient and pulling the power lead becomes a way to get a
   second look at a hard question — which is the whole reason the
   client asked for this.

   Too harsh and a candidate whose machine genuinely died loses work
   they had already committed, which is far worse: it punishes the
   honest case, and it is the honest case almost every time.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planSwap, rebuildPaper, isInterchangeable, answeredIds,
} from '../services/resume.js';

const q = (id, over = {}) => ({
  _id: id, section: 'A', type: 'mcq', marks: 1, order: Number(String(id).replace(/\D/g, '')) || 0,
  text: `Question ${id}`, ...over,
});

/* A four-question Part A and a two-question Part C. */
const paper = [
  q('a1'), q('a2'), q('a3'), q('a4'),
  q('c1', { section: 'C', type: 'desc', marks: 15, order: 1 }),
  q('c2', { section: 'C', type: 'desc', marks: 15, order: 2 }),
];

const bank = [
  q('b1'), q('b2'), q('b3'), q('b4'), q('b5'),
  q('bc1', { section: 'C', type: 'desc', marks: 15 }),
  q('bc2', { section: 'C', type: 'desc', marks: 15 }),
];

const ids = (xs) => xs.map((x) => String(x._id ?? x));

/* ---------------- what counts as answered ---------------- */

test('any committed content seals a question, whatever form it took', () => {
  const attempt = {
    answers: [
      { questionId: 'a1', selected: ['A'] },
      { questionId: 'a2', text: 'something' },
      { questionId: 'a3', html: '<p>written</p>' },
      { questionId: 'a4', scanPages: [{ page: 1 }] },
      { questionId: 'c1' },                       // opened, nothing written
      { questionId: 'c2', text: '   ' },          // whitespace is not an answer
    ],
  };
  const sealed = answeredIds(attempt);
  for (const id of ['a1', 'a2', 'a3', 'a4']) assert.ok(sealed.has(id), `${id} should be sealed`);
  for (const id of ['c1', 'c2']) assert.ok(!sealed.has(id), `${id} should not be sealed`);
});

/* ---------------- what may replace what ---------------- */

test('a replacement matches the part, the type and the marks', () => {
  const original = q('a1');
  assert.ok(isInterchangeable(original, q('b1')));
  assert.ok(!isInterchangeable(original, q('b1', { section: 'B' })), 'different part');
  assert.ok(!isInterchangeable(original, q('b1', { type: 'fib' })), 'different type');
  assert.ok(!isInterchangeable(original, q('b1', { marks: 2 })), 'different marks');
});

test('a question is never swapped for itself', () => {
  assert.ok(!isInterchangeable(q('a1'), q('a1')));
});

/* ---------------- the plan ---------------- */

test('answered questions are sealed and unanswered ones replaced', () => {
  const answered = new Set(['a1', 'a2']);
  const { sealed, swaps, unswappable } = planSwap({ paper, answered, bank });

  assert.deepEqual(ids(sealed), ['a1', 'a2']);
  assert.deepEqual(swaps.map((s) => String(s.from._id)), ['a3', 'a4', 'c1', 'c2']);
  assert.equal(unswappable.length, 0);
});

test('a replacement is never one the candidate has already seen', () => {
  const answered = new Set(['a1']);
  const { swaps } = planSwap({ paper, answered, bank });
  const onThePaper = new Set(ids(paper));
  for (const s of swaps) {
    assert.ok(!onThePaper.has(String(s.to._id)),
      `${s.to._id} was already on this candidate's paper`);
  }
});

test('one bank question cannot fill two gaps on the same paper', () => {
  const { swaps } = planSwap({ paper, answered: new Set(), bank });
  const used = ids(swaps.map((s) => s.to));
  assert.equal(new Set(used).size, used.length, 'a replacement was used twice');
});

test('a descriptive gap is filled by a descriptive question of the same marks', () => {
  const { swaps } = planSwap({ paper, answered: new Set(['a1', 'a2', 'a3', 'a4']), bank });
  assert.equal(swaps.length, 2);
  for (const s of swaps) {
    assert.equal(s.to.type, 'desc');
    assert.equal(s.to.marks, 15);
  }
});

test('a candidate who answered everything keeps the paper they sat', () => {
  const answered = new Set(ids(paper));
  const { sealed, swaps } = planSwap({ paper, answered, bank });
  assert.equal(sealed.length, paper.length);
  assert.equal(swaps.length, 0);
});

test('a candidate who answered nothing gets a wholly new paper', () => {
  const { sealed, swaps } = planSwap({ paper, answered: new Set(), bank });
  assert.equal(sealed.length, 0);
  assert.equal(swaps.length, paper.length);
});

/* ---------------- when the bank cannot help ---------------- */

test('an empty bank keeps the question rather than removing it', () => {
  const { sealed, swaps, unswappable } = planSwap({ paper, answered: new Set(['a1']), bank: [] });
  assert.equal(swaps.length, 0);
  assert.equal(sealed.length, paper.length, 'every question is kept');
  assert.equal(unswappable.length, 5);
});

test('a bank too small to cover every gap replaces what it can', () => {
  const { swaps, unswappable } = planSwap({
    paper, answered: new Set(), bank: [q('b1'), q('b2')],
  });
  assert.equal(swaps.length, 2);
  assert.equal(unswappable.length, 4);
  /* And says which, and why, rather than failing silently. */
  for (const u of unswappable) assert.match(u.why, /bank holds no other/);
});

test('a paper that cannot be reshaped is never left shorter than it was', () => {
  const { sealed, swaps } = planSwap({ paper, answered: new Set(), bank: [q('b1')] });
  assert.equal(sealed.length + swaps.length, paper.length);
});

/* ---------------- the rebuilt paper ---------------- */

test('the rebuilt paper keeps its length and its reading order', () => {
  const answered = new Set(['a1', 'c1']);
  const { swaps } = planSwap({ paper, answered, bank });
  const rebuilt = rebuildPaper({ paper, answered, swaps });

  assert.equal(rebuilt.length, paper.length);
  assert.deepEqual(rebuilt.map((x) => x.section), paper.map((x) => x.section));
  assert.deepEqual(rebuilt.map((x) => x.marks), paper.map((x) => x.marks));
  assert.deepEqual(rebuilt.map((x) => x.type), paper.map((x) => x.type));
});

test('a sealed question is still the same question afterwards', () => {
  const answered = new Set(['a1', 'a2']);
  const { swaps } = planSwap({ paper, answered, bank });
  const rebuilt = rebuildPaper({ paper, answered, swaps });
  assert.equal(String(rebuilt[0]._id), 'a1');
  assert.equal(String(rebuilt[1]._id), 'a2');
});

test('an unanswered question is gone from the rebuilt paper', () => {
  const answered = new Set(['a1']);
  const { swaps } = planSwap({ paper, answered, bank });
  const rebuilt = rebuildPaper({ paper, answered, swaps });
  const left = new Set(ids(rebuilt));
  for (const gone of ['a2', 'a3', 'a4', 'c1', 'c2']) {
    assert.ok(!left.has(gone), `${gone} should have been replaced`);
  }
});

test('the marks a resumed paper is worth are unchanged', () => {
  const total = (xs) => xs.reduce((s, x) => s + x.marks, 0);
  const answered = new Set(['a1', 'a2']);
  const { swaps } = planSwap({ paper, answered, bank });
  assert.equal(total(rebuildPaper({ paper, answered, swaps })), total(paper));
});

/* ---------------- the point of the whole exercise ---------------- */

test('disconnecting deliberately buys a new question, not another look', () => {
  /* The candidate is stuck on a3 and a4, answers the easy ones, and
     pulls the plug hoping to come back to the same two. */
  const answered = new Set(['a1', 'a2']);
  const { swaps } = planSwap({ paper, answered, bank });
  const rebuilt = rebuildPaper({ paper, answered, swaps });
  const back = new Set(ids(rebuilt));

  assert.ok(!back.has('a3'), 'the question they were stuck on came back');
  assert.ok(!back.has('a4'), 'the question they were stuck on came back');
  assert.ok(back.has('a1') && back.has('a2'), 'their committed work was taken away');
});

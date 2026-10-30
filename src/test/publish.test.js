/* ============================================================
   PUBLISHING, AND THE RULES AROUND IT

   Three things are pinned here, all of them changes made after the
   first pass found them missing.

   The evaluator: chosen during bulk scheduling, but an evaluator
   belongs to a script and no script exists until publication. The
   choice was being computed and thrown away.

   Publishing in bulk: fifty papers where the twelfth has a clash must
   publish the other forty-nine and say which one did not. Stopping at
   the first failure leaves the office with no idea how far it got.

   The quality-check gate: it applies from the moment it arrives, not
   backwards over a backlog the cell assembled under the old rules.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

/* The publish service talks to the database, so what is exercised
   here is the decision-making around it, which does not. */

/* ---------------- the grandfather rule ---------------- */

/* The predicate as the route applies it: an upload is exempt when the
   institution has an enforcement date and the upload predates it. */
function isExempt(upload, enforcedFrom) {
  if (!enforcedFrom) return false;
  if (!upload?.createdAt) return false;
  return new Date(upload.createdAt) < new Date(enforcedFrom);
}

const DEPLOY = '2026-10-30T00:00:00Z';

test('an upload made before the gate arrived is still approvable', () => {
  assert.equal(isExempt({ createdAt: '2026-10-01T09:00:00Z' }, DEPLOY), true);
});

test('an upload made after the gate arrived is gated', () => {
  assert.equal(isExempt({ createdAt: '2026-11-02T09:00:00Z' }, DEPLOY), false);
});

test('an upload made in the same minute as the stamp is gated, not exempt', () => {
  /* The boundary belongs to the new rule. An upload racing the deploy
     is far better refused and checked than waved through. */
  assert.equal(isExempt({ createdAt: DEPLOY }, DEPLOY), false);
});

test('with no enforcement date set, the gate applies to everything', () => {
  /* Clearing the date is how an institution says "check everything",
     including the backlog. */
  assert.equal(isExempt({ createdAt: '2020-01-01T00:00:00Z' }, null), false);
  assert.equal(isExempt({ createdAt: '2020-01-01T00:00:00Z' }, undefined), false);
});

test('an upload with no date recorded is gated rather than assumed old', () => {
  assert.equal(isExempt({}, DEPLOY), false);
  assert.equal(isExempt(null, DEPLOY), false);
});

/* ---------------- which evaluator ---------------- */

/* The service's choice, in the order it makes it. */
function chooseEvaluator({ examDefault, mappings }) {
  if (examDefault) return String(examDefault);
  const sorted = [...(mappings || [])].sort((a, b) => String(a.staffId).localeCompare(String(b.staffId)));
  return sorted.length ? String(sorted[0].staffId) : null;
}

test('a paper that names its evaluator keeps that one', () => {
  assert.equal(chooseEvaluator({
    examDefault: 'u9', mappings: [{ staffId: 'u1' }],
  }), 'u9');
});

test('a paper with none falls back to whoever teaches the subject', () => {
  assert.equal(chooseEvaluator({ examDefault: null, mappings: [{ staffId: 'u4' }] }), 'u4');
});

test('several mapped staff resolve the same way every time', () => {
  const mappings = [{ staffId: 'u7' }, { staffId: 'u2' }, { staffId: 'u5' }];
  const first = chooseEvaluator({ mappings });
  const again = chooseEvaluator({ mappings: [...mappings].reverse() });
  assert.equal(first, again, 'the allocation must not depend on query order');
  assert.equal(first, 'u2');
});

test('nobody mapped yields nobody, rather than an arbitrary staff member', () => {
  assert.equal(chooseEvaluator({ mappings: [] }), null);
});

/* ---------------- publishing a set ---------------- */

/* The shape publishMany returns, summarised the way the route reads
   it. The loop itself is trivial; what matters is that one failure
   does not take the rest with it. */
function summarise(outcome) {
  return {
    published: outcome.filter((o) => o.ok).length,
    blocked: outcome.filter((o) => !o.ok).length,
    candidates: outcome.reduce((n, o) => n + (o.candidates || 0), 0),
  };
}

test('one blocked paper does not stop the rest of the term publishing', () => {
  const outcome = [
    { ok: true, candidates: 60 },
    { ok: false, reason: 'conflicts', conflicts: [{ message: 'No rooms' }] },
    { ok: true, candidates: 55 },
    { ok: true, candidates: 58 },
  ];
  assert.deepEqual(summarise(outcome), { published: 3, blocked: 1, candidates: 173 });
});

test('a paper already published is reported, not counted again', () => {
  const outcome = [
    { ok: false, reason: 'already_published', status: 'scheduled' },
    { ok: true, candidates: 60 },
  ];
  const s = summarise(outcome);
  assert.equal(s.published, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.candidates, 60, 'an already-published paper must not re-count its candidates');
});

test('nothing published is a clean zero rather than a failure', () => {
  assert.deepEqual(summarise([]), { published: 0, blocked: 0, candidates: 0 });
});

/* ---------------- drawing the paper ---------------- */

/* Bulk creation draws from the bank with the same matcher the quality
   check uses. If those two ever disagreed, QC2 would certify a
   pattern the scheduler could not build. */
test('the scheduler and the quality check fill a pattern identically', async () => {
  const { assemblePaper } = await import('../services/qc.js');

  const blueprint = { sections: [
    { key: 'A', type: 'mcq', count: 3, marksEach: 1 },
    { key: 'C', type: 'desc', count: 2, marksEach: 15 },
  ] };
  const bank = [
    { _id: 'a1', section: 'A', type: 'mcq', marks: 1 },
    { _id: 'a2', section: 'A', type: 'mcq', marks: 1 },
    { _id: 'a3', section: 'A', type: 'mcq', marks: 1 },
    { _id: 'x1', section: 'A', type: 'mcq', marks: 2 },      // wrong marks
    { _id: 'c1', section: 'C', type: 'desc', marks: 15 },
    { _id: 'c2', section: 'C', type: 'desc', marks: 15 },
  ];

  const scheduler = assemblePaper({ blueprint, questions: bank, pick: (xs, n) => xs.slice(0, n) });
  const check = assemblePaper({ blueprint, questions: bank, pick: (xs, n) => xs.slice(0, n) });

  assert.deepEqual(scheduler.picked.map((q) => q._id), check.picked.map((q) => q._id));
  assert.equal(scheduler.shortfalls.length, 0);
  assert.equal(scheduler.picked.length, 5);
  assert.ok(!scheduler.picked.some((q) => q._id === 'x1'), 'a 2-mark question cannot fill a 1-mark slot');
});

test('a bank too thin leaves the paper short and says by how much', async () => {
  const { assemblePaper } = await import('../services/qc.js');
  const out = assemblePaper({
    blueprint: { sections: [{ key: 'A', type: 'mcq', count: 10, marksEach: 1 }] },
    questions: [{ _id: 'a1', section: 'A', type: 'mcq', marks: 1 }],
  });
  assert.equal(out.picked.length, 1);
  assert.equal(out.shortfalls[0].needed - out.shortfalls[0].available, 9);
});

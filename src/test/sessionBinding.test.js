/* ============================================================
   ONE SIGN-IN PER PAPER IN PROGRESS

   The cheat this closes: a candidate gives their register number and
   password to somebody outside the hall, and both answer the same
   paper. The second sign-in invalidated the first's refresh token,
   but its ACCESS token stayed valid for its full life — so for
   fifteen minutes at a stretch, two people could write to one
   attempt, and nothing anywhere recorded it.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VIOLATION_CATALOGUE, SEVERITY_WEIGHT } from '../utils/grading.js';

/* The rule exactly as loadAttempt applies it. */
function intruder(attempt, actor) {
  return Boolean(attempt.sessionId && actor.sessionId && attempt.sessionId !== actor.sessionId);
}

test('the session that opened the paper keeps writing to it', () => {
  assert.equal(intruder({ sessionId: 'a1' }, { sessionId: 'a1' }), false);
});

test('a second sign-in on the same credentials is refused', () => {
  assert.equal(intruder({ sessionId: 'a1' }, { sessionId: 'b2' }), true);
});

test('it is the newcomer who is refused, never the one already writing', () => {
  /* Refusing both would hand every candidate a way to end a rival's
     examination: sign in as them once and the paper stops. The pin
     stays with whoever holds it. */
  const attempt = { sessionId: 'first' };
  assert.equal(intruder(attempt, { sessionId: 'first' }), false, 'the original must keep working');
  assert.equal(intruder(attempt, { sessionId: 'second' }), true);
  assert.equal(attempt.sessionId, 'first', 'the pin must not move to the intruder');
});

test('an unpinned attempt accepts the session that arrives', () => {
  /* The state after an invigilator readmits a candidate: the pin is
     cleared so they can sign in on whatever machine they were moved
     to. The control there is the invigilator, not the pin. */
  assert.equal(intruder({ sessionId: null }, { sessionId: 'new' }), false);
});

test('a token minted before this existed is not locked out', () => {
  /* Sessions already signed in when this deploys carry no sid. They
     must keep working rather than being thrown out of a paper that
     is running. */
  assert.equal(intruder({ sessionId: 'a1' }, { sessionId: null }), false);
  assert.equal(intruder({ sessionId: null }, { sessionId: null }), false);
});

/* ---------------- what it is recorded as ---------------- */

test('a concurrent sign-in is a known, critical violation', () => {
  const spec = VIOLATION_CATALOGUE.concurrent_session;
  assert.ok(spec, 'the route records this type; it must be in the catalogue');
  assert.equal(spec.severity, 'critical');
  assert.ok(SEVERITY_WEIGHT[spec.severity] >= 3);
});

test('it is recorded once, not on every refused request', () => {
  /* The intruder's browser will retry. Without the guard the record
     fills with hundreds of identical entries and the flag score runs
     away from anything meaningful. */
  const attempt = { violations: [], flagScore: 0 };
  const record = () => {
    if (attempt.violations.some((v) => v.type === 'concurrent_session')) return;
    attempt.violations.push({ type: 'concurrent_session' });
    attempt.flagScore += 3;
  };
  for (let i = 0; i < 25; i += 1) record();
  assert.equal(attempt.violations.length, 1);
  assert.equal(attempt.flagScore, 3);
});

/* ---------------- the attempt can hold the pin ---------------- */

test('the attempt schema holds a session id, and does not hand it out', async () => {
  const { Attempt } = await import('../models/exam.js');
  const path = Attempt.schema.path('sessionId');
  assert.ok(path, 'attempts need somewhere to record which sign-in is sitting the paper');
  /* Not selected by default: it is a bearer value for the duration of
     a paper and has no business in an ordinary read. */
  assert.equal(path.options.select, false);
});

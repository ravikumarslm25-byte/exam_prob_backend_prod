/* ============================================================
   The audit net.

   An examination portal has to be able to answer "who changed this,
   and when" about any change at all — including changes made by a
   route that nobody remembered to instrument. These tests pin the two
   halves of that promise: what the automatic recorder decides to
   record, and what it refuses to copy into the log.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, shouldAutoAudit, entityFromPath, auditPath } from '../middleware/audit.js';

const staff = { id: 'u1', kind: 'staff', name: 'Dr Ananth', institutionId: 'i1' };
const req = (over = {}) => ({
  method: 'POST', originalUrl: '/api/exams/abc/publish', actor: staff, ...over,
});
const res = (status = 200) => ({ statusCode: status });

/* ---------------- what gets recorded ---------------- */

test('a staff mutation that recorded nothing itself is caught by the net', () => {
  assert.equal(shouldAutoAudit(req(), res()), true);
});

test('a route that described its own change is not recorded twice', () => {
  assert.equal(shouldAutoAudit(req({ _audited: true }), res()), false);
});

test('reads are not recorded', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(shouldAutoAudit(req({ method }), res()), false, method);
  }
});

test('a refused change is recorded, because an attempt is the point', () => {
  assert.equal(shouldAutoAudit(req(), res(403)), true);
  assert.equal(shouldAutoAudit(req(), res(422)), true);
});

test('a request that never reached a route is not recorded', () => {
  assert.equal(shouldAutoAudit(req(), res(404)), false);
});

test('candidate writes stay out of the log', () => {
  const student = { ...staff, kind: 'student' };
  assert.equal(shouldAutoAudit(req({ actor: student }), res()), false);
});

test('an unauthenticated request has nobody to attribute', () => {
  assert.equal(shouldAutoAudit(req({ actor: undefined }), res()), false);
});

test('token refresh and candidate uploads do not bury the log', () => {
  assert.equal(shouldAutoAudit(req({ originalUrl: '/api/auth/refresh' }), res()), false);
  assert.equal(shouldAutoAudit(req({ originalUrl: '/api/uploads/pass/xyz' }), res()), false);
});

/* ---------------- what never reaches the log ---------------- */

test('passwords never reach the audit collection', () => {
  const out = redact({ email: 'a@b.com', password: 'hunter2', newPassword: 'x', nested: { currentPassword: 'y' } });
  assert.equal(out.email, 'a@b.com');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.newPassword, '[redacted]');
  assert.equal(out.nested.currentPassword, '[redacted]');
});

test('tokens and cookies never reach the audit collection', () => {
  const out = redact({ accessToken: 'ey...', refreshTokenHash: 'abc', authorization: 'Bearer x' });
  assert.equal(out.accessToken, '[redacted]');
  assert.equal(out.refreshTokenHash, '[redacted]');
  assert.equal(out.authorization, '[redacted]');
});

test('a captured frame is noted, not copied', () => {
  const out = redact({ image: 'x'.repeat(4_000_000), scanPages: [1, 2, 3] });
  assert.match(out.image, /^\[4000000 chars\]$/);
  assert.equal(out.scanPages, '[3 item(s)]');
});

test('a data URL anywhere is reduced to its size', () => {
  const out = redact({ avatar: `data:image/png;base64,${'A'.repeat(50_000)}` });
  assert.match(out.avatar, /bytes\]$/);
  assert.ok(out.avatar.length < 60);
});

test('a long free-text field is truncated, not dropped', () => {
  const out = redact({ instructions: 'y'.repeat(900) });
  assert.ok(out.instructions.startsWith('yyy'));
  assert.match(out.instructions, /\[900 chars\]$/);
});

test('a long array keeps its head and says how much it dropped', () => {
  const out = redact({ rows: Array.from({ length: 60 }, (_, i) => i) });
  assert.equal(out.rows.length, 26);
  assert.equal(out.rows[25], '… 35 more');
});

test('a deeply nested object stops rather than recursing forever', () => {
  let deep = { end: true };
  for (let i = 0; i < 20; i += 1) deep = { down: deep };
  assert.doesNotThrow(() => redact(deep));
});

test('ordinary values pass through untouched', () => {
  assert.deepEqual(redact({ marks: 42, title: 'Unit test', ok: false, when: null }),
    { marks: 42, title: 'Unit test', ok: false, when: null });
});

/* ---------------- how a row is labelled ---------------- */

test('the log is grouped by route pattern, not by one exam id', () => {
  assert.equal(auditPath({ baseUrl: '/api/exams', route: { path: '/:id/publish' } }), '/api/exams/:id/publish');
  assert.equal(auditPath({ baseUrl: '/api/exams', route: { path: '/' } }), '/api/exams');
  assert.equal(auditPath({ originalUrl: '/api/exams/1?x=2' }), '/api/exams/1');
});

test('the entity is read off the path so the log can be filtered by it', () => {
  assert.equal(entityFromPath('/api/exams/:id/publish'), 'exam');
  assert.equal(entityFromPath('/api/qbank/:id'), 'qbank');
  assert.equal(entityFromPath('/api/settings'), 'setting');
});

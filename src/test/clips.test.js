/* ============================================================
   CLIPS OF FLAGGED MOMENTS

   A clip cannot travel with the flag that caused it: the seconds
   after the moment have not happened yet. So it arrives separately,
   up to half a minute later, and has to find its way back to the
   right flag. These are the rules that make that safe.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUpload, maxBytesFor, acceptedTypes } from '../services/storage.js';

test('a webm clip of a reasonable size is accepted', () => {
  assert.equal(validateUpload('clip', 'video/webm', 2_000_000), null);
});

test('an oversized clip is refused rather than stored', () => {
  /* The browser is asked for a bitrate that cannot produce this. One
     that arrives anyway ignored the request, and storing it at ten
     thousand candidates is how a disk fills overnight. */
  const err = validateUpload('clip', 'video/webm', maxBytesFor('clip') + 1);
  assert.ok(err, 'an oversized clip must be refused');
});

test('a clip must actually be video', () => {
  for (const mime of ['image/jpeg', 'application/pdf', 'text/html', 'audio/webm']) {
    assert.ok(validateUpload('clip', mime, 1000), `${mime} must not be stored as a clip`);
  }
});

test('the clip kind offers exactly the container the recorder produces', () => {
  /* The browser records webm. If this list and the recorder ever
     disagree, every clip is refused and the only sign is an empty
     evidence panel. */
  assert.deepEqual(acceptedTypes('clip'), ['video/webm']);
});

test('an unknown evidence kind is refused by name', () => {
  const err = validateUpload('video', 'video/webm', 1000);
  assert.ok(err && /unknown/i.test(err));
});

/* ---------------- the schema has somewhere to put it ---------------- */

test('a violation carries an id, so a late clip can find its own flag', async () => {
  const { Attempt } = await import('../models/exam.js');
  const path = Attempt.schema.path('violations');
  assert.ok(path, 'attempts must hold violations');

  const sub = path.schema;
  assert.ok(sub.path('_id'), 'violations need an _id for a clip to be attached to');
  assert.ok(sub.path('clipKey'), 'violations need somewhere to record the camera clip');
  assert.ok(sub.path('screenClipKey'), 'violations need somewhere to record the screen clip');
});

test('an attempt can mint a violation and address it by id', async () => {
  const { Attempt } = await import('../models/exam.js');
  const attempt = new Attempt({
    institutionId: '000000000000000000000001',
    examId: '000000000000000000000002',
    studentId: '000000000000000000000003',
  });
  const made = attempt.violations.create({ type: 'gaze_off_screen', severity: 'high', weight: 2 });
  attempt.violations.push(made);

  const found = attempt.violations.id(made._id);
  assert.ok(found, 'a violation must be findable by the id handed back to the browser');
  assert.equal(found.type, 'gaze_off_screen');

  found.clipKey = 'some/key.webm';
  assert.equal(attempt.violations.id(made._id).clipKey, 'some/key.webm');
});

test('the per-paper switches for screen capture and clips both exist', async () => {
  const { Exam } = await import('../models/exam.js');
  assert.ok(Exam.schema.path('proctoring.screenCapture'));
  assert.ok(Exam.schema.path('proctoring.flagClips'));
  /* Both default on: a paper that says nothing records everything. */
  assert.equal(Exam.schema.path('proctoring.flagClips').defaultValue, true);
  assert.equal(Exam.schema.path('proctoring.screenCapture').defaultValue, true);
});

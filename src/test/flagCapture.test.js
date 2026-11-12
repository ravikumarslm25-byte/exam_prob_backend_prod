/* ============================================================
   WHAT IS CAPTURED AT A FLAGGED MOMENT

   The periodic snapshot runs on its own clock and is not the subject
   here. These are about the extra capture taken at the instant a flag
   is raised, and about the screen-sharing events that are themselves
   flags.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VIOLATION_CATALOGUE, SEVERITY_WEIGHT } from '../utils/grading.js';

/* ---------------- the screen-sharing events ---------------- */

test('every screen-sharing event the browser can raise is in the catalogue', () => {
  /* The route refuses any type it does not recognise, so a hook
     raising one of these against a catalogue that lacks it would have
     its report rejected and the moment would go unrecorded. */
  for (const type of ['screen_share_refused', 'screen_share_stopped', 'screen_share_partial']) {
    assert.ok(VIOLATION_CATALOGUE[type], `${type} must be a known violation type`);
    assert.ok(VIOLATION_CATALOGUE[type].label, `${type} needs a label for the invigilator`);
  }
});

test('refusing or stopping the share outranks sharing only one window', () => {
  const weight = (t) => SEVERITY_WEIGHT[VIOLATION_CATALOGUE[t].severity];
  assert.ok(weight('screen_share_refused') > weight('screen_share_partial'));
  assert.ok(weight('screen_share_stopped') > weight('screen_share_partial'));
});

test('sharing one window is not treated as proof of cheating', () => {
  /* Some browsers offer no whole-screen option at all. A candidate on
     one of those must not be failed out of an examination for it. */
  const spec = VIOLATION_CATALOGUE.screen_share_partial;
  assert.notEqual(spec.severity, 'critical');
});

/* ---------------- every catalogue entry is usable ---------------- */

test('every violation type has a severity the weight table knows', () => {
  for (const [type, spec] of Object.entries(VIOLATION_CATALOGUE)) {
    assert.ok(spec.severity, `${type} has no severity`);
    assert.ok(
      SEVERITY_WEIGHT[spec.severity] !== undefined,
      `${type} has severity "${spec.severity}", which is not in SEVERITY_WEIGHT`,
    );
  }
});

test('every violation type has a label fit to show an invigilator', () => {
  for (const [type, spec] of Object.entries(VIOLATION_CATALOGUE)) {
    assert.ok(spec.label && spec.label.length > 3, `${type} has no usable label`);
    assert.ok(
      !/^[a-z_]+$/.test(spec.label),
      `${type}'s label "${spec.label}" is the raw key, not something a person should read`,
    );
  }
});

/* ---------------- the flags that previously carried no picture ----------------

   These are raised by the lockdown and audio hooks, neither of which
   has a camera. Until the capture moved into reportViolation they
   were recorded with no photograph and no screenshot at all — which
   is to say, the most serious events in the system produced the least
   evidence. There is nothing in the server to assert against for
   that, so this records WHICH types depend on it, so that a later
   change which routes one of them around reportViolation has
   something to fail against. */

test('the events raised away from the camera are known types', () => {
  const raisedWithoutACamera = [
    'tab_switch', 'fullscreen_exit', 'copy_paste', 'devtools',
    'multiple_displays', 'room_noise',
    'screen_share_refused', 'screen_share_stopped', 'screen_share_partial',
  ];
  for (const type of raisedWithoutACamera) {
    assert.ok(
      VIOLATION_CATALOGUE[type],
      `${type} is raised by a hook with no camera and must still be reportable`,
    );
  }
});

test('the serious lockdown events are rated at least as high as looking away', () => {
  const weight = (t) => SEVERITY_WEIGHT[VIOLATION_CATALOGUE[t].severity];
  for (const type of ['tab_switch', 'fullscreen_exit', 'devtools']) {
    assert.ok(
      weight(type) >= weight('looking_away'),
      `${type} should not rank below a candidate glancing away`,
    );
  }
});

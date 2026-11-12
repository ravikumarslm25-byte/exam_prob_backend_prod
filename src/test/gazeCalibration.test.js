/* ============================================================
   WHAT THE SERVER ACCEPTS AS A GAZE CALIBRATION

   The calibration is computed in the candidate's browser and posted
   here, so it is attacker-controlled input that sets the thresholds
   deciding whether that same candidate gets flagged. Everything
   below is a test of the server refusing to take it at face value.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitiseCalibration, calibrationAcceptable,
  GAZE_CEILING, GAZE_FLOOR, CENTRE_CEILING, MIN_CALIBRATION_POINTS,
} from '../utils/gaze.js';

/* ---------------- the obvious attack ---------------- */

test('a calibration claiming an enormous gaze range is cut back to the ceiling', () => {
  /* Unclamped, this switches eye tracking off for the attempt and
     leaves a clean proctoring record behind. */
  const { calibration, clamped } = sanitiseCalibration({
    h: 99, down: 99, up: 99, centreH: 0, centreV: 0, points: 5,
  });
  assert.equal(calibration.h, GAZE_CEILING.h);
  assert.equal(calibration.down, GAZE_CEILING.down);
  assert.equal(calibration.up, GAZE_CEILING.up);
  assert.equal(clamped, true, 'the attempt must record that this happened');
});

test('a negative limit cannot be used to smuggle in a huge range', () => {
  const { calibration } = sanitiseCalibration({ h: -99, down: -99, up: -99, points: 5 });
  assert.equal(calibration.h, GAZE_CEILING.h);
  assert.ok(calibration.down > 0);
  assert.ok(calibration.up > 0);
});

test('a centre far off to one side is pulled back', () => {
  /* The second attack: calibrate while looking at the phone, so the
     phone becomes the middle of the screen. */
  const { calibration, clamped } = sanitiseCalibration({
    h: 0.2, down: 0.2, up: 0.2, centreH: 0.9, centreV: -0.9, points: 5,
  });
  assert.equal(calibration.centreH, CENTRE_CEILING);
  assert.equal(calibration.centreV, -CENTRE_CEILING);
  assert.equal(clamped, true);
});

test('nonsense in place of numbers yields the floor, not a crash or a hole', () => {
  for (const junk of [{ h: 'wide' }, { h: null }, { h: NaN }, { h: Infinity }, {}, null]) {
    const { calibration, clamped } = sanitiseCalibration(junk);
    assert.equal(calibration.h, GAZE_FLOOR.h, `h from ${JSON.stringify(junk)}`);
    assert.equal(clamped, true);
  }
});

/* ---------------- the honest candidate ---------------- */

test('a plausible calibration passes through untouched', () => {
  const input = { h: 0.21, down: 0.16, up: 0.19, centreH: 0.02, centreV: -0.01, points: 5 };
  const { calibration, clamped } = sanitiseCalibration(input);
  assert.equal(clamped, false, 'an honest calibration must not be flagged as limited');
  assert.equal(calibration.h, 0.21);
  assert.equal(calibration.down, 0.16);
  assert.equal(calibration.up, 0.19);
  assert.equal(calibration.centreH, 0.02);
  assert.equal(calibration.centreV, -0.01);
});

test('a calibration tighter than the floor is widened, not accepted', () => {
  /* A hostile client may make its own life harder; it may not make an
     honest candidate's worse, and a too-tight limit would flag a
     candidate for reading their own screen. */
  const { calibration } = sanitiseCalibration({ h: 0.0001, down: 0.0001, up: 0.0001, points: 5 });
  assert.equal(calibration.h, GAZE_FLOOR.h);
  assert.equal(calibration.down, GAZE_FLOOR.down);
  assert.equal(calibration.up, GAZE_FLOOR.up);
});

test('the floor is never above the ceiling on any axis', () => {
  for (const k of ['h', 'down', 'up']) {
    assert.ok(GAZE_FLOOR[k] <= GAZE_CEILING[k], `${k}: floor ${GAZE_FLOOR[k]} > ceiling ${GAZE_CEILING[k]}`);
  }
});

/* ---------------- how many points are enough ---------------- */

test('fewer than three usable readings is not a calibration', () => {
  assert.equal(calibrationAcceptable(0), false);
  assert.equal(calibrationAcceptable(1), false);
  assert.equal(calibrationAcceptable(2), false);
  assert.equal(calibrationAcceptable(MIN_CALIBRATION_POINTS), true);
  assert.equal(calibrationAcceptable(5), true);
});

test('a missing or junk point count is not enough', () => {
  assert.equal(calibrationAcceptable(undefined), false);
  assert.equal(calibrationAcceptable('five'), false);
  assert.equal(calibrationAcceptable(NaN), false);
});

test('an absurd point count cannot be stored', () => {
  const { calibration } = sanitiseCalibration({ h: 0.2, down: 0.2, up: 0.2, points: 1e9 });
  assert.ok(calibration.points <= 20, `points stored as ${calibration.points}`);
});

/* ---------------- the catalogue entry exists ---------------- */

test('the out-of-range event is a known violation type, so the route can record it', async () => {
  const { VIOLATION_CATALOGUE } = await import('../utils/grading.js');
  assert.ok(VIOLATION_CATALOGUE.calibration_out_of_range, 'route pushes this type; it must be in the catalogue');
  assert.ok(VIOLATION_CATALOGUE.gaze_off_screen);
  assert.ok(VIOLATION_CATALOGUE.eyes_obscured);
});

test('eyes directed off screen is rated above a turned head', async () => {
  const { VIOLATION_CATALOGUE, SEVERITY_WEIGHT } = await import('../utils/grading.js');
  const gaze = SEVERITY_WEIGHT[VIOLATION_CATALOGUE.gaze_off_screen.severity];
  const head = SEVERITY_WEIGHT[VIOLATION_CATALOGUE.looking_away.severity];
  assert.ok(gaze > head, 'a phone on the desk is harder to do by accident than a turned head');
});

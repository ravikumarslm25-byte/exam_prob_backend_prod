/* ============================================================
   ACCEPTING A GAZE CALIBRATION FROM A CANDIDATE'S BROWSER

   The calibration is computed in the candidate's own browser, from
   their own camera, and then posted here. That makes it attacker-
   controlled input, and it controls the thresholds that decide
   whether they get flagged for looking away.

   The obvious attack is to post enormous limits. A calibration
   claiming the candidate's on-screen gaze range spans the entire
   visual field switches eye tracking off for that attempt, silently,
   and leaves a clean proctoring record behind. Nothing about the
   request would look wrong.

   So the server does not trust the numbers. It clamps them to a
   plausible human range and records when it had to, because a
   browser sending out-of-range calibration is itself worth knowing
   about — an honest client has no reason to.
   ============================================================ */

/* The widest a genuine calibration can be. Derived from the geometry
   rather than from taste: the iris can only travel so far across an
   eye before it reaches the corner, and these offsets are measured
   as a fraction of eye width. A reading past roughly a third of eye
   width is not a candidate glancing at the corner of their monitor,
   it is a candidate looking somewhere else entirely. */
export const GAZE_CEILING = { h: 0.35, down: 0.30, up: 0.35 };

/* The narrowest. A calibration tighter than this would flag a
   candidate for reading their own screen, so it is raised rather
   than accepted — a hostile client can make its own life harder,
   but it must not be allowed to make an honest candidate's worse. */
export const GAZE_FLOOR = { h: 0.13, down: 0.10, up: 0.14 };

/* Where the centre of a candidate's gaze may sit. A centre far from
   zero means the "neutral" position was recorded while they were
   looking well off to one side — which is the second way to defeat
   the check: calibrate with a phone in view and make the phone the
   new centre. */
export const CENTRE_CEILING = 0.12;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function clampOne(value, floor, ceiling) {
  const n = num(value);
  if (n === null) return { value: floor, clamped: true };
  const bounded = Math.min(ceiling, Math.max(floor, Math.abs(n)));
  return { value: bounded, clamped: bounded !== Math.abs(n) };
}

function clampCentre(value) {
  const n = num(value);
  if (n === null) return { value: 0, clamped: true };
  const bounded = Math.min(CENTRE_CEILING, Math.max(-CENTRE_CEILING, n));
  return { value: bounded, clamped: bounded !== n };
}

/* Returns what will be stored, plus whether the browser's numbers
   had to be brought back into range. */
export function sanitiseCalibration(input) {
  const h = clampOne(input?.h, GAZE_FLOOR.h, GAZE_CEILING.h);
  const down = clampOne(input?.down, GAZE_FLOOR.down, GAZE_CEILING.down);
  const up = clampOne(input?.up, GAZE_FLOOR.up, GAZE_CEILING.up);
  const centreH = clampCentre(input?.centreH);
  const centreV = clampCentre(input?.centreV);

  const points = Math.max(0, Math.min(20, Math.round(num(input?.points) ?? 0)));

  return {
    calibration: {
      h: h.value,
      down: down.value,
      up: up.value,
      centreH: centreH.value,
      centreV: centreV.value,
      points,
    },
    clamped: h.clamped || down.clamped || up.clamped || centreH.clamped || centreV.clamped,
  };
}

/* Five points asked for, at least three usable. Fewer than three
   cannot bound a range in two axes, and a calibration built from one
   or two readings is worse than none — it carries the authority of a
   measurement without being one. */
export const MIN_CALIBRATION_POINTS = 3;

export function calibrationAcceptable(points) {
  return Math.round(num(points) ?? 0) >= MIN_CALIBRATION_POINTS;
}

/* What goes back to the candidate's screen when the paper opens.

   An attempt with no usable calibration returns null rather than a
   half-filled object, because the screen's fallback is the wider
   default limits and a partial object would quietly become a set of
   thresholds nobody chose. */
export function gazeCalibrationFor(attempt) {
  const c = attempt?.gazeCalibration;
  if (!c || c.unavailable) return null;
  if (![c.h, c.down, c.up].every((v) => Number.isFinite(v))) return null;
  return {
    centreH: c.centreH ?? 0,
    centreV: c.centreV ?? 0,
    h: c.h,
    down: c.down,
    up: c.up,
    points: c.points ?? 0,
  };
}

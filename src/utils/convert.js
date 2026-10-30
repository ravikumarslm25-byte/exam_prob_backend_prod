/* ============================================================
   Mark conversion.

   A paper is written for one total and reported against another. A
   60-mark paper is submitted to the examination cell out of 80; a
   50-mark paper may go out of 80 as well. The conversion is linear
   and the pair is set per paper, because it changes between subjects
   and between internal and end-semester papers.

       scored / outOfPaper * outOfReport

   The examination cell then adds its own internal marks — held in
   their software, not in this one — and computes the final result.
   Nothing here decides pass or fail against the converted figure.

   This file is pure and has no imports on purpose: the same function
   runs on the server when a report is built and in the browser when
   the office previews a conversion, and the two must never disagree
   about a candidate's mark.
   ============================================================ */

export const ROUNDING = ['nearest', 'half', 'up', 'down', 'exact'];

/* 'nearest' — the default, and what an examination cell expects:
      whole marks, a half rounded up. 29.5 becomes 30.
   'half'    — keeps half marks. 29.75 becomes 30, 29.4 becomes 29.5.
   'up'/'down' — always toward the ceiling or the floor.
   'exact'   — two decimal places, for an office that does its own
      rounding downstream and does not want ours applied first. */
export function applyRounding(value, rounding = 'nearest') {
  if (!Number.isFinite(value)) return null;
  switch (rounding) {
    case 'up':    return Math.ceil(value);
    case 'down':  return Math.floor(value);
    case 'half':  return Math.round(value * 2) / 2;
    case 'exact': return Math.round(value * 100) / 100;
    case 'nearest':
    default:
      /* Math.round already takes .5 upward for positive numbers, and a
         mark is never negative. Written out so the intent is on the
         page rather than inferred from the language. */
      return Math.floor(value + 0.5);
  }
}

/* A mark, or null when there is no figure at all.

   Number('') and Number(null) are both 0, and 0 is a real mark. Left
   to the usual Number().isFinite() check, an unevaluated script and
   an absentee would both be reported as having scored zero — a wrong
   mark on a transcript rather than a blank one. Everything that reads
   a mark goes through here. */
export function asMark(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* Returns the converted mark, or null when there is nothing to
   convert — an unevaluated script, an absentee, a paper with no
   total. null means "no figure", never zero: a zero reported for an
   absentee is a wrong mark, not a missing one. */
export function convertMark(scored, outOfPaper, outOfReport, rounding = 'nearest') {
  const got = asMark(scored);
  const from = Number(outOfPaper);
  const to = Number(outOfReport);

  if (got === null) return null;
  if (!Number.isFinite(from) || from <= 0) return null;
  if (!Number.isFinite(to) || to <= 0) return null;

  const raw = (got / from) * to;
  const out = applyRounding(raw, rounding);

  /* Rounding up at the very top can push a full mark past the
     reported total — 59.6 out of 60 becomes 79.47, which is fine, but
     'up' on a perfect script would read 81 out of 80. */
  if (out == null) return null;
  return Math.min(Math.max(out, 0), to);
}

/* The conversion as written on a report header: "60 → 80". */
export function conversionLabel(conv, paperTotal) {
  if (!conv?.enabled) return null;
  const to = Number(conv.outOf);
  if (!Number.isFinite(to) || to <= 0) return null;
  return `${paperTotal} → ${to}`;
}

/* Reads the setting off a paper and applies it. Papers with
   conversion switched off report their own total unchanged, so a
   report can call this for every row without branching. */
export function reportedMark(scored, exam) {
  const conv = exam?.conversion;
  if (!conv?.enabled) {
    return { mark: asMark(scored), outOf: exam?.totalMarks ?? null, converted: false };
  }
  return {
    mark: convertMark(scored, exam.totalMarks, conv.outOf, conv.rounding),
    outOf: Number(conv.outOf),
    converted: true,
  };
}

/* A worked example for the screen where the conversion is set, so
   whoever sets it sees what it does to a real mark before saving.
   Deliberately shows the boundaries and the middle. */
export function conversionPreview(outOfPaper, outOfReport, rounding = 'nearest') {
  const from = Number(outOfPaper);
  if (!Number.isFinite(from) || from <= 0) return [];
  const points = [...new Set([
    0,
    Math.round(from * 0.35),
    Math.round(from * 0.5),
    Math.round(from * 0.75),
    from,
  ])].filter((n) => n >= 0 && n <= from).sort((a, b) => a - b);

  return points.map((scored) => ({
    scored,
    converted: convertMark(scored, from, outOfReport, rounding),
  }));
}

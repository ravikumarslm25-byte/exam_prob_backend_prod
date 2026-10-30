/* ============================================================
   Mark conversion.

   This number leaves the product. It is typed into the examination
   cell's own software, added to an internal mark held there, and
   becomes part of a published result. A rounding mistake here is a
   wrong mark on a transcript, and nothing downstream would catch it.

   The worked case the client gave is the first test: 30 out of 60,
   reported out of 80, is 40.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  convertMark, applyRounding, reportedMark, conversionLabel, conversionPreview, ROUNDING,
} from '../utils/convert.js';

/* ---------------- the case the client stated ---------------- */

test('30 out of 60 is reported as 40 out of 80', () => {
  assert.equal(convertMark(30, 60, 80), 40);
});

test('the same paper converts across its whole range', () => {
  assert.equal(convertMark(0, 60, 80), 0);
  assert.equal(convertMark(15, 60, 80), 20);
  assert.equal(convertMark(45, 60, 80), 60);
  assert.equal(convertMark(60, 60, 80), 80);
});

test('50 out of 80 works as well, because the pair is per paper', () => {
  assert.equal(convertMark(25, 50, 80), 40);
  assert.equal(convertMark(50, 50, 80), 80);
  assert.equal(convertMark(0, 50, 80), 0);
});

test('converting downward is just as valid as upward', () => {
  assert.equal(convertMark(80, 100, 50), 40);
  assert.equal(convertMark(100, 100, 50), 50);
});

/* ---------------- rounding ---------------- */

test('a half mark rounds up by default, as an examination cell expects', () => {
  // 37 of 60 out of 80 = 49.33 -> 49;  38 of 60 = 50.67 -> 51
  assert.equal(convertMark(37, 60, 80), 49);
  assert.equal(convertMark(38, 60, 80), 51);
  // exactly .5
  assert.equal(applyRounding(29.5, 'nearest'), 30);
  assert.equal(applyRounding(30.5, 'nearest'), 31);
});

test('each rounding mode does what it says', () => {
  assert.equal(applyRounding(29.4, 'up'), 30);
  assert.equal(applyRounding(29.6, 'down'), 29);
  assert.equal(applyRounding(29.4, 'half'), 29.5);
  assert.equal(applyRounding(29.1, 'half'), 29);
  assert.equal(applyRounding(29.456, 'exact'), 29.46);
});

test('every advertised rounding mode is implemented', () => {
  for (const mode of ROUNDING) {
    assert.equal(typeof applyRounding(12.34, mode), 'number', mode);
  }
});

test('rounding up can never push a mark past the reported total', () => {
  assert.equal(convertMark(60, 60, 80, 'up'), 80);
  assert.equal(convertMark(59, 60, 80, 'up'), 79);
});

test('a converted mark is never negative', () => {
  assert.equal(convertMark(0, 60, 80, 'down'), 0);
});

/* ---------------- nothing to convert ---------------- */

test('an unevaluated script converts to nothing, not to zero', () => {
  assert.equal(convertMark(null, 60, 80), null);
  assert.equal(convertMark(undefined, 60, 80), null);
  assert.equal(convertMark('', 60, 80), null);
  assert.equal(convertMark(NaN, 60, 80), null);
});

test('a paper with no usable total converts to nothing', () => {
  assert.equal(convertMark(30, 0, 80), null);
  assert.equal(convertMark(30, -5, 80), null);
  assert.equal(convertMark(30, 60, 0), null);
  assert.equal(convertMark(30, 60, null), null);
});

test('zero marks scored is a real zero, not a missing figure', () => {
  assert.equal(convertMark(0, 60, 80), 0);
});

/* ---------------- reading the setting off a paper ---------------- */

test('a paper with conversion off reports its own total unchanged', () => {
  const exam = { totalMarks: 60, conversion: { enabled: false, outOf: 80 } };
  assert.deepEqual(reportedMark(45, exam), { mark: 45, outOf: 60, converted: false });
});

test('a paper with conversion on reports the converted figure', () => {
  const exam = { totalMarks: 60, conversion: { enabled: true, outOf: 80, rounding: 'nearest' } };
  assert.deepEqual(reportedMark(30, exam), { mark: 40, outOf: 80, converted: true });
});

test('an absentee stays absent through conversion', () => {
  const exam = { totalMarks: 60, conversion: { enabled: true, outOf: 80 } };
  assert.equal(reportedMark(null, exam).mark, null);
  assert.equal(reportedMark(null, { totalMarks: 60 }).mark, null);
});

test('the header label states the conversion plainly', () => {
  assert.equal(conversionLabel({ enabled: true, outOf: 80 }, 60), '60 → 80');
  assert.equal(conversionLabel({ enabled: false, outOf: 80 }, 60), null);
  assert.equal(conversionLabel({ enabled: true, outOf: 0 }, 60), null);
  assert.equal(conversionLabel(undefined, 60), null);
});

/* ---------------- the preview shown while setting it ---------------- */

test('the preview covers both ends and the middle', () => {
  const rows = conversionPreview(60, 80);
  assert.equal(rows[0].scored, 0);
  assert.equal(rows[0].converted, 0);
  assert.equal(rows[rows.length - 1].scored, 60);
  assert.equal(rows[rows.length - 1].converted, 80);
  assert.ok(rows.length >= 4);
});

test('the preview of a nonsense total is empty rather than wrong', () => {
  assert.deepEqual(conversionPreview(0, 80), []);
  assert.deepEqual(conversionPreview(null, 80), []);
});

/* ---------------- the two copies must not drift ---------------- */

test('the API and the browser hold the same conversion, byte for byte', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const webPath = new URL('../../../web/src/lib/convert.js', import.meta.url);
  if (!existsSync(webPath)) return;        // API checked out on its own

  assert.equal(
    readFileSync(new URL('../utils/convert.js', import.meta.url), 'utf8'),
    readFileSync(webPath, 'utf8'),
    'server/src/utils/convert.js and web/src/lib/convert.js have diverged — change both',
  );
});

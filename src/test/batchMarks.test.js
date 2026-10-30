/* ============================================================
   THE BATCH MARK STATEMENT

   The shape the examination cell asked for is not a filter, it is a
   layout: one heading row, then every candidate for the first
   subject, then every candidate for the second, down the sheet.

   The thing that must never go wrong is the absentee. A zero is a
   mark that was earned. Typed into the cell's own system the two are
   indistinguishable, and one of them is a wrong result on somebody's
   transcript.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

/* The row-building rule, as the builder applies it. */
function markCell({ sat, evaluated, scored }) {
  if (!sat) return 'AB';
  if (!evaluated) return '';
  return scored;
}

test('an absentee is AB, never a zero', () => {
  assert.equal(markCell({ sat: false, evaluated: false, scored: null }), 'AB');
  assert.notEqual(markCell({ sat: false, evaluated: false, scored: null }), 0);
});

test('a candidate who scored nothing is a real zero, not AB', () => {
  assert.equal(markCell({ sat: true, evaluated: true, scored: 0 }), 0);
});

test('a script still to be evaluated is blank, not zero and not AB', () => {
  /* Blank is the only honest value: the candidate sat the paper, so
     AB is wrong, and nobody has marked it, so a figure is wrong. */
  assert.equal(markCell({ sat: true, evaluated: false, scored: null }), '');
});

test('a marked script carries its mark', () => {
  assert.equal(markCell({ sat: true, evaluated: true, scored: 37 }), 37);
});

/* ---------------- the layout ---------------- */

/* Rows are grouped by paper in the order sat, and numbered
   continuously down the whole statement. */
function buildRows(exams, attemptsByExam) {
  const order = [...exams].sort((a, b) => (
    a.date === b.date ? a.code.localeCompare(b.code) : a.date.localeCompare(b.date)
  ));
  const rows = [];
  for (const exam of order) {
    const forThis = [...(attemptsByExam[exam.code] || [])]
      .sort((x, y) => String(x.regNo).localeCompare(String(y.regNo), undefined, { numeric: true }));
    for (const a of forThis) rows.push({ sno: rows.length + 1, subjectCode: exam.code, regNo: a.regNo });
  }
  return rows;
}

const exams = [
  { code: 'MBA1102', date: '2026-11-19' },
  { code: 'MBA1101', date: '2026-11-18' },
];
const attempts = {
  MBA1101: [{ regNo: '10' }, { regNo: '2' }, { regNo: '1' }],
  MBA1102: [{ regNo: '2' }, { regNo: '1' }, { regNo: '10' }],
};

test('every candidate for one subject comes before the next subject begins', () => {
  const codes = buildRows(exams, attempts).map((r) => r.subjectCode);
  assert.deepEqual(codes, ['MBA1101', 'MBA1101', 'MBA1101', 'MBA1102', 'MBA1102', 'MBA1102']);
});

test('subjects appear in the order they were sat', () => {
  const first = buildRows(exams, attempts)[0];
  assert.equal(first.subjectCode, 'MBA1101', 'the paper sat on the 18th comes first');
});

test('register numbers sort the way a person reads them, not as text', () => {
  /* Plain string sorting puts "10" before "2", which looks like a
     mistake to whoever is checking the sheet against a roll. */
  const regNos = buildRows(exams, attempts).slice(0, 3).map((r) => r.regNo);
  assert.deepEqual(regNos, ['1', '2', '10']);
});

test('the serial number runs down the whole statement, not per subject', () => {
  const snos = buildRows(exams, attempts).map((r) => r.sno);
  assert.deepEqual(snos, [1, 2, 3, 4, 5, 6]);
});

test('the statement is empty rather than wrong when nothing matches', () => {
  assert.deepEqual(buildRows([], {}), []);
});

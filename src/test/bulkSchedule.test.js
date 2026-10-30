/* ============================================================
   BULK SCHEDULING

   The client's words were that this "should not make any mistakes"
   and "should be very perfect". That is a reasonable thing to ask of
   a scheduler and an unreasonable thing to ask of a model, which is
   why none of this is one. Every rule below is a rule, and every one
   of them is pinned here.

   The failure that matters most is the quiet one: a clash the system
   did not notice, which nobody discovers until two hundred
   candidates are sitting in the wrong hall.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyse, readDate, readTime, readNumber, similarity, matchOne, overlaps,
  patternTotal, planRooms, pickStaff, rowIsReady, toMinutes, minutesToTime, normalise,
  dice, CONFIDENT,
} from '../services/bulkSchedule.js';

/* ---------------- reading a sheet that has been round three laptops ---------------- */

test('a date is read however Excel mangled it', () => {
  assert.equal(readDate('2026-11-18'), '2026-11-18');
  assert.equal(readDate('18/11/2026'), '2026-11-18', 'day first, as an Indian office writes it');
  assert.equal(readDate('18-11-2026'), '2026-11-18');
  assert.equal(readDate(new Date(2026, 10, 18)), '2026-11-18');
  assert.equal(readDate(46344), '2026-11-18', 'an Excel serial number');
});

test('nonsense in a date cell is refused rather than guessed at', () => {
  assert.equal(readDate('next Tuesday'), null);
  assert.equal(readDate(''), null);
  assert.equal(readDate(null), null);
});

test('a time is read however it was typed', () => {
  assert.equal(readTime('14:00'), '14:00');
  assert.equal(readTime('9:00'), '09:00');
  assert.equal(readTime('09:00:00'), '09:00');
  assert.equal(readTime('2:00 PM'), '14:00');
  assert.equal(readTime('2 pm'), '14:00');
  assert.equal(readTime('12:00 AM'), '00:00');
  assert.equal(readTime(0.5), '12:00', 'an Excel time fraction');
});

test('an impossible time is refused', () => {
  assert.equal(readTime('25:00'), null);
  assert.equal(readTime('half past nine'), null);
});

test('a number with stray spacing or a comma still reads', () => {
  assert.equal(readNumber('1,000'), 1000);
  assert.equal(readNumber(' 90 '), 90);
  assert.equal(readNumber(''), null);
  assert.equal(readNumber('abc'), null);
});

/* ---------------- matching, which is the only fuzzy part ---------------- */

test('an exact code match wins outright', () => {
  const subjects = [
    { id: '1', code: 'MBA1101', title: 'Organizational Behavior' },
    { id: '2', code: 'MBA1102', title: 'Managerial Economics' },
  ];
  const r = matchOne('MBA1102', subjects, { keys: ['code'], label: (s) => `${s.code} ${s.title}` });
  assert.equal(r.match.id, '2');
  assert.equal(r.exact, true);
  assert.equal(r.score, 1);
});

test('a British spelling still finds the American one', () => {
  /* The commonest real mistake in a Sathyabama sheet, and the one
     token comparison alone is completely blind to: "Organisational
     Behaviour" shares not a single word with "Organizational
     Behavior". */
  const subjects = [
    { id: '1', code: 'MBA1101', title: 'Organizational Behavior' },
    { id: '2', code: 'MBA1102', title: 'Managerial Economics' },
  ];
  const r = matchOne('Organisational Behaviour', subjects,
    { keys: ['code'], label: (s) => `${s.code} ${s.title}` });
  assert.equal(r.match?.id, '1');
  assert.ok(r.score >= CONFIDENT, `scored ${r.score}`);
});

test('a near-spelling does not drag an unrelated subject in with it', () => {
  const subjects = [{ id: '1', code: 'MBA1101', title: 'Organizational Behavior' }];
  const r = matchOne('Fluid Mechanics', subjects, { keys: ['code'], label: (s) => s.title });
  assert.equal(r.match, null, `scored ${r.score}`);
});

test('character similarity sees two spellings of one word', () => {
  /* Measured, not guessed: 0.85 and 0.80 against 0.29 for two
     unrelated words. The gap between them is what makes the
     confidence floor meaningful. */
  assert.ok(dice('organisational', 'organizational') >= 0.84);
  assert.ok(dice('behaviour', 'behavior') >= 0.80);
  assert.ok(dice('economics', 'thermodynamics') < 0.30);
});

test('a match nobody could be confident of is not made', () => {
  const subjects = [{ id: '1', code: 'MBA1101', title: 'Organizational Behavior' }];
  const r = matchOne('Thermodynamics', subjects, { keys: ['code'], label: (s) => s.title });
  assert.equal(r.match, null, 'an unrelated name must not be matched to something');
});

test('similarity is symmetric and bounded', () => {
  assert.equal(similarity('a b c', 'a b c'), 1);
  assert.equal(similarity('', 'x'), 0);
  assert.ok(similarity('managerial economics', 'economics managerial') > 0.9);
  assert.ok(similarity('x', 'y') <= 1);
});

test('normalising ignores punctuation and case', () => {
  assert.equal(normalise('MBA-1101 (A)'), 'mba 1101 a');
});

/* ---------------- overlap, which is what a clash is ---------------- */

const slot = (date, startTime, durationMinutes) => ({ date, startTime, durationMinutes });

test('two papers at the same hour on the same day clash', () => {
  assert.ok(overlaps(slot('2026-11-18', '10:00', 90), slot('2026-11-18', '10:30', 90)));
  assert.ok(overlaps(slot('2026-11-18', '10:00', 90), slot('2026-11-18', '09:30', 90)));
});

test('papers back to back do not clash', () => {
  /* 10:00–11:30 and 11:30–13:00 is a tight day, not a double booking. */
  assert.ok(!overlaps(slot('2026-11-18', '10:00', 90), slot('2026-11-18', '11:30', 90)));
});

test('the same hour on different days does not clash', () => {
  assert.ok(!overlaps(slot('2026-11-18', '10:00', 90), slot('2026-11-19', '10:00', 90)));
});

test('a paper wholly inside another clashes', () => {
  assert.ok(overlaps(slot('2026-11-18', '09:00', 180), slot('2026-11-18', '10:00', 30)));
});

test('time arithmetic round trips', () => {
  assert.equal(toMinutes('14:30'), 870);
  assert.equal(minutesToTime(870), '14:30');
});

/* ---------------- the pattern adds up ---------------- */

test('a pattern totals what the examination will actually mark', () => {
  assert.equal(patternTotal([
    { key: 'A', type: 'mcq', count: 10, marksEach: 1 },
    { key: 'B', type: 'fib', count: 5, marksEach: 2 },
    { key: 'C', type: 'desc', count: 4, marksEach: 15, answerCount: 2 },
  ]), 10 + 10 + 30);
});

test('an either-or part counts one question of each pair', () => {
  assert.equal(patternTotal([
    { key: 'C', type: 'desc', count: 6, marksEach: 20, choiceMode: 'either_or' },
  ]), 60);
});

/* ---------------- the whole analysis ---------------- */

const context = () => ({
  departments: [{ id: 'd1', code: 'MBA', name: 'Management Studies' }],
  batches: [
    { id: 'b1', departmentId: 'd1', programme: 'MBA', year: 1, section: 'A',
      academicYear: '2026-27', semester: 1, label: 'I Year MBA — Section A' },
    { id: 'b2', departmentId: 'd1', programme: 'MBA', year: 1, section: 'B',
      academicYear: '2026-27', semester: 1, label: 'I Year MBA — Section B' },
  ],
  subjects: [
    { id: 's1', code: 'MBA1101', title: 'Organizational Behavior', semester: 1 },
    { id: 's2', code: 'MBA1102', title: 'Managerial Economics', semester: 1 },
    { id: 's3', code: 'MBA2201', title: 'Operations Research', semester: 3 },
  ],
  staff: [
    { id: 'u1', name: 'R Saravanan', email: 'r.saravanan@sathyabama.ac.in' },
    { id: 'u2', name: 'K Priya', email: 'k.priya@sathyabama.ac.in' },
  ],
  existingExams: [],
  students: new Map([['b1', 60], ['b2', 55]]),
  settings: { dayStart: '08:00', dayEnd: '18:00' },
});

const patterns = () => new Map([['INT-50', { sections: [
  { key: 'A', type: 'mcq', count: 10, marksEach: 1 },
  { key: 'B', type: 'fib', count: 5, marksEach: 2 },
  { key: 'C', type: 'desc', count: 4, marksEach: 15, answerCount: 2 },
] }]]);

const row = (over = {}) => ({
  date: '2026-11-18', startTime: '10:00', durationMinutes: 90,
  departmentCode: 'MBA', programme: 'MBA', year: 1, section: 'A', academicYear: '2026-27',
  subjectCode: 'MBA1101', subjectTitle: 'Organizational Behavior',
  examType: 'internal', pattern: 'INT-50', totalMarks: 50, passMark: 20,
  ...over,
});

test('a clean row resolves with nothing to report', () => {
  const { rows, summary } = analyse({ rows: [row()], patterns: patterns(), context: context() });
  assert.deepEqual(rows[0].issues, [], JSON.stringify(rows[0].issues));
  assert.ok(rowIsReady(rows[0]));
  assert.equal(summary.ready, 1);
  assert.equal(summary.blocked, 0);
  assert.equal(rows[0].resolved.subject.code, 'MBA1101');
  assert.equal(rows[0].resolved.batch.label, 'I Year MBA — Section A');
});

test('the same class cannot sit two papers at once', () => {
  const { rows, summary } = analyse({
    rows: [row(), row({ subjectCode: 'MBA1102', startTime: '10:30' })],
    patterns: patterns(), context: context(),
  });
  assert.ok(rows[1].issues.some((i) => i.code === 'BATCH_CLASH'), JSON.stringify(rows[1].issues));
  assert.equal(summary.blocked, 1);
  assert.ok(!rowIsReady(rows[1]));
});

test('two sections of the same year may sit at the same time', () => {
  const { summary } = analyse({
    rows: [row(), row({ section: 'B' })],
    patterns: patterns(), context: context(),
  });
  assert.equal(summary.blocked, 0, 'different classes in different halls do not clash');
});

test('the same paper entered twice is reported as a duplicate', () => {
  const { rows } = analyse({ rows: [row(), row()], patterns: patterns(), context: context() });
  assert.ok(rows[1].issues.some((i) => i.code === 'DUPLICATE_ROW'));
});

test('a clash against a paper already in the calendar is caught', () => {
  const ctx = context();
  ctx.existingExams = [{ code: 'MBA1109', date: '2026-11-18', startTime: '10:00',
    durationMinutes: 120, batchIds: ['b1'] }];
  const { rows } = analyse({ rows: [row()], patterns: patterns(), context: ctx });
  assert.ok(rows[0].issues.some((i) => i.code === 'BATCH_CLASH_EXISTING'));
});

test('one invigilator cannot be in two halls at once', () => {
  const { rows } = analyse({
    rows: [
      row({ invigilatorEmail: 'r.saravanan@sathyabama.ac.in' }),
      row({ section: 'B', invigilatorEmail: 'r.saravanan@sathyabama.ac.in' }),
    ],
    patterns: patterns(), context: context(),
  });
  assert.ok(rows[1].issues.some((i) => i.code === 'INVIGILATOR_CLASH'));
});

test('a pattern that does not add up to the stated total is refused', () => {
  const { rows } = analyse({ rows: [row({ totalMarks: 60 })], patterns: patterns(), context: context() });
  const found = rows[0].issues.find((i) => i.code === 'PATTERN_TOTAL');
  assert.ok(found);
  assert.match(found.message, /adds up to 50 marks but this row says 60/);
});

test('a pattern the sheet never defined is refused', () => {
  const { rows } = analyse({ rows: [row({ pattern: 'END-999' })], patterns: patterns(), context: context() });
  assert.ok(rows[0].issues.some((i) => i.code === 'PATTERN_MISSING'));
});

test('a pass mark of zero is refused, not quietly accepted', () => {
  const { rows } = analyse({ rows: [row({ passMark: 0 })], patterns: patterns(), context: context() });
  assert.ok(rows[0].issues.some((i) => i.code === 'PASS_MARK'));
});

test('a pass mark nobody can reach is refused', () => {
  const { rows } = analyse({ rows: [row({ passMark: 60 })], patterns: patterns(), context: context() });
  assert.ok(rows[0].issues.some((i) => i.code === 'PASS_MARK'));
});

test('an unknown subject blocks the row rather than guessing', () => {
  const { rows } = analyse({ rows: [row({ subjectCode: 'ZZZ9999', subjectTitle: 'Astrology' })],
    patterns: patterns(), context: context() });
  assert.ok(rows[0].issues.some((i) => i.code === 'UNKNOWN_SUBJECT'));
});

test('a subject from the wrong semester is flagged but not blocked', () => {
  const { rows } = analyse({ rows: [row({ subjectCode: 'MBA2201' })],
    patterns: patterns(), context: context() });
  const found = rows[0].issues.find((i) => i.code === 'SUBJECT_SEMESTER');
  assert.ok(found);
  assert.equal(found.severity, 'warning');
  assert.ok(rowIsReady(rows[0]), 'a warning must not block the row');
});

test('a paper running past the end of the day is flagged', () => {
  const { rows } = analyse({ rows: [row({ startTime: '17:00', durationMinutes: 180 })],
    patterns: patterns(), context: context() });
  assert.ok(rows[0].issues.some((i) => i.code === 'OUTSIDE_HOURS'));
});

test('a Sunday is flagged but not refused', () => {
  /* 22 November 2026 is a Sunday. */
  const { rows } = analyse({ rows: [row({ date: '2026-11-22' })],
    patterns: patterns(), context: context() });
  const found = rows[0].issues.find((i) => i.code === 'SUNDAY');
  assert.ok(found);
  assert.equal(found.severity, 'warning');
});

test('a class with nobody on its roll is flagged', () => {
  const ctx = context();
  ctx.students = new Map([['b2', 55]]);
  const { rows } = analyse({ rows: [row()], patterns: patterns(), context: ctx });
  assert.ok(rows[0].issues.some((i) => i.code === 'NO_STUDENTS'));
});

test('a bank too thin for the pattern is flagged before the paper is created', () => {
  const ctx = context();
  ctx.bankCounts = new Map([['s1', new Map([['A:mcq:1', 4], ['B:fib:2', 5], ['C:desc:15', 4]])]]);
  const { rows } = analyse({ rows: [row()], patterns: patterns(), context: ctx });
  const found = rows[0].issues.find((i) => i.code === 'BANK_SHORT');
  assert.ok(found);
  assert.match(found.message, /needs 10 approved MCQ question\(s\) worth 1; the bank holds 4/);
});

test('an unreadable date blocks the row and names the cell', () => {
  const { rows } = analyse({ rows: [row({ date: 'next Tuesday' })],
    patterns: patterns(), context: context() });
  const found = rows[0].issues.find((i) => i.code === 'BAD_DATE');
  assert.ok(found);
  assert.equal(found.field, 'date');
  assert.equal(found.severity, 'error');
});

test('a row with several problems reports all of them, not the first', () => {
  const { rows } = analyse({
    rows: [row({ date: 'rubbish', passMark: 0, pattern: 'NOPE' })],
    patterns: patterns(), context: context(),
  });
  const codes = rows[0].issues.map((i) => i.code);
  assert.ok(codes.includes('BAD_DATE'));
  assert.ok(codes.includes('PASS_MARK'));
  assert.ok(codes.includes('PATTERN_MISSING'));
});

test('one bad row does not stop the good ones', () => {
  const { summary } = analyse({
    rows: [row(), row({ date: 'rubbish', section: 'B' })],
    patterns: patterns(), context: context(),
  });
  assert.equal(summary.ready, 1);
  assert.equal(summary.blocked, 1);
});

/* ---------------- rooms and staff ---------------- */

test('a class is split into even rooms rather than one full and one nearly empty', () => {
  const rooms = planRooms({ studentCount: 72, capacity: 30 });
  assert.equal(rooms.length, 3);
  assert.deepEqual(rooms.map((r) => r.seats), [24, 24, 24]);
});

test('a class that fits in one room gets one room', () => {
  assert.equal(planRooms({ studentCount: 28, capacity: 30 }).length, 1);
});

test('a class of exactly one capacity gets one room, not two', () => {
  assert.equal(planRooms({ studentCount: 30, capacity: 30 }).length, 1);
});

test('the least loaded free person is chosen', () => {
  const candidates = [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }];
  const chosen = pickStaff({
    candidates,
    slot: slot('2026-11-18', '10:00', 90),
    busyBy: new Map(),
    loadBy: new Map([['u1', 3], ['u2', 1]]),
  });
  assert.equal(chosen.id, 'u2');
});

test('somebody already booked at that hour is not chosen', () => {
  const chosen = pickStaff({
    candidates: [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }],
    slot: slot('2026-11-18', '10:00', 90),
    busyBy: new Map([['u2', [slot('2026-11-18', '10:30', 60)]]]),
    loadBy: new Map([['u1', 9], ['u2', 0]]),
  });
  assert.equal(chosen.id, 'u1', 'a free but busier person beats a free-looking but booked one');
});

test('nobody free yields nobody, rather than a double booking', () => {
  const chosen = pickStaff({
    candidates: [{ id: 'u1', name: 'A' }],
    slot: slot('2026-11-18', '10:00', 90),
    busyBy: new Map([['u1', [slot('2026-11-18', '10:00', 90)]]]),
    loadBy: new Map(),
  });
  assert.equal(chosen, null);
});

test('the same sheet assigns the same people twice over', () => {
  /* An office re-uploading a corrected sheet expects to see their
     correction change and nothing else. */
  const args = {
    candidates: [{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }],
    slot: slot('2026-11-18', '10:00', 90),
    busyBy: new Map(),
    loadBy: new Map([['u1', 2], ['u2', 2]]),
  };
  assert.equal(pickStaff(args).id, pickStaff(args).id);
});

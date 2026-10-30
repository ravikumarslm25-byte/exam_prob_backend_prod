/* ============================================================
   BULK EXAMINATION SCHEDULING

   Fifty subjects across a dozen classes, entered one paper at a time,
   is a week of work and a near certainty of at least one clash. The
   office uploads a spreadsheet instead.

   The client asked for this to be "ultra smart" and suggested machine
   learning. It is deliberately not. Every decision here is a rule
   that can be stated, replayed and argued with:

     a clash is an overlap of two intervals, not a probability;
     an invigilator is free or they are not;
     a paper either adds up to its stated marks or it does not.

   A model could do none of those three things reliably, could not
   explain itself to an examination cell, and would be wrong
   occasionally in ways nobody could predict — against a requirement
   that it must never be wrong. Where judgement genuinely helps is in
   READING the sheet: "Organisational Behaviour" matching MBA1101,
   "MBA 1st Yr A" matching a batch. That is fuzzy matching, it is
   scored, and anything uncertain is put in front of a human in the
   preview rather than acted on.

   Nothing here touches the database. It takes what the sheet said and
   what the institution holds, and returns what would happen.
   ============================================================ */

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

/* Every issue this engine can raise, with its severity and the words
   the examination cell reads. An ERROR blocks creation of that row; a
   WARNING is shown and can be accepted. */
export const ISSUES = {
  MISSING_FIELD:        { severity: 'error' },
  BAD_DATE:             { severity: 'error' },
  BAD_TIME:             { severity: 'error' },
  BAD_NUMBER:           { severity: 'error' },
  UNKNOWN_DEPARTMENT:   { severity: 'error' },
  UNKNOWN_BATCH:        { severity: 'error' },
  UNKNOWN_SUBJECT:      { severity: 'error' },
  UNKNOWN_STAFF:        { severity: 'warning' },
  PATTERN_MISSING:      { severity: 'error' },
  PATTERN_TOTAL:        { severity: 'error' },
  PASS_MARK:            { severity: 'error' },
  DUPLICATE_ROW:        { severity: 'error' },
  BATCH_CLASH:          { severity: 'error' },
  BATCH_CLASH_EXISTING: { severity: 'error' },
  INVIGILATOR_CLASH:    { severity: 'error' },
  EVALUATOR_LOAD:       { severity: 'warning' },
  SUBJECT_SEMESTER:     { severity: 'warning' },
  BANK_SHORT:           { severity: 'warning' },
  OUTSIDE_HOURS:        { severity: 'warning' },
  SUNDAY:               { severity: 'warning' },
  NO_STUDENTS:          { severity: 'warning' },
};

const issue = (code, message, field) => ({
  code, message, field, severity: ISSUES[code]?.severity || 'error',
});

/* ---------------- reading what the sheet said ---------------- */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* Excel mangles dates and times whatever the column format says, and
   a sheet that has been through three people's laptops arrives with
   all of these. Each is read back to the written form the product
   stores, rather than refused. */
export function readDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v).trim();
  if (DATE_RE.test(s)) return s;

  // 18/11/2026 and 18-11-2026, day first, as every Indian office writes it
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;

  // an Excel serial that arrived as a bare number
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return null;
}

export function readTime(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
  }
  const s = String(v).trim();
  if (TIME_RE.test(s)) return s;

  // 9:00, 09:00:00
  const hm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hm && Number(hm[1]) < 24) return `${pad(hm[1])}:${hm[2]}`;

  // 2:00 PM
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3].toLowerCase() === 'p') h += 12;
    return `${pad(h)}:${ampm[2] || '00'}`;
  }

  // an Excel time fraction: 0.5 is noon
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0 && n < 1) {
    const mins = Math.round(n * 24 * 60);
    return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

export function readNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* ---------------- matching what the sheet meant ----------------

   The only place judgement is applied, and it is applied to READING,
   never to deciding. A match below the confidence floor is not used;
   it is offered in the preview for a person to confirm. */

export function normalise(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Character bigrams, for comparing two spellings of one word.
   "organisational" against "organizational" shares every bigram but
   two, which token comparison cannot see at all — they are simply
   two different tokens. */
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

export function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a); const B = bigrams(b);
  let shared = 0; let total = 0;
  for (const [, n] of A) total += n;
  for (const [, n] of B) total += n;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) || 0);
  return total ? (2 * shared) / total : 0;
}

/* Similarity on 0..1, from three signals, because a real sheet goes
   wrong in three different ways.

   Token overlap catches extra or missing words — "Organizational
   Behavior" against "Organizational Behavior and Managerial
   Practice".

   Containment catches a code inside a label — "MBA1101" inside
   "MBA1101 Organizational Behavior".

   Per-token character similarity catches a different SPELLING of the
   same word, which is the common case here and which the other two
   are blind to: a staff member typing "Organisational Behaviour"
   against a bank that says "Organizational Behavior" shares not one
   token with it. */
export function similarity(a, b) {
  const x = normalise(a); const y = normalise(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const xs = new Set(x.split(' '));
  const ys = new Set(y.split(' '));
  let shared = 0;
  for (const t of xs) if (ys.has(t)) shared += 1;
  const union = new Set([...xs, ...ys]).size;
  const jaccard = union ? shared / union : 0;

  const contains = x.includes(y) || y.includes(x) ? 0.35 : 0;

  /* Every token of the shorter side matched to its best counterpart
     on the longer side, then averaged. Scored from the shorter side
     so that extra words on the stored label — a subject title that
     carries its code — do not drag an otherwise exact match down. */
  const [short, long] = xs.size <= ys.size ? [[...xs], [...ys]] : [[...ys], [...xs]];
  const perToken = short.length
    ? short.reduce((sum, t) => sum + Math.max(...long.map((u) => dice(t, u))), 0) / short.length
    : 0;

  return Math.min(1, Math.max(jaccard + contains, perToken));
}

export const CONFIDENT = 0.72;

/* Finds the one record the sheet meant. An exact key match wins
   outright; otherwise the best scoring candidate is returned WITH its
   score, so the caller can decide whether a person needs to confirm
   it. */
export function matchOne(wanted, candidates, { keys = [], label = (c) => c.label || '' } = {}) {
  if (!wanted) return { match: null, score: 0, exact: false };

  const want = normalise(wanted);
  for (const c of candidates) {
    for (const k of keys) {
      if (normalise(c[k]) === want && want) return { match: c, score: 1, exact: true };
    }
  }

  let best = null; let bestScore = 0;
  for (const c of candidates) {
    const score = Math.max(
      similarity(wanted, label(c)),
      ...keys.map((k) => similarity(wanted, c[k])),
    );
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return { match: bestScore >= CONFIDENT ? best : null, score: bestScore, exact: false, nearest: best };
}

/* ---------------- time ---------------- */

export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/* Two papers clash when their intervals overlap at all. Touching ends
   do not clash: a paper finishing at 12:00 and another starting at
   12:00 are back to back, which is a tight day, not a double booking. */
export function overlaps(a, b) {
  if (a.date !== b.date) return false;
  const aStart = toMinutes(a.startTime);
  const bStart = toMinutes(b.startTime);
  return aStart < bStart + b.durationMinutes && bStart < aStart + a.durationMinutes;
}

export const endOf = (row) => toMinutes(row.startTime) + row.durationMinutes;

/* ---------------- the pattern ---------------- */

/* What a pattern's sections add up to, reading the choice rule the
   same way the examination does: a best-of section is worth what is
   COUNTED, not what is set, and an either/or section counts half its
   questions because the candidate answers one of each pair. */
export function patternTotal(sections = []) {
  return sections.reduce((sum, s) => {
    const count = Number(s.count) || 0;
    const counted = s.choiceMode === 'either_or'
      ? Math.ceil(count / 2)
      : (s.type === 'desc' ? (Number(s.answerCount) || count) : count);
    return sum + counted * (Number(s.marksEach) || 0);
  }, 0);
}

/* ---------------- the analysis ---------------- */

/*  rows      what the Schedule sheet said, already read into fields
    patterns  Map of pattern name -> { sections: [...] }
    context   what the institution holds:
                departments, batches, subjects, staff,
                existingExams  (date, startTime, durationMinutes, batchIds)
                existingRooms  (invigilatorId, startAt, endAt)  — optional
                bankCounts     Map subjectId -> { 'A:mcq:1': 12, ... }
                students       Map batchId -> count
                settings       { dayStart, dayEnd }
*/
export function analyse({ rows, patterns, context }) {
  const out = rows.map((raw, index) => resolveRow(raw, index, patterns, context));

  /* Clashes are between rows, so they are found once every row has
     been read rather than while reading one. */
  detectClashes(out, context);

  return {
    rows: out,
    summary: summarise(out),
  };
}

function resolveRow(raw, index, patterns, context) {
  const issues = [];
  const add = (code, message, field) => issues.push(issue(code, message, field));

  const date = readDate(raw.date);
  const startTime = readTime(raw.startTime);
  const durationMinutes = readNumber(raw.durationMinutes);
  const totalMarks = readNumber(raw.totalMarks);
  const passMark = readNumber(raw.passMark);

  if (!date) add('BAD_DATE', `"${raw.date ?? ''}" is not a date the system can read. Write it as 2026-11-18.`, 'date');
  if (!startTime) add('BAD_TIME', `"${raw.startTime ?? ''}" is not a time. Write it as 14:00 on a 24 hour clock.`, 'startTime');
  if (!durationMinutes || durationMinutes < 10) add('BAD_NUMBER', 'Duration must be at least 10 minutes.', 'durationMinutes');
  if (!totalMarks || totalMarks < 1) add('BAD_NUMBER', 'Total marks must be above zero.', 'totalMarks');

  /* Nought is the value a cleared cell arrives as, and a pass mark of
     nought passes everybody while reading as configured. */
  if (passMark == null || passMark <= 0) {
    add('PASS_MARK', 'Pass mark must be above zero.', 'passMark');
  } else if (totalMarks && passMark > totalMarks) {
    add('PASS_MARK', `A pass mark of ${passMark} is above the paper's total of ${totalMarks}.`, 'passMark');
  }

  /* ---- the class ---- */
  const dept = matchOne(raw.departmentCode, context.departments || [],
    { keys: ['code', 'name'], label: (d) => `${d.code} ${d.name}` });
  if (!dept.match) {
    add('UNKNOWN_DEPARTMENT', `No department matches "${raw.departmentCode ?? ''}".`, 'departmentCode');
  }

  const batchPool = (context.batches || []).filter((b) => (
    !dept.match || String(b.departmentId) === String(dept.match.id)
  ));
  const wantedBatch = [raw.programme, raw.year, raw.section, raw.academicYear]
    .filter((x) => x != null && x !== '').join(' ');
  const batch = matchOne(wantedBatch, batchPool, {
    keys: ['label'],
    label: (b) => `${b.programme} ${b.year} ${b.section} ${b.academicYear} ${b.label}`,
  });
  if (!batch.match) {
    add('UNKNOWN_BATCH', `No class matches "${wantedBatch}".`, 'programme');
  } else if (!(context.students instanceof Map) || !context.students.get(String(batch.match.id))) {
    add('NO_STUDENTS', `${batch.match.label} has no students on its roll, so nobody would sit this paper.`, 'programme');
  }

  /* ---- the subject ---- */
  const subject = matchOne(raw.subjectCode || raw.subjectTitle, context.subjects || [], {
    keys: ['code'],
    label: (s) => `${s.code} ${s.title}`,
  });
  if (!subject.match) {
    add('UNKNOWN_SUBJECT', `No subject matches "${raw.subjectCode ?? raw.subjectTitle ?? ''}".`, 'subjectCode');
  } else if (batch.match && subject.match.semester
             && Number(subject.match.semester) !== Number(batch.match.semester)) {
    add('SUBJECT_SEMESTER',
      `${subject.match.code} is a semester ${subject.match.semester} subject and `
      + `${batch.match.label} is in semester ${batch.match.semester}.`, 'subjectCode');
  }

  /* ---- the pattern ---- */
  const pattern = patterns.get(String(raw.pattern || '').trim())
    || patterns.get(normalise(raw.pattern));
  if (!raw.pattern) {
    add('MISSING_FIELD', 'No pattern named. Write the name of a row on the Patterns sheet.', 'pattern');
  } else if (!pattern) {
    add('PATTERN_MISSING', `The Patterns sheet has no pattern called "${raw.pattern}".`, 'pattern');
  } else if (totalMarks) {
    const built = patternTotal(pattern.sections);
    if (built !== totalMarks) {
      add('PATTERN_TOTAL',
        `Pattern ${raw.pattern} adds up to ${built} marks but this row says ${totalMarks}.`, 'pattern');
    }
  }

  /* ---- the bank ---- */
  if (pattern && subject.match && context.bankCounts instanceof Map) {
    const held = context.bankCounts.get(String(subject.match.id)) || new Map();
    for (const s of pattern.sections || []) {
      const key = `${s.key}:${s.type}:${s.marksEach}`;
      const have = held.get ? (held.get(key) || 0) : (held[key] || 0);
      if (have < (Number(s.count) || 0)) {
        add('BANK_SHORT',
          `Part ${s.key} needs ${s.count} approved ${String(s.type).toUpperCase()} question(s) worth `
          + `${s.marksEach}; the bank holds ${have}.`, 'pattern');
      }
    }
  }

  /* ---- named staff ---- */
  const invigilator = raw.invigilatorEmail
    ? matchOne(raw.invigilatorEmail, context.staff || [], { keys: ['email'], label: (u) => `${u.name} ${u.email}` })
    : { match: null, score: 0 };
  if (raw.invigilatorEmail && !invigilator.match) {
    add('UNKNOWN_STAFF', `No staff member has the address "${raw.invigilatorEmail}". One will be assigned automatically.`, 'invigilatorEmail');
  }

  const evaluator = raw.evaluatorEmail
    ? matchOne(raw.evaluatorEmail, context.staff || [], { keys: ['email'], label: (u) => `${u.name} ${u.email}` })
    : { match: null, score: 0 };
  if (raw.evaluatorEmail && !evaluator.match) {
    add('UNKNOWN_STAFF', `No staff member has the address "${raw.evaluatorEmail}". One will be assigned automatically.`, 'evaluatorEmail');
  }

  /* ---- the calendar ---- */
  if (date && startTime && durationMinutes) {
    const settings = context.settings || {};
    const dayStart = toMinutes(settings.dayStart || '08:00');
    const dayEnd = toMinutes(settings.dayEnd || '18:00');
    const start = toMinutes(startTime);
    if (start < dayStart || start + durationMinutes > dayEnd) {
      add('OUTSIDE_HOURS',
        `This paper runs ${startTime}–${minutesToTime(start + durationMinutes)}, outside the `
        + `working day (${settings.dayStart || '08:00'}–${settings.dayEnd || '18:00'}).`, 'startTime');
    }
    if (new Date(`${date}T00:00:00`).getDay() === 0) {
      add('SUNDAY', 'This date is a Sunday.', 'date');
    }
  }

  return {
    index,
    raw,
    date, startTime, durationMinutes, totalMarks, passMark,
    examType: ['internal', 'model', 'end_semester'].includes(String(raw.examType))
      ? raw.examType : 'internal',
    title: raw.subjectTitle || subject.match?.title || '',
    resolved: {
      department: dept.match, departmentScore: dept.score,
      batch: batch.match, batchScore: batch.score, batchNearest: batch.nearest,
      subject: subject.match, subjectScore: subject.score, subjectNearest: subject.nearest,
      pattern: pattern || null, patternName: raw.pattern || null,
      invigilator: invigilator.match,
      evaluator: evaluator.match,
      roomCapacity: readNumber(raw.roomCapacity) || null,
    },
    /* A match the engine made but is not certain of. Shown in the
       preview for a person to confirm rather than acted on quietly. */
    uncertain: [
      batch.match && !batch.exact && batch.score < 0.95
        ? { field: 'programme', chose: batch.match.label, score: round2(batch.score) } : null,
      subject.match && !subject.exact && subject.score < 0.95
        ? { field: 'subjectCode', chose: `${subject.match.code} — ${subject.match.title}`, score: round2(subject.score) } : null,
    ].filter(Boolean),
    issues,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
export const minutesToTime = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

/* ---------------- clashes ---------------- */

function detectClashes(rows, context) {
  const usable = rows.filter((r) => r.date && r.startTime && r.durationMinutes);

  /* Two rows for the same class at the same time. */
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i]; const b = usable[j];
      const sameBatch = a.resolved.batch && b.resolved.batch
        && String(a.resolved.batch.id) === String(b.resolved.batch.id);
      if (!sameBatch || !overlaps(a, b)) continue;

      const identical = a.resolved.subject && b.resolved.subject
        && String(a.resolved.subject.id) === String(b.resolved.subject.id)
        && a.startTime === b.startTime;

      const code = identical ? 'DUPLICATE_ROW' : 'BATCH_CLASH';
      const msg = identical
        ? `This row is the same paper, class and time as row ${a.index + 1}.`
        : `${b.resolved.batch.label} is already sitting ${a.resolved.subject?.code || 'another paper'} `
          + `from ${a.startTime} on ${a.date} (row ${a.index + 1}).`;
      b.issues.push(issue(code, msg, 'date'));
    }
  }

  /* An invigilator named twice in one slot. Automatic assignment
     avoids this by construction; a named one has to be checked. */
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i]; const b = usable[j];
      const same = a.resolved.invigilator && b.resolved.invigilator
        && String(a.resolved.invigilator.id) === String(b.resolved.invigilator.id);
      if (same && overlaps(a, b)) {
        b.issues.push(issue('INVIGILATOR_CLASH',
          `${b.resolved.invigilator.name} is already invigilating row ${a.index + 1} at this time.`,
          'invigilatorEmail'));
      }
    }
  }

  /* And against what is already in the calendar. */
  for (const row of usable) {
    if (!row.resolved.batch) continue;
    for (const ex of context.existingExams || []) {
      const sameBatch = (ex.batchIds || []).some((b) => String(b) === String(row.resolved.batch.id));
      if (!sameBatch) continue;
      if (!overlaps(row, ex)) continue;
      row.issues.push(issue('BATCH_CLASH_EXISTING',
        `${row.resolved.batch.label} already has ${ex.code || 'a paper'} scheduled at `
        + `${ex.startTime} on ${ex.date}.`, 'date'));
    }
  }
}

function summarise(rows) {
  const errors = rows.filter((r) => r.issues.some((i) => i.severity === 'error'));
  const warnings = rows.filter((r) => !r.issues.some((i) => i.severity === 'error')
    && r.issues.some((i) => i.severity === 'warning'));
  const byCode = {};
  for (const r of rows) for (const i of r.issues) byCode[i.code] = (byCode[i.code] || 0) + 1;

  return {
    total: rows.length,
    ready: rows.length - errors.length,
    blocked: errors.length,
    withWarnings: warnings.length,
    uncertain: rows.filter((r) => r.uncertain.length).length,
    byCode,
  };
}

export const rowIsReady = (row) => !row.issues.some((i) => i.severity === 'error');

/* ============================================================
   ASSIGNING ROOMS AND STAFF

   Deterministic and explainable, which is the whole argument against
   a model here: every assignment can be read back as a sentence —
   this person, because they are mapped to the subject, were free at
   that hour, and had the lightest load of those who were.
   ============================================================ */

/* Rooms are whole-number divisions of the roll. A class of 72 at a
   capacity of 30 is three rooms of 24, not two of 30 and one of 12:
   an even split is easier to invigilate and leaves room for a
   candidate moved mid-examination. */
export function planRooms({ studentCount, capacity }) {
  const cap = Math.max(1, Number(capacity) || 30);
  const n = Math.max(1, Math.ceil(studentCount / cap));
  const per = Math.ceil(studentCount / n);
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    capacity: cap,
    seats: i === n - 1 ? studentCount - per * (n - 1) : per,
  }));
}

/* Picks the least-loaded free person. `busy` is a list of intervals
   per staff id; `load` is how many duties they already carry.

   Ties break on the identifier rather than at random, so running the
   same schedule twice produces the same allocation — which matters
   when an office re-uploads a corrected sheet and expects to see only
   their correction change. */
export function pickStaff({ candidates, slot, busyBy, loadBy }) {
  const free = candidates.filter((c) => {
    const busy = busyBy.get(String(c.id)) || [];
    return !busy.some((b) => overlaps(slot, b));
  });
  if (!free.length) return null;

  return [...free].sort((a, b) => {
    const la = loadBy.get(String(a.id)) || 0;
    const lb = loadBy.get(String(b.id)) || 0;
    if (la !== lb) return la - lb;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

/* Why that person, in words an examination cell can read back. */
export function explainAssignment(person, { reason, load }) {
  if (!person) return 'Nobody was free at that hour.';
  return `${person.name} — ${reason}, free at that hour, `
    + `${load} other dut${load === 1 ? 'y' : 'ies'} that week.`;
}

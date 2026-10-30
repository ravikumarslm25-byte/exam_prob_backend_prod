/* ============================================================
   Mail rendering.

   The send path needs a mail server and a database, so it is not
   covered here. What is covered is everything that can go wrong
   silently: an apostrophe in a candidate's name breaking the markup,
   a template drifting away from the fields its callers pass, and the
   plain-text alternative coming out empty — which is what sends a
   message to spam.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

import { render, esc, toText, layout, TEMPLATES, classifyFailure } from '../services/mail.js';

const notice = {
  studentName: "D'Souza, Mary", subjectTitle: 'Organizational Behavior', subjectCode: 'MBA1101',
  examTitle: 'Internal Assessment I', date: '2026-11-18', dateLong: 'Wednesday, 18 November 2026',
  reportingTime: '09:45', startTime: '10:00', durationMinutes: 90, totalMarks: 50,
  room: 'MBA1101-A-R1', portalUrl: 'https://exam.sathyabama.ac.in/',
};

const ack = {
  studentName: 'Arun Kumar', subjectTitle: 'Managerial Economics', subjectCode: 'MBA1102',
  examTitle: 'Internal Assessment I', date: '2026-11-19', regNo: '41720104031',
  submittedAt: '19 Nov 2026, 11:28', answered: 18, totalQuestions: 19,
  sheetPages: 4, reference: 'AP-7K3M9Q',
};

const qc = {
  staffName: 'Dr Ananth', stage: 'qc1', stageBlurb: 'Please check every question in this upload.',
  subjectTitle: 'Organizational Behavior', subjectCode: 'MBA1101', batchLabel: 'I Year MBA — Section A',
  questionCount: 40, requestedBy: 'Examination cell',
  link: 'https://exam.sathyabama.ac.in/qc/abc123',
};

/* ---------------- escaping ---------------- */

test('a name with an apostrophe cannot break the markup', () => {
  const { html } = render('exam_notice', notice);
  assert.ok(!html.includes("D'Souza"), 'the raw apostrophe should be escaped');
  assert.ok(html.includes('D&#39;Souza'));
});

test('angle brackets in supplied values are escaped, not rendered', () => {
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  const { html } = render('submission_ack', { ...ack, studentName: '<b>x</b>' });
  assert.ok(!html.includes('<b>x</b>'));
});

test('a link is escaped in both the button and the fallback line', () => {
  const { html } = render('qc_invite', { ...qc, link: 'https://x.test/a?b=1&c=2' });
  assert.ok(!/href="[^"]*&c=/.test(html) || html.includes('&amp;c=2'));
  assert.ok(html.includes('&amp;c=2'));
});

/* ---------------- every template renders ---------------- */

test('every template produces a subject, html and a plain-text part', () => {
  const cases = { exam_notice: notice, submission_ack: ack, qc_invite: qc };
  for (const [name, data] of Object.entries(cases)) {
    const out = render(name, data);
    assert.ok(out.subject && out.subject.length > 5, `${name} subject`);
    assert.ok(out.html.startsWith('<!doctype html>'), `${name} html`);
    assert.ok(out.text.length > 60, `${name} text`);
    assert.ok(!out.text.includes('<'), `${name} text should carry no markup`);
  }
});

test('every template in the catalogue is covered by a test above', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['exam_notice', 'qc_invite', 'submission_ack']);
});

test('an unknown template is a loud failure, not a blank message', () => {
  assert.throws(() => render('no_such_template', {}), /Unknown mail template/);
});

/* ---------------- what each one must say ---------------- */

test('the notice carries the details a candidate needs to turn up', () => {
  const { html, subject } = render('exam_notice', notice);
  assert.match(subject, /Organizational Behavior/);
  for (const must of ['MBA1101', '18 November 2026', '10:00', '90 minutes', 'MBA1101-A-R1']) {
    assert.ok(html.includes(must), `missing ${must}`);
  }
});

test('the acknowledgement is a receipt and promises no marks', () => {
  const { html } = render('submission_ack', ack);
  assert.ok(html.includes('41720104031'));
  assert.ok(html.includes('18 of 19'));
  assert.ok(html.includes('AP-7K3M9Q'));
  assert.match(html, /Marks are not published through this portal/);
});

test('the acknowledgement omits the sheet line when nothing was uploaded', () => {
  const { html } = render('submission_ack', { ...ack, sheetPages: 0 });
  assert.ok(!html.includes('Answer sheet pages received'));
});

test('the QC invitation says plainly that nothing is being monitored', () => {
  const { html } = render('qc_invite', qc);
  assert.ok(html.includes('https://exam.sathyabama.ac.in/qc/abc123'));
  assert.match(html, /Nothing is monitored/);
});

/* ---------------- the plain-text alternative ---------------- */

test('plain text keeps the words and drops the markup', () => {
  const text = toText('<p>Hello <b>there</b></p><br><p>Second &amp; last</p>');
  assert.match(text, /Hello there/);
  assert.match(text, /Second & last/);
  assert.ok(!text.includes('<'));
});

test('a layout with no rows and no button still renders', () => {
  const html = layout({ title: 'T', intro: 'Body text here.' });
  assert.ok(html.includes('Body text here.'));
  assert.ok(!html.includes('undefined'));
});

/* ---------------- the submission reference ---------------- */

test('the submission reference is short, stable and quotable', async () => {
  const { submissionReference } = await import('../services/finalise.js');
  const id = '6711f0a9c3d4e5f607182930';
  assert.equal(submissionReference(id), submissionReference(id), 'must be stable');
  assert.match(submissionReference(id), /^AP-[0-9A-F]{8}$/);
  assert.notEqual(submissionReference(id), submissionReference('6711f0a9c3d4e5f607182931'));
});

/* ============================================================
   WHY A MESSAGE FAILED

   This decision costs something in both directions, which is why it
   is a rule rather than a retry count.

   Treat a dead mailbox as temporary and it is retried on every
   examination for the rest of the year, burying the real failures.

   Treat a full mailbox or a server hiccup as permanent and a
   candidate is quietly suppressed and never hears about their own
   examination again.
   ============================================================ */

const smtp = (responseCode, response) => ({ responseCode, response, message: response });

test('a mailbox that does not exist is permanent', () => {
  const { kind } = classifyFailure(smtp(550, '550 5.1.1 User unknown'));
  assert.equal(kind, 'hard');
});

test('an address the server rejects outright is permanent', () => {
  assert.equal(classifyFailure(smtp(550, '550 Requested action not taken: recipient rejected')).kind, 'hard');
  assert.equal(classifyFailure(smtp(553, '553 Invalid recipient')).kind, 'hard');
});

test('a full mailbox is temporary, even though the code is 5xx', () => {
  /* The one 5xx that is about the moment rather than the address.
     Suppressing on it loses a candidate who was over quota that
     morning and fine by the afternoon. */
  const out = classifyFailure(smtp(552, '552 5.2.2 Mailbox is full'));
  assert.equal(out.kind, 'soft');
  assert.match(out.reason, /full/i);
});

test('being greylisted or rate limited is temporary', () => {
  assert.equal(classifyFailure(smtp(421, '421 Too many connections')).kind, 'soft');
  assert.equal(classifyFailure(smtp(450, '450 4.2.0 Greylisted, try again')).kind, 'soft');
});

test('a connection that never reached a mail server is temporary', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'ENOTFOUND']) {
    assert.equal(classifyFailure({ code }).kind, 'soft', code);
  }
});

test('being blocked as spam is permanent, and says so', () => {
  const out = classifyFailure(smtp(554, '554 5.7.1 Message blocked by policy'));
  assert.equal(out.kind, 'hard');
  assert.match(out.reason, /Refused by the receiving server/);
});

test('a failure nobody recognises is retried rather than given up on', () => {
  /* Giving up on something we do not understand is worse than
     trying it again. */
  assert.equal(classifyFailure(new Error('something went wrong')).kind, 'soft');
  assert.equal(classifyFailure({}).kind, 'soft');
  assert.equal(classifyFailure(null).kind, 'soft');
});

test('every verdict carries a reason a person can read', () => {
  for (const e of [smtp(550, 'User unknown'), smtp(421, 'Busy'), { code: 'ETIMEDOUT' }, {}]) {
    const out = classifyFailure(e);
    assert.ok(out.reason && out.reason.length > 3, JSON.stringify(out));
    assert.ok(['hard', 'soft'].includes(out.kind));
  }
});

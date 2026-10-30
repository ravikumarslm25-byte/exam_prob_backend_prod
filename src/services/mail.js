import { env, mailConfigured, isProd } from '../config/env.js';
import { MailMessage, MailSuppression } from '../models/mail.js';

/* ============================================================
   Outgoing mail.

   Three rules this module exists to enforce:

     1. Nothing waits on a mail server. Callers queue; a worker sends.
     2. Nothing is sent twice. A send is attempted from exactly one
        worker tick, claimed with a conditional update.
     3. Nothing is lost quietly. Every message has a row and a status,
        and a failure says why.

   Without SMTP configured the queue still works end to end and the
   worker logs each message instead of sending it, so the whole flow —
   notify, acknowledge, QC invite — is demonstrable on a laptop with
   no credentials at all.
   ============================================================ */

let transportPromise = null;

/* nodemailer is imported lazily so a deployment that never sends mail
   does not pay for it at boot, and so the test run does not need it. */
async function transport() {
  if (!mailConfigured()) return null;
  if (!transportPromise) {
    transportPromise = (async () => {
      const { default: nodemailer } = await import('nodemailer');
      return nodemailer.createTransport({
        host: env.smtp.host,
        port: env.smtp.port,
        secure: env.smtp.secure,
        auth: { user: env.smtp.user, pass: env.smtp.pass },
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
      });
    })().catch((e) => {
      console.error('[mail] transport could not be created:', e.message);
      transportPromise = null;
      return null;
    });
  }
  return transportPromise;
}

/* ---------------- templates ----------------
   Table layout and inline styles on purpose: Outlook and most Indian
   webmail clients still drop a stylesheet, and a candidate reading
   this on a phone must not get an unstyled wall of text. */

const BRAND = '#0b2545';

export function layout({ title, intro, rows = [], note, action }) {
  const rowHtml = rows.map(([k, v]) => `
      <tr>
        <td style="padding:7px 0;color:#5b6472;font-size:13px;width:42%;vertical-align:top">${esc(k)}</td>
        <td style="padding:7px 0;color:#101828;font-size:13px;font-weight:600">${esc(v)}</td>
      </tr>`).join('');

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f8">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;
                    font-family:Arial,Helvetica,sans-serif">
        <tr><td style="background:${BRAND};padding:18px 24px">
          <div style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:.2px">${esc(title)}</div>
          <div style="color:#aebcd0;font-size:12px;margin-top:2px">Office of the Controller of Examinations</div>
        </td></tr>
        <tr><td style="padding:22px 24px">
          <p style="margin:0 0 16px;color:#101828;font-size:14px;line-height:1.55">${intro}</p>
          ${rows.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
            style="border-top:1px solid #e6e9ef;border-bottom:1px solid #e6e9ef;margin:4px 0 16px">
            ${rowHtml}
          </table>` : ''}
          ${action ? `<p style="margin:0 0 18px">
            <a href="${esc(action.href)}"
               style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;
                      padding:11px 20px;border-radius:6px;font-size:14px;font-weight:600">${esc(action.label)}</a>
          </p>
          <p style="margin:0 0 16px;color:#5b6472;font-size:12px;line-height:1.5">
            If the button does not work, copy this address into your browser:<br>
            <span style="color:#0b2545;word-break:break-all">${esc(action.href)}</span>
          </p>` : ''}
          ${note ? `<p style="margin:0;color:#5b6472;font-size:12.5px;line-height:1.55">${note}</p>` : ''}
        </td></tr>
        <tr><td style="padding:14px 24px;background:#fafbfc;border-top:1px solid #e6e9ef">
          <div style="color:#8a94a6;font-size:11.5px;line-height:1.5">
            This message was sent automatically by ExamProbe. Please do not reply to it.
            For help, contact your examination cell.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function toText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const TEMPLATES = {
  /* Sent when an examination is scheduled and the office presses
     Notify. Deliberately does not carry a sign-in link with a token in
     it — candidates sign in the ordinary way. */
  exam_notice: (d) => ({
    subject: `Examination scheduled — ${d.subjectTitle} (${d.date})`,
    html: layout({
      title: 'Examination scheduled',
      intro: `Dear ${esc(d.studentName)},<br><br>An examination has been scheduled for your class. `
           + 'The details are below. Please sign in a few minutes early and make sure your camera '
           + 'and microphone are working.',
      rows: [
        ['Subject', `${d.subjectTitle} (${d.subjectCode})`],
        ['Paper', d.examTitle],
        ['Date', d.dateLong],
        ['Reporting time', d.reportingTime],
        ['Starts', d.startTime],
        ['Duration', `${d.durationMinutes} minutes`],
        ['Total marks', String(d.totalMarks)],
        ...(d.room ? [['Room', d.room]] : []),
      ],
      action: d.portalUrl ? { label: 'Open my examinations', href: d.portalUrl } : null,
      note: 'Keep your register number and password to yourself. You will be asked to verify your '
          + 'identity before the paper begins.',
    }),
  }),

  /* Sent the moment a paper is submitted. This is the candidate's
     receipt and the single most common support question the cell
     gets — "did my paper go through?" */
  submission_ack: (d) => ({
    subject: `Received — ${d.subjectTitle} (${d.date})`,
    html: layout({
      title: 'Your paper has been received',
      intro: `Dear ${esc(d.studentName)},<br><br>Your answers for the paper below have been received `
           + 'and recorded. No further action is needed from you.',
      rows: [
        ['Subject', `${d.subjectTitle} (${d.subjectCode})`],
        ['Paper', d.examTitle],
        ['Register number', d.regNo],
        ['Submitted at', d.submittedAt],
        ['Questions answered', `${d.answered} of ${d.totalQuestions}`],
        ...(d.sheetPages ? [['Answer sheet pages received', String(d.sheetPages)]] : []),
        ['Reference', d.reference],
      ],
      note: 'Marks are not published through this portal. Your results will be issued by the '
          + 'examination cell in the usual way. Keep this message as your receipt.',
    }),
  }),

  /* The quality-check invitation. The link carries its own one-time
     token and opens outside the portal. */
  qc_invite: (d) => ({
    subject: `Quality check ${d.stage.toUpperCase()} — ${d.subjectTitle}`,
    html: layout({
      title: `Question bank quality check — ${d.stage.toUpperCase()}`,
      intro: `Dear ${esc(d.staffName)},<br><br>${esc(d.stageBlurb)}`,
      rows: [
        ['Subject', `${d.subjectTitle} (${d.subjectCode})`],
        ['Class', d.batchLabel],
        ['Questions', String(d.questionCount)],
        ['Requested by', d.requestedBy],
      ],
      action: { label: `Start ${d.stage.toUpperCase()}`, href: d.link },
      note: 'This link is for you alone and opens in a new window. Nothing is monitored or recorded '
          + 'as an attempt — it is a check of the paper, not an examination. Flag anything that '
          + 'looks wrong as you go.',
    }),
  }),
};

/* ---------------- queueing ---------------- */

export function render(template, data) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`Unknown mail template: ${template}`);
  const { subject, html } = t(data);
  return { subject, html, text: toText(html) };
}

/* Queues one message. Returns the row, or null when the address is
   missing or suppressed — callers treat null as "nothing to send",
   never as an error. */
export async function queueMail({
  institutionId, to, toName, template, data,
  relatedKind = 'other', relatedId, queuedBy, notBefore,
}) {
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) return null;

  const suppressed = await MailSuppression.findOne({
    institutionId, email: String(to).toLowerCase(),
  }).lean();
  if (suppressed) {
    return MailMessage.create({
      institutionId, to, toName, template, relatedKind, relatedId, queuedBy,
      ...render(template, data),
      status: 'suppressed',
      lastError: `Address suppressed: ${suppressed.reason}`,
    });
  }

  return MailMessage.create({
    institutionId, to, toName, template, relatedKind, relatedId, queuedBy,
    ...render(template, data),
    notBefore: notBefore || new Date(),
  });
}

/* Queues a cohort. Spread over time so a notify of six thousand
   candidates does not hit the provider as one burst — each slice of
   `batchSize` is released a minute after the one before it. */
export async function queueBulk(messages, { spreadPerMinute } = {}) {
  const per = spreadPerMinute || env.smtp.batchSize;
  const start = Date.now();
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const delayMinutes = Math.floor(i / per);
    out.push(await queueMail({
      ...messages[i],
      notBefore: new Date(start + delayMinutes * 60_000),
    }));
  }
  return out.filter(Boolean);
}


/* ------------------------------------------------------------
   WHY A MESSAGE FAILED, AND WHETHER TO TRY AGAIN

   A mailbox that does not exist will not exist in five minutes
   either. Retrying it five times and then leaving it to be retried
   again on every future examination is how a queue fills with
   addresses that can never be delivered to — and how the real
   failures become impossible to see among them.

   So failures are read, not just counted. A hard failure suppresses
   the address; a soft one is retried.

   Classified on the SMTP reply code where the server gave one, since
   the wording varies by provider and the code does not: 5xx is
   permanent by definition, 4xx is temporary, and a connection that
   never got a reply is temporary too.
   ------------------------------------------------------------ */
export function classifyFailure(error) {
  const code = Number(error?.responseCode || error?.code);
  const text = String(error?.response || error?.message || '').toLowerCase();

  /* A network fault reached no mail server at all. */
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'EDNS', 'ENOTFOUND']
    .includes(String(error?.code))) {
    return { kind: 'soft', reason: 'The mail server could not be reached' };
  }

  if (Number.isFinite(code) && code >= 500 && code < 600) {
    /* Over quota is the one 5xx that is not about the address. */
    if (/quota|full|exceeded storage|mailbox is full/.test(text)) {
      return { kind: 'soft', reason: 'The mailbox is full' };
    }
    if (/user unknown|no such user|does not exist|unrouteable|unroutable|invalid recipient|recipient rejected|address rejected|5\.1\.[01]/.test(text)) {
      return { kind: 'hard', reason: 'No such mailbox' };
    }
    if (/blocked|blacklist|spam|policy|5\.7\./.test(text)) {
      return { kind: 'hard', reason: 'Refused by the receiving server' };
    }
    return { kind: 'hard', reason: `Permanently refused (${code})` };
  }

  if (Number.isFinite(code) && code >= 400 && code < 500) {
    return { kind: 'soft', reason: `Temporarily refused (${code})` };
  }

  /* Nothing recognisable. Treated as temporary, because giving up on
     a message we do not understand is worse than trying it again. */
  return { kind: 'soft', reason: 'Not delivered' };
}

/* Stops an address being written to again until somebody clears it.
   Idempotent: a second bounce from the same address is not an error. */
export async function suppress({ institutionId, email, reason, note }) {
  if (!email) return null;
  return MailSuppression.findOneAndUpdate(
    { institutionId, email: String(email).toLowerCase() },
    { $set: { reason: reason || 'bounced', note } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(() => null);
}

/* ---------------- the worker ---------------- */

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

/* One tick. Claims each due message with a conditional update before
   sending it, so two workers — or a worker and a restarted worker —
   cannot send the same message twice. */
export async function processQueue({ limit } = {}) {
  const take = limit || env.smtp.batchSize;
  const due = await MailMessage.find({ status: 'queued', notBefore: { $lte: new Date() } })
    .sort({ notBefore: 1, createdAt: 1 }).limit(take).lean();

  let sent = 0; let failed = 0; let logged = 0; let bounced = 0;

  for (const row of due) {
    const claimed = await MailMessage.findOneAndUpdate(
      { _id: row._id, status: 'queued' },
      { $set: { status: 'sending' }, $inc: { attempts: 1 } },
      { new: true },
    );
    if (!claimed) continue;                  // another tick got there first

    const tx = await transport();
    if (!tx) {
      /* No credentials. The message is marked sent and logged, so the
         flow is complete and visible without a mail server. */
      await MailMessage.updateOne({ _id: row._id }, {
        $set: { status: 'sent', sentAt: new Date(), lastError: 'Logged only — SMTP not configured' },
      });
      if (!isProd) console.log(`[mail] (not sent — no SMTP) to=${row.to} subject="${row.subject}"`);
      logged += 1;
      continue;
    }

    try {
      await tx.sendMail({
        from: `"${env.smtp.fromName}" <${env.smtp.from}>`,
        to: row.toName ? `"${row.toName}" <${row.to}>` : row.to,
        ...(env.smtp.replyTo ? { replyTo: env.smtp.replyTo } : {}),
        subject: row.subject,
        html: row.html,
        text: row.text,
      });
      await MailMessage.updateOne({ _id: row._id },
        { $set: { status: 'sent', sentAt: new Date(), lastError: null } });
      sent += 1;
    } catch (e) {
      const attempts = (row.attempts || 0) + 1;
      const verdict = classifyFailure(e);

      /* A hard failure is not retried at all, and the address is
         suppressed so it does not reappear on every examination for
         the rest of the year. */
      if (verdict.kind === 'hard') {
        await MailMessage.updateOne({ _id: row._id }, {
          $set: { status: 'failed', lastError: `${verdict.reason}: ${String(e.message || e).slice(0, 300)}` },
        });
        await suppress({
          institutionId: row.institutionId,
          email: row.to,
          reason: verdict.reason,
          note: `Suppressed automatically after a permanent failure on "${row.subject}".`,
        });
        bounced += 1;
        console.error(`[mail] hard bounce, address suppressed: ${row.to} — ${verdict.reason}`);
        continue;
      }

      const giveUp = attempts >= MAX_ATTEMPTS;
      const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
      await MailMessage.updateOne({ _id: row._id }, {
        $set: {
          status: giveUp ? 'failed' : 'queued',
          lastError: `${verdict.reason}: ${String(e.message || e).slice(0, 300)}`,
          notBefore: new Date(Date.now() + wait * 60_000),
        },
      });
      failed += 1;
      console.error(`[mail] send failed (attempt ${attempts}) to=${row.to}: ${e.message}`);
    }
  }

  return { considered: due.length, sent, failed, logged, bounced };
}

let timer = null;

export function startMailWorker({ everySeconds = 30 } = {}) {
  if (timer) return timer;
  if (!mailConfigured()) {
    console.log('[mail] SMTP is not configured — messages will be queued and logged, not sent.');
  } else {
    console.log(`[mail] sending as ${env.smtp.from} via ${env.smtp.host}:${env.smtp.port}`);
  }
  timer = setInterval(() => {
    processQueue().catch((e) => console.error('[mail] worker tick failed:', e.message));
  }, everySeconds * 1000);
  timer.unref?.();
  return timer;
}

export function stopMailWorker() {
  if (timer) { clearInterval(timer); timer = null; }
}

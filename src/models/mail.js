import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;
const ref = (name, opts = {}) => ({ type: Types.ObjectId, ref: name, index: true, ...opts });

/* ============================================================
   Outgoing mail, queued rather than sent inline.

   Nothing in this product may wait on a mail server. A candidate
   pressing Submit gets their acknowledgement because a row is written
   here and a worker picks it up a moment later — if the SMTP host is
   slow, unreachable or rate limiting, the submission still completes.

   The row is also the record. "Did the candidate get told?" is a
   question an examination cell will be asked, and the honest answer
   has to come from somewhere other than somebody's memory.
   ============================================================ */

const mailSchema = new Schema({
  institutionId: ref('Institution', { required: true }),

  to:      { type: String, required: true, lowercase: true, trim: true },
  toName:  String,
  subject: { type: String, required: true },
  html:    { type: String, required: true },
  text:    String,

  /* Which template produced it, for filtering the log and for the
     "resend all failed acknowledgements" case. */
  template: { type: String, required: true, index: true },

  /* What it is about, so a bounced notice can be traced back to the
     paper or the candidate it concerned. */
  relatedKind: { type: String, enum: ['exam', 'attempt', 'student', 'user', 'qc', 'other'], default: 'other' },
  relatedId:   { type: Types.ObjectId },

  status: {
    type: String,
    enum: ['queued', 'sending', 'sent', 'failed', 'suppressed'],
    default: 'queued', index: true,
  },
  attempts:  { type: Number, default: 0 },
  lastError: String,
  sentAt:    Date,

  /* Not before this instant. Used for back-off between retries and to
     stagger a large cohort. */
  notBefore: { type: Date, default: Date.now, index: true },

  queuedBy: ref('User'),
}, { timestamps: true });

/* The worker's query: everything due, oldest first. */
mailSchema.index({ status: 1, notBefore: 1 });
mailSchema.index({ institutionId: 1, createdAt: -1 });

/* An address that has hard-bounced or been unsubscribed. Checked
   before anything is queued to it, so one dead address does not
   generate a failure row on every examination for the rest of the
   year. */
const suppressionSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  email:  { type: String, required: true, lowercase: true, trim: true },
  reason: { type: String, default: 'bounced' },
  note:   String,
}, { timestamps: true });
suppressionSchema.index({ institutionId: 1, email: 1 }, { unique: true });

export const MailMessage = model('MailMessage', mailSchema);
export const MailSuppression = model('MailSuppression', suppressionSchema);

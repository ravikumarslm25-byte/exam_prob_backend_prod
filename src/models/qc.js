import mongoose from 'mongoose';

const { Schema, model, Types } = mongoose;
const ref = (name, opts = {}) => ({ type: Types.ObjectId, ref: name, index: true, ...opts });

/* ============================================================
   QUALITY CHECK ON AN UPLOADED QUESTION BANK

   Questions arrive by spreadsheet, in hundreds, typed by people. What
   gets through is predictable: a question whose text was truncated, a
   spelling mistake, an option list where the answer key points at the
   wrong letter, a question from a unit that is not on the syllabus,
   and — the one nobody catches by reading — a question that marks
   incorrectly even though it reads perfectly.

   Reading the spreadsheet again finds the first four and misses the
   fifth, because marking is not visible on the page. So the check is
   not a read-through: the staff member SITS the questions, exactly as
   a candidate would, and is shown what the system awarded. A question
   that reads correctly and marks wrongly is then obvious.

   Two stages, because they answer different questions:

     QC1 — every question in the upload, in order. Is each one
     correct, complete, on syllabus, and marked properly?

     QC2 — a real paper assembled from the pattern the subject will
     actually use: 10 MCQ, 10 fill in the blanks, 4 descriptive answer
     any 2. This is the stage that catches what QC1 cannot — that the
     bank has only seven usable MCQs where the pattern needs ten, or
     that every descriptive question happens to come from one unit.

   Nothing in the upload can be approved until both have passed.
   ============================================================ */

const responseSchema = new Schema({
  questionId: ref('Question', { required: true }),
  /* Answered exactly as a candidate would. */
  selected: [String],
  text: String,
  html: String,

  /* What the system awarded, and what the checker expected it to.
     A disagreement between these two is the finding this whole
     exercise exists to produce. */
  awarded:  Number,
  outOf:    Number,
  autoMarked: { type: Boolean, default: false },
  markLooksWrong: { type: Boolean, default: false },
}, { _id: false });

const ISSUE_KINDS = [
  'missing_content',    // text or options cut off
  'spelling',
  'wrong_option',       // the answer key points at the wrong one
  'out_of_syllabus',
  'wrong_marks',        // marked incorrectly after answering
  'duplicate',
  'unclear',
  'other',
];

const issueSchema = new Schema({
  questionId: ref('Question', { required: true }),
  kind: { type: String, enum: ISSUE_KINDS, required: true },
  note: { type: String, maxlength: 1000 },
  at:   { type: Date, default: Date.now },
}, { _id: false });

const qcRunSchema = new Schema({
  institutionId: ref('Institution', { required: true }),
  uploadId:  ref('QuestionUpload', { required: true }),
  subjectId: ref('Subject', { required: true }),
  /* The class this upload is intended for. Carried for the record and
     for the invitation; the questions themselves are per subject. */
  batchId:   ref('Batch'),

  stage: { type: String, enum: ['qc1', 'qc2'], required: true },

  /* The credential for the standalone window. The staff member opens
     this link in a new tab and sits the questions there, signed in or
     not — the link is what authorises it, exactly as the candidate's
     upload pass works. Nothing is proctored: this is a check of the
     paper, not an examination. */
  token: { type: String, required: true, unique: true },

  assignedTo:     ref('User'),
  assignedToName: String,
  requestedBy:    ref('User'),
  requestedByName: String,

  /* The questions under check. For QC1 this is every question in the
     upload; for QC2 it is the paper assembled from the pattern. Fixed
     when the run is created so a question added to the bank
     afterwards cannot change what was checked. */
  questionIds: [ref('Question')],

  /* QC2 only: the pattern the paper was built to, copied in so the
     record says what was checked even if the pattern changes later. */
  blueprint: {
    name: String,
    sections: [{
      key: String, title: String, type: String,
      count: Number, marksEach: Number, answerCount: Number,
      choiceMode: String, instruction: String,
    }],
  },
  /* QC2 only: where the bank could not fill the pattern. The most
     valuable thing this stage produces, and invisible to QC1. */
  shortfalls: [{
    section: String, type: String, marksEach: Number,
    needed: Number, available: Number,
  }],

  status: {
    type: String,
    enum: ['pending', 'in_progress', 'passed', 'failed'],
    default: 'pending', index: true,
  },
  startedAt: Date,
  submittedAt: Date,

  responses: [responseSchema],
  issues: [issueSchema],

  /* The checker's own words when they close the run. */
  verdictNote: { type: String, maxlength: 2000 },
}, { timestamps: true });

qcRunSchema.index({ institutionId: 1, uploadId: 1, stage: 1 });
qcRunSchema.index({ institutionId: 1, status: 1, createdAt: -1 });

/* Both stages passed is the gate on approval. Expressed here rather
   than in a route so every caller asks the same question. */
qcRunSchema.statics.gateFor = async function gateFor(institutionId, uploadId) {
  const runs = await this.find({ institutionId, uploadId })
    .select('stage status submittedAt assignedToName issues').sort({ createdAt: 1 }).lean();

  const latest = (stage) => runs.filter((r) => r.stage === stage).slice(-1)[0] || null;
  const qc1 = latest('qc1');
  const qc2 = latest('qc2');

  return {
    qc1, qc2,
    qc1Passed: qc1?.status === 'passed',
    qc2Passed: qc2?.status === 'passed',
    mayApprove: qc1?.status === 'passed' && qc2?.status === 'passed',
    openIssues: [...(qc1?.issues || []), ...(qc2?.issues || [])].length,
  };
};

export const QC_ISSUE_KINDS = ISSUE_KINDS;
export const QcRun = model('QcRun', qcRunSchema);

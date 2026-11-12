/* ============================================================
   Grading rules. Kept out of routes so they are testable and
   so evaluation and revaluation share one implementation.
   ============================================================ */

const normalise = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, '')   // drop punctuation
  .replace(/\s+/g, ' ')
  .trim();

/* ---- Part A: multiple choice ---- */
export function gradeMcq(question, answer) {
  const chosen = [...(answer?.selected || [])].sort();
  const correct = [...(question.correctOptions || [])].sort();
  if (!chosen.length) return { awarded: 0, needsReview: false };

  const exact = chosen.length === correct.length && chosen.every((c, i) => c === correct[i]);
  if (exact) return { awarded: question.marks, needsReview: false };

  // partial credit for multi-select: right picks minus wrong picks, floored at zero
  if (question.multiSelect) {
    const hits = chosen.filter((c) => correct.includes(c)).length;
    const misses = chosen.filter((c) => !correct.includes(c)).length;
    const share = Math.max(0, (hits - misses) / correct.length);
    return { awarded: Math.round(question.marks * share * 100) / 100, needsReview: false };
  }
  return { awarded: 0, needsReview: false };
}

/* ---- Part B: fill in the blanks ----
   Auto-matched against accepted variants. Anything that does not
   match is routed to an evaluator rather than marked wrong, so an
   unanticipated but correct phrasing is never silently penalised. */
export function gradeFib(question, answer) {
  const given = normalise(answer?.text);
  if (!given) return { awarded: 0, needsReview: false };

  const accepted = (question.acceptedAnswers || []).map(normalise).filter(Boolean);
  if (accepted.includes(given)) return { awarded: question.marks, needsReview: false };

  // tolerate a single character slip on longer answers
  const close = accepted.some((a) => a.length > 4 && levenshtein(a, given) <= 1);
  if (close) return { awarded: question.marks, needsReview: false };

  return { awarded: 0, needsReview: true };
}

/* Damerau-Levenshtein: counts a transposition as one edit.
   Plain Levenshtein scores "foriegn" against "foreign" as 2 and
   would send every transposed letter to manual review, which is
   the single commonest typing slip in a fill-in-the-blank. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;

  const d = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // transposition
      }
    }
  }
  return d[m][n];
}

/* ---- Part C: descriptive ----
   Weighted keyword coverage produces a SUGGESTED mark only.
   The evaluator always awards the final mark. */
export function suggestDescriptive(question, answer) {
  const body = normalise(`${answer?.text || ''} ${stripHtml(answer?.html || '')}`);
  const keywords = question.keywords || [];
  if (!keywords.length || !body) return { suggested: null, hits: [], coverage: 0 };

  const hits = [];
  let weighted = 0, totalWeight = 0;
  for (const k of keywords) {
    const term = normalise(k.term);
    const w = k.weight || 1;
    totalWeight += w;
    if (term && body.includes(term)) { hits.push(k.term); weighted += w; }
  }
  const coverage = totalWeight ? weighted / totalWeight : 0;
  return {
    suggested: Math.round(question.marks * coverage * 2) / 2,   // nearest half mark
    hits,
    coverage: Math.round(coverage * 100),
  };
}

const stripHtml = (h) => String(h).replace(/<[^>]*>/g, ' ');

/* ---- best-N across a choice section ----
   Where a candidate answers more than required, the highest
   scoring permitted subset counts and the surplus is retained
   in the record but excluded from the total. */
export function applyBestN(answers, answerCount) {
  const scored = answers
    .map((a, i) => ({ i, mark: a.awarded ?? 0, answered: hasContent(a) }))
    .filter((a) => a.answered)
    .sort((x, y) => y.mark - x.mark);

  const keep = new Set(scored.slice(0, answerCount).map((a) => a.i));
  answers.forEach((a, i) => { a.countedInBestN = keep.has(i); });
  return answers.reduce((sum, a) => sum + (a.countedInBestN ? (a.awarded ?? 0) : 0), 0);
}

export const hasContent = (a) =>
  Boolean(a?.selected?.length || (a?.text && a.text.trim()) ||
          (a?.html && stripHtml(a.html).trim()) || a?.scanPages?.length);

/* ---- violation weights ----
   A transient noise event and a second face in the room are not
   equivalent, so flags carry severity weight rather than a flat count. */
export const SEVERITY_WEIGHT = { info: 0, medium: 1, high: 2, critical: 3 };

export const VIOLATION_CATALOGUE = {
  no_face:            { severity: 'high',     label: 'Face not visible' },
  multiple_faces:     { severity: 'critical', label: 'Multiple faces detected' },
  looking_away:       { severity: 'medium',   label: 'Looking away' },
  /* The head stayed forward and the eyes did not. This is the one
     that catches a phone flat on the desk, which head tracking alone
     reads as a candidate facing the screen throughout. It is rated
     above looking_away because it is harder to do by accident. */
  gaze_off_screen:    { severity: 'high',     label: 'Eyes directed off screen' },
  /* Not an accusation in itself — the candidate is asked to remove
     the lenses and may simply have forgotten they had them on. It
     becomes serious if it persists after they have been told. */
  eyes_obscured:      { severity: 'medium',   label: 'Eyes not visible — tinted or dark lenses' },
  /* The candidate's browser sent gaze limits outside the plausible
     range and the server brought them back. Carries zero weight: a
     poor camera can cause it, so it is shown to the invigilator
     rather than counted against the candidate. */
  calibration_out_of_range: { severity: 'medium', label: 'Eye calibration outside the plausible range' },

  /* ---- the candidate's screen ----
     A browser cannot compel screen sharing: it can ask, check what it
     was given, and notice when it stops. Each of these is that
     noticing. Refusing outright is rated highest because it is the
     only one that cannot happen by accident. */
  screen_share_refused: { severity: 'critical', label: 'Screen sharing refused' },
  screen_share_stopped: { severity: 'critical', label: 'Screen sharing stopped mid-examination' },
  /* Sharing one window rather than the whole screen leaves the rest
     of the display unseen. Not necessarily deliberate — some browsers
     offer no whole-screen option — so it is shown to the invigilator
     rather than counted heavily against the candidate. */
  screen_share_partial: { severity: 'medium',   label: 'Shared one window, not the whole screen' },

  /* A second sign-in on the same credentials tried to answer a paper
     already in progress. There is no innocent reading of this that
     does not also mean the candidate's password is in someone else's
     hands, so it is rated at the top either way. */
  concurrent_session:  { severity: 'critical', label: 'Second sign-in on these credentials' },

  /* ---- reported by the secure client ----
     A browser cannot see any of these. They arrive only from the
     desktop client, which is why a paper that cares about them has
     to require it. */
  blocked_process:     { severity: 'critical', label: 'Prohibited program running' },
  blocked_request:     { severity: 'high',     label: 'Page reached for a host outside ExamProbe' },
  identity_mismatch:  { severity: 'critical', label: 'Candidate substitution suspected' },
  room_noise:         { severity: 'medium',   label: 'Room noise detected' },
  tab_switch:         { severity: 'high',     label: 'Tab or window switch' },
  fullscreen_exit:    { severity: 'high',     label: 'Left fullscreen' },
  copy_paste:         { severity: 'high',     label: 'Copy or paste attempt' },
  devtools:           { severity: 'critical', label: 'Developer tools opened' },
  virtual_machine:    { severity: 'critical', label: 'Virtual machine or remote session' },
  multiple_displays:  { severity: 'medium',   label: 'More than one display connected' },
  platform_violation: { severity: 'critical', label: 'Unsupported operating system' },
  network_loss:       { severity: 'info',     label: 'Network interruption' },
};

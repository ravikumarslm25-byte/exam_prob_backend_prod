#!/usr/bin/env node
/* ============================================================
   PROVING THE CAPACITY, RATHER THAN ASSERTING IT

   "Can it take ten thousand?" is not a question anybody should
   answer from architecture diagrams. This drives the real API with
   the real traffic shape of a sitting and reports what happened.

   WHAT IT SIMULATES, and why this shape and not a simpler one.

   A load test that hammers one endpoint proves nothing about an
   examination. The traffic of a real sitting is lopsided in a
   specific way: a brief, brutal spike as a few thousand candidates
   sign in and join within the same two minutes, then three hours of
   steady low-rate evidence uploads with answer saves scattered
   through, then a second spike at the end as everyone submits.

   The spikes are what breaks. So the test ramps candidates in over a
   window you choose, holds them through a compressed sitting, and
   submits them together.

   WHAT IT DOES NOT COVER, said here so nobody reads a pass as more
   than it is: no camera, no WebRTC, no live invigilation sockets,
   and the evidence frames are small synthetic JPEGs rather than real
   ones. It exercises the API and the database, which is where the
   first wall is. The media tier has to be measured separately.

   Usage:
     node scripts/loadtest.mjs --url https://exam... --candidates 12000 \
       --ramp 120 --hold 300 --from-file candidates.json
     node scripts/loadtest.mjs --dry-run        (no server; checks the harness)
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

/* ---------------- arguments ---------------- */
function args(argv) {
  const out = {
    url: 'http://localhost:5050',
    candidates: 100,
    ramp: 30,
    hold: 120,
    evidenceSeconds: 20,
    answerSeconds: 45,
    concurrency: 500,
    dryRun: false,
    fromFile: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (key) {
      case 'url': out.url = next(); break;
      case 'candidates': out.candidates = Number(next()); break;
      case 'ramp': out.ramp = Number(next()); break;
      case 'hold': out.hold = Number(next()); break;
      case 'evidence-seconds': out.evidenceSeconds = Number(next()); break;
      case 'answer-seconds': out.answerSeconds = Number(next()); break;
      case 'concurrency': out.concurrency = Number(next()); break;
      case 'from-file': out.fromFile = next(); break;
      case 'dry-run': out.dryRun = true; break;
      default: break;
    }
  }
  return out;
}

/* ---------------- measurement ----------------

   Latencies are kept per endpoint, because one slow endpoint hiding
   inside a healthy average is exactly the failure this is looking
   for. The mean is not reported at all: it is the one statistic that
   reliably conceals the problem. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  /* Nearest-rank. With 100 samples p95 is the 95th, which is what
     anybody reading the number expects it to be. */
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarise(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const failed = samples.filter((s) => !s.ok);
  const byStatus = {};
  for (const f of failed) byStatus[f.status || 'network'] = (byStatus[f.status || 'network'] || 0) + 1;

  return {
    calls: samples.length,
    ok: ok.length,
    failed: failed.length,
    failureRate: samples.length ? failed.length / samples.length : 0,
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    p99: percentile(ok, 99),
    max: ok.length ? ok[ok.length - 1] : null,
    failures: byStatus,
  };
}

/* The schedule candidates arrive on. Spreading them evenly across
   the ramp is the point: all at once measures the load balancer's
   accept queue, not the application. */
export function arrivalSchedule(count, rampSeconds) {
  const gap = count > 1 ? (rampSeconds * 1000) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => Math.round(i * gap));
}

/* ---------------- one candidate's sitting ---------------- */

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL'
  + 'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

async function timed(store, name, fn) {
  const started = performance.now();
  try {
    const res = await fn();
    const ms = performance.now() - started;
    const ok = res.status >= 200 && res.status < 300;
    (store[name] ||= []).push({ ms, ok, status: res.status });
    return { ok, res };
  } catch (e) {
    const ms = performance.now() - started;
    (store[name] ||= []).push({ ms, ok: false, status: null, error: e.message });
    return { ok: false, error: e };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sitting({ base, candidate, store, options, until }) {
  const json = (body, token) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  /* sign in */
  let token = null;
  let attemptId = null;

  const login = await timed(store, 'POST /auth/student/login', () => fetch(
    `${base}/api/auth/student/login`,
    json({ regNo: candidate.regNo, password: candidate.password }),
  ));
  if (!login.ok) return;
  try { token = (await login.res.json()).accessToken; } catch { return; }

  /* which paper */
  const mine = await timed(store, 'GET /attempts/mine', () => fetch(
    `${base}/api/attempts/mine`, { headers: { Authorization: `Bearer ${token}` } },
  ));
  if (!mine.ok) return;
  try {
    const data = await mine.res.json();
    attemptId = data.attempts?.find((a) => a.phase !== 'done')?.attemptId;
  } catch { return; }
  if (!attemptId) return;

  await timed(store, 'POST /attempts/:id/join', () => fetch(
    `${base}/api/attempts/${attemptId}/join`,
    json({ platform: 'Windows 11', browser: 'Chrome 131', screen: '1920x1080', displays: 1 }, token),
  ));

  const start = await timed(store, 'POST /attempts/:id/start', () => fetch(
    `${base}/api/attempts/${attemptId}/start`, json({}, token),
  ));
  if (!start.ok) return;

  let questionIds = [];
  try {
    const paper = await start.res.json();
    questionIds = (paper.sections || []).flatMap((s) => (s.questions || []).map((q) => q.id));
  } catch { /* the paper shape is not what is being measured */ }

  /* the sitting: evidence on its beat, answers on theirs */
  const evidenceEvery = options.evidenceSeconds * 1000;
  const answerEvery = options.answerSeconds * 1000;
  let nextEvidence = Date.now();
  let nextAnswer = Date.now() + answerEvery / 2;
  let n = 0;

  while (Date.now() < until) {
    const now = Date.now();

    if (now >= nextEvidence) {
      nextEvidence = now + evidenceEvery;
      await timed(store, 'POST /attempts/:id/evidence', () => fetch(
        `${base}/api/attempts/${attemptId}/evidence`, json({ cameraFrame: JPEG }, token),
      ));
    }

    if (now >= nextAnswer && questionIds.length) {
      nextAnswer = now + answerEvery;
      const qid = questionIds[n++ % questionIds.length];
      await timed(store, 'PATCH /attempts/:id/answers/:q', () => fetch(
        `${base}/api/attempts/${attemptId}/answers/${qid}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ selected: ['A'] }),
        },
      ));
    }

    await sleep(250);
  }

  /* everybody at once, which is the second spike */
  await timed(store, 'POST /attempts/:id/submit', () => fetch(
    `${base}/api/attempts/${attemptId}/submit`, json({}, token),
  ));
}

/* ---------------- the run ---------------- */

async function main() {
  const options = args(process.argv);

  if (options.dryRun) {
    /* Exercises the harness without a server, so its arithmetic and
       scheduling can be checked before anyone points it at
       infrastructure and trusts the numbers. */
    const schedule = arrivalSchedule(options.candidates, options.ramp);
    const fake = Array.from({ length: 1000 }, (_, i) => ({ ms: i + 1, ok: i < 980, status: i < 980 ? 200 : 500 }));
    console.log('dry run — no requests were made\n');
    console.log(`arrivals: ${schedule.length}, first at ${schedule[0]}ms, last at ${schedule.at(-1)}ms`);
    console.log('summary arithmetic on 1000 synthetic samples:');
    console.table(summarise(fake));
    return;
  }

  if (!options.fromFile) {
    console.error('Give --from-file with the candidates to sign in as:\n'
      + '  [{ "regNo": "41720610001", "password": "..." }, ...]\n'
      + 'Generate it from the register numbers the examination cell loaded, '
      + 'against a REHEARSAL paper on a REHEARSAL database — never a live one.');
    process.exit(1);
  }

  const candidates = JSON.parse(await readFile(options.fromFile, 'utf8'))
    .slice(0, options.candidates);

  if (!candidates.length) { console.error('No candidates in that file.'); process.exit(1); }

  const base = options.url.replace(/\/$/, '');
  const store = {};
  const schedule = arrivalSchedule(candidates.length, options.ramp);
  const until = Date.now() + (options.ramp + options.hold) * 1000;

  console.log(`ExamProbe load test
  target      ${base}
  candidates  ${candidates.length}
  ramp        ${options.ramp}s  (one every ${(schedule[1] || 0)}ms)
  hold        ${options.hold}s
  evidence    every ${options.evidenceSeconds}s per candidate
`);

  const started = performance.now();
  let live = 0;
  let peak = 0;

  const runners = candidates.map((candidate, i) => (async () => {
    await sleep(schedule[i]);
    live += 1; peak = Math.max(peak, live);
    try {
      await sitting({ base, candidate, store, options, until });
    } finally { live -= 1; }
  })());

  const ticker = setInterval(() => {
    const secs = Math.round((performance.now() - started) / 1000);
    process.stderr.write(`\r  ${secs}s elapsed · ${live} candidates in the paper · peak ${peak}   `);
  }, 2000);

  await Promise.allSettled(runners);
  clearInterval(ticker);
  process.stderr.write('\n\n');

  const rows = {};
  let worstFailure = 0;
  for (const [name, samples] of Object.entries(store)) {
    const s = summarise(samples);
    worstFailure = Math.max(worstFailure, s.failureRate);
    rows[name] = {
      calls: s.calls, failed: s.failed,
      'fail %': (s.failureRate * 100).toFixed(2),
      'p50 ms': s.p50?.toFixed(0), 'p95 ms': s.p95?.toFixed(0),
      'p99 ms': s.p99?.toFixed(0), 'max ms': s.max?.toFixed(0),
    };
  }

  console.table(rows);
  console.log(`\npeak concurrent candidates: ${peak}`);
  console.log(`wall clock: ${Math.round((performance.now() - started) / 1000)}s`);

  for (const [name, samples] of Object.entries(store)) {
    const s = summarise(samples);
    if (s.failed) console.log(`  ${name} failures: ${JSON.stringify(s.failures)}`);
  }

  /* An explicit verdict rather than a wall of numbers somebody has to
     interpret under pressure the morning of a sitting. */
  const pass = worstFailure < 0.01;
  console.log(`\n${pass ? 'PASS' : 'FAIL'} — worst failure rate ${(worstFailure * 100).toFixed(2)}% `
    + `(threshold 1%)`);
  process.exit(pass ? 0 : 1);
}

/* Imported by the tests without running. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

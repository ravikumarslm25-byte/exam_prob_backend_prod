# Running ExamProbe at scale

## The one rule

**Do not run more than one instance without `REDIS_URL` set.**

A WebSocket lives in the memory of the process that accepted it. A candidate's
socket is on whichever instance their browser reached; their invigilator's is
on whichever instance the invigilator reached. These are routinely different.

Without the shared bus, a push looks for those sockets in local memory, does not
find them, and returns quietly. **The invigilator sees nothing. No error is
logged and nothing retries.** The only symptom is live invigilation that is
intermittently less live than it used to be, depending on which instances two
people happened to land on.

The boot log tells you which mode you are in:

```
[api] realtime delivery: shared bus — safe to run several instances
[api] realtime delivery: single instance only — set REDIS_URL before scaling out
```

Check that line after every deploy.

## What is in place

| Concern | State |
|---|---|
| Realtime across instances | **Done** — `REDIS_URL` enables it, absent it stays single-instance |
| Stateless API tier | Yes — no session state in process memory; JWT access, tokens in Mongo |
| Mail worker on N instances | Safe — claims each message atomically, so instances cannot double-send |
| Indexes on the hot queries | Audited, present — attempts by exam+student, by exam+evaluation state, rooms by exam, questions by subject+status |
| Object storage for evidence | `STORAGE_DRIVER=s3` with `S3_BUCKET` |
| Load test harness | `scripts/loadtest.mjs` |

## What is NOT in place

- **An SFU for live video.** The current relay is sized to candidates, not to
  viewers. Live streaming at 10,000 needs mediasoup or LiveKit sitting in front.
  This is the largest remaining piece.
- **Queued background work.** Report generation and marking still run in the
  request path.
- **Autoscaling policy and load balancer config.** Infrastructure, not code.

## Before an entrance examination

1. `REDIS_URL` set, boot log confirms the shared bus.
2. `STORAGE_DRIVER=s3` — local disk does not survive several instances.
3. MongoDB as a replica set, not a single node.
4. Sticky sessions **not** required — but if your load balancer has them on,
   leave them on; they reduce bus traffic and cost nothing.
5. Run the load test at 20% above the real peak. See below.

## The load test

```
node scripts/loadtest.mjs --dry-run                 # check the harness first
node scripts/loadtest.mjs \
  --url https://exam.sathyabama.ac.in \
  --from-file rehearsal-candidates.json \
  --candidates 12000 --ramp 120 --hold 600
```

It simulates the shape of a real sitting: a hard spike as everyone signs in and
joins within two minutes, a steady period of evidence uploads and answer saves,
then a second spike as everyone submits. The spikes are what break.

It reports p50/p95/p99 per endpoint and **no mean** — a mean is the one
statistic that reliably hides five slow calls behind ninety-five fast ones.
Exit code 0 if the worst endpoint failure rate is under 1%.

**Run it against a rehearsal database with rehearsal candidates.** It signs in,
starts papers and submits them. Never point it at live data.

**What it does not cover:** no camera, no WebRTC, no invigilation sockets, and
synthetic evidence frames. It measures the API and the database, which is where
the first wall is. The media tier has to be measured separately — and until the
SFU exists there is nothing to measure.

/* ============================================================
   RUNNING ON MORE THAN ONE INSTANCE

   None of this can be proved without a cluster. What can be proved
   is the logic that decides where a message goes — which is where
   the bug lives, because on one instance it is invisible and on
   several it loses invigilation messages intermittently.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarise, arrivalSchedule } from '../../scripts/loadtest.mjs';

/* ---------------- the bus ---------------- */

test('with no REDIS_URL the bus runs single-instance and says so', async () => {
  const { startBus, busMode } = await import('../realtime/bus.js');
  const out = await startBus(undefined);
  assert.equal(out.mode, 'memory');
  assert.equal(busMode(), 'memory');
});

test('publishing with no bus connected is a no-op, not a crash', async () => {
  const { publish, CHANNELS } = await import('../realtime/bus.js');
  assert.equal(publish(CHANNELS.watchers, { attemptId: 'a1', payload: {} }), false);
});

test('a subscription returns something that unsubscribes', async () => {
  const { subscribe } = await import('../realtime/bus.js');
  let hits = 0;
  const off = subscribe('test:channel', () => { hits += 1; });
  assert.equal(typeof off, 'function');
  off();
  assert.equal(hits, 0);
});

test('every push channel has a name, and they are distinct', async () => {
  const { CHANNELS } = await import('../realtime/bus.js');
  const names = Object.values(CHANNELS);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3, 'two pushes sharing a channel would cross-deliver');
  for (const n of names) assert.match(n, /^examprobe:/);
});

test('the instance id is stable within a process and not empty', async () => {
  const { busInstanceId } = await import('../realtime/bus.js');
  const a = busInstanceId();
  assert.ok(a && a.length >= 8);
  assert.equal(busInstanceId(), a, 'an id that changed would stop a process ignoring its own echo');
});

/* ---------------- the load test's arithmetic ---------------- */

test('percentiles are nearest-rank, so p95 of 100 samples is the 95th', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(s, 50), 50);
  assert.equal(percentile(s, 95), 95);
  assert.equal(percentile(s, 99), 99);
  assert.equal(percentile(s, 100), 100);
});

test('percentiles of nothing are nothing, not zero', () => {
  /* Zero would read as "instantaneous" in a report. */
  assert.equal(percentile([], 95), null);
  assert.equal(summarise([]).p95, null);
});

test('a slow tail is not hidden by fast calls', () => {
  /* 95 fast calls and 5 very slow ones average out to something
     healthy. The percentile is the whole reason this is measured
     this way rather than as a mean. */
  const samples = [
    ...Array.from({ length: 95 }, () => ({ ms: 20, ok: true, status: 200 })),
    ...Array.from({ length: 5 }, () => ({ ms: 9000, ok: true, status: 200 })),
  ];
  const s = summarise(samples);
  assert.equal(s.p50, 20);
  assert.ok(s.p99 >= 9000, 'the tail must be visible');
  assert.ok(!('mean' in s), 'a mean would conceal exactly this case and is deliberately absent');
});

test('failures are counted and broken down by status', () => {
  const s = summarise([
    { ms: 10, ok: true, status: 200 },
    { ms: 10, ok: false, status: 503 },
    { ms: 10, ok: false, status: 503 },
    { ms: 10, ok: false, status: null },
  ]);
  assert.equal(s.failed, 3);
  assert.equal(s.failureRate, 0.75);
  assert.equal(s.failures[503], 2);
  assert.equal(s.failures.network, 1);
});

test('failed calls do not pollute the latency figures', () => {
  /* A request that failed in 1ms would otherwise flatter the p50. */
  const s = summarise([
    { ms: 1, ok: false, status: 500 },
    { ms: 100, ok: true, status: 200 },
  ]);
  assert.equal(s.p50, 100);
});

test('arrivals spread across the ramp rather than all at once', () => {
  const schedule = arrivalSchedule(1000, 120);
  assert.equal(schedule.length, 1000);
  assert.equal(schedule[0], 0);
  assert.equal(schedule.at(-1), 120000);
  /* Evenly, so the test measures the application rather than the
     load balancer's accept queue. */
  const gaps = schedule.slice(1).map((t, i) => t - schedule[i]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1);
});

test('a single candidate arrives immediately', () => {
  assert.deepEqual(arrivalSchedule(1, 60), [0]);
});

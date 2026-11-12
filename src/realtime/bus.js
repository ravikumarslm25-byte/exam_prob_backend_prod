/* ============================================================
   REACHING A SOCKET HELD BY ANOTHER INSTANCE

   One process can serve a few hundred candidates. Ten thousand needs
   several, behind a load balancer — and the moment there is more than
   one, a bug appears that does not exist today and is invisible in
   testing on a single machine.

   A WebSocket lives in the memory of the process that accepted it.
   A candidate's socket is on whichever instance their browser
   happened to connect to; their invigilator's socket is on whichever
   instance the invigilator reached. These are routinely different.

   So when a candidate posts a violation and the server pushes it to
   their watchers, the push looks for those sockets in local memory,
   does not find them, and returns quietly. The invigilator sees
   nothing. No error is logged, nothing retries, and the only symptom
   is an invigilation screen that is mysteriously less live than it
   used to be — intermittently, depending on which instances two
   people landed on.

   This is the fix: every push is also published on a channel that all
   instances subscribe to. Each instance delivers to whichever sockets
   it actually holds. The sockets are never shared — they cannot be —
   only the instruction to deliver.

   Broadcasting to every instance rather than routing to the right one
   is deliberate. It needs no registry of who holds what, which is one
   fewer thing to keep correct and one fewer thing to go stale when an
   instance dies. The traffic is chat, warnings, terminations and flag
   notices — not video — so the cost of a few instances ignoring a
   message is nothing next to the cost of a registry that lies.

   With no REDIS_URL set, this degrades to direct local delivery and
   the server behaves exactly as it did before. That is the correct
   single-instance behaviour, not a stub.
   ============================================================ */

import crypto from 'node:crypto';

/* Identifies THIS process, so it can ignore the echo of its own
   publications — it has already delivered them locally. */
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

const handlers = new Map();          // channel -> Set<handler>
let publisher = null;
let subscriber = null;
let mode = 'memory';

export const busInstanceId = () => INSTANCE_ID;
export const busMode = () => mode;

/* Connects the bus if a Redis address is configured.

   Never throws. A realtime bus that cannot connect must not stop a
   server from starting: examinations run without it, with the
   single-instance behaviour, and the log says so loudly enough that
   somebody notices before the next sitting. */
export async function startBus(url = process.env.REDIS_URL) {
  if (!url) {
    console.log('[bus] no REDIS_URL — running single-instance. '
      + 'Do NOT run more than one instance without it: live invigilation '
      + 'would silently miss candidates connected elsewhere.');
    return { mode: 'memory' };
  }

  try {
    /* Imported only when configured, like the S3 driver, so a
       deployment that does not use Redis need not install it. */
    const { default: Redis } = await import('ioredis');

    publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });

    await publisher.connect();
    await subscriber.connect();

    subscriber.on('message', (channel, raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      /* Our own publication, already delivered locally. */
      if (message?.from === INSTANCE_ID) return;
      for (const handler of handlers.get(channel) || []) {
        try { handler(message.payload); } catch { /* one bad handler is not the bus */ }
      }
    });

    /* A dropped connection is reported and reconnected by the client.
       It is logged because the window while it is down is a window in
       which invigilation is quietly single-instance again. */
    subscriber.on('error', (e) => console.error('[bus] subscriber error:', e.message));
    publisher.on('error', (e) => console.error('[bus] publisher error:', e.message));

    /* Anything subscribed before the connection came up. */
    for (const channel of handlers.keys()) await subscriber.subscribe(channel);

    mode = 'redis';
    console.log(`[bus] connected, instance ${INSTANCE_ID}. Live invigilation spans instances.`);
    return { mode };
  } catch (e) {
    console.error('[bus] could not connect, falling back to single-instance delivery:', e.message);
    publisher = null;
    subscriber = null;
    mode = 'memory';
    return { mode, error: e.message };
  }
}

export function subscribe(channel, handler) {
  if (!handlers.has(channel)) {
    handlers.set(channel, new Set());
    subscriber?.subscribe(channel).catch(() => {});
  }
  handlers.get(channel).add(handler);
  return () => handlers.get(channel)?.delete(handler);
}

/* Tells the other instances to deliver this. The caller has already
   delivered locally — publishing is only about the sockets this
   process does not hold. */
export function publish(channel, payload) {
  if (!publisher) return false;
  try {
    publisher.publish(channel, JSON.stringify({ from: INSTANCE_ID, payload }));
    return true;
  } catch { return false; }
}

export async function stopBus() {
  try { await publisher?.quit(); } catch { /* closing anyway */ }
  try { await subscriber?.quit(); } catch { /* closing anyway */ }
  publisher = null;
  subscriber = null;
  mode = 'memory';
}

export const CHANNELS = {
  candidate: 'examprobe:candidate',   // server -> one candidate
  watchers: 'examprobe:watchers',     // candidate -> their invigilators
  room: 'examprobe:room',             // -> everyone watching a room
};

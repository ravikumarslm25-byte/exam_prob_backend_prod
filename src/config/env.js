import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/* The server folder, found from this file rather than from the current
   directory, so a process manager can start the API from anywhere and
   it still finds its .env and its uploads folder. */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const need = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${k}`);
  return v;
};


/* PUBLIC_URL is ONE address — where a browser reaches this API — and
   it is what every proctoring capture is linked from. CORS_ORIGINS
   beside it in the same file is a comma-separated list, and the two
   get confused: a PUBLIC_URL of "https://api.example.com,http://localhost:5050"
   produced evidence links with both hosts glued together, so every
   capture in the timeline showed as a broken image. Take the first
   address, drop anything after it, and complain loudly at boot. */
function publicUrl() {
  const raw = process.env.PUBLIC_URL;
  const fallback = `http://localhost:${Number(process.env.PORT || 5050)}`;
  if (!raw || !raw.trim()) return fallback;

  const first = raw.split(',')[0].trim().replace(/\/+$/, '');
  if (first !== raw.trim().replace(/\/+$/, '')) {
    console.warn(`[env] PUBLIC_URL holds more than one address. Using "${first}".`);
    console.warn('      PUBLIC_URL is a single address; CORS_ORIGINS is the list.');
  }

  try {
    const u = new URL(first);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
  } catch {
    console.warn(`[env] PUBLIC_URL "${first}" is not a valid address. Using ${fallback}.`);
    console.warn('      Proctoring captures will not load until this is corrected.');
    return fallback;
  }
  return first;
}

export const env = {
  nodeEnv:  process.env.NODE_ENV || 'development',
  port:     Number(process.env.PORT || 5050),
  mongoUri: need('MONGO_URI', 'mongodb://127.0.0.1:27017/examprobe'),
  accessSecret:  need('JWT_ACCESS_SECRET', 'dev-access-secret'),
  refreshSecret: need('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
  accessTtl:  process.env.ACCESS_TTL  || '15m',
  refreshTtl: process.env.REFRESH_TTL || '7d',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim()),

  /* Where this API is reachable from a browser. Evidence stored on the
     local driver is served from here, so the URL has to be absolute —
     a relative path would resolve against the web app's origin, not
     the API's. */
  publicUrl: publicUrl(),

  /* Where the WEB APP is reachable — a different host from the API in
     any real deployment (examprobe.com against api.examprobe.com).
     The answer-upload QR code points at a page of the web app, so a
     code built from the API's own address would open a blank page on
     the candidate's phone. Defaults to the first CORS origin, which
     is the web app by definition. */
  appUrl: (process.env.APP_URL
    || (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',')[0]
  ).trim().replace(/\/+$/, ''),

  /* WebRTC. Public STUN is enough for a candidate and an invigilator on
     the same network, which covers a campus and covers testing. A TURN
     server is required once either side sits behind a symmetric NAT,
     which is the normal case over the open internet. */
  stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((s) => s.trim()).filter(Boolean),
  turnUrl: process.env.TURN_URL || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',

  /* Outgoing mail. Two shapes are supported deliberately:

     Gmail — SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_SECURE=true,
     SMTP_USER the full address and SMTP_PASS a 16-character app
     password, NOT the account password. Fine for a pilot; Google caps
     it at roughly 500 recipients a day, which one examination day of
     a large cohort will exceed.

     A verified domain — any provider's SMTP credentials with SPF and
     DKIM published for the from address. Required before a full
     cohort is notified, or the mail lands in spam.

     With nothing configured the queue still accepts work and records
     it, and logs each message instead of sending. Nothing that calls
     the mailer has to care which of the three is in force. */
  smtp: {
    host:   process.env.SMTP_HOST || '',
    port:   Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true',
    user:   process.env.SMTP_USER || '',
    pass:   process.env.SMTP_PASS || '',
    from:   process.env.SMTP_FROM || process.env.SMTP_USER || '',
    fromName: process.env.SMTP_FROM_NAME || 'Office of the Controller of Examinations',
    replyTo:  process.env.SMTP_REPLY_TO || '',
    /* A hard ceiling per run of the queue worker, so a bulk notify of
       six thousand candidates is spread over minutes instead of
       tripping the provider's rate limit in one burst. */
    batchSize: Number(process.env.SMTP_BATCH || 40),
  },
};

export const mailConfigured = () => Boolean(env.smtp.host && env.smtp.user && env.smtp.from);

export const isProd = env.nodeEnv === 'production';

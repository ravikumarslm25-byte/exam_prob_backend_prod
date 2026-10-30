import { Audit } from '../models/exam.js';

/* ---------------------------------------------------------------
   Two ways in, one collection.

   `audit(req, {...})` is the explicit call a route makes when it can
   describe a change properly — the row it writes carries `before` and
   `after`, which is worth far more than a method and a path.

   `autoAudit` is the net underneath. It runs on every request and,
   once the response has finished, records any staff mutation that did
   NOT already record itself. That is the part that makes "every
   change is logged" true of routes nobody has thought about yet,
   including the ones added next month.

   A route that calls audit() therefore produces one rich row, not a
   rich row and a generic duplicate.
   --------------------------------------------------------------- */

/* Anything whose value must never reach the audit collection. Matched
   on the key, case-insensitively, at any depth. */
const SECRET_KEYS = [
  'password', 'newpassword', 'currentpassword', 'passwordhash', 'confirmpassword',
  'token', 'accesstoken', 'refreshtoken', 'refreshtokenhash', 'secret',
  'authorization', 'cookie', 'otp', 'pin',
];

/* Fields that are legitimately enormous — identity captures, scan
   pages, proctoring frames. Recording that they were present is
   useful; recording 6 MB of base64 is not. */
const BULK_KEYS = [
  'image', 'images', 'photo', 'photos', 'frame', 'frames', 'dataurl', 'data',
  'pageimage', 'pages', 'scanpages', 'idproof', 'capture', 'snapshot', 'file', 'content',
];

const MAX_STRING = 512;
const MAX_ARRAY = 25;
const MAX_DEPTH = 6;

export function redact(value, depth = 0) {
  if (value == null) return value;

  if (typeof value === 'string') {
    if (value.startsWith('data:')) return `[${value.slice(5, value.indexOf(';') + 1 || 20)} ${value.length} bytes]`;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested]';

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `… ${value.length - MAX_ARRAY} more`] : head;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (SECRET_KEYS.includes(key)) { out[k] = '[redacted]'; continue; }
    if (BULK_KEYS.includes(key)) {
      if (Array.isArray(v)) out[k] = `[${v.length} item(s)]`;
      else if (typeof v === 'string') out[k] = `[${v.length} chars]`;
      else out[k] = v == null ? v : '[omitted]';
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

/* Records a privileged action. Never throws into the request path —
   an audit failure must not fail the operation it is recording. */
export async function audit(req, { action, entity, entityId, before, after }) {
  if (req) req._audited = true;         // suppresses the generic row
  try {
    await Audit.create({
      institutionId: req.actor.institutionId,
      actorId: req.actor.id,
      actorKind: req.actor.kind,
      actorName: req.actor.name,
      action, entity, entityId,
      before: redact(before),
      after: redact(after),
      method: req.method,
      path: auditPath(req),
      status: 200,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    });
  } catch (e) {
    console.error('[audit] failed to record', action, e.message);
  }
}

/* The route pattern where express knows it (/exams/:id), the raw path
   where it does not. The pattern is what makes the log groupable. */
export function auditPath(req) {
  const base = req.baseUrl || '';
  const route = req.route?.path;
  if (route && route !== '/') return `${base}${route}`;
  if (route === '/') return base || '/';
  return (req.originalUrl || req.url || '').split('?')[0];
}

/* Requests that change nothing worth keeping, or that would bury the
   log. Sign-in records itself explicitly; refresh fires every quarter
   hour per signed-in person and says nothing. */
const SKIP_PATHS = [/^\/api\/auth\/refresh$/, /^\/api\/uploads\//];

export function shouldAutoAudit(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
  if (req._audited) return false;                    // a route described it properly
  if (!req.actor) return false;                      // nobody signed in; nothing to attribute
  if (req.actor.kind === 'student') return false;    // candidate writes live on the attempt
  if (res.statusCode === 404) return false;          // never reached a route
  const url = (req.originalUrl || '').split('?')[0];
  return !SKIP_PATHS.some((re) => re.test(url));
}

/* Mounted once, globally, before the routers. The listener fires after
   the response is sent, by which point the route's own authenticate
   middleware has put the actor on the request — so one mount covers
   every router without each of them having to opt in. */
export function autoAudit(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    if (!shouldAutoAudit(req, res)) return;
    const path = auditPath(req);
    Audit.create({
      institutionId: req.actor.institutionId,
      actorId: req.actor.id,
      actorKind: req.actor.kind,
      actorName: req.actor.name,
      action: `${req.method} ${path}`,
      entity: entityFromPath(path),
      method: req.method,
      path,
      status: res.statusCode,
      ms: Date.now() - started,
      after: {
        params: redact(req.params),
        query: redact(req.query),
        body: redact(req.body),
      },
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    }).catch((e) => console.error('[audit] auto record failed', path, e.message));
  });
  next();
}

/* /api/exams/:id/publish -> exam. Good enough to filter the log by. */
export function entityFromPath(path) {
  const seg = String(path).split('/').filter(Boolean);
  const i = seg.indexOf('api');
  const name = i >= 0 ? seg[i + 1] : seg[0];
  if (!name) return undefined;
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

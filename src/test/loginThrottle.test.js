/* ============================================================
   SIGN-IN THROTTLING

   Keyed on the address alone, the old limit was wrong twice over: a
   hall of three hundred candidates shares one address through NAT, so
   twenty attempts covered the entire room and a handful of mistyped
   passwords locked everybody else out of their own examination. And
   it barely inconvenienced an attacker, who has several addresses and
   only one account to guess at.
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';

/* The key exactly as the limiter builds it. */
const key = (req) => {
  const who = String(req.body?.regNo || req.body?.email || '').trim().toLowerCase();
  return who ? `id:${who}` : `ip:${req.ip}`;
};

test('two candidates in one hall do not share a budget', () => {
  const a = key({ ip: '10.0.0.1', body: { regNo: '41720610001' } });
  const b = key({ ip: '10.0.0.1', body: { regNo: '41720610002' } });
  assert.notEqual(a, b, 'one mistyped password must not lock out the next candidate');
});

test('one account is throttled wherever the attempts come from', () => {
  const home = key({ ip: '203.0.113.9', body: { regNo: '41720610001' } });
  const hall = key({ ip: '10.0.0.1', body: { regNo: '41720610001' } });
  assert.equal(home, hall, 'changing address must not reset an account budget');
});

test('capitals and padding do not mint a fresh budget', () => {
  const plain = key({ ip: '10.0.0.1', body: { regNo: '41720610001' } });
  assert.equal(key({ ip: '10.0.0.1', body: { regNo: ' 41720610001 ' } }), plain);
  assert.equal(
    key({ ip: '10.0.0.1', body: { email: 'ANANTH@sathyabama.ac.in' } }),
    key({ ip: '10.0.0.1', body: { email: 'ananth@sathyabama.ac.in' } }),
  );
});

test('staff and candidates are keyed the same way', () => {
  assert.equal(key({ ip: '1.1.1.1', body: { email: 'a@b.ac.in' } }), 'id:a@b.ac.in');
  assert.equal(key({ ip: '1.1.1.1', body: { regNo: 'X1' } }), 'id:x1');
});

test('a request naming nobody falls back to the address', () => {
  /* Otherwise every anonymous probe would share one budget and
     exhaust it for everybody. */
  assert.equal(key({ ip: '198.51.100.7', body: {} }), 'ip:198.51.100.7');
  assert.equal(key({ ip: '198.51.100.7' }), 'ip:198.51.100.7');
});

test('both limiters are mounted on both sign-in routes', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../routes/auth.routes.js', import.meta.url), 'utf8');
  for (const route of ["r.post('/login'", "r.post('/student/login'"]) {
    const line = src.split('\n').find((l) => l.includes(route));
    assert.ok(line, `${route} not found`);
    assert.ok(line.includes('loginSourceLimiter'),
      `${route} needs the per-network limiter: one machine working through a list of register `
      + 'numbers is a different account every guess, and slips past the per-account limit entirely');
    assert.ok(line.includes('loginLimiter'), `${route} needs the per-account limiter`);
  }
});

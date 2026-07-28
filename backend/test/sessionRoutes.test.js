const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createSessionRouter } = require('../src/routes/session');

async function withServer(validator, callback, options = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/session', createSessionRouter(validator, { allowedOrigins: new Set(['http://localhost:5173']), ...options }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('session login, restore, and logout validate each time and expose only safe principal', async () => {
  const seen = [];
  await withServer(async token => {
    seen.push(token);
    return { status: 'valid', user: { id: 7, name: 'Ana', role: 'admin', token_hash: 'never-return' } };
  }, async base => {
    const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'opaque-secret' }) });
    assert.equal(login.status, 201);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=/);
    assert.doesNotMatch(JSON.stringify(await login.json()), /opaque-secret|token_hash/);
    const restore = await fetch(`${base}/api/session`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(restore.status, 200);
    assert.deepEqual(seen, ['opaque-secret', 'opaque-secret']);
    const logout = await fetch(`${base}/api/session`, { method: 'DELETE', headers: { Origin: 'http://localhost:5173', Cookie: cookie.split(';')[0] } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  }, { env: { NODE_ENV: 'development', SESSION_MAX_AGE_SECONDS: '3600' } });
});

test('session mutations reject missing or foreign origins before token validation', async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; return { status: 'valid', user: { id: 1 } }; }, async base => {
    for (const origin of [undefined, 'https://evil.example']) {
      const headers = { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) };
      const response = await fetch(`${base}/api/session`, { method: 'POST', headers, body: JSON.stringify({ token: 'secret' }) });
      assert.equal(response.status, 403);
    }
    assert.equal(calls, 0);
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCookies, sessionToken, serializeSessionCookie, cookieIsSecure } = require('../src/security/sessionCookie');
const { createCsrfProtection, requestOrigin } = require('../src/middleware/csrf');
const { configuredOrigins } = require('../src/security/origins');
const { validateSecurityConfig } = require('../src/security/securityConfig');
const { createApiAuth } = require('../src/middleware/apiAuth');

function run(middleware, req) {
  return new Promise(resolve => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; resolve({ req, res: this, next: false }); } };
    middleware(req, res, () => resolve({ req, res, next: true }));
  });
}

test('session cookie is HttpOnly Strict bounded and secure behind trusted HTTPS proxy', () => {
  const secure = serializeSessionCookie('opaque-token', { secure: true }, { env: { SESSION_MAX_AGE_SECONDS: '3600' } });
  assert.match(secure, /^nexo_session=opaque-token;/);
  assert.match(secure, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=3600; Secure$/);
  const local = serializeSessionCookie('opaque-token', { secure: false }, { env: { NODE_ENV: 'development' } });
  assert.doesNotMatch(local, /; Secure/);
  assert.equal(cookieIsSecure({ secure: true }, {}), true);
});

test('hardened cookie parser accepts an opaque session and ignores malformed input', () => {
  assert.equal(sessionToken({ headers: { cookie: 'other=x; nexo_session=abc%2F123' } }), 'abc/123');
  assert.deepEqual({ ...parseCookies('bad; ok=value; encoded=%ZZ') }, { ok: 'value' });
  assert.equal(sessionToken({ headers: { cookie: `nexo_session=${'x'.repeat(4097)}` } }), null);
});

test('cookie mutations require exact configured Origin or Referer while bearer clients are exempt', async () => {
  const allowed = configuredOrigins({ FRONTEND_URL: 'https://nexo.example' }, { warn() {} });
  const csrf = createCsrfProtection(allowed);
  assert.equal((await run(csrf, { method: 'POST', authMethod: 'cookie', headers: { origin: 'https://nexo.example' } })).next, true);
  assert.equal((await run(csrf, { method: 'DELETE', authMethod: 'cookie', headers: { referer: 'http://localhost:5173/app' } })).next, true);
  assert.equal((await run(csrf, { method: 'POST', authMethod: 'cookie', headers: {} })).res.statusCode, 403);
  assert.equal((await run(csrf, { method: 'POST', authMethod: 'cookie', headers: { origin: 'https://evil.example' } })).res.statusCode, 403);
  assert.equal((await run(csrf, { method: 'POST', authMethod: 'bearer', headers: {} })).next, true);
  assert.equal(requestOrigin({ headers: { referer: 'https://nexo.example/page' } }), 'https://nexo.example');
});

test('api auth prefers cookie, validates every request, and deprecates bearer without logging token', async () => {
  const seen = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const auth = createApiAuth(async token => { seen.push(token); return { status: 'valid', user: { id: seen.length } }; });
    const cookieReq = { method: 'GET', path: '/safe', headers: { cookie: 'nexo_session=cookie-token', authorization: 'Bearer bearer-token' } };
    assert.equal((await run(auth, cookieReq)).next, true);
    assert.equal(cookieReq.authMethod, 'cookie');
    assert.equal((await run(auth, { method: 'GET', path: '/safe', headers: { cookie: 'nexo_session=cookie-token' } })).next, true);
    const bearer = await run(auth, { method: 'GET', path: '/safe', headers: { authorization: 'Bearer api-token' } });
    assert.equal(bearer.res.headers.Deprecation, 'true');
    assert.deepEqual(seen, ['cookie-token', 'cookie-token', 'api-token']);
    assert.doesNotMatch(JSON.stringify(warnings), /cookie-token|api-token|bearer-token/);
  } finally { console.warn = originalWarn; }
});

test('production origins and cookies fail closed except explicit loopback desktop topology', () => {
  assert.throws(() => configuredOrigins({ NODE_ENV: 'production' }), /requires/);
  const remote = configuredOrigins({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://nexo.example' });
  assert.equal(remote.has('http://localhost:5173'), false);
  assert.equal(validateSecurityConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://nexo.example', HOST: '0.0.0.0' }).cookieSecure, true);
  assert.throws(() => validateSecurityConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://localhost:5173', HOST: '0.0.0.0', ALLOW_INSECURE_LOCAL_COOKIE: 'true' }), /loopback/);
  assert.throws(() => validateSecurityConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://nexo.example', HOST: '127.0.0.1', ALLOW_INSECURE_LOCAL_COOKIE: 'true' }), /loopback/);
  const local = validateSecurityConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://localhost:5173', HOST: '127.0.0.1', ALLOW_INSECURE_LOCAL_COOKIE: 'true' }, { warn() {} });
  assert.equal(local.cookieSecure, false);
  assert.equal(cookieIsSecure({ secure: false }, { NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://localhost:5173', HOST: '127.0.0.1', ALLOW_INSECURE_LOCAL_COOKIE: 'true' }, { warn() {} }), false);
});

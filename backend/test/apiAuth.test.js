const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiAuth, extractBearerToken } = require('../src/middleware/apiAuth');

function runMiddleware(middleware, req = {}) {
  return new Promise(resolve => {
    const request = { headers: {}, query: {}, ...req };
    const res = {
      statusCode: 200,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        resolve({ nextCalled: false, res: this, req: request });
      },
    };
    middleware(request, res, () => resolve({ nextCalled: true, res, req: request }));
  });
}

test('extractBearerToken accepts Authorization Bearer header', () => {
  assert.equal(extractBearerToken({ headers: { authorization: 'Bearer valid-token' } }), 'valid-token');
});

test('apiAuth accepts Authorization Bearer header and attaches user', async () => {
  let validatedToken;
  const auth = createApiAuth(async token => {
    validatedToken = token;
    return { status: 'valid', user: { id: 1, role: 'admin' } };
  });

  const req = { headers: { authorization: 'Bearer valid-token' }, query: {} };
  const result = await runMiddleware(auth, req);

  assert.equal(result.nextCalled, true);
  assert.equal(validatedToken, 'valid-token');
  assert.deepEqual(result.req.user, { id: 1, role: 'admin' });
});

test('apiAuth returns AUTH_REVOKED for a confirmed inactive token', async () => {
  const auth = createApiAuth(async () => ({ status: 'invalid', code: 'AUTH_REVOKED' }));

  const result = await runMiddleware(auth, { headers: { authorization: 'Bearer revoked-token' }, query: {} });

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.res.body.code, 'AUTH_REVOKED');
});

test('apiAuth returns safe error when token validator throws', async () => {
  const auth = createApiAuth(async () => { throw new Error('database password=secret'); });

  const result = await runMiddleware(auth, { headers: { authorization: 'Bearer valid-token' }, query: {} });

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 503);
  assert.equal(result.res.body.code, 'AUTH_UNAVAILABLE');
  assert.doesNotMatch(result.res.body.error, /secret/);
});

test('apiAuth rejects query token alone without touching token validator', async () => {
  let validateCalls = 0;
  const auth = createApiAuth(async () => {
    validateCalls += 1;
    throw new Error('validator should not be called');
  });

  const result = await runMiddleware(auth, { headers: {}, query: { token: 'legacy-query-token' } });

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.equal(validateCalls, 0);
  assert.equal(result.res.body.code, 'AUTH_INVALID');
  assert.match(result.res.body.error, /Token ausente/);
});

test('apiAuth rejects malformed non-Bearer Authorization without touching token validator', async () => {
  let validateCalls = 0;
  const auth = createApiAuth(async () => {
    validateCalls += 1;
    throw new Error('validator should not be called');
  });

  const result = await runMiddleware(auth, { headers: { authorization: 'Basic abc123' }, query: {} });

  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 401);
  assert.equal(validateCalls, 0);
});

test('apiAuth accepts only safe correlation IDs and never forwards rejected values', async () => {
  const seen = [];
  const generated = 'server-generated-id';
  const auth = createApiAuth(async (_token, context) => { seen.push(context.correlationId); return { status: 'valid', user: { id: 1 } }; }, { randomUUID: () => generated });
  const rejected = ['token.like.a.jwt', 'line\nbreak', 'x'.repeat(65)];

  for (const correlationId of rejected) {
    const result = await runMiddleware(auth, { headers: { authorization: 'Bearer valid-token', 'x-correlation-id': correlationId } });
    assert.equal(result.res.headers['x-correlation-id'], generated);
  }
  await runMiddleware(auth, { headers: { authorization: 'Bearer valid-token', 'x-correlation-id': 'safe_ID-123' } });
  assert.deepEqual(seen, [generated, generated, generated, 'safe_ID-123']);
  assert.equal(JSON.stringify(seen).includes('token.like.a.jwt'), false);
  assert.equal(JSON.stringify(seen).includes('line\\nbreak'), false);
  assert.equal(JSON.stringify(seen).includes('x'.repeat(65)), false);
});

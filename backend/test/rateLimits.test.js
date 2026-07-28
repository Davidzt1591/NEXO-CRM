const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  CONFIG_BOUNDS,
  DEFAULTS,
  createPostAuthLimiters,
  createPreAuthApiLimiter,
  createSessionLimiter,
  rateLimitConfig,
  trustProxySetting,
} = require('../src/middleware/rateLimits');

test('session route limiter is strict and returns safe 429 metadata', async () => {
  await withServer(app => {
    app.use('/api/session', createSessionLimiter({ mutationWindowMs: 60_000, mutationMax: 2 }));
    app.post('/api/session', (_req, res) => res.json({ ok: true }));
  }, async base => {
    assert.equal((await fetch(`${base}/api/session`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/api/session`, { method: 'POST' })).status, 200);
    const limited = await fetch(`${base}/api/session`, { method: 'POST' });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'RATE_LIMITED');
  });
});

const MUTATION_ROUTES = [
  ['POST', '/api/sf/cases'],
  ['PATCH', '/api/sf/cases/500xx000001'],
  ['POST', '/api/sf/cases/500xx000001/close'],
  ['PATCH', '/api/sf/cases/500xx000001/assign-me'],
  ['PUT', '/api/candidates/chat-1'],
  ['DELETE', '/api/candidates/chat-1'],
  ['POST', '/api/admin/areas'],
  ['PATCH', '/api/admin/areas/1'],
  ['POST', '/api/admin/analysts'],
  ['PATCH', '/api/admin/analysts/1'],
  ['PUT', '/api/admin/candidate-settings'],
  ['POST', '/api/admin/agent-tokens'],
  ['POST', '/api/admin/agent-tokens/7/revoke'],
  ['POST', '/api/admin/salesforce-outbox/1/retry'],
  ['POST', '/api/admin/tickets/1/assign'],
  ['POST', '/api/admin/tickets/1/unassign'],
  ['POST', '/api/admin/tickets/1/transfer'],
  ['PUT', '/api/admin/bot-flow-studio/layout'],
  ['POST', '/api/admin/bot-flows'],
  ['PATCH', '/api/admin/bot-flows/1'],
  ['POST', '/api/admin/bot-flows/1/toggle'],
  ['POST', '/api/admin/bot-flows/cache/invalidate'],
];

const PROCESSOR_ROUTES = [
  ['POST', '/api/admin/salesforce-outbox/process'],
  ['POST', '/api/admin/ticket-post-processing/process'],
];

async function withServer(configure, run) {
  const app = express();
  app.use(express.json());
  configure(app);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('default API limiter allows more than 100 representative admin GET requests', async () => {
  await withServer(app => {
    app.use('/api', createPreAuthApiLimiter(rateLimitConfig({})));
    app.get('/api/admin/queue', (_req, res) => res.json({ ok: true }));
  }, async base => {
    for (let index = 0; index < 101; index += 1) {
      const response = await fetch(`${base}/api/admin/queue`);
      assert.equal(response.status, 200);
    }
  });
});

test('configured API limit returns safe structured 429 and health never consumes quota', async () => {
  await withServer(app => {
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.use('/api', createPreAuthApiLimiter({ ...rateLimitConfig({}), apiMax: 1, apiWindowMs: 60_000 }));
    app.get('/api/data', (_req, res) => res.json({ ok: true }));
  }, async base => {
    for (let index = 0; index < 5; index += 1) assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/data`)).status, 200);
    const limited = await fetch(`${base}/api/data`);
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('ratelimit'), /r=/);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const body = await limited.json();
    assert.equal(body.code, 'RATE_LIMITED');
    assert.ok(body.retryAfterSeconds > 0);
    assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1/);
  });
});

test('post-auth processor and mutation limits are stricter while GET and simulator remain unthrottled', async () => {
  const config = { ...rateLimitConfig({}), mutationMax: 1, processorMax: 1, mutationWindowMs: 60_000, processorWindowMs: 60_000 };
  await withServer(app => {
    app.use('/api', (req, _res, next) => { req.user = { id: 42 }; next(); }, createPostAuthLimiters(config, { RATE_LIMIT_KEY_SECRET: 'test-secret' }));
    app.all('/api/*path', (_req, res) => res.json({ ok: true }));
  }, async base => {
    assert.equal((await fetch(`${base}/api/admin/candidate-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/candidate-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
    assert.equal((await fetch(`${base}/api/admin/salesforce-outbox/process`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/salesforce-outbox/process`, { method: 'POST' })).status, 429);
    for (let index = 0; index < 3; index += 1) assert.equal((await fetch(`${base}/api/admin/queue`)).status, 200);
    for (let index = 0; index < 3; index += 1) assert.equal((await fetch(`${base}/api/admin/bot-flow-studio/simulate`, { method: 'POST' })).status, 200);
  });
});

test('agent-token mutations share the authenticated principal quota and return exact safe 429 metadata', async () => {
  const config = { ...rateLimitConfig({}), mutationMax: 1, mutationWindowMs: 60_000 };
  await withServer(app => {
    app.use('/api', (req, _res, next) => { req.user = { id: 73 }; next(); }, createPostAuthLimiters(config, { RATE_LIMIT_KEY_SECRET: 'test-secret' }));
    app.all('/api/*path', (_req, res) => res.json({ ok: true }));
  }, async base => {
    assert.equal((await fetch(`${base}/api/admin/agent-tokens`, { method: 'POST' })).status, 200);
    const limited = await fetch(`${base}/api/admin/agent-tokens/7/revoke`, { method: 'POST' });
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.code, 'RATE_LIMITED');
    assert.match(body.error, /límite de solicitudes/);
    assert.ok(body.retryAfterSeconds > 0);
  });
});

test('sensitive limiter matches every external, mutation, retry, and processor route by method and normalized path', async () => {
  for (const [method, path] of [...MUTATION_ROUTES, ...PROCESSOR_ROUTES]) {
    await withServer(app => {
      const config = { ...rateLimitConfig({}), mutationMax: 1, processorMax: 1, mutationWindowMs: 60_000, processorWindowMs: 60_000 };
      app.use('/api', (req, _res, next) => { req.user = { id: `${method}:${path}` }; next(); }, createPostAuthLimiters(config, { RATE_LIMIT_KEY_SECRET: 'test-secret' }));
      app.all('/api/*path', (_req, res) => res.json({ ok: true }));
    }, async base => {
      const normalizedVariant = `${path}/`.replace('/api//', '/api/');
      assert.equal((await fetch(`${base}${path}`, { method })).status, 200, `${method} ${path} first request`);
      assert.equal((await fetch(`${base}${normalizedVariant}`, { method })).status, 429, `${method} ${path} must be limited`);
    });
  }
});

test('route matching does not throttle read traffic, simulator, or wrong methods', async () => {
  await withServer(app => {
    const config = { ...rateLimitConfig({}), mutationMax: 1, mutationWindowMs: 60_000 };
    app.use('/api', (req, _res, next) => { req.user = { id: 42 }; next(); }, createPostAuthLimiters(config, {}));
    app.all('/api/*path', (_req, res) => res.json({ ok: true }));
  }, async base => {
    for (let index = 0; index < 3; index += 1) {
      assert.equal((await fetch(`${base}/api/admin/queue`)).status, 200);
      assert.equal((await fetch(`${base}/api/admin/bot-flow-studio/simulate`, { method: 'POST' })).status, 200);
      assert.equal((await fetch(`${base}/api/sf/cases/1`, { method: 'DELETE' })).status, 200);
    }
  });
});

test('rate-limit env values accept inclusive safe boundaries and fail closed to defaults with safe warnings', () => {
  const warnings = [];
  const logger = { warn: (message, metadata) => warnings.push([message, metadata]) };
  const atBounds = rateLimitConfig({
    API_RATE_LIMIT_WINDOW_MS: String(CONFIG_BOUNDS.apiWindowMs.min),
    API_RATE_LIMIT_MAX: String(CONFIG_BOUNDS.apiMax.max),
    MUTATION_RATE_LIMIT_WINDOW_MS: String(CONFIG_BOUNDS.mutationWindowMs.max),
    MUTATION_RATE_LIMIT_MAX: String(CONFIG_BOUNDS.mutationMax.min),
    PROCESSOR_RATE_LIMIT_WINDOW_MS: String(CONFIG_BOUNDS.processorWindowMs.min),
    PROCESSOR_RATE_LIMIT_MAX: String(CONFIG_BOUNDS.processorMax.max),
  }, logger);
  assert.deepEqual(atBounds, {
    apiWindowMs: CONFIG_BOUNDS.apiWindowMs.min,
    apiMax: CONFIG_BOUNDS.apiMax.max,
    mutationWindowMs: CONFIG_BOUNDS.mutationWindowMs.max,
    mutationMax: CONFIG_BOUNDS.mutationMax.min,
    processorWindowMs: CONFIG_BOUNDS.processorWindowMs.min,
    processorMax: CONFIG_BOUNDS.processorMax.max,
  });
  assert.equal(warnings.length, 0);

  const invalid = rateLimitConfig({
    API_RATE_LIMIT_WINDOW_MS: '0',
    API_RATE_LIMIT_MAX: String(CONFIG_BOUNDS.apiMax.max + 1),
    MUTATION_RATE_LIMIT_WINDOW_MS: String(2 ** 31),
    MUTATION_RATE_LIMIT_MAX: 'not-a-number',
    PROCESSOR_RATE_LIMIT_WINDOW_MS: '-1',
    PROCESSOR_RATE_LIMIT_MAX: String(Number.MAX_SAFE_INTEGER + 1),
  }, logger);
  assert.deepEqual(invalid, DEFAULTS);
  assert.equal(warnings.length, 6);
  assert.ok(warnings.every(([message, metadata]) => message === 'rate_limit_config_fallback' && Object.keys(metadata).sort().join(',') === 'fallback,setting'));
});

test('proxy trust defaults direct, rejects numeric/invalid config, and ignores spoofed XFF for quota', async () => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  assert.equal(trustProxySetting({}), false);
  assert.equal(trustProxySetting({ TRUST_PROXY_HOPS: '1' }, logger), false);
  assert.equal(trustProxySetting({ TRUST_PROXY_CIDRS: '' }, logger), false);
  assert.equal(trustProxySetting({ TRUST_PROXY_CIDRS: 'not-a-cidr' }, logger), false);
  assert.equal(warnings.length, 2);
  await withServer(app => {
    app.set('trust proxy', trustProxySetting({}));
    app.use('/api', createPreAuthApiLimiter({ ...rateLimitConfig({}), apiMax: 1, apiWindowMs: 60_000 }));
    app.get('/api/ip', (req, res) => res.json({ ip: req.ip }));
  }, async base => {
    const direct = await fetch(`${base}/api/ip`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    assert.notEqual((await direct.json()).ip, '203.0.113.7');
    assert.equal((await fetch(`${base}/api/ip`, { headers: { 'X-Forwarded-For': '198.51.100.9' } })).status, 429);
  });
});

test('explicit trusted loopback proxy can convey distinct client IPs', async () => {
  await withServer(app => {
    app.set('trust proxy', trustProxySetting({ TRUST_PROXY_CIDRS: 'loopback' }));
    app.use('/api', createPreAuthApiLimiter({ ...rateLimitConfig({}), apiMax: 1, apiWindowMs: 60_000 }));
    app.get('/api/ip', (req, res) => res.json({ ip: req.ip }));
  }, async base => {
    const proxied = await fetch(`${base}/api/ip`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    assert.equal((await proxied.json()).ip, '203.0.113.7');
    assert.equal((await fetch(`${base}/api/ip`, { headers: { 'X-Forwarded-For': '198.51.100.9' } })).status, 200);
  });
});

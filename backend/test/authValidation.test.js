const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthValidator } = require('../src/services/authValidation');

const valid = { status: 'valid', user: { id: 1, role: 'agent' } };
const transient = code => Object.assign(new Error('safe failure'), { code });

test('retries only known transient codes and recovers with jittered sleep', async () => {
  let calls = 0; const delays = [];
  const validator = createAuthValidator(async () => { if (++calls < 3) throw transient('ENOTFOUND'); return valid; }, { sleep: async ms => delays.push(ms), random: () => 0.5, attemptTimeoutMs: 100 });
  assert.deepEqual(await validator.validate('secret'), valid);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [25, 50]);
});

test('fails closed after transient exhaustion and does not retry deterministic errors', async () => {
  let transientCalls = 0;
  const exhausted = createAuthValidator(async () => { transientCalls += 1; throw transient('ECONNRESET'); }, { sleep: async () => {}, attemptTimeoutMs: 100 });
  await assert.rejects(exhausted.validate('secret'));
  assert.equal(transientCalls, 3);
  let deterministicCalls = 0;
  const deterministic = createAuthValidator(async () => { deterministicCalls += 1; throw transient('CERT_HAS_EXPIRED'); }, { attemptTimeoutMs: 100 });
  await assert.rejects(deterministic.validate('secret'));
  assert.equal(deterministicCalls, 1);
});

test('bounds each attempt by a deadline', async () => {
  const validator = createAuthValidator((_token, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { maxAttempts: 1, attemptTimeoutMs: 5 });
  await assert.rejects(validator.validate('secret'), error => error.code === 'ETIMEDOUT');
});

test('aborts a timed-out operation before starting the next attempt and prevents late effects', async () => {
  const events = [];
  let attempts = 0;
  const validator = createAuthValidator((_token, { signal }) => {
    attempts += 1;
    const attempt = attempts;
    events.push(`start-${attempt}`);
    if (attempt === 2) return Promise.resolve(valid);
    return new Promise((resolve, reject) => {
      const late = setTimeout(() => { events.push('late-effect'); resolve(valid); }, 50);
      signal.addEventListener('abort', () => { clearTimeout(late); events.push('abort-1'); reject(signal.reason); }, { once: true });
    });
  }, { maxAttempts: 2, attemptTimeoutMs: 5, sleep: async () => {} });

  assert.deepEqual(await validator.validate('secret'), valid);
  assert.deepEqual(events, ['start-1', 'abort-1', 'start-2']);
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal(events.includes('late-effect'), false);
});

test('bounds unique inflight validation globally while preserving same-token deduplication', async () => {
  const resolvers = [];
  let calls = 0;
  const validator = createAuthValidator(() => {
    calls += 1;
    if (calls > 2) return Promise.resolve(valid);
    return new Promise(resolve => resolvers.push(resolve));
  }, { maxInflight: 2, attemptTimeoutMs: 1_000 });

  const first = validator.validate('one');
  const duplicate = validator.validate('one');
  const second = validator.validate('two');
  await assert.rejects(validator.validate('three'), error => error.code === 'AUTH_OVERLOADED');
  assert.equal(calls, 2);
  resolvers.forEach(resolve => resolve(valid));
  await Promise.all([first, duplicate, second]);
  await validator.validate('three');
  assert.equal(calls, 3);
});

test('revalidates a token after each completed request and rejects immediate revocation', async () => {
  let calls = 0;
  const validator = createAuthValidator(async () => {
    calls += 1;
    return calls === 1 ? valid : { status: 'invalid', code: 'AUTH_REVOKED' };
  });
  assert.deepEqual(await validator.validate('same-token'), valid);
  assert.deepEqual(await validator.validate('same-token'), { status: 'invalid', code: 'AUTH_REVOKED' });
  assert.equal(calls, 2);
});

test('never caches invalid or unavailable and deduplicates concurrent validation', async () => {
  let resolve; let calls = 0;
  const validator = createAuthValidator(() => { calls += 1; return new Promise(done => { resolve = done; }); }, { attemptTimeoutMs: 100 });
  const first = validator.validate('raw-token'); const second = validator.validate('raw-token');
  resolve(valid);
  assert.deepEqual(await Promise.all([first, second]), [valid, valid]);
  assert.equal(calls, 1);

  let invalidCalls = 0;
  const invalid = createAuthValidator(async () => { invalidCalls += 1; return { status: 'invalid', code: 'AUTH_REVOKED' }; });
  await invalid.validate('raw-token'); await invalid.validate('raw-token');
  assert.equal(invalidCalls, 2);
});

test('safe telemetry contains no token, digest, raw error, URL, or identity fields', async () => {
  const events = [];
  const validator = createAuthValidator(async () => { throw transient('EAI_AGAIN'); }, { maxAttempts: 1, logger: { warn: (...args) => events.push(args) } });
  await assert.rejects(validator.validate('top-secret', { eventType: 'rest_auth', route: '/api/template', correlationId: 'cid' }));
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /top-secret|safe failure|https?:|user|chat|message/i);
  assert.match(serialized, /EAI_AGAIN|rest_auth|cid/);
});

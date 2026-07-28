const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createClassificationState,
  lookupCandidateClassification,
} = require('../src/services/classificationReliability');

const config = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

test('classification telemetry is structured and excludes raw failure details', async () => {
  const entries = [];
  let captured;
  const state = createClassificationState();
  const result = await lookupCandidateClassification({
    lookup: async () => { throw Object.assign(new Error('token=secret phone=573001112233 https://private.test'), { code: 'ETIMEDOUT' }); },
    state, config, sleep: async () => {}, random: () => 0, now: () => 100,
    logger: { log: (...args) => entries.push(args), warn: (...args) => entries.push(args), error: (...args) => entries.push(args) },
    captureException: (...args) => { captured = args; },
  });

  assert.deepEqual(result, { ok: false, attempts: 3, causeCode: 'ETIMEDOUT' });
  assert.equal(entries.length, 3);
  for (const [event, fields] of entries) {
    assert.equal(event, 'candidate_classification_lookup');
    assert.deepEqual(Object.keys(fields).sort(), ['attempt', 'causeCode', 'latencyMs', 'outcome']);
    assert.doesNotMatch(JSON.stringify(fields), /secret|573001112233|private\.test|token|stack|message/i);
  }
  assert.equal(captured[0].name, 'CandidateClassificationFailure');
  assert.equal(captured[0].cause, undefined);
  assert.doesNotMatch(captured[0].stack, /secret|573001112233|private\.test|token/i);
  assert.deepEqual(captured[1], { tags: { component: 'candidate_classification', code: 'ETIMEDOUT', attempts: '3', outcome: 'terminal_drop' } });
  assert.deepEqual(state.publicView(), {
    status: 'degraded', transientFailures: 3, recoveredAfterRetry: 0, terminalDrops: 1,
    lastFailureTimestamp: '1970-01-01T00:00:00.100Z', lastFailureCode: 'ETIMEDOUT',
  });
});

test('deterministic classification failure is attempted once', async () => {
  let calls = 0;
  const state = createClassificationState();
  const result = await lookupCandidateClassification({
    lookup: async () => { calls += 1; throw Object.assign(new Error('invalid query'), { code: '42703' }); },
    state, config, logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: false, attempts: 1, causeCode: '42703' });
  assert.equal(state.transientFailures, 0);
  assert.equal(state.terminalDrops, 1);
});

test('arbitrary codes and nested sensitive details are normalized across logs, health and Sentry', async () => {
  const forbidden = /API_TOKEN_SUPERSECRET123|bearer-secret|private\.example|573009998888/i;
  const entries = [];
  let captured;
  const state = createClassificationState();
  const sensitive = Object.assign(new Error('Bearer bearer-secret https://private.example/573009998888@c.us'), {
    code: 'API_TOKEN_SUPERSECRET123',
    cause: Object.assign(new Error('nested bearer-secret'), { code: 'ANOTHER_SECRET_CODE' }),
  });

  const result = await lookupCandidateClassification({
    lookup: async () => { throw sensitive; }, state, config,
    logger: { log: (...args) => entries.push(args), warn: (...args) => entries.push(args), error: (...args) => entries.push(args) },
    captureException: (...args) => { captured = args; },
  });

  assert.deepEqual(result, { ok: false, attempts: 1, causeCode: 'UNKNOWN_ERROR' });
  assert.equal(forbidden.test(JSON.stringify(entries)), false);
  assert.equal(forbidden.test(JSON.stringify(state.publicView())), false);
  assert.equal(state.publicView().lastFailureCode, 'UNKNOWN_ERROR');
  assert.equal(forbidden.test(JSON.stringify([captured[0].message, captured[0].code, captured[1]])), false);
  assert.equal(captured[0].message, 'Candidate classification lookup terminal_drop (UNKNOWN_ERROR)');
  assert.deepEqual(captured[1].tags, { component: 'candidate_classification', code: 'UNKNOWN_ERROR', attempts: '1', outcome: 'terminal_drop' });
});

test('recovery counter and telemetry record the successful retry attempt', async () => {
  let calls = 0;
  const logs = [];
  const state = createClassificationState();
  const result = await lookupCandidateClassification({
    lookup: async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('temporary'), { code: 'EAI_AGAIN' }); return null; },
    state, config, sleep: async () => {}, random: () => 0, now: () => 10,
    logger: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(state.transientFailures, 2);
  assert.equal(state.recoveredAfterRetry, 1);
  assert.equal(logs.at(-1)[1].outcome, 'recovered');
  assert.equal(logs.at(-1)[1].attempt, 3);
});

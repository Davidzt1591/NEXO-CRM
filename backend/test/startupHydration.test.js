const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createHealthHandler, createStartupState, hydrateThenStart, isRetryableTransportError } = require('../src/startup');
const { createClassificationState } = require('../src/services/classificationReliability');

const quietLogger = { log() {}, warn() {}, error() {} };
const config = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

function fetchFailure(code = 'ENOTFOUND') {
  return new Error('Unable to load persisted bot sessions.', { cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('network'), { code }) }) });
}

function health(state) {
  let statusCode;
  let body;
  createHealthHandler(state)(null, { status(code) { statusCode = code; return this; }, json(value) { body = value; return this; } });
  return { statusCode, body };
}

test('retries hydration, remains unready until one WhatsApp start resolves', async () => {
  const state = createStartupState(() => 100);
  let calls = 0;
  let whatsappStarts = 0;
  const result = await hydrateThenStart({
    state, config, logger: quietLogger, sleep: async () => {}, random: () => 0, now: () => 100,
    hydrate: async () => { calls += 1; if (calls === 1) throw fetchFailure(); return 2; },
    startWhatsApp: async () => {
      assert.equal(state.ready, false);
      assert.equal(health(state).statusCode, 503);
      whatsappStarts += 1;
    },
  });
  assert.equal(result.ready, true);
  assert.equal(calls, 2);
  assert.equal(whatsappStarts, 1);
  assert.equal(health(state).statusCode, 200);
  assert.deepEqual(health(state).body, { status: 'ready', ready: true });
});

test('exhausted retries remain degraded and never start WhatsApp', async () => {
  const state = createStartupState(() => 0);
  let starts = 0;
  let captured;
  const original = fetchFailure('ETIMEDOUT');
  const result = await hydrateThenStart({
    state, config, logger: quietLogger, sleep: async () => {}, random: () => 0, now: () => 10,
    hydrate: async () => { throw original; },
    startWhatsApp: async () => { starts += 1; }, captureException: (...args) => { captured = args; },
  });
  assert.equal(result.ready, false);
  assert.equal(result.attempts, 3);
  assert.equal(starts, 0);
  assert.notEqual(captured[0], original);
  assert.equal(captured[0].name, 'StartupFailure');
  assert.equal(captured[0].code, 'ETIMEDOUT');
  assert.equal(captured[0].cause, undefined);
  assert.doesNotMatch(captured[0].stack, /Unable to load persisted|fetch failed|network/i);
  assert.deepEqual(captured[1], { tags: { component: 'startup', phase: 'session_hydration', code: 'ETIMEDOUT', attempts: '3' } });
  assert.equal('extra' in captured[1], false);
  assert.equal(health(state).statusCode, 503);
  assert.equal(health(state).body.status, 'degraded');
  assert.deepEqual(health(state).body, { status: 'degraded', ready: false });
});

test('deterministic Supabase errors are not retried', async () => {
  const state = createStartupState(() => 0);
  let calls = 0;
  const error = Object.assign(new Error('column does not exist'), { code: '42703' });
  const result = await hydrateThenStart({ state, config, logger: quietLogger, now: () => 1, hydrate: async () => { calls += 1; throw error; }, startWhatsApp: async () => assert.fail() });
  assert.equal(result.ready, false);
  assert.equal(calls, 1);
});

test('successful empty hydration is ready and starts WhatsApp', async () => {
  const state = createStartupState(() => 5);
  let started = false;
  const result = await hydrateThenStart({ state, config, logger: quietLogger, now: () => 6, hydrate: async () => 0, startWhatsApp: async () => { started = true; } });
  assert.equal(result.sessionCount, 0);
  assert.equal(started, true);
  assert.equal(health(state).statusCode, 200);
});

test('WhatsApp rejection stays degraded and is never retried', async () => {
  const state = createStartupState(() => 0);
  const original = Object.assign(new Error('endpoint https://secret.example failed'), {
    cause: Object.assign(new Error('request metadata'), { code: 'ECONNRESET' }),
  });
  let starts = 0;
  let captured;
  const result = await hydrateThenStart({
    state, config, logger: quietLogger, now: () => 7,
    hydrate: async () => 4,
    startWhatsApp: async () => { starts += 1; throw original; },
    captureException: (...args) => { captured = args; },
  });
  assert.equal(starts, 1);
  assert.deepEqual(result, { ready: false, attempts: 1, causeCode: 'WHATSAPP_INIT_FAILED' });
  assert.equal(health(state).statusCode, 503);
  assert.equal(state.causeCode, 'WHATSAPP_INIT_FAILED');
  assert.notEqual(captured[0], original);
  assert.equal(captured[0].cause, undefined);
  assert.doesNotMatch(captured[0].message, /secret|endpoint|request metadata/i);
  assert.deepEqual(captured[1], { tags: { component: 'startup', phase: 'whatsapp_init', code: 'WHATSAPP_INIT_FAILED', attempts: '1' } });
});

test('only known transient transport codes are retryable', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(isRetryableTransportError(Object.assign(new Error('transport'), { code })), true, code);
  }
  const nestedFetch = new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'EAI_AGAIN' }) });
  assert.equal(isRetryableTransportError(nestedFetch), true);
  assert.equal(isRetryableTransportError(new TypeError('fetch failed')), false);
});

test('certificate codes and message-only TLS errors are deterministic', () => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    assert.equal(isRetryableTransportError(Object.assign(new Error('certificate failed'), { code })), false, code);
  }
  assert.equal(isRetryableTransportError(new Error('TLS certificate handshake failed')), false);
});

test('public HTTP /health exposes only minimal readiness state', async t => {
  const startupState = createStartupState(() => 0);
  startupState.status = 'ready';
  startupState.ready = true;
  const candidateState = createClassificationState();
  candidateState.transientFailures = 2;
  candidateState.recoveredAfterRetry = 1;
  candidateState.terminalDrops = 1;
  candidateState.lastFailureTimestamp = '2026-07-17T12:00:00.000Z';
  candidateState.lastFailureCode = 'UNKNOWN_ERROR';

  const app = express();
  app.get('/health', createHealthHandler(startupState, () => 42, { candidateClassification: candidateState }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: 'ready', ready: true });
  assert.doesNotMatch(JSON.stringify(body), /diagnostics|cache|capacity|inflight|revocation|attempt|latency|uptime|message|stack|cause|url|chat|identifier|content|token/i);
});

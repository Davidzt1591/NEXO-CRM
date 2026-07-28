const test = require('node:test');
const assert = require('node:assert/strict');
const { createPassiveSocketRevalidator, createSocketAuthMiddleware, createSocketEventAuthMiddleware, passiveRevalidationInterval } = require('../src/middleware/socketAuth');

function runAuth(validator, token = 'opaque-token') {
  const socket = { handshake: { auth: {}, query: {}, headers: { cookie: `nexo_session=${encodeURIComponent(token)}` } } };
  return new Promise(resolve => createSocketAuthMiddleware(validator)(socket, error => resolve({ socket, error })));
}

function runHandshake(validator, handshake, options) {
  const socket = { handshake };
  return new Promise(resolve => createSocketAuthMiddleware(validator, options)(socket, error => resolve({ socket, error })));
}

test('socket auth exposes safe machine codes for invalid, revoked, and unavailable states', async () => {
  const invalid = await runAuth(async () => ({ status: 'invalid', code: 'AUTH_INVALID' }));
  const revoked = await runAuth(async () => ({ status: 'invalid', code: 'AUTH_REVOKED' }));
  const unavailable = await runAuth(async () => { throw new Error('database password=secret'); });

  assert.equal(invalid.error.data.code, 'AUTH_INVALID');
  assert.equal(revoked.error.data.code, 'AUTH_REVOKED');
  assert.equal(unavailable.error.data.code, 'AUTH_UNAVAILABLE');
  assert.doesNotMatch(unavailable.error.message, /secret|opaque-token/);
});

test('socket auth attaches a validated user', async () => {
  const result = await runAuth(async () => ({ status: 'valid', user: { id: 7, role: 'admin' } }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.socket.user, { id: 7, role: 'admin' });
});

test('socket auth rejects a query-only token without passing it to validation', async () => {
  let validationCalls = 0;
  const validator = async () => {
    validationCalls += 1;
    return { status: 'valid', user: { id: 7 } };
  };
  const result = await runHandshake(validator, { auth: {}, query: { token: 'query-secret' }, headers: {} });

  assert.equal(result.error.data.code, 'AUTH_INVALID');
  assert.equal(result.error.message.includes('query-secret'), false);
  assert.equal(validationCalls, 0);
});

test('socket auth replaces unsafe correlation IDs before telemetry and does not echo them', async () => {
  let context;
  const generated = 'server-generated-id';
  const result = await runHandshake(async (_token, value) => { context = value; throw new Error('offline'); }, {
    auth: {}, query: {}, headers: { cookie: 'nexo_session=opaque-token', 'x-correlation-id': 'jwt.like.value\n' },
  }, { randomUUID: () => generated });

  assert.equal(context.correlationId, generated);
  assert.equal(result.error.data.attemptId, undefined);
  assert.doesNotMatch(JSON.stringify(context), /jwt\.like\.value/);
});

test('socket auth ignores token auth payload when no HttpOnly cookie is present', async () => {
  let calls = 0;
  const result = await runHandshake(async () => { calls += 1; }, { auth: { token: 'js-secret' }, query: {}, headers: {} });
  assert.equal(result.error.data.code, 'AUTH_INVALID');
  assert.equal(calls, 0);
});

function runEventAuth(validator, analyst, socket = {}) {
  const value = {
    sessionToken: 'opaque-token', user: { id: 1, role: 'admin' }, analyst: { id: 9, area_id: 3 },
    emit: () => {}, disconnect: () => {}, join: () => {}, leave: () => {}, ...socket,
  };
  return new Promise(resolve => createSocketEventAuthMiddleware(validator, async () => analyst)(value, ['privileged-event'], error => resolve({ socket: value, error })));
}

test('socket event auth revalidates and refreshes role, analyst, area, and rooms before execution', async () => {
  const joined = []; const left = [];
  const result = await runEventAuth(async () => ({ status: 'valid', user: { id: 1, role: 'agent', name: 'Ana' } }), { id: 10, area_id: 4 }, {
    join: room => joined.push(room), leave: room => left.push(room),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.socket.user.role, 'agent');
  assert.deepEqual(result.socket.analyst, { id: 10, area_id: 4 });
  assert.deepEqual(left.sort(), ['admin', 'analyst:9', 'area:3'].sort());
  assert.deepEqual(joined.sort(), ['analyst:10', 'area:4'].sort());
});

test('revoked event auth disconnects and unavailable auth rejects without executing or disconnecting', async () => {
  const revokedEvents = []; let revokedDisconnect = false;
  const revoked = await runEventAuth(async () => ({ status: 'invalid', code: 'AUTH_REVOKED' }), null, {
    emit: (event, payload) => revokedEvents.push([event, payload]), disconnect: () => { revokedDisconnect = true; },
  });
  assert.equal(revoked.error.message, 'AUTH_REVOKED');
  assert.equal(revokedDisconnect, true);
  assert.equal(revokedEvents[0][1].code, 'AUTH_REVOKED');

  const unavailableEvents = []; let unavailableDisconnect = false;
  const unavailable = await runEventAuth(async () => { throw new Error('secret backend'); }, null, {
    emit: (event, payload) => unavailableEvents.push([event, payload]), disconnect: () => { unavailableDisconnect = true; },
  });
  assert.equal(unavailable.error.message, 'AUTH_UNAVAILABLE');
  assert.equal(unavailableDisconnect, false);
  assert.equal(unavailableEvents[0][1].code, 'AUTH_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unavailableEvents), /secret/);
});

function passiveHarness(validator, analyst = null) {
  let tick; let cleared = false; let unref = false;
  const joined = []; const left = []; const emitted = []; let disconnected = false;
  const socket = { connected: true, sessionToken: 'opaque-token', user: { id: 1, role: 'admin' }, analyst: { id: 9, area_id: 3 },
    join: room => joined.push(room), leave: room => left.push(room), emit: (event, payload) => emitted.push([event, payload]), disconnect: () => { disconnected = true; socket.connected = false; } };
  const stop = createPassiveSocketRevalidator(socket, validator, async () => analyst, {
    intervalMs: 15_000,
    setIntervalFn: callback => { tick = callback; return { unref: () => { unref = true; } }; },
    clearIntervalFn: () => { cleared = true; },
  });
  return { socket, tick: async () => { await tick(); }, stop, joined, left, emitted, disconnected: () => disconnected, cleared: () => cleared, unref: () => unref };
}

test('idle passive auth disconnects revoked sockets and clears protected principal and rooms', async () => {
  const harness = passiveHarness(async () => ({ status: 'invalid', code: 'AUTH_REVOKED' }));
  assert.equal(harness.unref(), true);
  await harness.tick();
  assert.equal(harness.disconnected(), true);
  assert.deepEqual(harness.left.sort(), ['admin', 'analyst:9', 'area:3'].sort());
  assert.equal(harness.socket.user, null); assert.equal(harness.socket.analyst, null); assert.equal(harness.socket.sessionToken, null);
  assert.equal(harness.emitted[0][1].code, 'AUTH_REVOKED');
  assert.equal(harness.cleared(), true);
});

test('idle passive auth reconciles changed role and area without disconnecting', async () => {
  const harness = passiveHarness(async () => ({ status: 'valid', user: { id: 1, role: 'agent' } }), { id: 10, area_id: 4 });
  await harness.tick();
  assert.equal(harness.disconnected(), false);
  assert.deepEqual(harness.left.sort(), ['admin', 'analyst:9', 'area:3'].sort());
  assert.deepEqual(harness.joined.sort(), ['analyst:10', 'area:4'].sort());
});

test('idle unavailable auth leaves protected rooms, disconnects, prevents overlap, and timer cleanup is idempotent', async () => {
  let release; let calls = 0;
  const harness = passiveHarness(async () => { calls += 1; await new Promise(resolve => { release = resolve; }); throw new Error('offline'); });
  const first = harness.tick(); await Promise.resolve();
  await harness.tick(); assert.equal(calls, 1);
  release(); await first;
  assert.equal(harness.disconnected(), true);
  assert.deepEqual(harness.left.sort(), ['admin', 'analyst:9', 'area:3'].sort());
  assert.equal(harness.emitted[0][1].code, 'AUTH_UNAVAILABLE');
  assert.equal(harness.cleared(), true);
  harness.stop(); harness.stop(); assert.equal(harness.cleared(), true);
});

test('passive interval is safely bounded', () => {
  assert.equal(passiveRevalidationInterval({}), 20_000);
  assert.equal(passiveRevalidationInterval({ SOCKET_AUTH_REVALIDATE_MS: '15000' }), 15_000);
  assert.equal(passiveRevalidationInterval({ SOCKET_AUTH_REVALIDATE_MS: '30000' }), 30_000);
  assert.equal(passiveRevalidationInterval({ SOCKET_AUTH_REVALIDATE_MS: '5000' }), 20_000);
});

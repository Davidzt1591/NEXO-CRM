const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const express = require('express');
const adminOnly = require('../src/middleware/adminOnly');

const adminPath = path.resolve(__dirname, '../src/routes/admin.js');
const dbPath = path.resolve(__dirname, '../src/database/db.js');
const botFlowPath = path.resolve(__dirname, '../src/services/botFlow.js');

function loadAdminRouter(mockDb) {
  delete require.cache[adminPath];
  delete require.cache[botFlowPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: mockDb,
  };
  return require(adminPath);
}

async function withServer(mockDb, user, run, io = null) {
  const app = express();
  if (io) app.set('io', io);
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/admin', adminOnly, loadAdminRouter(mockDb));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    return await run(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete require.cache[adminPath];
    delete require.cache[botFlowPath];
    delete require.cache[dbPath];
  }
}

function createIo() {
  const emissions = [];
  return {
    emissions,
    to(room) {
      const rooms = [room];
      const chain = {
        to(nextRoom) {
          rooms.push(nextRoom);
          return chain;
        },
        emit(event, payload) {
          emissions.push({ rooms: [...rooms], event, payload });
        },
      };
      return chain;
    },
    emit(event, payload) {
      emissions.push({ rooms: ['*'], event, payload });
    },
  };
}

async function request(baseUrl, method, pathname, body) {
  const url = new URL(pathname, baseUrl);
  const payload = body ? JSON.stringify(body) : null;

  return await new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : undefined,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: raw ? JSON.parse(raw) : null,
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('/api/admin candidate settings validate HTTPS and expose candidate list', async () => {
  const audits = [];
  const mockDb = {
    getCandidateSupportSettings: async () => ({ formUrl: '', message: '' }),
    updateCandidateSupportSettings: async settings => settings,
    listCandidateClassifications: async () => [{ chat_id: '573001234567@c.us', classification: 'candidate' }],
    logAudit: async entry => { audits.push(entry); },
  };
  await withServer(mockDb, { id: 1, role: 'admin', name: 'Admin' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'GET', '/api/admin/candidates')).body.candidates.length, 1);
    assert.equal((await request(baseUrl, 'PUT', '/api/admin/candidate-settings', { formUrl: 'http://unsafe.test', message: '' })).status, 400);
    assert.equal((await request(baseUrl, 'PUT', '/api/admin/candidate-settings', { formUrl: 'https://safe.test/form', message: 'Safe guidance' })).status, 200);
    assert.deepEqual(audits[0].metadata, { form_url_configured: true, message_length: 13 });
    assert.equal(JSON.stringify(audits).includes('safe.test'), false);
  });
});

function createMockDb(overrides = {}) {
  return {
    listAgentTokens: async () => [],
    createPendingAgentToken: async name => ({ rawToken: 'nexo_tkn_once', token: { id: 21, name, role: 'agent', active: false, created_at: '2026-07-27T12:00:00.000Z' } }),
    activatePendingAgentToken: async id => ({ id, name: 'Support agent', role: 'agent', active: true, created_at: '2026-07-27T12:00:00.000Z' }),
    revokeAgentTokenAtomically: async id => ({ outcome: 'revoked', token: { id, name: 'Support agent', role: 'agent', active: false, created_at: '2026-07-27T12:00:00.000Z', revoked_at: '2026-07-27T12:01:00.000Z' } }),
    revokePendingAgentToken: async () => null,
    getActiveAgentToken: async id => ({ id, name: 'Support agent', role: 'agent', active: true }),
    listAreas: async () => [{ id: 1, name: 'Integrations' }],
    createArea: async payload => ({ id: 2, ...payload }),
    updateArea: async (id, payload) => ({ id, ...payload }),
    listAnalysts: async () => [{ id: 1, display_name: 'Agent' }],
    createAnalyst: async payload => ({ id: 3, ...payload }),
    updateAnalyst: async (id, payload) => ({ id, ...payload }),
    listAuditLogs: async () => [],
    getAdminReportSummary: async () => ({ total_tickets: 0, open_tickets: 0, closed_tickets: 0, sf_attachments: 0, avg_close_minutes: null, by_area: [] }),
    logAudit: async () => ({ id: 1 }),
    getTicketsWithRouting: async () => [],
    getTicketById: async id => ({ id, area_id: 2, status: 'open', created_at: '2026-07-09T10:00:00.000Z' }),
    getTicketWithRouting: async id => ({ id, area_id: 2, status: 'open', created_at: '2026-07-09T10:00:00.000Z', area: { id: 2, name: 'Support', sla_minutes: 30 }, assignment: { ticket_id: id, analyst_id: 7, analyst: { id: 7, display_name: 'Ada', area_id: 2 } } }),
    getAreaById: async id => ({ id, name: `Area ${id}`, active: true }),
    getAnalystById: async id => ({ id, area_id: 2, display_name: 'Ada', available: true }),
    assignTicket: async (ticketId, analystId) => ({ ticket_id: ticketId, analyst_id: analystId }),
    unassignTicket: async ticketId => ({ ticket_id: ticketId, analyst_id: null }),
    updateTicketArea: async (ticketId, areaId) => ({ id: ticketId, area_id: areaId }),
    listAvailableAnalystsByArea: async areaId => [{ id: 7, area_id: areaId, display_name: 'Ada', available: true }],
    listActiveBotFlows: async () => [{ id: 1, step_key: 'initial_filter', version_id: 1, area_id: null }],
    listBotFlows: async () => [{ id: 1, step_key: 'initial_filter', message: 'Hola', version_id: 1, area_id: null, active: true, sort_order: 0 }],
    createBotFlowStep: async payload => ({ id: 4, ...payload }),
    updateBotFlowStep: async (id, payload) => ({ id, step_key: 'ask_name', version_id: 1, area_id: null, message: 'Nombre', sort_order: 0, active: true, ...payload }),
    getBotFlowStudioLayout: async () => null,
    putBotFlowStudioLayout: async payload => ({ version_id: payload.versionId, area_id: payload.areaId, layout: payload.layout, revision: payload.expectedRevision + 1, updated_at: '2026-07-14T12:00:00.000Z' }),
    listSalesforceOutboxJobs: async () => [],
    markSalesforceOutboxJobRetryable: async id => ({ id, ticket_id: 7, operation: 'case_close', status: 'pending' }),
    claimSalesforceOutboxJobs: async () => [],
    ...overrides,
  };
}

test('/api/admin rejects non-admin users before DB access', async () => {
  let dbCalled = false;
  const mockDb = createMockDb({ listAreas: async () => { dbCalled = true; return []; } });

  await withServer(mockDb, { role: 'agent' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/areas');
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Administrator privileges are required.' });
    assert.equal(dbCalled, false);
  });
});

test('/api/admin allows admins to list areas', async () => {
  await withServer(createMockDb(), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/areas');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ id: 1, name: 'Integrations' }]);
  });
});

test('/api/admin agent token inventory is admin-only and returns metadata without secrets or hashes', async () => {
  let reads = 0;
  const rows = [{ id: 7, name: 'Recruiting agent', role: 'agent', active: true, created_at: '2026-07-27T10:00:00.000Z', updated_at: null }];
  const db = createMockDb({ listAgentTokens: async () => { reads += 1; return rows; } });
  await withServer(db, { id: 1, role: 'admin', name: 'Root' }, async baseUrl => {
    const response = await request(baseUrl, 'GET', '/api/admin/agent-tokens');
    assert.deepEqual(response, { status: 200, body: { tokens: rows } });
    assert.doesNotMatch(JSON.stringify(response.body), /rawToken|token_hash|nexo_tkn_/);
  });
  await withServer(db, { role: 'agent' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'GET', '/api/admin/agent-tokens')).status, 403);
  });
  assert.equal(reads, 1);
});

test('/api/admin creates a forced-agent token only after required audit and conditional activation', async () => {
  const calls = [];
  const pending = { id: 21, name: 'Support agent', role: 'agent', active: false, created_at: '2026-07-27T12:00:00.000Z' };
  const active = { ...pending, active: true, updated_at: '2026-07-27T12:00:01.000Z' };
  const db = createMockDb({
    createPendingAgentToken: async name => { calls.push(['stage', name]); return { rawToken: 'nexo_tkn_once', token: pending }; },
    logAudit: async entry => { calls.push(['audit', entry]); return { id: 91 }; },
    activatePendingAgentToken: async id => { calls.push(['activate', id]); return active; },
  });
  await withServer(db, { id: 1, role: 'admin', name: 'Root' }, async baseUrl => {
    const response = await request(baseUrl, 'POST', '/api/admin/agent-tokens', { name: ' Support agent ' });
    assert.deepEqual(response, { status: 201, body: { token: 'nexo_tkn_once', metadata: active } });
  });
  assert.deepEqual(calls.map(([kind]) => kind), ['stage', 'audit', 'activate']);
  assert.equal(calls[1][1].action, 'agent_token.created');
  assert.deepEqual(calls[1][1].metadata, { name: 'Support agent', role: 'agent', activation_pending: true });
  assert.doesNotMatch(JSON.stringify(calls[1][1]), /nexo_tkn_once|token_hash/);
});

test('/api/admin rejects role control and unknown create fields before staging', async () => {
  let stages = 0;
  const db = createMockDb({ createPendingAgentToken: async () => { stages += 1; } });
  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'POST', '/api/admin/agent-tokens', { name: 'Agent', role: 'admin' })).status, 400);
    assert.equal((await request(baseUrl, 'POST', '/api/admin/agent-tokens', { name: 'Agent', extra: true })).status, 400);
    assert.equal((await request(baseUrl, 'POST', '/api/admin/agent-tokens', { name: '   ' })).status, 400);
  });
  assert.equal(stages, 0);
});

test('/api/admin leaves staged tokens inactive and never exposes secrets when strict creation audit fails', async () => {
  for (const logAudit of [async () => null, async () => { throw new Error('audit storage detail'); }]) {
    let activations = 0;
    const db = createMockDb({
      createPendingAgentToken: async () => ({ rawToken: 'nexo_tkn_never_expose', token: { id: 31, name: 'Agent', role: 'agent', active: false } }),
      logAudit,
      activatePendingAgentToken: async () => { activations += 1; },
    });
    await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
      const response = await request(baseUrl, 'POST', '/api/admin/agent-tokens', { name: 'Agent' });
      assert.deepEqual(response, { status: 503, body: { code: 'TOKEN_AUDIT_FAILED', error: 'Token creation could not be audited.' } });
      assert.doesNotMatch(JSON.stringify(response.body), /nexo_tkn_never_expose|storage detail/);
    });
    assert.equal(activations, 0);
  }
});

test('/api/admin compensates activation failure and returns a sanitized response without the secret', async () => {
  const calls = [];
  const db = createMockDb({
    createPendingAgentToken: async () => ({ rawToken: 'nexo_tkn_never_expose', token: { id: 41, name: 'Agent', role: 'agent', active: false } }),
    logAudit: async () => ({ id: 1 }),
    activatePendingAgentToken: async () => null,
    revokePendingAgentToken: async id => { calls.push(id); return { outcome: 'already_revoked' }; },
  });
  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    const response = await request(baseUrl, 'POST', '/api/admin/agent-tokens', { name: 'Agent' });
    assert.deepEqual(response, { status: 503, body: { code: 'TOKEN_ACTIVATION_FAILED', error: 'Token creation could not be activated.' } });
    assert.doesNotMatch(JSON.stringify(response.body), /nexo_tkn_never_expose/);
  });
  assert.deepEqual(calls, [41]);
});

test('/api/admin delegates atomic audit and maps committed and repeated outcomes deterministically', async () => {
  const order = [];
  const revoked = { id: 51, name: 'Agent', role: 'agent', active: false, revoked_at: '2026-07-27T12:01:00.000Z' };
  const db = createMockDb({
    revokeAgentTokenAtomically: async (id, actorTokenId, requestId) => { order.push(['rpc', id, actorTokenId, requestId]); return { outcome: 'revoked', token: revoked }; },
  });
  await withServer(db, { id: 1, role: 'admin', name: 'Root' }, async baseUrl => {
    assert.deepEqual(await request(baseUrl, 'POST', '/api/admin/agent-tokens/51/revoke', {}), { status: 200, body: { outcome: 'revoked', metadata: revoked } });
  });
  assert.equal(order[0][0], 'rpc'); assert.equal(order[0][1], 51); assert.equal(order[0][2], 1); assert.match(order[0][3], /^[A-Za-z0-9_-]{1,64}$/);

  let audits = 0;
  await withServer(createMockDb({ revokeAgentTokenAtomically: async () => ({ outcome: 'already_revoked', token: revoked }), logAudit: async () => { audits += 1; } }), { id: 1, role: 'admin' }, async baseUrl => {
    assert.deepEqual(await request(baseUrl, 'POST', '/api/admin/agent-tokens/51/revoke', {}), { status: 200, body: { outcome: 'already_revoked', metadata: revoked } });
  });
  assert.equal(audits, 0);
});

test('/api/admin disconnects matching local sockets only after durable audited revocation', async () => {
  const order = [];
  const telemetry = [];
  const originalInfo = console.info;
  console.info = (...args) => telemetry.push(args);
  const matching = { user: { id: 61, role: 'agent' }, analyst: null, sessionToken: 'opaque', rooms: new Set(['socket-a']), leave() {}, emit() {}, disconnect() { order.push('disconnect'); } };
  const unrelated = { user: { id: 62, role: 'agent' }, analyst: null, sessionToken: 'other', rooms: new Set(['socket-b']), leave() {}, emit() {}, disconnect() { order.push('wrong-disconnect'); } };
  const io = { sockets: { sockets: new Map([['a', matching], ['b', unrelated]]) } };
  const db = createMockDb({
    revokeAgentTokenAtomically: async id => { order.push('rpc-committed'); return { outcome: 'revoked', token: { id, name: 'Agent', role: 'agent', active: false } }; },
  });
  try {
    await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
      const response = await request(baseUrl, 'POST', '/api/admin/agent-tokens/61/revoke', {});
      assert.deepEqual(response.body, { outcome: 'revoked', metadata: { id: 61, name: 'Agent', role: 'agent', active: false }, disconnected_sockets: 1 });
    }, io);
  } finally { console.info = originalInfo; }
  assert.deepEqual(order, ['rpc-committed', 'disconnect']);
  assert.equal(unrelated.user.id, 62);
  assert.deepEqual(telemetry, [['[agent_token_revocation] local_socket_teardown', { outcome: 'completed', disconnected_sockets: 1, reason_code: 'MATCHES_DISCONNECTED' }]]);
});

test('/api/admin reports safe zero-match telemetry after committed revocation', async () => {
  const telemetry = [];
  const originalInfo = console.info;
  console.info = (...args) => telemetry.push(args);
  try {
    await withServer(createMockDb(), { role: 'admin', name: 'Root' }, async baseUrl => {
      const response = await request(baseUrl, 'POST', '/api/admin/agent-tokens/63/revoke', {});
      assert.equal(response.body.disconnected_sockets, 0);
    }, { sockets: { sockets: new Map() } });
  } finally { console.info = originalInfo; }
  assert.deepEqual(telemetry, [['[agent_token_revocation] local_socket_teardown', { outcome: 'completed', disconnected_sockets: 0, reason_code: 'NO_LOCAL_MATCH' }]]);
  assert.doesNotMatch(JSON.stringify(telemetry), /token_id|principal|socket_id|name|63/);
});

test('/api/admin keeps durable revocation successful when local socket teardown fails', async () => {
  let revoked = false;
  const telemetry = [];
  const originalWarn = console.warn;
  console.warn = (...args) => telemetry.push(args);
  const socket = { user: { id: 71 }, analyst: null, rooms: new Set(), leave() {}, emit() {}, disconnect() { throw new Error('socket secret'); } };
  const io = { sockets: { sockets: new Map([['a', socket]]) } };
  const db = createMockDb({
    revokeAgentTokenAtomically: async id => { revoked = true; return { outcome: 'revoked', token: { id, name: 'Agent', role: 'agent', active: false } }; },
  });
  try {
    await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
      const response = await request(baseUrl, 'POST', '/api/admin/agent-tokens/71/revoke', {});
      assert.equal(response.status, 200);
      assert.equal(response.body.outcome, 'revoked');
      assert.equal(Object.hasOwn(response.body, 'disconnected_sockets'), false);
      assert.doesNotMatch(JSON.stringify(response.body), /secret|teardown/);
    }, io);
  } finally { console.warn = originalWarn; }
  assert.equal(revoked, true);
  assert.deepEqual(telemetry, [['[agent_token_revocation] local_socket_teardown', { outcome: 'failed', disconnected_sockets: 0, reason_code: 'SOCKET_TEARDOWN_FAILED' }]]);
  assert.doesNotMatch(JSON.stringify(telemetry), /secret|token_id|principal|socket_id|name|71/);
});

test('/api/admin fails closed with sanitized revocation availability and no socket teardown', async () => {
  let disconnects = 0;
  const socket = { user: { id: 72 }, analyst: null, rooms: new Set(), leave() {}, disconnect() { disconnects += 1; } };
  const io = { sockets: { sockets: new Map([['a', socket]]) } };
  const db = createMockDb({
    revokeAgentTokenAtomically: async () => { throw Object.assign(new Error('database audit detail'), { code: 'TOKEN_REVOCATION_UNAVAILABLE', statusCode: 503 }); },
  });
  await withServer(db, { id: 1, role: 'admin', name: 'Root' }, async baseUrl => {
    const response = await request(baseUrl, 'POST', '/api/admin/agent-tokens/72/revoke', {});
    assert.deepEqual(response, { status: 503, body: { code: 'TOKEN_REVOCATION_UNAVAILABLE', error: 'Token revocation is temporarily unavailable.' } });
    assert.doesNotMatch(JSON.stringify(response.body), /database|audit detail/);
  }, io);
  assert.equal(disconnects, 0);
});

test('/api/admin maps classified non-transitions and never disconnects sockets', async () => {
  const cases = [
    [{ outcome: 'not_found' }, 404],
    [{ outcome: 'wrong_role' }, 409],
    [{ outcome: 'already_revoked', token: { id: 73, name: 'Agent', role: 'agent', active: false } }, 200],
  ];
  let disconnects = 0;
  const io = { sockets: { sockets: new Map([['a', { user: { id: 73 }, rooms: new Set(), leave() {}, disconnect() { disconnects += 1; } }]]) } };
  for (const [result, status] of cases) {
    await withServer(createMockDb({ revokeAgentTokenAtomically: async () => result }), { id: 1, role: 'admin' }, async baseUrl => {
      assert.equal((await request(baseUrl, 'POST', '/api/admin/agent-tokens/73/revoke', {})).status, status);
    }, io);
  }
  assert.equal(disconnects, 0);
});

test('/api/admin serializes revoke before analyst create and rejects inactive token without a write', async () => {
  const revokeStarted = deferred(); const releaseRevoke = deferred();
  let creates = 0; let availabilityWrites = 0;
  const db = createMockDb({
    revokeAgentTokenAtomically: async id => { revokeStarted.resolve(); await releaseRevoke.promise; return { outcome: 'revoked', token: { id, name: 'Agent', role: 'agent', active: false } }; },
    getActiveAgentToken: async () => null,
    createAnalyst: async () => { creates += 1; return {}; },
    updateAnalyst: async () => { availabilityWrites += 1; return {}; },
  });
  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    const revoke = request(baseUrl, 'POST', '/api/admin/agent-tokens/81/revoke', {});
    await revokeStarted.promise;
    const create = request(baseUrl, 'POST', '/api/admin/analysts', { token_id: 81, area_id: 2, display_name: 'Ada', available: true });
    releaseRevoke.resolve();
    const [revokeResponse, createResponse] = await Promise.all([revoke, create]);
    assert.equal(revokeResponse.status, 200);
    assert.deepEqual(createResponse, { status: 409, body: { code: 'TOKEN_NOT_ACTIVE', error: 'The selected agent token is not active.' } });
  });
  assert.equal(creates, 0); assert.equal(availabilityWrites, 0);
});

test('/api/admin validates active token immediately before analyst update and preserves availability on rejection', async () => {
  const calls = [];
  const db = createMockDb({
    getActiveAgentToken: async id => { calls.push(['validate', id]); return null; },
    updateAnalyst: async (id, body) => { calls.push(['write', id, body]); return { id, ...body }; },
  });
  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    const response = await request(baseUrl, 'PATCH', '/api/admin/analysts/11', { token_id: 91, available: false });
    assert.deepEqual(response, { status: 409, body: { code: 'TOKEN_NOT_ACTIVE', error: 'The selected agent token is not active.' } });
  });
  assert.deepEqual(calls, [['validate', 91]]);
});

test('/api/admin queues analyst update behind same-token revoke before active validation', async () => {
  const revokeStarted = deferred(); const releaseRevoke = deferred();
  let validations = 0; let writes = 0;
  const db = createMockDb({
    revokeAgentTokenAtomically: async id => { revokeStarted.resolve(); await releaseRevoke.promise; return { outcome: 'revoked', token: { id, name: 'Agent', role: 'agent', active: false } }; },
    getActiveAgentToken: async () => { validations += 1; return null; },
    updateAnalyst: async () => { writes += 1; return {}; },
  });
  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    const revoke = request(baseUrl, 'POST', '/api/admin/agent-tokens/92/revoke', {});
    await revokeStarted.promise;
    const update = request(baseUrl, 'PATCH', '/api/admin/analysts/11', { token_id: 92, available: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(validations, 0, 'same-token update must wait for durable revoke');
    releaseRevoke.resolve();
    const [, updateResponse] = await Promise.all([revoke, update]);
    assert.deepEqual(updateResponse, { status: 409, body: { code: 'TOKEN_NOT_ACTIVE', error: 'The selected agent token is not active.' } });
  });
  assert.equal(validations, 1); assert.equal(writes, 0);
});

test('/api/admin SLA reads map exact policy and calendar service results', async () => {
  const policies = [{ id: 1, version: 2 }]; const calendars = [{ id: 3, business_calendar_windows: [], business_calendar_exceptions: [] }];
  await withServer(createMockDb({ listSlaPolicies: async () => policies, listBusinessCalendars: async () => calendars }), { role: 'admin', name: 'Ada Admin' }, async baseUrl => {
    assert.deepEqual(await request(baseUrl, 'GET', '/api/admin/sla/policies'), { status: 200, body: { policies } });
    assert.deepEqual(await request(baseUrl, 'GET', '/api/admin/sla/calendars'), { status: 200, body: { calendars } });
  });
});

test('/api/admin SLA writes map exact validated payloads and actor identity', async () => {
  const calls = [];
  const db = createMockDb({
    configureSlaPolicy: async payload => { calls.push(['policy', payload]); return { id: 8, version: 3 }; },
    configureBusinessCalendar: async payload => { calls.push(['calendar', payload]); return { id: 9, version: 2 }; },
  });
  await withServer(db, { role: 'admin', name: 'Ada Admin' }, async baseUrl => {
    const policy = await request(baseUrl, 'POST', '/api/admin/sla/policies', { area_id: 2, priority: 'HIGH', clock_type: 'support', clock_mode: 'business_hours', calendar_id: 4, target_minutes: 120, warning_minutes: 30 });
    const calendar = await request(baseUrl, 'POST', '/api/admin/sla/calendars', { area_id: 2, name: 'Bogotá', timezone: 'America/Bogota', windows: [{ weekday: 1, start: '08:00', end: '17:00' }], exceptions: [{ date: '2026-12-25', closed: true, windows: null }] });
    assert.equal(policy.status, 201); assert.equal(calendar.status, 201);
    assert.deepEqual(calls, [['policy', { areaId: 2, priority: 'high', clockType: 'support', clockMode: 'business_hours', calendarId: 4, targetMinutes: 120, warningMinutes: 30, actorName: 'Ada Admin' }], ['calendar', { areaId: 2, name: 'Bogotá', timezone: 'America/Bogota', windows: [{ weekday: 1, start: '08:00', end: '17:00' }], exceptions: [{ date: '2026-12-25', closed: true, windows: null }], actorName: 'Ada Admin' }]]);
  });
});

test('/api/admin SLA rejects invalid commands before service access', async () => {
  let calls = 0; const db = createMockDb({ configureSlaPolicy: async () => { calls += 1; }, configureBusinessCalendar: async () => { calls += 1; } });
  await withServer(db, { role: 'admin', name: 'Admin' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'POST', '/api/admin/sla/policies', { area_id: 1, priority: 'urgent', clock_type: 'support', target_minutes: 10, warning_minutes: 20 })).status, 400);
    assert.equal((await request(baseUrl, 'POST', '/api/admin/sla/calendars', { area_id: 1, name: 'X', timezone: 'Not/AZone', windows: [], exceptions: [] })).status, 400);
    assert.equal(calls, 0);
  });
});

test('/api/admin SLA returns a safe service-unavailable response', async () => {
  await withServer(createMockDb({ listSlaPolicies: async () => { throw Object.assign(new Error('database secret detail'), { statusCode: 503 }); } }), { role: 'admin', name: 'Admin' }, async baseUrl => {
    const response = await request(baseUrl, 'GET', '/api/admin/sla/policies'); assert.equal(response.status, 503); assert.equal(JSON.stringify(response.body).includes('secret'), false);
  });
});

test('/api/admin exposes bot flow studio definition without write side effects', async () => {
  let writes = 0;
  const db = createMockDb({
    listActiveBotFlows: async () => [],
    saveSession: async () => { writes += 1; },
    createTicket: async () => { writes += 1; },
    logAudit: async () => { writes += 1; },
  });
  await withServer(db, { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/bot-flow-studio/definition');
    assert.equal(res.status, 200);
    assert.equal(res.body.definition.flow_id, 'nexo-whatsapp-support');
    assert.ok(res.body.definition.nodes.some(node => node.message_key === 'welcome_audience'));
    assert.equal(writes, 0);
  });
});

test('/api/admin bot flow simulation is admin-only, deterministic and side-effect free', async () => {
  let externalCalls = 0;
  const db = createMockDb({
    listActiveBotFlows: async () => { externalCalls += 1; return []; },
    saveSession: async () => { externalCalls += 1; },
    createTicket: async () => { externalCalls += 1; },
    logAudit: async () => { externalCalls += 1; },
  });
  await withServer(db, { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const payload = { session: { paso: 0 }, input: 'si', version_id: 2, area_id: null };
    const first = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', payload);
    const second = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', payload);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, second.body);
    assert.equal(first.body.mode, 'dry-run');
    assert.equal(first.body.outputs[0].message_key, 'legacy_migration_audience');
    assert.deepEqual(first.body.session, { paso: 'audience_choice' });
    assert.equal(externalCalls, 0);
  });
});

test('/api/admin bot flow simulation resolves messages from selected version and area', async () => {
  const scoped = { version_id: 4, area_id: 9, step_key: 'legacy_migration_audience', message: 'Flujo actualizado para el área nueve' };
  const db = createMockDb({
    listBotFlows: async filters => filters.areaId === 9 ? [scoped] : [],
  });
  await withServer(db, { role: 'admin', name: 'Admin' }, async baseUrl => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { session: { paso: 0 }, input: 'si', version_id: 4, area_id: 9 });
    assert.equal(res.status, 200);
    assert.equal(res.body.outputs[0].text, scoped.message);
  });
});

test('/api/admin candidate simulation returns safe editable provenance without classification lookup', async () => {
  let classificationReads = 0;
  const candidateRow = { id: 19, version_id: 2, area_id: null, step_key: 'candidate_exit', message: 'Mensaje de candidato guardado', active: true };
  const db = createMockDb({
    listBotFlows: async filters => filters.globalOnly ? [candidateRow] : [],
    listCandidateClassifications: async () => { classificationReads += 1; return []; },
  });
  await withServer(db, { role: 'admin', name: 'Admin' }, async baseUrl => {
    const start = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { session: null, input: '', version_id: 2, area_id: null });
    const candidate = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { session: start.body.session, input: '2', version_id: 2, area_id: null });
    assert.equal(candidate.body.outputs[0].text, candidateRow.message);
    assert.deepEqual(candidate.body.provenance['candidate-exit'], { node_id: 'candidate-exit', message_key: 'candidate_exit', source: 'bot_flows', edit_context: { version_id: 2, area_id: null } });
    assert.equal(classificationReads, 0);
    assert.equal(JSON.stringify(candidate.body.provenance).includes('chat_id'), false);
  });
});

test('/api/admin candidate simulation labels fallback provenance', async () => {
  await withServer(createMockDb({ listBotFlows: async () => [] }), { role: 'admin', name: 'Admin' }, async baseUrl => {
    const start = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { session: null, input: '', version_id: 2, area_id: null });
    const candidate = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { session: start.body.session, input: 'candidato', version_id: 2, area_id: null });
    assert.equal(candidate.body.provenance['candidate-exit'].source, 'fallback');
  });
});

test('/api/admin bot flow simulation validates a closed bounded request schema', async () => {
  await withServer(createMockDb(), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const unknown = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { input: '', unexpected: true });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /campos no soportados/);

    const oversized = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { session: { paso: 1 }, input: 'x'.repeat(4001) });
    assert.equal(oversized.status, 400);

    const customDefinition = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { input: '', definition: {} });
    assert.equal(customDefinition.status, 400);
    assert.match(customDefinition.body.error, /campos no soportados/);

    const badSession = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { session: { paso: 1, arbitrary: 'value' } });
    assert.equal(badSession.status, 400);
    const badEffects = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { effects: { ticket_result: 'success', arbitrary: true } });
    assert.equal(badEffects.status, 400);
    const badScope = await request(baseUrl, 'POST', '/api/admin/bot-flow-studio/simulate', { version_id: 2147483648, area_id: 1 });
    assert.equal(badScope.status, 400);
  });
});

test('/api/admin bot flow layout loads and saves isolated version/area drafts with safe audit metadata', async () => {
  const calls = [];
  const audits = [];
  const layout = { schema_version: 1, nodes: [{ id: 'capture-name', kind: 'canonical', position: { x: 10, y: 20 }, label: 'Nombre' }, { id: 'draft-question', kind: 'draft', draft_only: true, type: 'capture', position: { x: 30, y: 40 }, label: 'Pregunta', message: '¿Qué necesitas?' }], edges: [{ id: 'draft-edge', source: 'capture-name', target: 'draft-question', draft_only: true, label: 'Después' }] };
  const db = createMockDb({
    getBotFlowStudioLayout: async scope => { calls.push(['get', scope]); return null; },
    putBotFlowStudioLayout: async payload => { calls.push(['put', payload]); return { version_id: 3, area_id: 8, layout: payload.layout, revision: 1, updated_at: 'now' }; },
    logAudit: async payload => { audits.push(payload); },
  });
  await withServer(db, { role: 'admin', name: 'Admin' }, async baseUrl => {
    const loaded = await request(baseUrl, 'GET', '/api/admin/bot-flow-studio/layout?version_id=3&area_id=8');
    assert.equal(loaded.status, 200); assert.equal(loaded.body.revision, 0); assert.deepEqual(loaded.body.layout.nodes, []);
    const saved = await request(baseUrl, 'PUT', '/api/admin/bot-flow-studio/layout?version_id=3&area_id=8', { revision: 0, layout });
    assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
    assert.deepEqual(calls[0][1], { versionId: 3, areaId: 8 });
    assert.equal(calls[1][1].updatedBy, 'Admin');
    assert.deepEqual(audits[0].metadata, { version_id: 3, area_id: 8, revision: 1, node_count: 2, edge_count: 1 });
    assert.equal(JSON.stringify(audits[0]).includes('¿Qué necesitas?'), false);
  });
});

test('/api/admin bot flow layout rejects stale, unsafe, oversized and runtime-capable payloads', async () => {
  let writes = 0;
  const db = createMockDb({ putBotFlowStudioLayout: async () => { writes += 1; return null; } });
  await withServer(db, { role: 'admin', name: 'Admin' }, async baseUrl => {
    const invalid = [
      { revision: 0, layout: { schema_version: 1, nodes: [{ id: 'capture-name', kind: 'canonical', position: { x: 1, y: 2 }, message: 'hack' }], edges: [] } },
      { revision: 0, layout: { schema_version: 1, nodes: [{ id: 'draft-x', kind: 'draft', draft_only: false, type: 'capture', position: { x: 1, y: 2 }, label: 'X' }], edges: [] } },
      { revision: 0, layout: { schema_version: 1, nodes: [], edges: [], interpreter: 'eval()' } },
      { revision: 0, layout: { schema_version: 1, nodes: [{ id: 'draft-x', kind: 'draft', draft_only: true, type: 'capture', position: { x: 1, y: 2 }, label: '<b>X</b>' }], edges: [] } },
    ];
    for (const body of invalid) assert.equal((await request(baseUrl, 'PUT', '/api/admin/bot-flow-studio/layout?version_id=2', body)).status, 400);
    assert.equal(writes, 0);
    const safe = { revision: 1, layout: { schema_version: 1, nodes: [], edges: [] } };
    assert.equal((await request(baseUrl, 'PUT', '/api/admin/bot-flow-studio/layout?version_id=2', safe)).status, 409);
  });
});

test('/api/admin concurrent first layout writes return one success and one conflict', async () => {
  let claimed = false;
  const db = createMockDb({
    putBotFlowStudioLayout: async payload => {
      await new Promise(resolve => setImmediate(resolve));
      if (claimed) return null;
      claimed = true;
      return { version_id: payload.versionId, area_id: payload.areaId, layout: payload.layout, revision: 1, updated_at: 'now' };
    },
  });
  await withServer(db, { role: 'admin', name: 'Admin' }, async baseUrl => {
    const body = { revision: 0, layout: { schema_version: 1, nodes: [], edges: [] } };
    const results = await Promise.all([
      request(baseUrl, 'PUT', '/api/admin/bot-flow-studio/layout?version_id=7', body),
      request(baseUrl, 'PUT', '/api/admin/bot-flow-studio/layout?version_id=7', body),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  });
});

test('/api/admin bot flow layout returns controlled 503 before phase8 is applied and remains admin-only', async () => {
  const missing = Object.assign(new Error('relation bot_flow_studio_layouts does not exist'), { code: '42P01' });
  const db = createMockDb({ getBotFlowStudioLayout: async () => { throw missing; } });
  await withServer(db, { role: 'admin', name: 'Admin' }, async baseUrl => {
    const result = await request(baseUrl, 'GET', '/api/admin/bot-flow-studio/layout?version_id=1');
    assert.equal(result.status, 503); assert.match(result.body.error, /phase8/);
  });
  await withServer(createMockDb(), { role: 'agent' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'GET', '/api/admin/bot-flow-studio/layout?version_id=1')).status, 403);
  });
});

test('/api/admin returns 500 when DB list rejects', async () => {
  const mockDb = createMockDb({ listAreas: async () => { throw new Error('database unavailable'); } });

  await withServer(mockDb, { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/areas');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'database unavailable' });
  });
});

test('/api/admin rejects invalid PATCH bodies', async () => {
  await withServer(createMockDb(), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'PATCH', '/api/admin/areas/1', { unknown: 'field' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /PATCH body must include/);
  });
});

test('/api/admin creates and updates areas', async () => {
  await withServer(createMockDb(), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const created = await request(baseUrl, 'POST', '/api/admin/areas', { name: 'Support', active: true });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Support');

    const updated = await request(baseUrl, 'PATCH', '/api/admin/areas/2', { name: 'Support L2' });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body, { id: '2', name: 'Support L2' });
  });
});

test('/api/admin allows admins to list analysts', async () => {
  await withServer(createMockDb({
    listAnalysts: async () => [{ id: 10, display_name: 'Ada', area_id: 2, available: true }],
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/analysts');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ id: 10, display_name: 'Ada', area_id: 2, available: true }]);
  });
});

test('/api/admin creates analysts and writes audit logs', async () => {
  const audits = [];
  await withServer(createMockDb({
    createAnalyst: async payload => ({ id: 11, ...payload }),
    logAudit:      async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/analysts', {
      token_id: 'tok_1',
      area_id:  2,
      display_name: 'Grace',
      available: true,
    });

    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { id: 11, token_id: 'tok_1', area_id: 2, display_name: 'Grace', available: true });
    assert.equal(audits[0].action, 'analyst.created');
    assert.equal(audits[0].actor_name, 'Root');
    assert.deepEqual(audits[0].metadata, { token_id: 'tok_1', area_id: 2 });
  });
});

test('/api/admin rejects invalid analyst creation payloads', async () => {
  let createCalled = false;
  await withServer(createMockDb({
    createAnalyst: async payload => { createCalled = true; return { id: 1, ...payload }; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/analysts', { token_id: 'tok_1' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'display_name is required.' });
    assert.equal(createCalled, false);
  });
});

test('/api/admin updates analysts and writes audit logs', async () => {
  const audits = [];
  await withServer(createMockDb({
    updateAnalyst: async (id, payload) => ({ id, display_name: 'Grace Hopper', ...payload }),
    logAudit:      async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'PATCH', '/api/admin/analysts/11', { available: false });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: '11', display_name: 'Grace Hopper', available: false });
    assert.equal(audits[0].action, 'analyst.updated');
    assert.equal(audits[0].target_id, '11');
    assert.deepEqual(audits[0].metadata, { available: false });
  });
});

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('/api/admin serializes overlapping analyst area reconciliation to the latest authoritative room set', async () => {
  const switches = [deferred(), deferred()];
  const firstRead = deferred();
  let switchIndex = 0; let readIndex = 0;
  const socket = {
    user: { role: 'admin' }, analyst: { id: 11, area_id: 1 }, rooms: new Set(['socket-1', 'admin', 'analyst:11', 'area:1', 'area:stale']), events: [],
    join(room) { this.rooms.add(room); }, leave(room) { this.rooms.delete(room); }, emit(event, payload) { this.events.push({ event, payload }); },
  };
  const io = { sockets: { sockets: new Map([['socket-1', socket]]) } };
  const db = createMockDb({
    switchAnalystArea: async () => switches[switchIndex++].promise,
    getAnalystById: async () => {
      readIndex += 1;
      return readIndex === 1 ? firstRead.promise : { id: 11, area_id: 3, area_revision: 3 };
    },
  });

  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    const first = request(baseUrl, 'PATCH', '/api/admin/analysts/11', { area_id: 2 });
    const second = request(baseUrl, 'PATCH', '/api/admin/analysts/11', { area_id: 3 });
    while (switchIndex < 2) await new Promise(resolve => setImmediate(resolve));
    switches[0].resolve({ previous_area_id: 1, area_revision: 2, unassigned_ticket_ids: ['old'] });
    while (readIndex < 1) await new Promise(resolve => setImmediate(resolve));
    switches[1].resolve({ previous_area_id: 2, area_revision: 3, unassigned_ticket_ids: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readIndex, 1, 'the second authoritative read must wait for the first reconciliation');
    firstRead.resolve({ id: 11, area_id: 3, area_revision: 3 });
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map(result => result.status), [200, 200]);
  }, io);

  assert.deepEqual([...socket.rooms].sort(), ['admin', 'analyst:11', 'area:3', 'socket-1']);
  assert.equal(socket.events.filter(item => item.event === 'workspace-replaced').at(-1).payload.areaId, 3);
});

test('/api/admin reconciles authoritative analyst rooms when area RPC fails after commit', async () => {
  const socket = {
    user: { role: 'agent' }, analyst: { id: 11, area_id: 2 }, rooms: new Set(['socket-1', 'analyst:11', 'area:2', 'area:stale']), events: [],
    join(room) { this.rooms.add(room); }, leave(room) { this.rooms.delete(room); }, emit(event, payload) { this.events.push({ event, payload }); },
  };
  const io = { sockets: { sockets: new Map([['socket-1', socket]]) } };
  const db = createMockDb({ switchAnalystArea: async () => { throw new Error('response lost after commit'); }, getAnalystById: async () => ({ id: 11, area_id: 4, area_revision: 4 }) });
  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'PATCH', '/api/admin/analysts/11', { area_id: 4 })).status, 500);
  }, io);
  assert.deepEqual([...socket.rooms].sort(), ['analyst:11', 'area:4', 'socket-1']);
  assert.equal(socket.events.find(item => item.event === 'workspace-replaced').payload.areaId, 4);
});

test('/api/admin allows admins to list audit logs', async () => {
  let receivedFilters;
  const logs = [{ id: 1, action: 'analyst.created', actor_name: 'Admin' }];
  await withServer(createMockDb({
    listAuditLogs: async filters => { receivedFilters = filters; return logs; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/audit?limit=25&action=ticket.closed&offset=10');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, logs);
    assert.equal(receivedFilters.limit, '25');
    assert.equal(receivedFilters.action, 'ticket.closed');
    assert.equal(receivedFilters.offset, '10');
  });
});

test('/api/admin reports summary returns aggregate payload', async () => {
  const summary = { total_tickets: 2, open_tickets: 1, closed_tickets: 1, sf_attachments: 3, avg_close_minutes: 12, by_area: [{ area: 'Support', total: 2, open: 1, closed: 1 }] };
  await withServer(createMockDb({
    getAdminReportSummary: async () => summary,
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/reports/summary');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, summary);
  });
});

test('/api/admin lists Salesforce outbox jobs with normalized filters', async () => {
  let receivedFilters;
  const jobs = [{
    id: 1,
    ticket_id: 7,
    status: 'failed',
    operation: 'case_close',
    payload: { transcript: 'secret transcript' },
    idempotency_key: 'secret-idempotency-key',
    last_error: 'raw Supabase error with token=secret',
  }];
  await withServer(createMockDb({
    listSalesforceOutboxJobs: async filters => { receivedFilters = filters; return jobs; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/salesforce-outbox?status=failed&ticket_id=7&limit=500&offset=2');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.jobs, [{
      id: 1,
      ticket_id: 7,
      sf_case_id: null,
      operation: 'case_close',
      status: 'failed',
      attempts: null,
      next_attempt_at: null,
      processed_at: null,
      created_at: null,
      updated_at: null,
    }]);
    assert.equal(res.body.jobs[0].payload, undefined);
    assert.equal(res.body.jobs[0].idempotency_key, undefined);
    assert.equal(res.body.jobs[0].last_error, undefined);
    assert.deepEqual(receivedFilters, { status: 'failed', ticket_id: 7, limit: 200, offset: 2 });
  });
});

test('/api/admin retries Salesforce outbox job locally without Salesforce calls', async () => {
  const audits = [];
  let retriedId;
  await withServer(createMockDb({
    markSalesforceOutboxJobRetryable: async id => {
      retriedId = id;
      return {
        id,
        ticket_id: 7,
        operation: 'case_close',
        status: 'pending',
        payload: { transcript: 'secret transcript' },
        idempotency_key: 'secret-idempotency-key',
        last_error: 'raw Supabase error with token=secret',
      };
    },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/salesforce-outbox/12/retry');
    assert.equal(res.status, 200);
    assert.equal(retriedId, 12);
    assert.equal(res.body.job.status, 'pending');
    assert.equal(res.body.job.payload, undefined);
    assert.equal(res.body.job.idempotency_key, undefined);
    assert.equal(res.body.job.last_error, undefined);
    assert.equal(audits[0].action, 'salesforce_outbox.retry');
    assert.deepEqual(audits[0].metadata, { ticket_id: 7, operation: 'case_close' });
  });
});

test('/api/admin Salesforce outbox missing schema returns controlled 503', async () => {
  await withServer(createMockDb({
    listSalesforceOutboxJobs: async () => {
      const err = new Error('Salesforce outbox schema is not available.');
      err.statusCode = 503;
      err.code = 'SF_OUTBOX_SCHEMA_MISSING';
      throw err;
    },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/salesforce-outbox');
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: 'Salesforce outbox schema is not available.' });
  });
});

test('/api/admin one-shot processor bounds limit, audits safe counts, and returns no sensitive fields', async () => {
  const audits = [];
  let claimLimit;
  await withServer(createMockDb({
    claimSalesforceOutboxJobs: async (workerId, limit) => { assert.match(workerId, /^admin-/); claimLimit = limit; return []; },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/salesforce-outbox/process', { limit: 99, payload: 'secret' });
    assert.equal(res.status, 200);
    assert.equal(claimLimit, 1);
    assert.deepEqual(res.body.counts, { claimed: 0, synced: 0, retrying: 0, failed: 0, lease_lost: 0, processor_error: 0 });
    assert.doesNotMatch(JSON.stringify(res.body), /secret/);
    assert.equal(res.body.recovery, 'manual_admin_invocation_required');
    assert.equal(res.body.invocation, 'manual_only');
    assert.equal(res.body.audit_persisted, true);
    assert.deepEqual(res.body.warnings, []);
    assert.equal(res.body.external_alerting, 'not_configured_intentional_next_step');
    assert.equal(audits[0].action, 'salesforce_outbox.processed');
    assert.equal(audits[0].metadata.limit, 10);
  });
});

test('/api/admin surfaces processor audit persistence failure with a safe fallback', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await withServer(createMockDb({
      claimSalesforceOutboxJobs: async () => [],
      logAudit: async () => { throw new Error('database secret details'); },
    }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
      const res = await request(baseUrl, 'POST', '/api/admin/salesforce-outbox/process', { limit: 1 });
      assert.equal(res.status, 200);
      assert.equal(res.body.audit_persisted, false);
      assert.deepEqual(res.body.warnings, ['PROCESSOR_AUDIT_PERSIST_FAILED']);
      assert.deepEqual(errors, ['[salesforce_outbox] processor_audit_persist_failed']);
      assert.doesNotMatch(JSON.stringify(res.body) + errors.join(' '), /database secret details/);
    });
  } finally {
    console.error = originalError;
  }
});

test('/api/admin audits processor-level claim failure with safe code and manual recovery', async () => {
  const audits = [];
  await withServer(createMockDb({
    claimSalesforceOutboxJobs: async () => { throw Object.assign(new Error('database secret details'), { code: 'DB_CLAIM_FAILED' }); },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/salesforce-outbox/process', { limit: 2 });
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.processor_error, 1);
    assert.equal(res.body.recovery, 'manual_admin_invocation_required');
    assert.doesNotMatch(JSON.stringify(res.body), /database secret details/);
    assert.equal(audits[0].action, 'salesforce_outbox.process_failed');
    assert.equal(audits[0].metadata.error_code, 'DB_CLAIM_FAILED');
    assert.equal(audits[0].metadata.error_category, 'claim_failure');
    assert.equal(audits[0].metadata.processor_error, 1);
  });
});

test('/api/admin one-shot processor defaults to one and rejects non-admin access', async () => {
  let calls = 0;
  const mockDb = createMockDb({ claimSalesforceOutboxJobs: async (workerId, limit) => { calls += 1; assert.equal(limit, 1); return []; } });
  await withServer(mockDb, { role: 'admin' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'POST', '/api/admin/salesforce-outbox/process', {})).status, 200);
  });
  await withServer(mockDb, { role: 'agent' }, async baseUrl => {
    assert.equal((await request(baseUrl, 'POST', '/api/admin/salesforce-outbox/process', {})).status, 403);
  });
  assert.equal(calls, 1);
});

test('/api/admin returns 500 when audit listing rejects', async () => {
  await withServer(createMockDb({
    listAuditLogs: async () => { throw new Error('audit unavailable'); },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/audit');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'audit unavailable' });
  });
});

test('/api/admin queue returns unconfigured SLA without a policy snapshot', async () => {
  await withServer(createMockDb({
    getTicketsWithRouting: async () => [{ id: 20, area_id: 2, status: 'open', created_at: '2026-07-09T10:00:00.000Z', area: { id: 2, name: 'Support', sla_minutes: 30 } }],
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/queue');

    assert.equal(res.status, 200);
    assert.equal(res.body.tickets[0].id, 20);
    assert.equal(res.body.tickets[0].sla.state, 'unconfigured');
    assert.equal(res.body.tickets[0].sla.due_at, null);
  });
});

test('/api/admin assignment relies on the transactional RPC audit exactly once', async () => {
  const audits = [];
  await withServer(createMockDb({
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
    adminRouteTicket: async () => ({ id: 20, area_id: 2, assignment: { analyst_id: 7 } }),
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/assign', { analyst_id: 7 });

    assert.equal(res.status, 200);
    assert.equal(res.body.assignment.analyst_id, 7);
    assert.equal(audits.length, 0);
  });
});

test('/api/admin REST assignment emits scoped routing updates', async () => {
  const io = createIo();

  await withServer(createMockDb(), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/assign', { analyst_id: 7 });

    assert.equal(res.status, 200);
    const scoped = io.emissions.map(item => `${item.rooms.join(',')}:${item.event}`);
    for (const expected of ['admin:ticket-assigned','area:2:ticket-assigned','analyst:7:ticket-assigned','admin:queue-updated','area:2:queue-updated','analyst:7:queue-updated']) assert.ok(scoped.includes(expected));
    assert.equal(scoped.some(item => item.endsWith(':sla-alert')), false);
  }, io);
});

test('/api/admin rejects assignment to analysts outside ticket area', async () => {
  await withServer(createMockDb({ getAnalystById: async id => ({ id, area_id: 9, display_name: 'Wrong area' }) }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/assign', { analyst_id: 9 });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /does not belong/);
  });
});

test('/api/admin rejects assignment to null-area analysts for area tickets', async () => {
  await withServer(createMockDb({ getAnalystById: async id => ({ id, area_id: null, display_name: 'No area' }) }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/assign', { analyst_id: 11 });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /does not belong/);
  });
});

test('/api/admin transfer emits old-area and new-area routing updates', async () => {
  const io = createIo();

  await withServer(createMockDb({
    adminRouteTicket: async () => ({ id: 20, previous_area_id: 1, area_id: 2, status: 'open', created_at: '2026-07-09T10:00:00.000Z', area: { id: 2, name: 'Support', sla_minutes: 30 }, assignment: { ticket_id: 20, analyst_id: 7, analyst: { id: 7, display_name: 'Ada', area_id: 2 } } }),
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/transfer', { area_id: 2, analyst_id: 7 });

    assert.equal(res.status, 200);
    const scoped = io.emissions.map(item => `${item.rooms.join(',')}:${item.event}`);
    for (const expected of ['admin:ticket-removed','area:1:ticket-removed','admin:ticket-assigned','area:2:ticket-assigned','analyst:7:ticket-assigned','admin:queue-updated','area:2:queue-updated','analyst:7:queue-updated']) assert.ok(scoped.includes(expected));
  }, io);
});

test('/api/admin allows admins to list bot flows and cache status', async () => {
  const flows = [{ id: 1, step_key: 'ask_name', message: 'Nombre', version_id: 1, area_id: null }];
  await withServer(createMockDb({
    listActiveBotFlows: async ({ areaId }) => {
      assert.equal(areaId, null);
      return flows;
    },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/bot-flows');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.flows, flows);
    assert.deepEqual(res.body.cache, []);
  });
});

test('/api/admin lists area bot flows with validated area_id', async () => {
  await withServer(createMockDb({
    listActiveBotFlows: async ({ areaId }) => {
      assert.equal(areaId, 3);
      return [{ id: 2, step_key: 'ask_name', message: 'Nombre', version_id: 2, area_id: 3 }];
    },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/bot-flows?area_id=3');

    assert.equal(res.status, 200);
    assert.equal(res.body.flows[0].area_id, 3);
  });
});

test('/api/admin rejects invalid bot flow area_id query', async () => {
  let dbCalled = false;
  await withServer(createMockDb({
    listActiveBotFlows: async () => { dbCalled = true; return []; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/bot-flows?area_id=abc');

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'area_id must be a positive integer.' });
    assert.equal(dbCalled, false);
  });
});

test('/api/admin returns 500 when bot flow listing rejects', async () => {
  await withServer(createMockDb({
    listActiveBotFlows: async () => { throw new Error('flow lookup failed'); },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/bot-flows');

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'flow lookup failed' });
  });
});

test('/api/admin invalidates bot flow cache and writes audit log', async () => {
  const audits = [];
  await withServer(createMockDb({
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows/cache/invalidate', { area_id: 3 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, cache: [] });
    assert.equal(audits[0].action, 'flow.cache_invalidated');
    assert.equal(audits[0].target_id, '3');
    assert.deepEqual(audits[0].metadata, { area_id: 3 });
  });
});

test('/api/admin lists manageable bot flows with filters', async () => {
  await withServer(createMockDb({
    listBotFlows: async filters => {
      assert.deepEqual(filters, { versionId: 2, areaId: 3, globalOnly: false, active: false });
      return [{ id: 8, step_key: 'ask_issue', message: 'Describe', version_id: 2, area_id: 3, active: false }];
    },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/bot-flows?version_id=2&area_id=3&active=false');

    assert.equal(res.status, 200);
    assert.equal(res.body.flows[0].id, 8);
  });
});

test('/api/admin creates bot flow steps, invalidates cache, and writes audit logs', async () => {
  const audits = [];
  let createdPayload;

  await withServer(createMockDb({
    listBotFlows: async () => [],
    createBotFlowStep: async payload => { createdPayload = payload; return { id: 9, ...payload }; },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows', {
      version_id: 2,
      area_id: null,
      step_key: 'ask_name',
      message: 'Indica tu nombre',
      sort_order: 10,
      active: true,
    });

    assert.equal(res.status, 201);
    assert.deepEqual(createdPayload, { version_id: 2, area_id: null, step_key: 'ask_name', message: 'Indica tu nombre', sort_order: 10, active: true });
    assert.equal(audits[0].action, 'flow.created');
    assert.equal(audits[0].target_id, '9');
    assert.deepEqual(res.body.cache, undefined);
  });
});

test('/api/admin rejects bot flow creation with missing required fields', async () => {
  let createCalled = false;
  await withServer(createMockDb({
    createBotFlowStep: async payload => { createCalled = true; return { id: 1, ...payload }; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows', { version_id: 1, step_key: 'ask_name' });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'message is required.' });
    assert.equal(createCalled, false);
  });
});

test('/api/admin rejects duplicate bot flow steps before insert', async () => {
  let createCalled = false;
  await withServer(createMockDb({
    listBotFlows: async () => [{ id: 1, version_id: 1, area_id: null, step_key: 'ask_name' }],
    createBotFlowStep: async payload => { createCalled = true; return { id: 2, ...payload }; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows', { version_id: 1, step_key: 'ask_name', message: 'Nombre' });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /already exists/);
    assert.equal(createCalled, false);
  });
});

test('/api/admin translates DB bot flow unique violations to 409', async () => {
  await withServer(createMockDb({
    listBotFlows: async () => [],
    createBotFlowStep: async () => {
      const err = new Error('duplicate key value violates unique constraint "bot_flows_effective_identity_uidx"');
      err.code = '23505';
      throw err;
    },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows', { version_id: 1, step_key: 'ask_name', message: 'Nombre' });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /already exists/);
  });
});

test('/api/admin rejects unsupported bot flow step keys', async () => {
  let createCalled = false;
  await withServer(createMockDb({
    createBotFlowStep: async payload => { createCalled = true; return { id: 2, ...payload }; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows', { version_id: 1, step_key: 'custom_future_step', message: 'No usado' });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unsupported step_key/);
    assert.equal(createCalled, false);
  });
});

test('/api/admin create bot flow invalidates populated route cache', async () => {
  await withServer(createMockDb({
    listActiveBotFlows: async () => [{ id: 1, step_key: 'ask_name', message: 'Nombre cacheado', version_id: 1, area_id: null }],
    listBotFlows: async () => [],
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const loadedBotFlow = require(botFlowPath);
    await loadedBotFlow.loadFlow();
    assert.equal(loadedBotFlow.getBotFlowCacheStatus().length, 1);

    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows', { version_id: 1, step_key: 'ask_email', message: 'Correo' });

    assert.equal(res.status, 201);
    assert.deepEqual(loadedBotFlow.getBotFlowCacheStatus(), []);
  });
});

test('/api/admin updates bot flow steps and guards duplicates', async () => {
  const audits = [];
  let updateCalled = false;
  await withServer(createMockDb({
    listBotFlows: async () => [
      { id: 1, version_id: 1, area_id: null, step_key: 'ask_name', message: 'Nombre' },
      { id: 2, version_id: 1, area_id: null, step_key: 'ask_email', message: 'Correo' },
    ],
    updateBotFlowStep: async (id, payload) => { updateCalled = true; return { id, version_id: 1, area_id: null, step_key: 'ask_name', message: 'Nombre completo', active: true, ...payload }; },
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const duplicate = await request(baseUrl, 'PATCH', '/api/admin/bot-flows/1', { step_key: 'ask_email' });
    assert.equal(duplicate.status, 409);
    assert.equal(updateCalled, false);

    const updated = await request(baseUrl, 'PATCH', '/api/admin/bot-flows/1', { message: 'Nombre completo' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.message, 'Nombre completo');
    assert.equal(audits[0].action, 'flow.updated');
  });
});

test('/api/admin update and toggle bot flow routes invalidate populated cache', async () => {
  await withServer(createMockDb({
    listActiveBotFlows: async () => [{ id: 1, step_key: 'ask_name', message: 'Nombre cacheado', version_id: 1, area_id: null }],
    listBotFlows: async () => [{ id: 1, version_id: 1, area_id: null, step_key: 'ask_name', message: 'Nombre' }],
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const loadedBotFlow = require(botFlowPath);

    await loadedBotFlow.loadFlow();
    assert.equal(loadedBotFlow.getBotFlowCacheStatus().length, 1);
    const updated = await request(baseUrl, 'PATCH', '/api/admin/bot-flows/1', { message: 'Nombre completo' });
    assert.equal(updated.status, 200);
    assert.deepEqual(loadedBotFlow.getBotFlowCacheStatus(), []);

    await loadedBotFlow.loadFlow();
    assert.equal(loadedBotFlow.getBotFlowCacheStatus().length, 1);
    const toggled = await request(baseUrl, 'POST', '/api/admin/bot-flows/1/toggle', { active: false });
    assert.equal(toggled.status, 200);
    assert.deepEqual(loadedBotFlow.getBotFlowCacheStatus(), []);
  });
});

test('/api/admin toggles bot flow active state and writes audit logs', async () => {
  const audits = [];
  await withServer(createMockDb({
    updateBotFlowStep: async (id, payload) => ({ id, step_key: 'ask_name', version_id: 1, area_id: null, message: 'Nombre', active: payload.active }),
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows/1/toggle', { active: false });

    assert.equal(res.status, 200);
    assert.equal(res.body.active, false);
    assert.equal(audits[0].action, 'flow.toggled');
    assert.deepEqual(audits[0].metadata, { active: false });
  });
});

test('/api/admin rejects invalid bot flow invalidation area_id body', async () => {
  let auditCalled = false;
  await withServer(createMockDb({
    logAudit: async () => { auditCalled = true; return { id: 1 }; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows/cache/invalidate', { area_id: 0 });

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'area_id must be a positive integer.' });
    assert.equal(auditCalled, false);
  });
});

test('/api/admin invalidates global bot flow cache when area_id is omitted', async () => {
  const audits = [];
  await withServer(createMockDb({
    logAudit: async payload => { audits.push(payload); return { id: 1 }; },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows/cache/invalidate', {});

    assert.equal(res.status, 200);
    assert.equal(audits[0].target_id, 'global');
    assert.deepEqual(audits[0].metadata, { area_id: null });
  });
});

test('/api/admin returns 500 when bot flow invalidation audit rejects', async () => {
  await withServer(createMockDb({
    logAudit: async () => { throw new Error('audit failed'); },
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/bot-flows/cache/invalidate', { area_id: 3 });

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'audit failed' });
  });
});

test('/api/admin ticket post-processing requires durable invocation audit before claiming work', async () => {
  let processCalled = false;
  const db = createMockDb({
    logAudit: async () => { throw new Error('audit storage unavailable'); },
    claimTicketPostProcessing: async () => { processCalled = true; return []; },
  });
  await withServer(db, { role: 'admin', name: 'Root' }, async baseUrl => {
    const res = await request(baseUrl, 'POST', '/api/admin/ticket-post-processing/process', { limit: 3 });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { code: 'AUDIT_UNAVAILABLE', error: 'Processing could not be authorized for execution.' });
    assert.equal(processCalled, false);
    assert.equal(JSON.stringify(res.body).includes('storage'), false);
  });
});

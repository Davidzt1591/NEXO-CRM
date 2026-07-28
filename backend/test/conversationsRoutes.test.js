const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const path = require('node:path');

const dbPath = path.resolve(__dirname, '../src/database/db.js');
const routerPath = path.resolve(__dirname, '../src/routes/conversations.js');

function workflow({ analystId = 7, areaId = 3 } = {}) {
  return { id: 101, area_id: areaId, status: 'open', conversation_state: 'in_progress', workflow_revision: 2, assignment: analystId == null ? null : { analyst_id: analystId }, development_escalations: [], sla_snapshots: [] };
}

async function withApp(db, user, run) {
  const emissions = [];
  const io = { to(room) { return { emit(event, payload) { emissions.push({ room, event, payload }); } }; } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  delete require.cache[routerPath];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.set('io', io);
  app.use('/api/conversations', require(routerPath));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ request, emissions }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('GET workflow maps identity and returns the exact workflow contract', async () => {
  const calls = [];
  const db = { getAnalystByTokenId: async id => { calls.push(['principal', id]); return { id: 7, area_id: 3 }; }, getTicketWorkflow: async id => { calls.push(['workflow', id]); return workflow(); } };
  await withApp(db, { id: 'token', role: 'agent', name: 'Ana' }, async ({ request }) => {
    assert.deepEqual(await request('GET', '/api/conversations/101/workflow'), { status: 200, body: { ...workflow(), sla: {} } });
    assert.deepEqual(calls, [['principal', 'token'], ['workflow', '101']]);
    db.getTicketWorkflow = async () => workflow({ analystId: 8 });
    assert.deepEqual(await request('GET', '/api/conversations/101/workflow'), { status: 403, body: { error: 'Ticket access denied.' } });
    db.getTicketWorkflow = async () => workflow({ analystId: null });
    assert.deepEqual(await request('GET', '/api/conversations/101/workflow'), { status: 403, body: { error: 'Ticket access denied.' } });
    db.getTicketWorkflow = async () => workflow({ areaId: 4 });
    assert.deepEqual(await request('GET', '/api/conversations/101/workflow'), { status: 403, body: { error: 'Ticket access denied.' } });
  });
  await withApp({ ...db, getTicketWorkflow: async () => workflow({ analystId: 8, areaId: 4 }) }, { id: 'admin', role: 'admin', name: 'Root' }, async ({ request }) => {
    assert.deepEqual(await request('GET', '/api/conversations/101/workflow'), { status: 200, body: { ...workflow({ analystId: 8, areaId: 4 }), sla: {} } });
  });
});

test('every mutation endpoint normalizes payload, maps actor, returns contract, and suppresses replay emission', async () => {
  const current = workflow();
  const calls = [];
  let replayed = false;
  const result = () => ({ workflow: current, mutation: { replayed, eventId: 9, eventType: 'test' } });
  const db = {
    getAnalystByTokenId: async () => ({ id: 7, area_id: 3 }),
    transitionConversation: async input => { calls.push(['transition', input]); return result(); },
    updateDevelopmentEscalation: async input => { calls.push(['escalation', input]); return result(); },
  };
  await withApp(db, { id: 'token', role: 'agent', name: 'Ana' }, async ({ request, emissions }) => {
    const actor = { actorId: 7, actorName: 'Ana', actorRole: 'analyst', actorAreaId: 3 };
    const contract = { ...current, sla: {} };
    const transition = { state: ' WAITING ', waiting_reason: ' CUSTOMER_RESPONSE ', expected_revision: 2, idempotency_key: 'transition_101' };
    assert.deepEqual(await request('POST', '/api/conversations/101/transitions', transition), { status: 200, body: contract });
    assert.deepEqual(await request('POST', '/api/conversations/101/development-escalations', { note: '  internal  ', expected_revision: 2, idempotency_key: 'escalate_101' }), { status: 201, body: contract });
    assert.deepEqual(await request('POST', '/api/conversations/101/development-escalations/status', { status: ' RESOLVED ', expected_revision: 0, idempotency_key: 'resolve_101' }), { status: 200, body: contract });
    assert.deepEqual(calls, [
      ['transition', { ticketId: '101', state: 'waiting', waitingReason: 'customer_response', expectedRevision: 2, idempotencyKey: 'transition_101', actor }],
      ['escalation', { ticketId: '101', status: 'requested', expectedRevision: 2, idempotencyKey: 'escalate_101', note: 'internal', actor }],
      ['escalation', { ticketId: '101', status: 'resolved', expectedRevision: 0, idempotencyKey: 'resolve_101', note: null, actor }],
    ]);
    assert.equal(emissions.filter(item => item.room === 'area:3').some(item => JSON.stringify(item.payload).includes('internal')), false);
    const count = emissions.length;
    replayed = true;
    assert.deepEqual(await request('POST', '/api/conversations/101/transitions', transition), { status: 200, body: contract });
    assert.deepEqual(await request('POST', '/api/conversations/101/development-escalations', { note: 'internal', expected_revision: 2, idempotency_key: 'escalate_101' }), { status: 200, body: contract });
    assert.equal(emissions.length, count);
  });
});

test('router returns exact safe validation and workflow error bodies without emission', async () => {
  const errors = [
    Object.assign(new Error('WORKFLOW_FORBIDDEN'), { statusCode: 403 }), Object.assign(new Error('WORKFLOW_REVISION_CONFLICT'), { statusCode: 409 }),
    Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), { statusCode: 409 }), Object.assign(new Error('WORKFLOW_RESULT_MISMATCH'), { statusCode: 409 }),
    Object.assign(new Error('database unavailable'), { statusCode: 503 }),
  ];
  let index = 0;
  const db = { getAnalystByTokenId: async () => ({ id: 7, area_id: 3 }), transitionConversation: async () => { throw errors[index++]; } };
  await withApp(db, { id: 'token', role: 'agent', name: 'Ana' }, async ({ request, emissions }) => {
    assert.deepEqual(await request('POST', '/api/conversations/101/transitions', {}), { status: 400, body: { code: 'Unsupported conversation state.', error: 'Unsupported conversation state.' } });
    const body = { state: 'closed', expected_revision: 2, idempotency_key: 'close_ticket_101' };
    for (const [status, error] of [[403, errors[0]], [409, errors[1]], [409, errors[2]], [409, errors[3]], [503, errors[4]]]) {
      assert.deepEqual(await request('POST', '/api/conversations/101/transitions', body), { status, body: { code: error.message, error: error.message } });
    }
    assert.deepEqual(emissions, []);
  });
});

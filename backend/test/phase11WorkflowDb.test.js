const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dbPath = path.resolve(__dirname, '../src/database/db.js');
const supabaseModulePath = require.resolve('@supabase/supabase-js');

function loadDb({ rpcResult, onFrom = () => {}, onRpc = () => {} }) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const query = {
    select() { return this; }, eq() { return this; }, order() { return this; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: { id: 101, area_id: 3, assignment: { analyst_id: 7 } }, error: null }); },
    then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
  };
  const client = {
    rpc: async (name, args) => { onRpc(name, args); return rpcResult; },
    from(table) { onFrom(table); return query; },
  };
  delete require.cache[dbPath];
  require.cache[supabaseModulePath] = { id: supabaseModulePath, filename: supabaseModulePath, loaded: true, exports: { createClient: () => client } };
  return require(dbPath);
}

for (const operation of ['claimConversation', 'transitionConversation', 'updateDevelopmentEscalation']) {
  test(`${operation} rejects mismatched authoritative identity before service-role reads`, async () => {
    const reads = [];
    const db = loadDb({ rpcResult: { data: { ticket_id: 202, event_id: 9, replayed: false }, error: null }, onFrom: table => reads.push(table) });
    const common = { ticketId: 101, expectedRevision: 0, idempotencyKey: 'same_key_101' };
    const args = operation === 'claimConversation'
      ? { ...common, analystId: 7, analystAreaId: 3, actorName: 'Ana' }
      : operation === 'transitionConversation'
        ? { ...common, state: 'waiting', waitingReason: 'customer_response', actor: { actorId: 7, actorName: 'Ana', actorRole: 'analyst', actorAreaId: 3 } }
        : { ...common, status: 'requested', note: 'x', actor: { actorId: 7, actorName: 'Ana', actorRole: 'analyst', actorAreaId: 3 } };
    await assert.rejects(db[operation](args), error => error.message === 'WORKFLOW_RESULT_MISMATCH' && error.statusCode === 409);
    assert.deepEqual(reads, []);
  });
}

test('idempotency conflict is a safe 409 and does not fetch caller target', async () => {
  const reads = [];
  const db = loadDb({ rpcResult: { data: null, error: { message: 'IDEMPOTENCY_KEY_REUSED', code: '23505' } }, onFrom: table => reads.push(table) });
  await assert.rejects(db.claimConversation({ ticketId: 101, analystId: 7, analystAreaId: 3, expectedRevision: 0, idempotencyKey: 'same_key_101', actorName: 'Ana' }), error => error.statusCode === 409);
  assert.deepEqual(reads, []);
});

test('database unavailability propagates without a service-role follow-up read', async () => {
  const reads = [];
  const failure = { message: 'database unavailable', code: '08006' };
  const db = loadDb({ rpcResult: { data: null, error: failure }, onFrom: table => reads.push(table) });
  await assert.rejects(db.transitionConversation({ ticketId: 101, state: 'closed', waitingReason: null, expectedRevision: 4, idempotencyKey: 'close_key_101', actor: { actorId: 7, actorName: 'Ana', actorRole: 'analyst', actorAreaId: 3 } }), error => error.message === 'database unavailable' && error.statusCode === 503);
  assert.deepEqual(reads, []);
});

test('workflow wrappers call exact RPCs with versioned JSONB commands', async () => {
  const calls = [];
  const db = loadDb({ rpcResult: { data: { ticket_id: 101, event_id: 9, event_type: 'workflow.event', replayed: true }, error: null }, onRpc: (name, args) => calls.push({ name, args }) });
  const actor = { actorId: 7, actorName: 'Ana', actorRole: 'analyst', actorAreaId: 3 };
  const claim = await db.claimConversation({ ticketId: '101', analystId: 7, analystAreaId: 3, expectedRevision: 0, idempotencyKey: 'claim_key_101', actorName: 'Ana' });
  await db.transitionConversation({ ticketId: '101', state: 'waiting', waitingReason: 'customer_response', expectedRevision: 4, idempotencyKey: 'wait_key_101', actor });
  await db.updateDevelopmentEscalation({ ticketId: '101', status: 'requested', note: 'Investigate', expectedRevision: 5, idempotencyKey: 'create_dev_101', actor });
  const update = await db.updateDevelopmentEscalation({ ticketId: '101', status: 'resolved', note: null, expectedRevision: 2, idempotencyKey: 'resolve_dev_101', actor });
  assert.deepEqual(calls, [
    { name: 'claim_conversation', args: { p_command: { version: 1, ticket_id: 101, expected_revision: 0, idempotency_key: 'claim_key_101' }, p_actor_id: '7', p_actor_name: 'Ana', p_actor_role: 'analyst', p_actor_area_id: 3 } },
    { name: 'transition_conversation', args: { p_command: { version: 1, ticket_id: 101, state: 'waiting', waiting_reason: 'customer_response', expected_revision: 4, idempotency_key: 'wait_key_101' }, p_actor_id: '7', p_actor_name: 'Ana', p_actor_role: 'analyst', p_actor_area_id: 3 } },
    { name: 'update_development_escalation', args: { p_command: { version: 1, ticket_id: 101, status: 'requested', note: 'Investigate', expected_revision: 5, idempotency_key: 'create_dev_101' }, p_actor_id: '7', p_actor_name: 'Ana', p_actor_role: 'analyst', p_actor_area_id: 3 } },
    { name: 'update_development_escalation', args: { p_command: { version: 1, ticket_id: 101, status: 'resolved', note: null, expected_revision: 2, idempotency_key: 'resolve_dev_101' }, p_actor_id: '7', p_actor_name: 'Ana', p_actor_role: 'analyst', p_actor_area_id: 3 } },
  ]);
  assert.deepEqual(claim.mutation, { replayed: true, eventId: 9, eventType: 'workflow.event' });
  assert.deepEqual(update.mutation, { replayed: true, eventId: 9, eventType: 'workflow.event' });
});

test('workflow wrappers preserve nonnumeric admin IDs and use analyst IDs for analysts', async () => {
  const calls = [];
  const db = loadDb({ rpcResult: { data: { ticket_id: 101, event_id: 9, event_type: 'workflow.event', replayed: true }, error: null }, onRpc: (name, args) => calls.push({ name, args }) });
  await db.transitionConversation({ ticketId: 101, state: 'closed', waitingReason: null, expectedRevision: 1, idempotencyKey: 'admin_close_101', actor: { actorId: '550e8400-e29b-41d4-a716-446655440000', actorName: 'Root', actorRole: 'admin', actorAreaId: null } });
  assert.equal(calls[0].args.p_actor_id, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(calls[0].args.p_actor_area_id, null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SALESFORCE_OUTBOX_LEASE_SECONDS } = require('../src/services/salesforceOutboxContract');

const dbPath = path.resolve(__dirname, '../src/database/db.js');
const supabaseModulePath = require.resolve('@supabase/supabase-js');

function loadDb(client) {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'service-role-key';

  delete require.cache[dbPath];
  require.cache[supabaseModulePath] = {
    id: supabaseModulePath,
    filename: supabaseModulePath,
    loaded: true,
    exports: { createClient: () => client },
  };

  return require(dbPath);
}

function createQuery(result, hooks = {}) {
  return {
    select(columns) { hooks.select?.(columns); return this; },
    eq(field, value) { hooks.eq?.(field, value); return this; },
    gte(field, value) { hooks.gte?.(field, value); return this; },
    in(field, values) { hooks.in?.(field, values); return this; },
    order(field, options) { hooks.order?.(field, options); return this; },
    range(from, to) { hooks.range?.(from, to); return this; },
    single() { hooks.single?.(); return Promise.resolve(result); },
    maybeSingle() { hooks.maybeSingle?.(); return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
}

test('claimSalesforceOutboxJobs calls bounded atomic RPC', async () => {
  let received;
  const db = loadDb({
    rpc(name, params) { received = { name, params }; return Promise.resolve({ data: [{ id: 1 }], error: null }); },
  });
  assert.deepEqual(await db.claimSalesforceOutboxJobs('worker-1', 50), [{ id: 1 }]);
  assert.deepEqual(received, { name: 'claim_salesforce_outbox_jobs', params: { p_worker_id: 'worker-1', p_limit: 10, p_lock_timeout_seconds: SALESFORCE_OUTBOX_LEASE_SECONDS } });
  await assert.rejects(() => db.claimSalesforceOutboxJobs(''), err => err.code === 'SF_OUTBOX_WORKER_REQUIRED');
});

test('claimed job transitions delegate ownership and fresh-lease enforcement to atomic RPC', async () => {
  let received;
  const db = loadDb({
    rpc(name, params) {
      received = { name, params };
      return Promise.resolve({ data: [], error: null });
    },
  });
  await assert.rejects(() => db.markSalesforceOutboxJobSynced(4, 'worker-1'), err => err.code === 'SF_OUTBOX_LEASE_LOST' && err.statusCode === 409);
  assert.equal(received.name, 'transition_salesforce_outbox_job');
  assert.equal(received.params.p_job_id, 4);
  assert.equal(received.params.p_worker_id, 'worker-1');
  assert.equal(received.params.p_status, 'synced');
  assert.equal(received.params.p_lock_timeout_seconds, SALESFORCE_OUTBOX_LEASE_SECONDS);
});

test('listTicketSalesforceOutboxJobs maps missing schema to controlled 503', async () => {
  const db = loadDb({
    from(table) {
      assert.equal(table, 'salesforce_outbox');
      return createQuery({
        data: null,
        error: { code: '42P01', message: 'relation "salesforce_outbox" does not exist' },
      });
    },
  });

  await assert.rejects(
    () => db.listTicketSalesforceOutboxJobs(7),
    err => err.statusCode === 503 && err.code === 'SF_OUTBOX_SCHEMA_MISSING',
  );
});

test('createSalesforceOutboxJob returns existing job on duplicate idempotency insert', async () => {
  const existing = { id: 9, ticket_id: 7, operation: 'case_close', idempotency_key: 'same-key' };
  const calls = [];
  const db = loadDb({
    from(table) {
      assert.equal(table, 'salesforce_outbox');
      calls.push(table);
      if (calls.length === 1) {
        return {
          insert(payload) {
            assert.equal(payload.idempotency_key, 'same-key');
            return createQuery({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
          },
        };
      }
      return createQuery({ data: existing, error: null }, {
        eq(field, value) {
          assert.equal(field, 'idempotency_key');
          assert.equal(value, 'same-key');
        },
      });
    },
  });

  const job = await db.createSalesforceOutboxJob({
    ticket_id: 7,
    sf_case_id: '500xx',
    operation: 'case_close',
    status: 'pending',
    payload: {},
    idempotency_key: 'same-key',
  });

  assert.deepEqual(job, { ...existing, duplicate: true });
  assert.equal(calls.length, 2);
});

test('createSalesforceOutboxJob propagates generic Supabase errors', async () => {
  const db = loadDb({
    from(table) {
      assert.equal(table, 'salesforce_outbox');
      return {
        insert() {
          return createQuery({ data: null, error: { code: 'XX000', message: 'database unavailable' } });
        },
      };
    },
  });

  await assert.rejects(
    () => db.createSalesforceOutboxJob({ ticket_id: 7, operation: 'case_close', idempotency_key: 'key' }),
    err => err.code === 'XX000' && err.message === 'database unavailable',
  );
});

test('markSalesforceOutboxJobRetryable conflicts for active, synced, or missing jobs', async () => {
  const db = loadDb({
    rpc(name, params) {
      assert.equal(name, 'retry_salesforce_outbox_job');
      assert.deepEqual(params, { p_job_id: 12 });
      return Promise.resolve({ data: [], error: null });
    },
  });

  await assert.rejects(
    () => db.markSalesforceOutboxJobRetryable(12),
    err => err.statusCode === 409 && err.code === 'SF_OUTBOX_JOB_NOT_RETRYABLE' && /not failed/i.test(err.message),
  );
});

test('listTicketSalesforceOutboxJobs requests only ticket-safe outbox columns', async () => {
  let selectedColumns;
  const rows = [{ id: 1, ticket_id: 7, status: 'pending', operation: 'case_close' }];
  const db = loadDb({
    from(table) {
      assert.equal(table, 'salesforce_outbox');
      return createQuery({ data: rows, error: null }, {
        select(columns) { selectedColumns = columns; },
      });
    },
  });

  const result = await db.listTicketSalesforceOutboxJobs(7);

  assert.equal(selectedColumns, 'id,ticket_id,sf_case_id,operation,status,attempts,next_attempt_at,processed_at,created_at,updated_at');
  assert.deepEqual(result, rows);
});

test('admin Salesforce outbox helpers request only admin-safe outbox columns', async () => {
  const selectedColumns = [];
  const db = loadDb({
    rpc(name, params) {
      assert.equal(name, 'retry_salesforce_outbox_job');
      assert.deepEqual(params, { p_job_id: 1 });
      return Promise.resolve({ data: [{ id: 1, ticket_id: 7, status: 'pending', operation: 'case_close' }], error: null });
    },
    from(table) {
      assert.equal(table, 'salesforce_outbox');
      return {
        select(columns) {
          selectedColumns.push(columns);
          return createQuery({ data: [{ id: 1, ticket_id: 7, status: 'failed', operation: 'case_close' }], error: null });
        },
      };
    },
  });

  await db.listSalesforceOutboxJobs({ status: 'failed' });
  await db.markSalesforceOutboxJobRetryable(1);

  assert.deepEqual(selectedColumns, [
    'id,ticket_id,sf_case_id,operation,status,attempts,next_attempt_at,processed_at,created_at,updated_at',
  ]);
  assert.equal(selectedColumns.some(columns => columns === '*' || /payload|idempotency_key|last_error/.test(columns)), false);
});

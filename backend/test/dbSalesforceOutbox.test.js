const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
    in(field, values) { hooks.in?.(field, values); return this; },
    order(field, options) { hooks.order?.(field, options); return this; },
    range(from, to) { hooks.range?.(from, to); return this; },
    single() { hooks.single?.(); return Promise.resolve(result); },
    maybeSingle() { hooks.maybeSingle?.(); return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
}

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

test('markSalesforceOutboxJobRetryable rejects synced or missing jobs deterministically', async () => {
  const db = loadDb({
    from(table) {
      assert.equal(table, 'salesforce_outbox');
      return {
        update(payload) {
          assert.equal(payload.status, 'pending');
          assert.equal(payload.last_error, null);
          assert.equal(payload.processed_at, null);
          return createQuery({ data: null, error: null }, {
            eq(field, value) {
              assert.equal(field, 'id');
              assert.equal(value, 12);
            },
            in(field, values) {
              assert.equal(field, 'status');
              assert.deepEqual(values, ['pending', 'retrying', 'failed']);
            },
          });
        },
      };
    },
  });

  await assert.rejects(
    () => db.markSalesforceOutboxJobRetryable(12),
    err => err.statusCode === 404 && err.code === 'SF_OUTBOX_JOB_NOT_RETRYABLE',
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
    from(table) {
      assert.equal(table, 'salesforce_outbox');
      return {
        select(columns) {
          selectedColumns.push(columns);
          return createQuery({ data: [{ id: 1, ticket_id: 7, status: 'failed', operation: 'case_close' }], error: null });
        },
        update(payload) {
          assert.equal(payload.status, 'pending');
          return createQuery({ data: { id: 1, ticket_id: 7, status: 'pending', operation: 'case_close' }, error: null }, {
            select(columns) { selectedColumns.push(columns); },
          });
        },
      };
    },
  });

  await db.listSalesforceOutboxJobs({ status: 'failed' });
  await db.markSalesforceOutboxJobRetryable(1);

  assert.deepEqual(selectedColumns, [
    'id,ticket_id,sf_case_id,operation,status,attempts,next_attempt_at,processed_at,created_at,updated_at',
    'id,ticket_id,sf_case_id,operation,status,attempts,next_attempt_at,processed_at,created_at,updated_at',
  ]);
  assert.equal(selectedColumns.some(columns => columns === '*' || /payload|idempotency_key|last_error/.test(columns)), false);
});

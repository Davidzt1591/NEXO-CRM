const test = require('node:test');
const assert = require('node:assert/strict');

const outbox = require('../src/services/salesforceOutbox');
const contract = require('../src/services/salesforceOutboxContract');

function job(overrides = {}) {
  return {
    id: 1, ticket_id: 7, operation: 'case_close', attempts: 1, max_attempts: 5,
    payload: { version: 1, operation: 'case_close', salesforce: { case_id: '500xx' }, close: { has_resolution: true, subetapa_resuelto: 'Solved' } },
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    workerId: 'worker-1',
    now: () => new Date('2026-07-14T12:00:00.000Z'),
    db: {
      markSalesforceOutboxJobSynced: async (...args) => calls.push(['synced', ...args]),
      markSalesforceOutboxJobRetrying: async (...args) => calls.push(['retrying', ...args]),
      markSalesforceOutboxJobFailed: async (...args) => calls.push(['failed', ...args]),
      ...overrides.db,
    },
    salesforce: {
      getCaseCloseState: async () => ({ Id: '500xx', Status: 'New', Subetapa_resuelto__c: null }),
      closeCaseFromOutbox: async (...args) => calls.push(['patch', ...args]),
      ...overrides.salesforce,
    },
  };
}

test('invalid payload is terminal without Salesforce access', async () => {
  const deps = dependencies({ salesforce: { getCaseCloseState: async () => assert.fail('must not read Salesforce') } });
  const result = await outbox.processClaimedJob(job({ payload: { version: 2 } }), deps);
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'SF_OUTBOX_PAYLOAD_INVALID');
  assert.equal(deps.calls[0][0], 'failed');
});

test('whitespace-only case id and substage are rejected before Salesforce access', async () => {
  for (const payload of [
    { version: 1, operation: 'case_close', salesforce: { case_id: '   ' }, close: { has_resolution: true, subetapa_resuelto: 'Solved' } },
    { version: 1, operation: 'case_close', salesforce: { case_id: '500xx' }, close: { has_resolution: true, subetapa_resuelto: '  ' } },
  ]) {
    const deps = dependencies({ salesforce: { getCaseCloseState: async () => assert.fail('must not read Salesforce') } });
    assert.equal((await outbox.processClaimedJob(job({ payload }), deps)).status, 'failed');
  }
});

test('already closed Case converges to synced without PATCH', async () => {
  const deps = dependencies({ salesforce: {
    getCaseCloseState: async () => ({ Id: '500xx', Status: 'Resuelto', Subetapa_resuelto__c: 'Solved' }),
    closeCaseFromOutbox: async () => assert.fail('must not PATCH'),
  } });
  const result = await outbox.processClaimedJob(job(), deps);
  assert.equal(result.status, 'synced');
  assert.deepEqual(deps.calls.map(call => call[0]), ['synced']);
});

test('open Case is PATCHed and marked synced', async () => {
  const deps = dependencies();
  const result = await outbox.processClaimedJob(job(), deps);
  assert.equal(result.status, 'synced');
  assert.deepEqual(deps.calls.map(call => call[0]), ['patch', 'synced']);
  assert.deepEqual(deps.calls[0].slice(1), ['500xx', 'Solved']);
});

test('transient failure schedules deterministic retry backoff', async () => {
  const error = Object.assign(new Error('timeout with secret body'), { code: 'ETIMEDOUT' });
  const deps = dependencies({ salesforce: { getCaseCloseState: async () => { throw error; } } });
  const result = await outbox.processClaimedJob(job({ attempts: 2 }), deps);
  assert.equal(result.status, 'retrying');
  assert.equal(result.error_code, 'ETIMEDOUT');
  assert.equal(deps.calls[0][3].nextAttemptAt, '2026-07-14T12:02:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /secret body/);
});

test('terminal HTTP and exhausted attempts are marked failed', async () => {
  for (const current of [
    { attempts: 1, error: Object.assign(new Error('bad'), { statusCode: 422, code: 'INVALID_FIELD' }) },
    { attempts: 5, error: Object.assign(new Error('down'), { statusCode: 503, code: 'SF_HTTP_503' }) },
  ]) {
    const deps = dependencies({ salesforce: { getCaseCloseState: async () => { throw current.error; } } });
    const result = await outbox.processClaimedJob(job({ attempts: current.attempts }), deps);
    assert.equal(result.status, 'failed');
  }
});

test('lease loss is returned safely and does not trigger another transition', async () => {
  const leaseError = Object.assign(new Error('lost'), { code: 'SF_OUTBOX_LEASE_LOST' });
  const deps = dependencies({ db: { markSalesforceOutboxJobSynced: async () => { throw leaseError; } }, salesforce: {
    getCaseCloseState: async () => ({ Status: 'Resuelto', Subetapa_resuelto__c: 'Solved' }),
  } });
  assert.equal((await outbox.processClaimedJob(job(), deps)).status, 'lease_lost');
});

test('lease loss during retrying and failed transitions is returned safely', async () => {
  const leaseError = Object.assign(new Error('lost'), { code: 'SF_OUTBOX_LEASE_LOST' });
  for (const current of [
    { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), method: 'markSalesforceOutboxJobRetrying' },
    { error: Object.assign(new Error('invalid'), { statusCode: 422, code: 'INVALID_FIELD' }), method: 'markSalesforceOutboxJobFailed' },
  ]) {
    const deps = dependencies({
      db: { [current.method]: async () => { throw leaseError; } },
      salesforce: { getCaseCloseState: async () => { throw current.error; } },
    });
    assert.equal((await outbox.processClaimedJob(job(), deps)).status, 'lease_lost');
  }
});

test('retry classification covers transient and terminal HTTP statuses', () => {
  for (const status of [408, 409, 425, 429, 500, 503]) {
    assert.equal(outbox.classifyProcessorError({ statusCode: status, code: `SF_HTTP_${status}` }).retryable, true);
  }
  for (const status of [400, 402, 403, 404, 418, 422]) {
    assert.equal(outbox.classifyProcessorError({ statusCode: status, code: `SF_HTTP_${status}` }).retryable, false);
  }
  assert.equal(outbox.classifyProcessorError({ code: 'SF_REQUEST_TIMEOUT' }).retryable, true);
});

test('retry backoff uses first and capped boundaries', () => {
  const now = new Date('2026-07-14T12:00:00.000Z');
  assert.equal(outbox.nextRetryAt(1, now), '2026-07-14T12:00:30.000Z');
  assert.equal(outbox.nextRetryAt(999, now), '2026-07-14T12:30:00.000Z');
});

test('uncertain PATCH converges on the second claimed attempt without another PATCH', async () => {
  let reads = 0;
  let patches = 0;
  const timeout = Object.assign(new Error('timeout'), { code: 'SF_REQUEST_TIMEOUT', statusCode: 408 });
  const deps = dependencies({ salesforce: {
    getCaseCloseState: async () => (++reads === 1
      ? { Status: 'New', Subetapa_resuelto__c: null }
      : { Status: 'Resuelto', Subetapa_resuelto__c: 'Solved' }),
    closeCaseFromOutbox: async () => { patches += 1; throw timeout; },
  } });
  assert.equal((await outbox.processClaimedJob(job({ attempts: 1 }), deps)).status, 'retrying');
  assert.equal((await outbox.processClaimedJob(job({ attempts: 2 }), deps)).status, 'synced');
  assert.equal(patches, 1);
});

test('finite batch claims one immediately before each job and returns manual recovery metadata', async () => {
  let active = 0;
  let maxActive = 0;
  const jobs = [job({ id: 1 }), job({ id: 2 })];
  const result = await outbox.processBatch({
    limit: 10, workerId: 'worker-batch', now: () => new Date('2026-07-14T12:00:00.000Z'),
    db: {
      claimSalesforceOutboxJobs: async (workerId, limit) => { assert.equal(workerId, 'worker-batch'); assert.equal(limit, 1); return jobs.splice(0, 1); },
      markSalesforceOutboxJobSynced: async () => {},
      markSalesforceOutboxJobRetrying: async () => {},
      markSalesforceOutboxJobFailed: async () => {},
    },
    salesforce: {
      getCaseCloseState: async () => { active += 1; maxActive = Math.max(maxActive, active); await Promise.resolve(); active -= 1; return { Status: 'Resuelto', Subetapa_resuelto__c: 'Solved' }; },
      closeCaseFromOutbox: async () => {},
    },
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(result.counts, { claimed: 2, synced: 2, retrying: 0, failed: 0, lease_lost: 0, processor_error: 0 });
  assert.equal(result.recovery, 'manual_admin_invocation_required');
  assert.equal(result.invocation, 'manual_only');
  assert.equal(result.external_alerting, 'not_configured_intentional_next_step');
  assert.equal(result.jobs[0].payload, undefined);
});

test('worst bounded Salesforce request path stays comfortably below the lease', () => {
  assert.equal(contract.SALESFORCE_OUTBOX_MAX_REQUESTS_PER_OPERATION, 6);
  assert.equal(contract.SALESFORCE_OUTBOX_MAX_REQUESTS_PER_JOB, 12);
  assert.equal(contract.SALESFORCE_OUTBOX_WORST_REQUEST_PATH_MS, 240_000);
  assert.ok(
    contract.SALESFORCE_OUTBOX_WORST_REQUEST_PATH_MS <=
      (contract.SALESFORCE_OUTBOX_LEASE_SECONDS * 1_000) / 3,
    'request path must use at most one third of the lease',
  );
});

test('transition processor error is isolated and later requested jobs continue', async () => {
  const jobs = [job({ id: 1 }), job({ id: 2 })];
  const result = await outbox.processBatch({
    limit: 2, workerId: 'worker-batch', now: () => new Date('2026-07-14T12:00:00.000Z'),
    db: {
      claimSalesforceOutboxJobs: async () => jobs.splice(0, 1),
      markSalesforceOutboxJobSynced: async id => { if (id === 1) throw Object.assign(new Error('db down'), { code: 'DB_TRANSITION_FAILED' }); },
      markSalesforceOutboxJobRetrying: async () => {},
      markSalesforceOutboxJobFailed: async id => { if (id === 1) throw Object.assign(new Error('db down'), { code: 'DB_TRANSITION_FAILED' }); },
    },
    salesforce: { getCaseCloseState: async () => ({ Status: 'Resuelto', Subetapa_resuelto__c: 'Solved' }), closeCaseFromOutbox: async () => {} },
  });
  assert.deepEqual(result.jobs.map(item => item.status), ['processor_error', 'synced']);
  assert.equal(result.counts.processor_error, 1);
  assert.deepEqual(result.diagnosis, { error_code: 'DB_TRANSITION_FAILED', category: 'processor_failure' });
});

test('batch diagnosis prioritizes a later processor error over an earlier retryable failure', async () => {
  const jobs = [job({ id: 1 }), job({ id: 2 })];
  const result = await outbox.processBatch({
    limit: 2, workerId: 'worker-batch', now: () => new Date('2026-07-14T12:00:00.000Z'),
    db: {
      claimSalesforceOutboxJobs: async () => jobs.splice(0, 1),
      markSalesforceOutboxJobSynced: async id => { if (id === 2) throw Object.assign(new Error('private detail'), { code: 'DB_TRANSITION_FAILED' }); },
      markSalesforceOutboxJobRetrying: async () => {},
      markSalesforceOutboxJobFailed: async () => {},
    },
    salesforce: {
      getCaseCloseState: async caseId => {
        if (caseId === '500xx' && jobs.length === 1) throw Object.assign(new Error('secret timeout'), { code: 'ETIMEDOUT' });
        return { Status: 'Resuelto', Subetapa_resuelto__c: 'Solved' };
      },
      closeCaseFromOutbox: async () => {},
    },
  });
  assert.deepEqual(result.jobs.map(item => item.status), ['retrying', 'processor_error']);
  assert.deepEqual(result.diagnosis, { error_code: 'DB_TRANSITION_FAILED', category: 'processor_failure' });
  assert.doesNotMatch(JSON.stringify(result), /private detail|secret timeout/);
});

test('stalled claim and transition DB operations time out with a normalized safe code', async () => {
  const never = () => new Promise(() => {});
  const claimResult = await outbox.processBatch({
    limit: 1, dbTimeoutMs: 5,
    db: { claimSalesforceOutboxJobs: never },
    salesforce: {},
  });
  assert.equal(claimResult.jobs[0].status, 'processor_error');
  assert.deepEqual(claimResult.diagnosis, { error_code: 'SF_OUTBOX_DB_TIMEOUT', category: 'claim_failure' });

  const deps = dependencies({ db: { markSalesforceOutboxJobSynced: never }, salesforce: {
    getCaseCloseState: async () => ({ Status: 'Resuelto', Subetapa_resuelto__c: 'Solved' }),
  } });
  deps.dbTimeoutMs = 5;
  const transitionResult = await outbox.processClaimedJob(job(), deps);
  assert.deepEqual(
    { status: transitionResult.status, error_code: transitionResult.error_code },
    { status: 'processor_error', error_code: 'SF_OUTBOX_DB_TIMEOUT' },
  );
  assert.equal(outbox.classifyProcessorError({ code: 'SF_OUTBOX_DB_TIMEOUT' }).retryable, true);
});

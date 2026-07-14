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

function createMockDb(overrides = {}) {
  return {
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

test('/api/admin queue returns SLA-enriched tickets', async () => {
  await withServer(createMockDb({
    getTicketsWithRouting: async () => [{ id: 20, area_id: 2, status: 'open', created_at: '2026-07-09T10:00:00.000Z', area: { id: 2, name: 'Support', sla_minutes: 30 } }],
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/queue');

    assert.equal(res.status, 200);
    assert.equal(res.body.tickets[0].id, 20);
    assert.ok(res.body.tickets[0].sla.due_at);
  });
});

test('/api/admin assigns tickets and writes audit logs', async () => {
  const audits = [];
  await withServer(createMockDb({ logAudit: async payload => { audits.push(payload); return { id: 1 }; } }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/assign', { analyst_id: 7 });

    assert.equal(res.status, 200);
    assert.equal(res.body.assignment.analyst_id, 7);
    assert.equal(audits[0].action, 'ticket.assigned');
  });
});

test('/api/admin REST assignment emits scoped routing updates', async () => {
  const io = createIo();

  await withServer(createMockDb(), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/assign', { analyst_id: 7 });

    assert.equal(res.status, 200);
    assert.deepEqual(io.emissions.map(item => ({ rooms: item.rooms, event: item.event })), [
      { rooms: ['admin', 'area:2'], event: 'ticket-assigned' },
      { rooms: ['admin', 'area:2'], event: 'queue-updated' },
      { rooms: ['analyst:7'], event: 'ticket-assigned' },
      { rooms: ['admin', 'area:2'], event: 'sla-alert' },
    ]);
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
    getTicketById: async id => ({ id, area_id: 1, status: 'open', created_at: '2026-07-09T10:00:00.000Z' }),
    getTicketWithRouting: async id => ({ id, area_id: 2, status: 'open', created_at: '2026-07-09T10:00:00.000Z', area: { id: 2, name: 'Support', sla_minutes: 30 }, assignment: { ticket_id: id, analyst_id: 7, analyst: { id: 7, display_name: 'Ada', area_id: 2 } } }),
  }), { role: 'admin', name: 'Root' }, async (baseUrl) => {
    const res = await request(baseUrl, 'POST', '/api/admin/tickets/20/transfer', { area_id: 2, analyst_id: 7 });

    assert.equal(res.status, 200);
    assert.deepEqual(io.emissions.map(item => ({ rooms: item.rooms, event: item.event })), [
      { rooms: ['admin', 'area:1'], event: 'ticket-assigned' },
      { rooms: ['admin', 'area:1'], event: 'queue-updated' },
      { rooms: ['admin', 'area:2'], event: 'ticket-assigned' },
      { rooms: ['admin', 'area:2'], event: 'queue-updated' },
      { rooms: ['analyst:7'], event: 'ticket-assigned' },
      { rooms: ['admin', 'area:2'], event: 'sla-alert' },
    ]);
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

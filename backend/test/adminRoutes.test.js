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

async function withServer(mockDb, user, run) {
  const app = express();
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
    logAudit: async () => ({ id: 1 }),
    listActiveBotFlows: async () => [{ id: 1, step_key: 'initial_filter', version_id: 1, area_id: null }],
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
  let receivedLimit;
  const logs = [{ id: 1, action: 'analyst.created', actor_name: 'Admin' }];
  await withServer(createMockDb({
    listAuditLogs: async limit => { receivedLimit = limit; return logs; },
  }), { role: 'admin', name: 'Admin' }, async (baseUrl) => {
    const res = await request(baseUrl, 'GET', '/api/admin/audit?limit=25');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, logs);
    assert.equal(receivedLimit, '25');
  });
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

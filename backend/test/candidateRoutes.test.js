const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');

const routePath = path.resolve(__dirname, '../src/routes/candidates.js');
const dbPath = path.resolve(__dirname, '../src/database/db.js');
const quarantinePath = path.resolve(__dirname, '../src/services/candidateQuarantine.js');

async function withServer({ db, quarantine, user }, run) {
  delete require.cache[routePath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  require.cache[quarantinePath] = { id: quarantinePath, filename: quarantinePath, loaded: true, exports: { candidateQuarantine: quarantine } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/candidates', require(routePath));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    await new Promise(resolve => server.close(resolve));
    delete require.cache[routePath]; delete require.cache[dbPath]; delete require.cache[quarantinePath];
  }
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { headers: { 'content-type': 'application/json' }, ...options });
  return { status: response.status, body: await response.json() };
}

function fixtures(overrides = {}) {
  const calls = [];
  return {
    calls,
    db: {
      getTicketWithAssignment: async () => ({ id: 5, chat_id: '573001234567@c.us', area_id: 2, assignment: { analyst_id: 8 } }),
      getAnalystByTokenId: async () => ({ id: 8, area_id: 2 }),
      getCandidateClassification: async () => null,
      markCandidate: async () => { calls.push('db-mark'); return { classification: 'candidate' }; },
      unmarkCandidate: async () => { calls.push('db-unmark'); return true; },
      logAudit: async entry => { calls.push(entry); },
      ...overrides.db,
    },
    quarantine: {
      has: async () => false,
      add: async () => { calls.push('local-add'); },
      remove: async () => { calls.push('local-remove'); },
      ...overrides.quarantine,
    },
  };
}

test('analyst candidate status requires ticket and matching authorized chat', async () => {
  const f = fixtures();
  await withServer({ ...f, user: { id: 10, role: 'agent', name: 'Analyst' } }, async base => {
    assert.equal((await request(base, '/api/candidates/573001234567@c.us/status')).status, 400);
    assert.equal((await request(base, '/api/candidates/573009999999@c.us/status?ticket_id=5')).status, 409);
    assert.equal((await request(base, '/api/candidates/573001234567@c.us/status?ticket_id=5')).status, 200);
  });
});

test('analyst outside ticket area is forbidden while admin is allowed', async () => {
  const f = fixtures({ db: { getAnalystByTokenId: async () => ({ id: 9, area_id: 7 }) } });
  await withServer({ ...f, user: { id: 10, role: 'agent' } }, async base => {
    assert.equal((await request(base, '/api/candidates/573001234567@c.us/status?ticket_id=5')).status, 403);
  });
  const admin = fixtures({ db: { getAnalystByTokenId: async () => null } });
  await withServer({ ...admin, user: { id: 1, role: 'admin' } }, async base => {
    assert.equal((await request(base, '/api/candidates/573001234567@c.us/status?ticket_id=5')).status, 200);
  });
});

test('mark persists database then durable quarantine before success', async () => {
  const f = fixtures();
  await withServer({ ...f, user: { id: 1, role: 'admin', name: 'Admin' } }, async base => {
    const result = await request(base, '/api/candidates/573001234567@c.us?ticket_id=5', { method: 'PUT', body: '{}' });
    assert.equal(result.status, 200);
    assert.deepEqual(f.calls.slice(0, 2), ['db-mark', 'local-add']);
  });
});

test('mark and unmark partial failures report retryable safe state without optimistic success', async () => {
  const mark = fixtures({ quarantine: { add: async () => { throw new Error('disk'); } } });
  await withServer({ ...mark, user: { id: 1, role: 'admin' } }, async base => {
    const result = await request(base, '/api/candidates/573001234567@c.us?ticket_id=5', { method: 'PUT', body: '{}' });
    assert.equal(result.status, 503); assert.equal(result.body.code, 'CANDIDATE_MARK_PARTIAL'); assert.equal(result.body.candidate, true);
  });
  const unmark = fixtures({ quarantine: { remove: async () => { throw new Error('disk'); } } });
  await withServer({ ...unmark, user: { id: 1, role: 'admin' } }, async base => {
    const result = await request(base, '/api/candidates/573001234567@c.us?ticket_id=5', { method: 'DELETE' });
    assert.equal(result.status, 503); assert.equal(result.body.code, 'CANDIDATE_UNMARK_PARTIAL'); assert.equal(result.body.candidate, true);
  });
});

test('audit failures after successful mark and unmark do not change successful API state', async () => {
  const mark = fixtures({ db: { logAudit: async () => { throw new Error('audit unavailable'); } } });
    await withServer({ ...mark, user: { id: 1, role: 'admin' } }, async base => {
      const result = await request(base, '/api/candidates/573001234567@c.us?ticket_id=5', { method: 'PUT', body: '{}' });
      assert.equal(result.status, 200);
      assert.equal(result.body.candidate, true);
      assert.equal(result.body.locally_quarantined, true);
    });

  const unmark = fixtures({ db: { logAudit: async () => { throw new Error('audit unavailable'); } } });
    await withServer({ ...unmark, user: { id: 1, role: 'admin' } }, async base => {
      const result = await request(base, '/api/candidates/573001234567@c.us?ticket_id=5', { method: 'DELETE' });
      assert.equal(result.status, 200);
      assert.equal(result.body.candidate, false);
      assert.equal(result.body.locally_quarantined, false);
    });
});

test('audit failures do not replace safe partial mutation responses', async () => {
  const mark = fixtures({
    db: { logAudit: async () => { throw new Error('audit unavailable'); } },
    quarantine: { add: async () => { throw new Error('disk'); } },
  });
    await withServer({ ...mark, user: { id: 1, role: 'admin' } }, async base => {
      const result = await request(base, '/api/candidates/573001234567@c.us?ticket_id=5', { method: 'PUT', body: '{}' });
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'CANDIDATE_MARK_PARTIAL');
      assert.equal(result.body.candidate, true);
    });
});

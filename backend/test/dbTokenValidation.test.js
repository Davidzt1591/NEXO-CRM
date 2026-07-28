const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dbPath = path.resolve(__dirname, '../src/database/db.js');
const supabaseModulePath = require.resolve('@supabase/supabase-js');

function loadDb(result, onSignal) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const query = {
    select() { return this; },
    eq() { return this; },
    abortSignal(signal) { onSignal?.(signal); return this; },
    maybeSingle() { return Promise.resolve(result); },
  };
  delete require.cache[dbPath];
  require.cache[supabaseModulePath] = {
    id: supabaseModulePath,
    filename: supabaseModulePath,
    loaded: true,
    exports: { createClient: () => ({ from: () => query }) },
  };
  return require(dbPath);
}

function loadDbWithClient(client) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete require.cache[dbPath];
  require.cache[supabaseModulePath] = {
    id: supabaseModulePath,
    filename: supabaseModulePath,
    loaded: true,
    exports: { createClient: () => client },
  };
  return require(dbPath);
}

test('validateToken distinguishes missing, revoked, and valid tokens', async () => {
  assert.deepEqual(await loadDb({ data: null, error: null }).validateToken('missing'), { status: 'invalid', code: 'AUTH_INVALID' });
  assert.deepEqual(await loadDb({ data: { id: 1, name: 'Ana', role: 'agent', active: false }, error: null }).validateToken('revoked'), { status: 'invalid', code: 'AUTH_REVOKED' });
  assert.deepEqual(await loadDb({ data: { id: 1, name: 'Ana', role: 'agent', active: true }, error: null }).validateToken('valid'), {
    status: 'valid', user: { id: 1, name: 'Ana', role: 'agent' },
  });
});

test('validateToken propagates Supabase failures without exposing the raw token', async () => {
  const failure = new Error('network unavailable');
  const db = loadDb({ data: null, error: failure });
  await assert.rejects(db.validateToken('raw-secret-token'), error => error === failure);
  assert.doesNotMatch(failure.message, /raw-secret-token/);
});

test('validateToken passes the per-attempt abort signal to Supabase', async () => {
  let observedSignal;
  const db = loadDb({ data: null, error: null }, signal => { observedSignal = signal; });
  await db.validateToken('missing');
  assert.equal(observedSignal instanceof AbortSignal, true);
  assert.equal(observedSignal.aborted, false);
});

test('revokeAgentTokenAtomically calls the exact RPC and accepts only closed valid outcomes', async () => {
  const calls = [];
  const responses = [
    { outcome: 'revoked', token: { id: 7, name: 'Agent', role: 'agent', active: false } },
    { outcome: 'already_revoked', token: { id: 7, name: 'Agent', role: 'agent', active: false } },
    { outcome: 'not_found' },
    { outcome: 'wrong_role' },
  ];
  const db = loadDbWithClient({
    from() { throw new Error('sequential fallback used'); },
    async rpc(name, params) { calls.push([name, params]); return { data: responses.shift(), error: null }; },
  });
  for (const outcome of ['revoked', 'already_revoked', 'not_found', 'wrong_role']) {
    assert.equal((await db.revokeAgentTokenAtomically(7, 3, 'request_1')).outcome, outcome);
  }
  assert.deepEqual(calls[0], ['revoke_agent_token_with_audit', { p_token_id: 7, p_actor_token_id: 3, p_request_id: 'request_1' }]);
  assert.equal(calls.length, 4);
});

test('revokeAgentTokenAtomically fails closed on denied, unavailable, malformed, or mismatched RPC results', async () => {
  const cases = [
    { data: null, error: { code: '42501', message: 'permission detail' } },
    { data: null, error: { code: 'PGRST202', message: 'function detail' } },
    { data: { outcome: 'unexpected' }, error: null },
    { data: { outcome: 'revoked', token: { id: 8, name: 'Wrong', role: 'agent', active: false } }, error: null },
    { data: { outcome: 'already_revoked', token: { id: 7, name: 'Wrong role', role: 'admin', active: false } }, error: null },
  ];
  let fromCalls = 0;
  for (const result of cases) {
    const db = loadDbWithClient({ from() { fromCalls += 1; }, async rpc() { return result; } });
    await assert.rejects(db.revokeAgentTokenAtomically(7, 3, 'request_2'), error => {
      assert.equal(error.code, 'TOKEN_REVOCATION_UNAVAILABLE');
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, 'Token revocation is temporarily unavailable.');
      assert.doesNotMatch(JSON.stringify(error), /permission detail|function detail/);
      return true;
    });
  }
  assert.equal(fromCalls, 0);
});

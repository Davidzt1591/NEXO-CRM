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

test('saveSession persists flow version and category when present', async () => {
  let capturedPayload;
  const client = {
    from(table) {
      assert.equal(table, 'bot_sessions');
      return {
        upsert(payload, options) {
          capturedPayload = payload;
          assert.deepEqual(options, { onConflict: 'chat_id' });
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  const db = loadDb(client);
  await db.saveSession('chat-1', { paso: 'capture_name', categoria: 'Tests', nombre: 'Ana', flowVersionId: 9 });

  assert.equal(capturedPayload.chat_id, 'chat-1');
  assert.equal(capturedPayload.flow_version_id, 9);
  assert.equal(capturedPayload.categoria, 'Tests');
  assert.equal(capturedPayload.submission_id, null);
});

test('getSession restores flowVersionId and keeps legacy null sessions compatible', async () => {
  const client = {
    from(table) {
      assert.equal(table, 'bot_sessions');
      return {
        select() { return this; },
        eq() { return this; },
        single() {
          return Promise.resolve({
            data: {
              paso: 5,
              categoria: 'Integrations',
              nombre: 'Ana',
              empresa: 'Acme',
              correo: 'ana@example.com',
              situacion: 'Error',
              ticket_id: 123,
              flow_version_id: null,
              submission_id: '0f5ca4fa-0d0b-4a56-bca0-1e61782858e1',
            },
            error: null,
          });
        },
      };
    },
  };

  const db = loadDb(client);
  const session = await db.getSession('chat-1');

  assert.equal(session.ticketId, 123);
  assert.equal(session.categoria, 'Integrations');
  assert.equal(session.flowVersionId, undefined);
  assert.equal(session.submissionId, '0f5ca4fa-0d0b-4a56-bca0-1e61782858e1');
});

test('loadAllSessions preserves Supabase errors while allowing a successful empty result', async () => {
  let response = { data: [], error: null };
  const client = { from: table => ({ select: async () => { assert.equal(table, 'bot_sessions'); return response; } }) };
  const db = loadDb(client);
  assert.deepEqual(await db.loadAllSessions(), []);

  const cause = Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' });
  response = { data: null, error: cause };
  await assert.rejects(db.loadAllSessions(), error => error.code === 'SESSION_HYDRATION_FAILED' && error.cause === cause);
});

test('createTicket returns existing row on submission unique violation', async () => {
  const existing = { id: 42, bot_submission_id: '0f5ca4fa-0d0b-4a56-bca0-1e61782858e1' };
  const client = {
    from(table) {
      assert.equal(table, 'tickets');
      return {
        insert(payload) { this.payload = payload; return this; }, select() { return this; },
        single() { return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value' } }); },
        eq(column, value) { assert.equal(column, 'bot_submission_id'); assert.equal(value, existing.bot_submission_id); return this; },
        maybeSingle() { return Promise.resolve({ data: existing, error: null }); },
      };
    },
  };
  const db = loadDb(client);
  const result = await db.createTicket({ chat_id: 'chat-1', submission_id: existing.bot_submission_id });
  assert.deepEqual(result, { ...existing, created: false });
});

test('candidate helpers preserve the exact bounded chat ID and use the atomic guidance RPC', async () => {
  const chatId = '573001112233@c.us';
  const calls = [];
  const client = {
    from(table) {
      assert.equal(table, 'contact_classifications');
      return {
        select() { return this; },
        eq(column, value) { calls.push({ kind: 'eq', column, value }); return this; },
        maybeSingle() { return Promise.resolve({ data: { chat_id: chatId, classification: 'candidate' }, error: null }); },
      };
    },
    rpc(name, payload) { calls.push({ kind: 'rpc', name, payload }); return Promise.resolve({ data: true, error: null }); },
  };
  const db = loadDb(client);
  const classification = await db.getCandidateClassification(chatId);
  const claimed = await db.claimCandidateGuidance(chatId);
  await db.finalizeCandidateGuidance(chatId, claimed);
  await db.releaseCandidateGuidance(chatId, claimed);
  assert.equal(classification.chat_id, chatId);
  assert.match(claimed, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.filter(call => call.kind === 'rpc').map(call => call.name), [
    'claim_candidate_guidance', 'finalize_candidate_guidance', 'release_candidate_guidance',
  ]);
  assert.equal(calls[1].payload.p_chat_id, chatId);
  assert.equal(calls[1].payload.p_token, claimed);
  await assert.rejects(() => db.getCandidateClassification('573001112233@c.us-extra'), { code: 'INVALID_CHAT_ID' });
  assert.equal(calls.filter(call => call.kind === 'eq').length, 1);
});

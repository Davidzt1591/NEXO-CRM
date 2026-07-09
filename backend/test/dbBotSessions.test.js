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

test('saveSession persists flow_version_id when present', async () => {
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
  await db.saveSession('chat-1', { paso: 2, nombre: 'Ana', flowVersionId: 9 });

  assert.equal(capturedPayload.chat_id, 'chat-1');
  assert.equal(capturedPayload.flow_version_id, 9);
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
              nombre: 'Ana',
              empresa: 'Acme',
              correo: 'ana@example.com',
              situacion: 'Error',
              ticket_id: 123,
              flow_version_id: null,
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
  assert.equal(session.flowVersionId, undefined);
});

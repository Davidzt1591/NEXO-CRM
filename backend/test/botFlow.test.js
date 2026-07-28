const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../src/services/botFlow.js');
const dbPath = path.resolve(__dirname, '../src/database/db.js');

function loadService(mockDb) {
  delete require.cache[servicePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: mockDb,
  };
  const service = require(servicePath);
  service._resetCache();
  return service;
}

test('bot flow service returns static Spanish fallback when DB is empty', async () => {
  const service = loadService({ listActiveBotFlows: async () => [] });

  const message = await service.getBotMessage('ask_company', { nombre: 'Ana' });

  assert.equal(message.source, 'fallback');
  assert.equal(message.versionId, 2);
  assert.equal(message.text, 'Gracias, Ana. ¿Cuál es el nombre de tu empresa?');
});

test('bot flow service caches DB templates until TTL expires', async () => {
  let now = 1_000;
  let calls = 0;
  const service = loadService({
    listActiveBotFlows: async () => {
      calls += 1;
      return [{ step_key: 'ask_name', message: `Plantilla ${calls}`, version_id: 7, area_id: null }];
    },
  });
  service._setNow(() => now);

  assert.equal((await service.getBotMessage('ask_name')).text, 'Plantilla 1');
  assert.equal((await service.getBotMessage('ask_name')).text, 'Plantilla 1');
  assert.equal(calls, 1);

  now += service.CACHE_TTL_MS + 1;
  assert.equal((await service.getBotMessage('ask_name')).text, 'Plantilla 2');
  assert.equal(calls, 2);
});

test('bot flow cache invalidation forces reload', async () => {
  let calls = 0;
  const service = loadService({
    listActiveBotFlows: async () => {
      calls += 1;
      return [{ step_key: 'ask_email', message: `Correo ${calls}`, version_id: 3, area_id: null }];
    },
  });

  assert.equal((await service.getBotMessage('ask_email')).text, 'Correo 1');
  service.invalidateBotFlowCache();
  assert.equal((await service.getBotMessage('ask_email')).text, 'Correo 2');
  assert.equal(calls, 2);
});

test('bot flow service keeps separate cache entries for global and area flows', async () => {
  const receivedAreaIds = [];
  const service = loadService({
    listActiveBotFlows: async ({ areaId }) => {
      receivedAreaIds.push(areaId || null);
      return [{
        step_key: 'ask_name',
        message: areaId ? `Área ${areaId}` : 'Global',
        version_id: areaId ? 2 : 1,
        area_id: areaId || null,
      }];
    },
  });

  assert.equal((await service.getBotMessage('ask_name')).text, 'Global');
  assert.equal((await service.getBotMessage('ask_name', {}, { areaId: 5 })).text, 'Área 5');
  assert.equal((await service.getBotMessage('ask_name', {}, { areaId: 5 })).text, 'Área 5');
  assert.deepEqual(receivedAreaIds, [null, 5]);
});

test('bot flow service falls back when DB lookup fails', async () => {
  const service = loadService({ listActiveBotFlows: async () => { throw new Error('offline'); } });

  const message = await service.getBotMessage('processing');

  assert.equal(message.source, 'fallback');
  assert.equal(message.text, 'Estamos creando tu ticket. Un momento, por favor.');
});

test('area flow uses global DB template version when global row supplies effective message', async () => {
  const service = loadService({
    listActiveBotFlows: async ({ areaId }) => {
      assert.equal(areaId, 9);
      return [{ step_key: 'ask_name', message: 'Global ask name', version_id: 12, area_id: null }];
    },
  });

  const message = await service.getBotMessage('ask_name', {}, { areaId: 9 });

  assert.equal(message.text, 'Global ask name');
  assert.equal(message.source, 'database');
  assert.equal(message.versionId, 12);
});

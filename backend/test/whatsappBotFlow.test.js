const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wwebjsPath = path.resolve(__dirname, '../src/services/whatsapp/wwebjs.js');
const botFlowPath = path.resolve(__dirname, '../src/services/botFlow.js');
const dbPath = path.resolve(__dirname, '../src/database/db.js');
const aiPath = path.resolve(__dirname, '../src/services/ai.js');
const salesforcePath = path.resolve(__dirname, '../src/services/salesforce.js');
const operationalPath = path.resolve(__dirname, '../src/realtime/operational.js');
const storePath = path.resolve(__dirname, '../src/store.js');

function loadHarness(mockDb = {}) {
  for (const modulePath of [wwebjsPath, botFlowPath, dbPath, aiPath, salesforcePath, operationalPath]) {
    delete require.cache[modulePath];
  }

  const db = {
    listActiveBotFlows: async () => [],
    saveSession: async () => undefined,
    deleteSession: async () => undefined,
    saveMessage: async () => ({ id: 1 }),
    getTicketById: async () => null,
    createTicket: async () => ({ id: 77, area_id: null }),
    updateTicketSalesforce: async () => undefined,
    ...mockDb,
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: { analizarPrioridad: async () => 'Media' } };
  require.cache[salesforcePath] = { id: salesforcePath, filename: salesforcePath, loaded: true, exports: { crearCase: async () => { throw new Error('sf offline'); } } };
  require.cache[operationalPath] = { id: operationalPath, filename: operationalPath, loaded: true, exports: { emitOperational: () => undefined } };

  const store = require(storePath);
  store.sesiones = {};
  store.chatModes = new Map();
  store.silenciados = new Set();
  store.botActivo = true;
  store.horaDeInicio = 100;

  const { createWhatsAppMessageHandler } = require(wwebjsPath);
  const handler = createWhatsAppMessageHandler({}, { getContactById: async () => ({ number: '573001112233' }) }, { isBusinessHours: () => true });
  return { handler, store };
}

function message(body, replies, from = '573001112233@c.us') {
  return {
    from,
    body,
    timestamp: 101,
    id: { _serialized: `msg-${replies.length}` },
    reply: async text => {
      replies.push(text);
      return { id: { _serialized: `reply-${replies.length}` } };
    },
  };
}

test('WhatsApp handler sends initial filter and persists fallback flow version when DB is empty', async () => {
  const saved = [];
  const replies = [];
  const { handler, store } = loadHarness({ saveSession: async (chatId, session) => saved.push({ chatId, session: { ...session } }) });

  await handler(message('hola', replies));

  assert.match(replies[0], /Bienvenido al canal de soporte/);
  assert.equal(store.sesiones['573001112233@c.us'].paso, 0);
  assert.equal(store.sesiones['573001112233@c.us'].flowVersionId, 1);
  assert.equal(saved.at(-1).session.flowVersionId, 1);
});

test('WhatsApp handler uses fallback replies when bot flow DB lookup throws', async () => {
  const replies = [];
  const { handler } = loadHarness({ listActiveBotFlows: async () => { throw new Error('offline'); } });

  await handler(message('hola', replies));

  assert.match(replies[0], /Bienvenido al canal de soporte/);
});

test('WhatsApp handler transitions si to ask-name step', async () => {
  const replies = [];
  const { handler, store } = loadHarness();
  store.sesiones['573001112233@c.us'] = { paso: 0 };

  await handler(message('si', replies));

  assert.match(replies[0], /Nombre Completo/);
  assert.equal(store.sesiones['573001112233@c.us'].paso, 1);
});

test('WhatsApp handler persists resolved DB flow version after existing-session transition', async () => {
  const saved = [];
  const replies = [];
  const { handler, store } = loadHarness({
    listActiveBotFlows: async () => ([{
      step_key: 'ask_name',
      message: 'DB template: name please',
      version_id: 12,
      area_id: null,
    }]),
    saveSession: async (chatId, session) => saved.push({ chatId, session: { ...session } }),
  });
  store.sesiones['573001112233@c.us'] = { paso: 0 };

  await handler(message('si', replies));

  assert.equal(replies[0], 'DB template: name please');
  assert.equal(store.sesiones['573001112233@c.us'].paso, 1);
  assert.equal(store.sesiones['573001112233@c.us'].flowVersionId, 12);
  assert.equal(saved.at(-1).session.flowVersionId, 12);
});

test('WhatsApp handler redirects no through filter menu and keeps invalid answer in filter state', async () => {
  const replies = [];
  const { handler, store } = loadHarness();
  store.sesiones['573001112233@c.us'] = { paso: 0 };

  await handler(message('no', replies));
  assert.match(replies[0], /Escriba \*1\* si es \*Analista\*/);
  assert.equal(store.sesiones['573001112233@c.us'].paso, 'filtro_no');

  await handler(message('x', replies));
  assert.match(replies[1], /responda \*1\* para Analista o \*2\* para Candidato/);
  assert.equal(store.sesiones['573001112233@c.us'].paso, 'filtro_no');
});

test('WhatsApp handler collects name, company, email, issue and confirms ticket', async () => {
  const replies = [];
  const { handler, store } = loadHarness();
  store.sesiones['573001112233@c.us'] = { paso: 1 };

  await handler(message('Ana Pérez', replies));
  await handler(message('Acme', replies));
  await handler(message('ana@acme.test', replies));
  await handler(message('API timeout', replies));

  assert.match(replies[0], /Gracias, Ana Pérez/);
  assert.match(replies[1], /Correo Electrónico Corporativo/);
  assert.match(replies[2], /Requerimiento Técnico o Incidencia/);
  assert.match(replies[3], /Procesando solicitud técnica/);
  assert.match(replies[4], /SOLICITUD RECIBIDA/);
  assert.equal(store.sesiones['573001112233@c.us'].paso, 5);
  assert.equal(store.sesiones['573001112233@c.us'].ticketId, 77);
});

test('WhatsApp handler sends ticket error fallback and clears session when ticket creation fails', async () => {
  const replies = [];
  const { handler, store } = loadHarness({ createTicket: async () => { throw new Error('ticket insert failed'); } });
  store.sesiones['573001112233@c.us'] = {
    paso: 4,
    nombre: 'Ana',
    empresa: 'Acme',
    correo: 'ana@acme.test',
  };

  await handler(message('API timeout', replies));

  assert.match(replies[0], /Procesando solicitud técnica/);
  assert.match(replies[1], /Ocurrió un error al registrar su solicitud/);
  assert.equal(store.sesiones['573001112233@c.us'], undefined);
});

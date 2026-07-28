const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { simulateTransition } = require('../src/services/botFlowEngine');
const { CandidateQuarantine } = require('../src/services/candidateQuarantine');

const paths = {
  runtime: path.resolve(__dirname, '../src/services/whatsapp/wwebjs.js'), botFlow: path.resolve(__dirname, '../src/services/botFlow.js'),
  db: path.resolve(__dirname, '../src/database/db.js'), ai: path.resolve(__dirname, '../src/services/ai.js'), sf: path.resolve(__dirname, '../src/services/salesforce.js'),
  operational: path.resolve(__dirname, '../src/realtime/operational.js'), store: path.resolve(__dirname, '../src/store.js'), whatsapp: require.resolve('whatsapp-web.js'),
};

function loadHarness(overrides = {}) {
  Object.values(paths).forEach(modulePath => delete require.cache[modulePath]);
  const calls = { tickets: [], ai: 0, sf: 0, outbox: [], saves: [], deletes: 0, priorities: 0, audits: [], marks: [], guidanceClaims: 0, guidanceFinalizes: 0, guidanceReleases: 0, operational: [], ackClaims: [], ackFinalizes: [] };
  class FakeClient { constructor() { this.handlers = new Map(); } on(event, handler) { this.handlers.set(event, handler); } async getContactById() { return { number: '573001112233' }; } }
  const db = {
    listActiveBotFlows: async () => [], loadAllSessions: async () => [], saveMessage: async () => ({ id: 1 }), getTicketById: async id => ({ id, area_id: null, status: 'open' }),
    saveSession: async (chatId, session) => calls.saves.push({ chatId, session: { ...session } }), deleteSession: async () => { calls.deletes += 1; },
    createTicket: async payload => { calls.tickets.push(payload); return { id: 77, area_id: null, created: true }; },
    updateTicketPriority: async (id, prioridad) => { calls.priorities += 1; return { id, prioridad, area_id: null }; },
    updateTicketSalesforce: async () => undefined, logAudit: async entry => calls.audits.push(entry),
    ensureTicketPostProcessing: async id => ({ ticket_id: id }),
    claimTicketPostProcessing: async (workerId, limit) => [{ ticket_id: 77, chat_id: '573001112233@c.us', salesforce_outbox_status: 'pending', operational_emit_status: 'pending', session_cleanup_status: 'pending' }].slice(0, limit),
    finalizeTicketPostProcessingEffect: async () => true,
    markTicketPostProcessingAttemptStarted: async () => true,
    createSalesforceOutboxJob: async job => { calls.outbox.push(job); return { id: 1, ...job }; },
    claimTicketWhatsAppAck: async (...args) => { calls.ackClaims.push(args); return true; },
    finalizeTicketWhatsAppAck: async (...args) => { calls.ackFinalizes.push(args); return true; },
    getCandidateClassification: async () => null,
    markCandidate: async (chatId, metadata) => { calls.marks.push({ chatId, metadata }); return { chat_id: chatId }; },
    claimCandidateGuidance: async () => { calls.guidanceClaims += 1; return '00000000-0000-4000-8000-000000000001'; },
    finalizeCandidateGuidance: async () => { calls.guidanceFinalizes += 1; return true; },
    releaseCandidateGuidance: async () => { calls.guidanceReleases += 1; return true; },
    getCandidateSupportSettings: async () => ({ formUrl: '', message: '' }),
    ...overrides.db,
  };
  if (!Object.hasOwn(overrides.db || {}, 'createRoutedTicket')) db.createRoutedTicket = db.createTicket;
  require.cache[paths.db] = { id: paths.db, filename: paths.db, loaded: true, exports: db };
  require.cache[paths.ai] = { id: paths.ai, filename: paths.ai, loaded: true, exports: { analizarPrioridad: async () => { calls.ai += 1; return 'Media'; } } };
  require.cache[paths.sf] = { id: paths.sf, filename: paths.sf, loaded: true, exports: { crearCase: async () => { calls.sf += 1; throw new Error('sf offline'); } } };
  require.cache[paths.operational] = { id: paths.operational, filename: paths.operational, loaded: true, exports: {
    emitClassified: (...args) => calls.operational.push(args),
    emitTicketOperation: (...args) => calls.operational.push(args),
    toMinimalQueueCard: ticket => ({ id: ticket.id, area_id: ticket.area_id, queue_card: true }),
  } };
  require.cache[paths.whatsapp] = { id: paths.whatsapp, filename: paths.whatsapp, loaded: true, exports: { Client: FakeClient, LocalAuth: class {}, MessageMedia: class {} } };
  const store = require(paths.store); store.sesiones = {}; store.chatModes = new Map(); store.silenciados = new Set(); store.botActivo = true; store.horaDeInicio = 100;
  const runtime = require(paths.runtime);
  const quarantineEntries = new Set();
  const candidateQuarantine = overrides.candidateQuarantine || {
    has: async chatId => quarantineEntries.has(chatId),
    add: async chatId => { quarantineEntries.add(chatId); return true; },
    remove: async chatId => { quarantineEntries.delete(chatId); return true; },
  };
  const handler = runtime.createWhatsAppMessageHandler({}, new FakeClient(), {
    isBusinessHours: () => true,
    candidateQuarantine,
    classificationRetryConfig: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    classificationSleep: async () => {},
    classificationRandom: () => 0,
    logger: { log() {}, warn() {}, error() {} },
    ...overrides.handlerOptions,
  });
  return { ...runtime, handler, store, calls, candidateQuarantine };
}

function message(body, replies, from = '573001112233@c.us') {
  return { from, body, timestamp: 101, id: { _serialized: `msg-${replies.length}` }, reply: async text => { replies.push(text); return { id: { _serialized: `reply-${replies.length}` } }; } };
}

test('new sessions start at semantic audience state and fallback version 2', async () => {
  const replies = []; const h = loadHarness();
  await h.handler(message('hola', replies));
  assert.equal(h.store.sesiones['573001112233@c.us'].paso, 'audience_choice');
  assert.match(h.store.sesiones['573001112233@c.us'].submissionId, /^[0-9a-f-]{36}$/);
  assert.equal(h.store.sesiones['573001112233@c.us'].flowVersionId, 2);
  assert.match(replies[0], /quién eres/);
});

test('candidate exits and invalid audience/category inputs have no effects', async () => {
  const replies = []; const h = loadHarness(); const chat = '573001112233@c.us';
  h.store.sesiones[chat] = { paso: 'audience_choice' };
  await h.handler(message('sistema', replies));
  assert.equal(h.store.sesiones[chat].paso, 'audience_choice');
  await h.handler(message('analista', replies));
  assert.equal(h.store.sesiones[chat].paso, 'issue_category');
  await h.handler(message('ventas', replies));
  assert.equal(h.store.sesiones[chat].paso, 'issue_category');
  assert.equal(h.calls.ai, 0); assert.equal(h.calls.tickets.length, 0); assert.equal(h.calls.sf, 0);
  h.store.sesiones[chat] = { paso: 'audience_choice' };
  await h.handler(message('soy candidata', replies));
  assert.equal(h.store.sesiones[chat], undefined);
  assert.match(replies.at(-1), /únicamente solicitudes de analistas/);
  assert.equal(h.calls.marks.length, 1);
});

test('candidate selection auto-marks and future messages remain blocked without ticket or session', async () => {
  const replies = []; const chat = '573001112233@c.us'; let blocked = false;
  const h = loadHarness({ db: {
    getCandidateClassification: async () => blocked ? { classification: 'candidate', support_blocked: true } : null,
    markCandidate: async (chatId, metadata) => { blocked = true; h.calls.marks.push({ chatId, metadata }); },
  } });
  h.store.sesiones[chat] = { paso: 'audience_choice' };
  await h.handler(message('candidata', replies, chat));
  await h.handler(message('necesito ayuda', replies, chat));
  assert.equal(h.calls.marks[0].metadata.source, 'auto');
  assert.equal(h.store.sesiones[chat], undefined);
  assert.equal(h.calls.tickets.length, 0);
  assert.ok(h.calls.deletes >= 2);
  assert.equal(h.calls.operational.length, 0);
});

test('candidate persistence failure stays quarantined and retries without operational effects', async () => {
  const replies = []; const chat = '573001112233@c.us'; let attempts = 0; let durable = false;
  const h = loadHarness({ db: {
    getCandidateClassification: async () => durable ? { classification: 'candidate', support_blocked: true } : null,
    markCandidate: async (chatId, metadata) => {
      attempts += 1;
      h.calls.marks.push({ chatId, metadata });
      if (attempts === 1) throw new Error('write unavailable');
      durable = true;
    },
  } });
  h.store.sesiones[chat] = { paso: 'audience_choice' };
  await h.handler(message('soy candidata', replies, chat));
  assert.equal(h.store.sesiones[chat].paso, 'candidate_pending');
  assert.equal(h.calls.deletes, 0);
  assert.equal(h.calls.operational.length, 0);
  await h.handler(message('mi correo es candidate@example.test', replies, chat));
  assert.equal(attempts, 2);
  assert.equal(h.store.sesiones[chat], undefined);
  assert.equal(h.calls.tickets.length, 0);
  assert.equal(h.calls.operational.length, 0);
});

test('durable candidate quarantine blocks and retries persistence through the WhatsApp path after restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexo-candidate-runtime-restart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const quarantineOptions = {
    filePath: path.join(directory, 'candidate-quarantine.json'),
    serviceRoleKey: 'restart-contract-service-role-key-with-sufficient-entropy',
  };
  const chat = '573001112233@c.us';
  const selectionReplies = [];
  let markAttempts = 0;
  let sessionPersistenceAttempts = 0;

  const beforeRestart = loadHarness({
    candidateQuarantine: new CandidateQuarantine(quarantineOptions),
    db: {
      markCandidate: async () => { markAttempts += 1; throw new Error('classification database unavailable'); },
      saveSession: async () => { sessionPersistenceAttempts += 1; throw new Error('session database unavailable'); },
    },
  });
  beforeRestart.store.sesiones[chat] = { paso: 'audience_choice' };
  await beforeRestart.handler(message('soy candidata', selectionReplies, chat));

  assert.equal(markAttempts, 1);
  assert.equal(sessionPersistenceAttempts, 1);
  assert.equal(beforeRestart.store.sesiones[chat].paso, 'candidate_pending');
  assert.equal(beforeRestart.calls.tickets.length, 0);
  assert.equal(beforeRestart.calls.operational.length, 0);

  let classificationPersisted = false;
  const afterRestart = loadHarness({
    candidateQuarantine: new CandidateQuarantine(quarantineOptions),
    db: {
      getCandidateClassification: async () => classificationPersisted
        ? { classification: 'candidate', support_blocked: true }
        : null,
      markCandidate: async () => { markAttempts += 1; classificationPersisted = true; },
    },
  });
  const futureReplies = [];
  await afterRestart.handler(message('necesito soporte', futureReplies, chat));

  assert.equal(markAttempts, 2);
  assert.equal(classificationPersisted, true);
  assert.equal(afterRestart.calls.guidanceClaims, 1);
  assert.equal(afterRestart.calls.guidanceFinalizes, 1);
  assert.equal(afterRestart.calls.guidanceReleases, 0);
  assert.equal(futureReplies.length, 1);
  assert.match(futureReplies[0], /únicamente solicitudes de analistas/);
  assert.deepEqual(afterRestart.store.sesiones, {});
  assert.equal(afterRestart.calls.saves.length, 0);
  assert.equal(afterRestart.calls.tickets.length, 0);
  assert.equal(afterRestart.calls.ai, 0);
  assert.equal(afterRestart.calls.sf, 0);
  assert.equal(afterRestart.calls.operational.length, 0);
});

test('candidate selection remains fail-closed when quarantine and database marking both fail', async () => {
  const replies = []; const chat = '573001112233@c.us';
  const h = loadHarness({
    candidateQuarantine: { has: async () => false, add: async () => { throw new Error('disk unavailable'); } },
    db: { markCandidate: async () => { throw new Error('database unavailable'); } },
  });
  h.store.sesiones[chat] = { paso: 'audience_choice' };
  await h.handler(message('soy candidata', replies, chat));
  assert.equal(h.store.sesiones[chat].paso, 'candidate_pending');
  assert.equal(h.calls.deletes, 0);
  assert.equal(h.calls.tickets.length, 0);
  assert.equal(h.calls.operational.length, 0);
});

test('candidate boundary logs exclude attacker-controlled errors, URLs and chat identifiers', async () => {
  const logs = [];
  const secret = 'TOKEN_LIKE_SECRET_987';
  const chat = '573009998888@c.us';
  const h = loadHarness({
    candidateQuarantine: { has: async () => false, add: async () => { throw Object.assign(new Error(`${secret} https://private.example/${chat}`), { code: secret }); } },
    db: { markCandidate: async () => { throw Object.assign(new Error(`${secret} ${chat}`), { code: 'LIBRARY_SECRET_CODE' }); } },
    handlerOptions: { logger: { log() {}, error() {}, warn: (...args) => logs.push(args) } },
  });
  h.store.sesiones[chat] = { paso: 'audience_choice' };
  await h.handler(message('soy candidata', [], chat));

  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /TOKEN_LIKE_SECRET_987|LIBRARY_SECRET_CODE|private\.example|573009998888|@c\.us/i);
  assert.ok(logs.length >= 3);
  for (const [, fields] of logs) {
    assert.deepEqual(Object.keys(fields).sort(), ['attempt', 'causeCode', 'outcome']);
    assert.equal(fields.causeCode, 'UNKNOWN_ERROR');
  }
  assert.equal(h.store.sesiones[chat].paso, 'candidate_pending');
  assert.equal(h.calls.tickets.length, 0);
});

test('blocked candidate guidance respects the atomic cooldown claim', async () => {
  const replies = []; let first = true;
  const h = loadHarness({ db: {
    getCandidateClassification: async () => ({ classification: 'candidate', support_blocked: true }),
    claimCandidateGuidance: async () => { h.calls.guidanceClaims += 1; const allowed = first; first = false; return allowed ? '00000000-0000-4000-8000-000000000001' : null; },
  } });
  await h.handler(message('hola', replies));
  await h.handler(message('otra vez', replies));
  assert.equal(h.calls.guidanceClaims, 2);
  assert.equal(replies.length, 1);
  assert.equal(h.calls.guidanceFinalizes, 1);
  assert.equal(h.calls.tickets.length, 0);
});

test('candidate guidance reply failure releases claim so the next message can retry', async () => {
  const replies = []; let replyAttempts = 0;
  const h = loadHarness({ db: { getCandidateClassification: async () => ({ classification: 'candidate', support_blocked: true }) } });
  const failingMessage = message('hola', replies);
  failingMessage.reply = async () => { replyAttempts += 1; throw new Error('WhatsApp unavailable'); };
  await assert.rejects(() => h.handler(failingMessage), /WhatsApp unavailable/);
  await h.handler(message('retry', replies));
  assert.equal(replyAttempts, 1);
  assert.equal(h.calls.guidanceClaims, 2);
  assert.equal(h.calls.guidanceReleases, 1);
  assert.equal(h.calls.guidanceFinalizes, 1);
  assert.equal(replies.length, 1);
  assert.equal(h.calls.operational.length, 0);
});

test('candidate guidance appends only a valid configured HTTPS form URL', async () => {
  for (const [formUrl, expected] of [
    ['', false],
    ['http://candidate.example/form', false],
    ['not a url', false],
    ['https://candidate.example/form', true],
  ]) {
    const replies = [];
    const h = loadHarness({ db: {
      getCandidateClassification: async () => ({ classification: 'candidate', support_blocked: true }),
      getCandidateSupportSettings: async () => ({ formUrl, message: 'Professional guidance.' }),
    } });
    await h.handler(message('hola', replies));
    assert.equal(replies[0].includes('https://candidate.example/form'), expected);
    assert.match(replies[0], /Professional guidance/);
  }
});

test('candidate classification database errors fail closed before session or ticket processing', async () => {
  const replies = []; const h = loadHarness({ db: { getCandidateClassification: async () => { throw new Error('db offline'); } } });
  await h.handler(message('hola', replies));
  assert.deepEqual(h.store.sesiones, {});
  assert.equal(h.calls.tickets.length, 0);
  assert.equal(replies.length, 0);
});

test('transient candidate classification retries then processes the inbound message exactly once', async () => {
  const replies = []; let lookups = 0;
  const h = loadHarness({ db: {
    getCandidateClassification: async () => {
      lookups += 1;
      if (lookups < 3) throw Object.assign(new Error('hidden transport details'), { code: lookups === 1 ? 'EAI_AGAIN' : 'ECONNRESET' });
      return null;
    },
  } });
  await h.handler(message('hola', replies));
  assert.equal(lookups, 3);
  assert.equal(h.calls.saves.length, 2);
  assert.equal(replies.length, 1);
  assert.equal(h.calls.operational.length, 2);
  assert.equal(h.calls.tickets.length, 0);
});

test('terminal transient classification failure has zero downstream effects', async () => {
  const replies = []; let lookups = 0;
  const h = loadHarness({ db: { getCandidateClassification: async () => { lookups += 1; throw Object.assign(new Error('secret URL https://example.test'), { code: 'ETIMEDOUT' }); } } });
  await h.handler(message('hola', replies));
  assert.equal(lookups, 3);
  assert.deepEqual(h.store.sesiones, {});
  assert.equal(h.calls.saves.length, 0);
  assert.equal(h.calls.deletes, 0);
  assert.equal(h.calls.tickets.length, 0);
  assert.equal(h.calls.ai, 0);
  assert.equal(h.calls.sf, 0);
  assert.equal(h.calls.operational.length, 0);
  assert.equal(h.calls.guidanceClaims, 0);
  assert.equal(replies.length, 0);
});

test('classification retry never duplicates candidate guidance', async () => {
  const replies = []; let lookups = 0;
  const h = loadHarness({ db: { getCandidateClassification: async () => {
    lookups += 1;
    if (lookups === 1) throw Object.assign(new Error('temporary'), { code: 'ENOTFOUND' });
    return { classification: 'candidate', support_blocked: true };
  } } });
  await h.handler(message('hola', replies));
  assert.equal(lookups, 2);
  assert.equal(h.calls.guidanceClaims, 1);
  assert.equal(h.calls.guidanceFinalizes, 1);
  assert.equal(h.calls.tickets.length, 0);
  assert.equal(replies.length, 1);
});

test('concurrent classification retries are independent', async () => {
  const replies = []; const attempts = new Map();
  const h = loadHarness({ db: { getCandidateClassification: async chatId => {
    const count = (attempts.get(chatId) || 0) + 1;
    attempts.set(chatId, count);
    if (count === 1) throw Object.assign(new Error('temporary'), { code: 'ECONNRESET' });
    return null;
  } } });
  await Promise.all([
    h.handler(message('hola', replies, '573001112233@c.us')),
    h.handler(message('hola', replies, '573009998877@c.us')),
  ]);
  assert.deepEqual([...attempts.values()], [2, 2]);
  assert.equal(replies.length, 2);
  assert.equal(Object.keys(h.store.sesiones).length, 2);
  assert.equal(h.calls.tickets.length, 0);
});

async function reachSummary(h, replies, chat = '573001112233@c.us') {
  h.store.sesiones[chat] = { paso: 'issue_category', submissionId: '0f5ca4fa-0d0b-4a56-bca0-1e61782858e1' };
  for (const input of ['Plataforma Magneto', 'Ana *Pérez*', 'Acme_Control', 'mal', 'ana@acme.test', 'corto', 'La plataforma falla al guardar el formulario']) {
    await h.handler(message(input, replies, chat));
  }
  return h.store.sesiones[chat];
}

test('runtime validates captures, escapes summary and creates no effects before confirm', async () => {
  const replies = []; const h = loadHarness();
  const session = await reachSummary(h, replies);
  assert.equal(session.paso, 'confirm_summary');
  assert.equal(session.categoria, 'Platform');
  assert.equal(h.calls.tickets.length, 0); assert.equal(h.calls.ai, 0); assert.equal(h.calls.sf, 0);
  assert.ok(replies.at(-1).includes('Ana \\*Pérez\\*'));
  assert.ok(replies.at(-1).includes('Acme\\_Control'));
  await h.handler(message('silla', replies));
  assert.equal(h.store.sesiones['573001112233@c.us'].paso, 'confirm_summary');
  assert.equal(h.calls.tickets.length, 0);
});

test('correction preserves category and clears all collected fields', async () => {
  const replies = []; const h = loadHarness(); const session = await reachSummary(h, replies);
  const simulation = simulateTransition({ session, input: 'corregir' });
  await h.handler(message('corregir', replies));
  assert.deepEqual(h.store.sesiones['573001112233@c.us'], simulation.session);
  assert.equal(h.store.sesiones['573001112233@c.us'].paso, 'capture_name');
  assert.equal(h.store.sesiones['573001112233@c.us'].categoria, 'Platform');
  assert.equal(h.store.sesiones['573001112233@c.us'].submissionId, session.submissionId);
});

test('explicit confirmation is the sole AI, ticket, routing and Salesforce-outbox gate', async () => {
  const replies = []; const h = loadHarness(); await reachSummary(h, replies);
  await h.handler(message('sí', replies));
  assert.equal(h.calls.ai, 1); assert.equal(h.calls.tickets.length, 1); assert.equal(h.calls.sf, 0); assert.equal(h.calls.outbox.length, 1);
  assert.equal(h.calls.tickets[0].categoria, 'Platform');
  assert.equal(h.store.sesiones['573001112233@c.us'], undefined);
  assert.equal(h.calls.deletes, 1);
  assert.deepEqual(replies.slice(-2).map(text => text.includes('registrada correctamente')), [false, true]);
  assert.equal(h.calls.ackClaims.length, 1); assert.equal(h.calls.ackFinalizes.length, 1);
  assert.equal(h.calls.ackClaims[0][1], h.calls.ackFinalizes[0][1]);
});

test('WhatsApp acknowledgement mark-attempt failure invokes no acknowledgement effect', async () => {
  const replies = []; const h = loadHarness({ db: { claimTicketWhatsAppAck: async () => false } });
  await reachSummary(h, replies);
  const before = replies.length;
  await h.handler(message('confirmar', replies));
  assert.equal(replies.slice(before).some(text => text.includes('registrada correctamente')), false);
  assert.equal(h.calls.ackFinalizes.length, 0);
});

test('ambiguous WhatsApp acknowledgement timeout remains claimed and a later confirmation does not invoke it again', async () => {
  let ackClaimed = false; let ackInvocations = 0;
  const h = loadHarness({ db: { claimTicketWhatsAppAck: async () => {
    if (ackClaimed) return false;
    ackClaimed = true;
    return true;
  } } });
  const replies = [];
  await reachSummary(h, replies);
  const timedOutMessage = message('confirmar', replies);
  timedOutMessage.reply = async text => {
    if (!text.includes('registrada correctamente')) { replies.push(text); return {}; }
    ackInvocations += 1;
    throw Object.assign(new Error('ack timed out'), { code: 'ACK_TIMEOUT' });
  };
  await h.handler(timedOutMessage);
  await reachSummary(h, replies);
  await h.handler(message('confirmar', replies));
  assert.equal(ackInvocations, 1);
  assert.equal(h.calls.ackFinalizes.length, 0);
});

test('confirmed ticket success has null-session parity across simulator and WhatsApp runtime', async () => {
  const replies = []; const h = loadHarness();
  const session = await reachSummary(h, replies);
  const simulation = simulateTransition({ session, input: 'confirmar', effects: { ticket_result: 'success', synthetic_ticket_id: 'SIM-77' } });
  await h.handler(message('confirmar', replies));
  assert.equal(simulation.session, null);
  assert.equal(h.store.sesiones['573001112233@c.us'], undefined);
  assert.equal(h.calls.tickets.length, 1);
  await h.handler(message('hola', replies));
  assert.equal(h.calls.tickets.length, 1);
  assert.equal(h.store.sesiones['573001112233@c.us'].paso, 'audience_choice');
});

test('ticket failure reports exact failure and clears semantic session', async () => {
  const replies = []; const h = loadHarness({ db: { createTicket: async () => { throw new Error('insert failed'); } } }); await reachSummary(h, replies);
  await h.handler(message('confirmar', replies));
  assert.equal(h.store.sesiones['573001112233@c.us'], undefined);
  assert.equal(replies.at(-1), 'No pudimos crear tu ticket en este momento. Tu información no quedó registrada como un caso. Por favor, inténtalo nuevamente más tarde.');
});

test('duplicate confirmation returns the same radicado without repeating side effects', async () => {
  const replies = []; const h = loadHarness({ db: { createTicket: async payload => { h.calls.tickets.push(payload); return { id: 77, created: false, area_id: null }; } } });
  await reachSummary(h, replies);
  await h.handler(message('confirmar', replies));
  assert.equal(h.calls.tickets.length, 1);
  assert.equal(h.calls.ai, 0); assert.equal(h.calls.priorities, 0); assert.equal(h.calls.sf, 0); assert.equal(h.calls.outbox.length, 1);
  assert.match(replies.at(-1), /77/);
});

test('post-insert priority or routing failure still reports registered ticket truthfully', async () => {
  const replies = []; const h = loadHarness({ db: { updateTicketPriority: async () => { throw Object.assign(new Error('route down'), { code: 'ROUTE_DOWN', secret: 'hidden' }); } } });
  await reachSummary(h, replies);
  await h.handler(message('confirmar', replies));
  assert.match(replies.at(-1), /registrada correctamente/);
  assert.match(replies.at(-1), /pendiente/);
  assert.equal(h.calls.sf, 0); assert.equal(h.calls.outbox.length, 1);
  assert.deepEqual(h.calls.audits[0].metadata, { code: 'ROUTE_DOWN' });
});

test('Salesforce outbox enqueue failure preserves the ticket and returns its radicado', async () => {
  const replies = []; const h = loadHarness({ db: { createSalesforceOutboxJob: async () => { throw Object.assign(new Error('outbox down'), { code: 'OUTBOX_DOWN' }); } } }); await reachSummary(h, replies);
  await h.handler(message('confirmar', replies));
  assert.match(replies.at(-1), /Número de caso interno: \*77\*/);
  assert.match(replies.at(-1), /pendiente/);
  assert.equal(h.calls.sf, 0);
  assert.equal(h.store.sesiones['573001112233@c.us'], undefined);
});

test('two simultaneous confirmations sharing one submission ID create and effect exactly once', async () => {
  const replies = []; let resolveInsert; let claimed = false;
  const h = loadHarness({ db: { createTicket: async payload => {
    h.calls.tickets.push(payload);
    if (!claimed) { claimed = true; await new Promise(resolve => { resolveInsert = resolve; }); return { id: 77, created: true, area_id: null }; }
    resolveInsert(); return { id: 77, created: false, area_id: null };
  } } });
  const session = await reachSummary(h, replies);
  const confirmA = h.handler(message('confirmar', replies));
  const confirmB = h.handler(message('confirmar', replies));
  await Promise.all([confirmA, confirmB]);
  assert.equal(h.calls.tickets.length, 2);
  assert.equal(new Set(h.calls.tickets.map(ticket => ticket.submission_id)).size, 1);
  assert.equal(h.calls.tickets[0].submission_id, session.submissionId);
  assert.equal(h.calls.ai, 1); assert.equal(h.calls.priorities, 1); assert.equal(h.calls.sf, 0);
  assert.equal(h.calls.outbox.length, 2);
  assert.equal(replies.filter(text => text.includes('registrada correctamente')).length, 2);
});

test('numeric legacy completion and unknown numeric no-op remain safe in both runtime entries', async () => {
  for (const entry of ['factory', 'setup']) {
    const replies = []; const h = loadHarness();
    const handler = entry === 'factory' ? h.handler : h.setupWhatsApp({ to: () => ({ emit: () => undefined }) }, { isBusinessHours: () => true, candidateQuarantine: h.candidateQuarantine }).client.handlers.get('message_create');
    h.store.sesiones['573001112233@c.us'] = { paso: 5, ticketId: 77 };
    await handler(message('ignored', replies));
    assert.equal(h.store.sesiones['573001112233@c.us'], undefined);
    h.store.sesiones['573001112233@c.us'] = { paso: 99, nombre: 'Ana' };
    await handler(message('ignored', replies));
    assert.deepEqual(h.store.sesiones['573001112233@c.us'], { paso: 99, nombre: 'Ana' });
    assert.equal(h.calls.tickets.length, 0);
  }
});

test('all active legacy runtime states reset without ticketing and require the semantic gates', async () => {
  for (const paso of [0, 1, 2, 3, 4, 'filtro_no']) {
    const replies = []; const h = loadHarness(); const chat = '573001112233@c.us';
    h.store.sesiones[chat] = { paso, categoria: 'Other', nombre: 'Ana', empresa: 'Acme', correo: 'ana@acme.test', situacion: 'legacy issue' };
    await h.handler(message(paso === 4 ? 'confirmar' : 'analista', replies));
    assert.equal(h.store.sesiones[chat].paso, 'audience_choice');
    assert.equal(h.store.sesiones[chat].flowVersionId, 2);
    assert.match(h.store.sesiones[chat].submissionId, /^[0-9a-f-]{36}$/);
    assert.equal(h.calls.tickets.length, 0);
    assert.match(replies[0], /Actualizamos nuestro flujo/);
    await h.handler(message('analista', replies));
    assert.equal(h.store.sesiones[chat].paso, 'issue_category');
  }
});

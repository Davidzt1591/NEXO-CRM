const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const socketPath = path.resolve(__dirname, '../src/socket.js');
const dbPath = path.resolve(__dirname, '../src/database/db.js');
const whatsappPath = path.resolve(__dirname, '../src/services/whatsapp/index.js');

function loadSocketHelpers(isReady = false, mockDb = {}) {
  delete require.cache[socketPath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: mockDb,
  };
  require.cache[whatsappPath] = {
    id: whatsappPath,
    filename: whatsappPath,
    loaded: true,
    exports: { isReady: () => isReady },
  };

  return require(socketPath);
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

function createSocket(user) {
  const events = [];
  return {
    user,
    events,
    emit(event, payload) {
      events.push({ event, payload });
    },
  };
}

test('targeted token invalidation clears and disconnects only matching local sockets', async () => {
  const { disconnectSocketsForToken } = loadSocketHelpers(false);
  const order = [];
  const matching = {
    user: { id: 51, role: 'agent' }, analyst: { id: 9, area_id: 3 }, sessionToken: 'opaque',
    rooms: new Set(['socket-a', 'analyst:9', 'area:3']), disconnected: false,
    events: [], leave(room) { this.rooms.delete(room); },
    emit(event, payload) { order.push('emit'); this.events.push({ event, payload }); },
    disconnect() { order.push('disconnect'); this.disconnected = true; },
  };
  const unrelated = {
    user: { id: 52, role: 'agent' }, analyst: { id: 10, area_id: 4 }, sessionToken: 'other',
    rooms: new Set(['socket-b', 'analyst:10', 'area:4']), disconnected: false,
    events: [], leave(room) { this.rooms.delete(room); }, emit(event, payload) { this.events.push({ event, payload }); }, disconnect() { this.disconnected = true; },
  };
  const io = { sockets: { sockets: new Map([['a', matching], ['b', unrelated]]) } };

  assert.equal(await disconnectSocketsForToken(io, 51), 1);
  assert.equal(matching.disconnected, true);
  assert.equal(matching.user, null); assert.equal(matching.analyst, null); assert.equal(matching.sessionToken, null);
  assert.deepEqual([...matching.rooms], ['socket-a']);
  assert.deepEqual(matching.events, [{ event: 'auth-error', payload: { code: 'AUTH_REVOKED' } }]);
  assert.deepEqual(order, ['emit', 'disconnect']);
  assert.equal(unrelated.disconnected, false);
  assert.deepEqual(unrelated.events, []);
  assert.deepEqual(unrelated.user, { id: 52, role: 'agent' });
});

test('targeted token invalidation returns zero without emitting or disconnecting unrelated sockets', async () => {
  const { disconnectSocketsForToken } = loadSocketHelpers(false);
  const events = [];
  const unrelated = { user: { id: 52 }, rooms: new Set(), leave() {}, emit(event, payload) { events.push({ event, payload }); }, disconnect() { throw new Error('must not disconnect'); } };
  const io = { sockets: { sockets: new Map([['a', unrelated]]) } };

  assert.equal(await disconnectSocketsForToken(io, 51), 0);
  assert.deepEqual(events, []);
});

test('targeted token invalidation reports safe teardown failure after attempting every match', async () => {
  const { disconnectSocketsForToken } = loadSocketHelpers(false);
  let laterDisconnected = false;
  const failing = { user: { id: 51 }, analyst: null, rooms: new Set(), leave() {}, emit() {}, disconnect() { throw new Error('transport secret'); } };
  const later = { user: { id: '51' }, analyst: null, rooms: new Set(), leave() {}, emit() {}, disconnect() { laterDisconnected = true; } };
  const io = { sockets: { sockets: new Map([['a', failing], ['b', later]]) } };

  await assert.rejects(disconnectSocketsForToken(io, 51), error => error.code === 'SOCKET_TEARDOWN_FAILED' && !error.message.includes('secret'));
  assert.equal(laterDisconnected, true);
});

test('non-admin sockets do not receive initial WhatsApp QR/auth status', () => {
  const store = require('../src/store');
  store.lastQR = 'secret-qr';
  store.lastQRTime = Date.now();

  const { emitInitialWhatsAppAuthState } = loadSocketHelpers(false);
  const socket = createSocket({ role: 'agent' });

  emitInitialWhatsAppAuthState(socket);

  assert.deepEqual(socket.events, []);
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

test('admin sockets receive initial WhatsApp QR/auth status', () => {
  const store = require('../src/store');
  store.lastQR = 'secret-qr';
  store.lastQRTime = Date.now();

  const { emitInitialWhatsAppAuthState } = loadSocketHelpers(false);
  const socket = createSocket({ role: 'admin' });

  emitInitialWhatsAppAuthState(socket);

  assert.equal(socket.events[0].event, 'qr');
  assert.equal(socket.events[0].payload.qr, 'secret-qr');
  assert.deepEqual(socket.events[1], { event: 'bot-status', payload: { status: 'qr' } });
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

test('admin operational emits without area are scoped to admins only', () => {
  const { emitAdminOperation } = loadSocketHelpers(false);
  const io = createIo();

  emitAdminOperation(io, 'message-reaction', { waMessageId: 'wamid', emoji: '👍' }, null);

  assert.deepEqual(io.emissions, [{
    rooms:   ['admin'],
    event:   'message-reaction',
    payload: { waMessageId: 'wamid', emoji: '👍' },
  }]);
  assert.equal(io.emissions.some(item => item.rooms.includes('*') || item.rooms.includes('unassigned:agents')), false);
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

test('chat operational emits send full payload only to admin and current assignee', async () => {
  const store = require('../src/store');
  store.sesiones['chat-1'] = { ticketId: 42 };
  const { emitAdminChatOperation } = loadSocketHelpers(false, {
    getTicketWithAssignment: async id => ({ id, area_id: 7, assignment: { analyst_id: 9 } }),
  });
  const io = createIo();

  await emitAdminChatOperation(io, 'mode-changed', { chatId: 'chat-1', mode: 'manual' }, 'chat-1');

  assert.deepEqual(io.emissions, [
    { rooms: ['admin'], event: 'mode-changed', payload: { chatId: 'chat-1', mode: 'manual' } },
    { rooms: ['analyst:9'], event: 'mode-changed', payload: { chatId: 'chat-1', mode: 'manual' } },
  ]);
  assert.equal(io.emissions.some(item => item.rooms.some(room => room.startsWith('area:'))), false);
  assert.equal(io.emissions.some(item => item.rooms.includes('*') || item.rooms.includes('unassigned:agents')), false);
  delete store.sesiones['chat-1'];
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

test('routing updates target admin, area, analyst, and SLA alert rooms', () => {
  const { emitRoutingUpdate } = loadSocketHelpers(false);
  const io = createIo();

  emitRoutingUpdate(io, {
    id: 55,
    area_id: 7,
    assignment: { analyst_id: 9 },
    sla: { state: 'breached', age_minutes: 45 },
  });

  const scoped = io.emissions.map(item => `${item.rooms.join(',')}:${item.event}`);
  for (const expected of ['admin:ticket-assigned','area:7:ticket-assigned','analyst:9:ticket-assigned','admin:queue-updated','area:7:queue-updated','analyst:9:queue-updated','admin:sla-alert','area:7:sla-alert']) assert.ok(scoped.includes(expected));
  for (const emission of io.emissions.filter(item => item.rooms.includes('area:7'))) for (const pii of ['telefono','correo','chat_id','situacion','message','media']) assert.equal(JSON.stringify(emission.payload).includes(`"${pii}"`), false);
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

test('routing transfer updates target old and new area rooms', () => {
  const { emitRoutingUpdate } = loadSocketHelpers(false);
  const io = createIo();
  const ticket = {
    id: 56,
    area_id: 8,
    assignment: { analyst_id: 10 },
    sla: { state: 'ok', age_minutes: 5 },
  };

  emitRoutingUpdate(io, ticket, { previousAreaId: 7 });

  const scoped = io.emissions.map(item => `${item.rooms.join(',')}:${item.event}`);
  for (const expected of ['admin:ticket-removed','area:7:ticket-removed','admin:ticket-assigned','area:8:ticket-assigned','analyst:10:ticket-assigned','admin:queue-updated','area:8:queue-updated','analyst:10:queue-updated']) assert.ok(scoped.includes(expected));
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

test('exact socket claim replay acknowledges caller without broadcasting mutation', async () => {
  const ticket = { id: 55, area_id: 7, assignment: { analyst_id: 9 }, sla: { state: 'ok' } };
  const { handleAssignTicket } = loadSocketHelpers(false, {
    getTicketWithAssignment: async () => ticket,
    claimConversation: async () => ({ workflow: ticket, mutation: { replayed: true, eventId: 12 } }),
  });
  const socket = createSocket({ role: 'agent', name: 'Ana' });
  socket.analyst = { id: 9, area_id: 7 };
  const io = createIo();

  await handleAssignTicket({ socket, io, payload: { ticketId: 55, analystId: 9, expectedRevision: 0, idempotencyKey: 'claim_replay_55' } });

  assert.equal(socket.events.some(item => item.event === 'assignment-success'), true);
  assert.deepEqual(io.emissions, []);
});

test('same-area analyst cannot self-assign a ticket already assigned to another analyst', () => {
  const { canSelfAssignTicket } = loadSocketHelpers(false);
  const socket = createSocket({ role: 'agent' });
  socket.analyst = { id: 9, area_id: 7 };

  const ticket = {
    id: 55,
    area_id: 7,
    assignment: { analyst_id: 10 },
  };

  assert.equal(canSelfAssignTicket(socket, ticket), false);
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

test('claim rejection branches preserve only structurally safe ticket correlation', async () => {
  const { handleAssignTicket } = loadSocketHelpers(false, {
    getTicketWithAssignment: async ticketId => ticketId === 'missing' ? null : ({ id: ticketId, area_id: 7, assignment: { analyst_id: 10 } }),
  });
  const cases = [
    { payload: null, event: 'assignment-error', expected: {} },
    { payload: { ticketId: { secret: true }, analystId: 9, correlationId: 'request-1' }, event: 'assignment-error', expected: { correlationId: 'request-1' } },
    { payload: { ticketId: 41, analystId: { invalid: true }, correlationId: 'request-2' }, event: 'assignment-error', expected: { ticketId: '41', correlationId: 'request-2' } },
    { payload: { ticketId: 42, analystId: 99, correlationId: 'request-3' }, event: 'auth-error', expected: { ticketId: '42', correlationId: 'request-3' } },
    { payload: { ticketId: 'missing', analystId: 9, correlationId: 'request-4' }, event: 'auth-error', expected: { ticketId: 'missing', correlationId: 'request-4' } },
    { payload: { ticketId: 43, analystId: 9, correlationId: 'request-5' }, event: 'auth-error', expected: { ticketId: '43', correlationId: 'request-5' } },
  ];

  for (const item of cases) {
    const socket = createSocket({ role: 'agent' });
    socket.analyst = { id: 9, area_id: 7 };
    await handleAssignTicket({ socket, io: createIo(), payload: item.payload });
    assert.equal(socket.events[0].event, item.event);
    assert.deepEqual(Object.fromEntries(Object.entries(socket.events[0].payload).filter(([key]) => key !== 'message')), item.expected);
  }
  delete require.cache[socketPath]; delete require.cache[dbPath]; delete require.cache[whatsappPath];
});

test('concurrent claims echo independent correlation IDs on success and committed failure', async () => {
  const { handleAssignTicket } = loadSocketHelpers(false, {
    getTicketWithAssignment: async id => ({ id, area_id: 7, assignment: null }),
    claimTicket: async id => id === '42' ? Promise.reject(new Error('Already claimed')) : ({ id, area_id: 7, assignment: { analyst_id: 9 } }),
  });
  const socket = createSocket({ role: 'agent' });
  socket.analyst = { id: 9, area_id: 7 };
  await Promise.all([
    handleAssignTicket({ socket, io: createIo(), payload: { ticketId: 41, analystId: 9, correlationId: 'claim-a' } }),
    handleAssignTicket({ socket, io: createIo(), payload: { ticketId: 42, analystId: 9, correlationId: 'claim-b' } }),
  ]);
  assert.ok(socket.events.some(({ event, payload }) => event === 'assignment-success' && payload.ticketId === '41' && payload.correlationId === 'claim-a'));
  assert.ok(socket.events.some(({ event, payload }) => event === 'assignment-error' && payload.ticketId === '42' && payload.correlationId === 'claim-b'));
  delete require.cache[socketPath]; delete require.cache[dbPath]; delete require.cache[whatsappPath];
});

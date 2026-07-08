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

test('chat operational emits include area room when chat ticket area resolves', async () => {
  const store = require('../src/store');
  store.sesiones['chat-1'] = { ticketId: 42 };
  const { emitAdminChatOperation } = loadSocketHelpers(false, {
    getTicketById: async id => ({ id, area_id: 7 }),
  });
  const io = createIo();

  await emitAdminChatOperation(io, 'mode-changed', { chatId: 'chat-1', mode: 'manual' }, 'chat-1');

  assert.deepEqual(io.emissions, [{
    rooms:   ['admin', 'area:7'],
    event:   'mode-changed',
    payload: { chatId: 'chat-1', mode: 'manual' },
  }]);
  assert.equal(io.emissions.some(item => item.rooms.includes('*') || item.rooms.includes('unassigned:agents')), false);
  delete store.sesiones['chat-1'];
  delete require.cache[socketPath];
  delete require.cache[dbPath];
  delete require.cache[whatsappPath];
});

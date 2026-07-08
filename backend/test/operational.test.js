const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canAccessTicket,
  filterTicketsForPrincipal,
  emitOperational,
} = require('../src/realtime/operational');

function createIoRecorder() {
  const calls = [];
  const io = {
    to(room) {
      calls.push({ type: 'to', room });
      return io;
    },
    emit(event, payload) {
      calls.push({ type: 'emit', event, payload });
      return io;
    },
  };
  return { io, calls };
}

test('admin can access every ticket', () => {
  assert.equal(canAccessTicket({ role: 'admin' }, null, { id: 1 }), true);
});

test('analyst can access assigned or same-area tickets only', () => {
  const analyst = { id: 7, area_id: 20 };

  assert.equal(canAccessTicket({ role: 'agent' }, analyst, { id: 1, area_id: 20 }), true);
  assert.equal(canAccessTicket({ role: 'agent' }, analyst, { id: 2, area_id: null, assignment: { analyst_id: 7 } }), true);
  assert.equal(canAccessTicket({ role: 'agent' }, null, { id: 5, area_id: null }), true);
  assert.equal(canAccessTicket({ role: 'agent' }, analyst, { id: 3, area_id: 30, assignment: { analyst_id: 8 } }), false);
  assert.equal(canAccessTicket({ role: 'agent' }, null, { id: 4, area_id: 20 }), false);
});

test('filterTicketsForPrincipal limits analyst ticket lists', () => {
  const tickets = [
    { id: 1, area_id: 10 },
    { id: 2, area_id: null },
    { id: 3, area_id: 11 },
  ];

  const visible = filterTicketsForPrincipal(tickets, { role: 'agent' }, { id: 5, area_id: 10 });
  assert.deepEqual(visible.map(ticket => ticket.id), [1, 2]);
});

test('emitOperational sends null-area payloads to admin and unassigned agent rooms', () => {
  const { io, calls } = createIoRecorder();

  emitOperational(io, 'new-message', { ticketId: 1 }, null);

  assert.deepEqual(calls, [
    { type: 'to', room: 'admin' },
    { type: 'to', room: 'unassigned:agents' },
    { type: 'emit', event: 'new-message', payload: { ticketId: 1 } },
  ]);
});

test('emitOperational sends area payloads to admin and area rooms', () => {
  const { io, calls } = createIoRecorder();

  emitOperational(io, 'ticket-created', { id: 1 }, 9);

  assert.deepEqual(calls, [
    { type: 'to', room: 'admin' },
    { type: 'to', room: 'area:9' },
    { type: 'emit', event: 'ticket-created', payload: { id: 1 } },
  ]);
});

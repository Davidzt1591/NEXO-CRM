const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canAccessTicket,
  filterTicketsForPrincipal,
  emitClassified,
  AREA_PAYLOAD_DENYLIST,
  assertAreaPayloadSafe,
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

test('central area payload denylist rejects every sensitive field at any depth', () => {
  for (const field of AREA_PAYLOAD_DENYLIST) {
    assert.throws(() => assertAreaPayloadSafe({ envelope: { [field]: 'secret' } }), /forbidden field/);
  }
  assert.doesNotThrow(() => assertAreaPayloadSafe({ ticketId: 9, status: 'open', queue_card: true }));
});

test('analyst can access full history only when assigned', () => {
  const analyst = { id: 7, area_id: 20 };

  assert.equal(canAccessTicket({ role: 'agent' }, analyst, { id: 1, area_id: 20 }), false);
  assert.equal(canAccessTicket({ role: 'agent' }, analyst, { id: 2, area_id: null, assignment: { analyst_id: 7 } }), false);
  assert.equal(canAccessTicket({ role: 'agent' }, analyst, { id: 2, area_id: 20, assignment: { analyst_id: 7 } }), true);
  assert.equal(canAccessTicket({ role: 'agent' }, null, { id: 5, area_id: null }), false);
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
  assert.deepEqual(visible.map(ticket => ticket.id), [1]);
});

test('classified emitter sends full null-area payloads only to admins', () => {
  const { io, calls } = createIoRecorder();

  emitClassified(io, { event: 'new-message', adminPayload: { ticketId: 1 } });

  assert.deepEqual(calls, [
    { type: 'to', room: 'admin' },
    { type: 'emit', event: 'new-message', payload: { ticketId: 1 } },
  ]);
});

test('classified emitter requires an explicit separate area payload', () => {
  const { io, calls } = createIoRecorder();

  emitClassified(io, { event: 'ticket-created', adminPayload: { id: 1, correo: 'secret' }, areaId: 9, areaPayload: { id: 1, queue_card: true } });

  assert.deepEqual(calls, [
    { type: 'to', room: 'admin' },
    { type: 'emit', event: 'ticket-created', payload: { id: 1, correo: 'secret' } },
    { type: 'to', room: 'area:9' },
    { type: 'emit', event: 'ticket-created', payload: { id: 1, queue_card: true } },
  ]);
});

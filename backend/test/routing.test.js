const test = require('node:test');
const assert = require('node:assert/strict');

const routing = require('../src/services/routing');

function createRoutingDb(overrides = {}) {
  const state = {
    ticket: { id: 10, area_id: 2, status: 'open', created_at: '2026-07-09T10:00:00.000Z' },
    assignment: null,
  };

  return {
    state,
    getTicketById: async () => state.ticket,
    getTicketWithRouting: async () => ({ ...state.ticket, assignment: state.assignment, area: { id: 2, name: 'Integraciones', sla_minutes: 30 } }),
    getAreaById: async id => ({ id, name: `Area ${id}`, active: true }),
    listAvailableAnalystsByArea: async () => [{ id: 3, area_id: 2, display_name: 'Ada', available: true }],
    assignTicket: async (ticketId, analystId, meta) => {
      state.assignment = { ticket_id: ticketId, analyst_id: analystId, assigned_by: meta.assigned_by };
      return state.assignment;
    },
    unassignTicket: async (ticketId, meta) => {
      state.assignment = { ticket_id: ticketId, analyst_id: null, assigned_by: meta.assigned_by };
      return state.assignment;
    },
    updateTicketArea: async (ticketId, areaId) => {
      state.ticket = { ...state.ticket, id: ticketId, area_id: areaId };
      return state.ticket;
    },
    getAnalystById: async id => ({ id, area_id: 2, display_name: 'Ada', available: true }),
    ...overrides,
  };
}

test('autoRouteTicket assigns an area ticket to the first available analyst', async () => {
  const db = createRoutingDb();

  const routed = await routing.autoRouteTicket(db, db.state.ticket);

  assert.equal(routed.assignment.analyst_id, 3);
  assert.equal(routed.assignment.assigned_by, 'auto');
  assert.ok(routed.sla.due_at);
});

test('autoRouteTicket only auto-assigns area-scoped tickets and keeps null-area tickets unassigned', async () => {
  let listCalled = false;
  const db = createRoutingDb({
    getTicketById: async () => ({ id: 11, area_id: null, status: 'open', created_at: '2026-07-09T10:00:00.000Z' }),
    listAvailableAnalystsByArea: async () => { listCalled = true; return []; },
  });

  const routed = await routing.autoRouteTicket(db, 11);

  assert.equal(routed.area_id, null);
  assert.equal(routed.assignment, null);
  assert.equal(listCalled, false);
});

test('assignTicket rejects analysts from a different ticket area', async () => {
  const db = createRoutingDb({ getAnalystById: async id => ({ id, area_id: 9, display_name: 'Other' }) });

  await assert.rejects(
    () => routing.assignTicket(db, { ticketId: 10, analystId: 9 }),
    /does not belong to the ticket area/
  );
});

test('assignTicket rejects null-area analysts for area-scoped tickets', async () => {
  const db = createRoutingDb({ getAnalystById: async id => ({ id, area_id: null, display_name: 'No area' }) });

  await assert.rejects(
    () => routing.assignTicket(db, { ticketId: 10, analystId: 4 }),
    /does not belong to the ticket area/
  );
});

test('transferTicket validates target analyst before mutating area or assignment', async () => {
  const db = createRoutingDb({
    getAnalystById: async id => ({ id, area_id: 9, display_name: 'Wrong area' }),
  });
  db.state.assignment = { ticket_id: 10, analyst_id: 3, assigned_by: 'manual' };

  await assert.rejects(
    () => routing.transferTicket(db, { ticketId: 10, areaId: 5, analystId: 9 }),
    /does not belong to the target area/
  );

  assert.equal(db.state.ticket.area_id, 2);
  assert.deepEqual(db.state.assignment, { ticket_id: 10, analyst_id: 3, assigned_by: 'manual' });
});

test('transferTicket rejects unknown target areas before mutating area or assignment', async () => {
  const db = createRoutingDb({ getAreaById: async () => null });
  db.state.assignment = { ticket_id: 10, analyst_id: 3, assigned_by: 'manual' };

  await assert.rejects(
    () => routing.transferTicket(db, { ticketId: 10, areaId: 99, analystId: 3 }),
    /Target area not found/
  );

  assert.equal(db.state.ticket.area_id, 2);
  assert.deepEqual(db.state.assignment, { ticket_id: 10, analyst_id: 3, assigned_by: 'manual' });
});

test('computeSla returns warning and breached states from ticket timestamps', () => {
  const warning = routing.computeSla({ created_at: '2026-07-09T10:00:00.000Z', status: 'open', area: { sla_minutes: 30 } }, new Date('2026-07-09T10:26:00.000Z'));
  const breached = routing.computeSla({ created_at: '2026-07-09T10:00:00.000Z', status: 'open', area: { sla_minutes: 30 } }, new Date('2026-07-09T10:31:00.000Z'));

  assert.equal(warning.state, 'warning');
  assert.equal(breached.state, 'breached');
});

test('computeSla marks the exact due time as breached', () => {
  const sla = routing.computeSla({ created_at: '2026-07-09T10:00:00.000Z', status: 'open', area: { sla_minutes: 30 } }, new Date('2026-07-09T10:30:00.000Z'));

  assert.equal(sla.state, 'breached');
  assert.equal(sla.minutes_remaining, 0);
});

test('computeSla clamps future timestamps to zero age', () => {
  const sla = routing.computeSla({ created_at: '2026-07-09T11:00:00.000Z', status: 'open', area: { sla_minutes: 30 } }, new Date('2026-07-09T10:00:00.000Z'));

  assert.equal(sla.state, 'ok');
  assert.equal(sla.age_minutes, 0);
});

test('computeSla keeps closed tickets out of warning and breached states', () => {
  const sla = routing.computeSla({ created_at: '2026-07-09T10:00:00.000Z', closed_at: '2026-07-09T11:00:00.000Z', status: 'closed', area: { sla_minutes: 30 } }, new Date('2026-07-09T12:00:00.000Z'));

  assert.equal(sla.state, 'ok');
  assert.equal(sla.minutes_remaining, -30);
});

test('computeSla returns null for invalid created_at', () => {
  assert.equal(routing.computeSla({ created_at: 'not-a-date', status: 'open', area: { sla_minutes: 30 } }), null);
});

test('computeSla falls back to default SLA for invalid or non-positive SLA values', () => {
  const invalid = routing.computeSla({ created_at: '2026-07-09T10:00:00.000Z', status: 'open', area: { sla_minutes: 'invalid' } }, new Date('2026-07-09T10:01:00.000Z'));
  const nonPositive = routing.computeSla({ created_at: '2026-07-09T10:00:00.000Z', status: 'open', area: { sla_minutes: 0 } }, new Date('2026-07-09T10:01:00.000Z'));

  assert.equal(invalid.sla_minutes, routing.DEFAULT_SLA_MINUTES);
  assert.equal(nonPositive.sla_minutes, routing.DEFAULT_SLA_MINUTES);
});

const DEFAULT_SLA_MINUTES = 30;
const SLA_WARNING_MINUTES_FLOOR = 5;
const SLA_WARNING_RATIO = 0.2;
const MS_PER_MINUTE = 60000;

function normalizeId(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeAssignment(record) {
  if (!record) return null;
  if (Array.isArray(record)) return normalizeAssignment(record[0]);
  return record;
}

function normalizeTicket(ticket) {
  if (!ticket) return null;
  const assignment = normalizeAssignment(ticket.assignment || ticket.ticket_assignments);
  return {
    ...ticket,
    area: ticket.area || null,
    assignment,
  };
}

function computeSla(ticket, now = new Date()) {
  const normalized = normalizeTicket(ticket);
  if (!normalized?.created_at) return null;

  const createdAt = new Date(normalized.created_at);
  if (Number.isNaN(createdAt.getTime())) return null;

  const closedAt = normalized.closed_at ? new Date(normalized.closed_at) : null;
  const endAt = normalized.status === 'closed' && closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : now;
  const slaMinutes = Number(normalized.area?.sla_minutes || normalized.sla_minutes || DEFAULT_SLA_MINUTES);
  const safeSlaMinutes = Number.isFinite(slaMinutes) && slaMinutes > 0 ? slaMinutes : DEFAULT_SLA_MINUTES;
  const ageMinutes = Math.max(0, Math.floor((endAt.getTime() - createdAt.getTime()) / MS_PER_MINUTE));
  const dueAt = new Date(createdAt.getTime() + safeSlaMinutes * MS_PER_MINUTE);
  const minutesRemaining = Math.ceil((dueAt.getTime() - endAt.getTime()) / MS_PER_MINUTE);

  let state = 'ok';
  if (normalized.status !== 'closed') {
    if (minutesRemaining <= 0) state = 'breached';
    else if (minutesRemaining <= Math.max(SLA_WARNING_MINUTES_FLOOR, Math.ceil(safeSlaMinutes * SLA_WARNING_RATIO))) state = 'warning';
  }

  return {
    state,
    age_minutes: ageMinutes,
    due_at: dueAt.toISOString(),
    minutes_remaining: minutesRemaining,
    sla_minutes: safeSlaMinutes,
  };
}

function enrichTicket(ticket, now = new Date()) {
  const normalized = normalizeTicket(ticket);
  if (!normalized) return null;
  return {
    ...normalized,
    sla: computeSla(normalized, now),
  };
}

function enrichTickets(tickets, now = new Date()) {
  return (tickets || []).map(ticket => enrichTicket(ticket, now)).filter(Boolean);
}

async function chooseAvailableAnalyst(db, areaId) {
  const safeAreaId = normalizeId(areaId);
  if (!safeAreaId) return null;
  const analysts = await db.listAvailableAnalystsByArea(safeAreaId);
  return [...(analysts || [])]
    .filter(analyst => analyst.available && String(analyst.area_id) === String(safeAreaId))
    .sort((a, b) => Number(a.id) - Number(b.id))[0] || null;
}

async function autoRouteTicket(db, ticketOrId) {
  const baseTicket = typeof ticketOrId === 'object' ? ticketOrId : await db.getTicketById(ticketOrId);
  const ticket = normalizeTicket(baseTicket);
  if (!ticket) return null;
  if (!ticket.area_id) return enrichTicket(ticket);
  if (ticket.assignment?.analyst_id) return enrichTicket(ticket);

  const analyst = await chooseAvailableAnalyst(db, ticket.area_id);
  if (!analyst) return enrichTicket(ticket);

  await db.assignTicket(ticket.id, analyst.id, { assigned_by: 'auto' });
  return enrichTicket(await db.getTicketWithRouting(ticket.id));
}

async function assignTicket(db, { ticketId, analystId, assignedBy = 'manual', actor = null }) {
  const ticket = await db.getTicketById(ticketId);
  if (!ticket) {
    const err = new Error('Ticket not found.');
    err.statusCode = 404;
    throw err;
  }

  const safeAnalystId = normalizeId(analystId);
  if (!safeAnalystId) {
    const err = new Error('analyst_id must be a positive integer.');
    err.statusCode = 400;
    throw err;
  }

  const analyst = await db.getAnalystById(safeAnalystId);
  if (!analyst) {
    const err = new Error('Analyst not found.');
    err.statusCode = 404;
    throw err;
  }

  if (ticket.area_id && String(ticket.area_id) !== String(analyst.area_id)) {
    const err = new Error('Analyst does not belong to the ticket area. Transfer the ticket area first.');
    err.statusCode = 409;
    throw err;
  }

  if (!ticket.area_id && analyst.area_id) {
    await db.updateTicketArea(ticket.id, analyst.area_id);
  }

  await db.assignTicket(ticket.id, analyst.id, { assigned_by: assignedBy, actor });
  return enrichTicket(await db.getTicketWithRouting(ticket.id));
}

async function unassignTicket(db, ticketId, { assignedBy = 'manual' } = {}) {
  await db.unassignTicket(ticketId, { assigned_by: assignedBy });
  return enrichTicket(await db.getTicketWithRouting(ticketId));
}

async function transferTicket(db, { ticketId, areaId, analystId = null, actor = null }) {
  const safeAreaId = normalizeId(areaId);
  if (!safeAreaId) {
    const err = new Error('area_id must be a positive integer.');
    err.statusCode = 400;
    throw err;
  }

  const ticket = await db.getTicketById(ticketId);
  if (!ticket) {
    const err = new Error('Ticket not found.');
    err.statusCode = 404;
    throw err;
  }

  if (db.getAreaById) {
    const area = await db.getAreaById(safeAreaId);
    if (!area) {
      const err = new Error('Target area not found.');
      err.statusCode = 404;
      throw err;
    }
  }

  const safeAnalystId = normalizeId(analystId);
  if (analystId && !safeAnalystId) {
    const err = new Error('analyst_id must be a positive integer.');
    err.statusCode = 400;
    throw err;
  }

  if (safeAnalystId) {
    const analyst = await db.getAnalystById(safeAnalystId);
    if (!analyst) {
      const err = new Error('Analyst not found.');
      err.statusCode = 404;
      throw err;
    }
    if (String(analyst.area_id) !== String(safeAreaId)) {
      const err = new Error('Analyst does not belong to the target area.');
      err.statusCode = 409;
      throw err;
    }
  }

  await db.updateTicketArea(ticketId, safeAreaId);
  if (safeAnalystId) {
    await db.assignTicket(ticketId, safeAnalystId, { assigned_by: 'transfer', actor });
    return enrichTicket(await db.getTicketWithRouting(ticketId));
  }

  await db.unassignTicket(ticketId, { assigned_by: 'transfer' });
  return autoRouteTicket(db, ticketId);
}

module.exports = {
  DEFAULT_SLA_MINUTES,
  SLA_WARNING_MINUTES_FLOOR,
  SLA_WARNING_RATIO,
  autoRouteTicket,
  assignTicket,
  chooseAvailableAnalyst,
  computeSla,
  enrichTicket,
  enrichTickets,
  transferTicket,
  unassignTicket,
};

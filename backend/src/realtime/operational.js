function isAdmin(user) {
  return user?.role === 'admin';
}

function getTicketAssignment(ticket) {
  if (!ticket) return null;
  if (ticket.assignment) return ticket.assignment;
  if (Array.isArray(ticket.ticket_assignments)) return ticket.ticket_assignments[0] || null;
  return null;
}

function analystCanAccessTicket(analyst, ticket) {
  if (!ticket) return false;

  if (!analyst?.id) return false;

  const assignment = getTicketAssignment(ticket);
  if (assignment?.analyst_id && String(assignment.analyst_id) === String(analyst.id)
    && analyst.area_id && ticket.area_id && String(ticket.area_id) === String(analyst.area_id)) {
    return true;
  }

  return false;
}

function analystCanSeeQueueCard(analyst, ticket) {
  const assignment = getTicketAssignment(ticket);
  return !!analyst?.area_id && !!ticket?.area_id && !assignment?.analyst_id && String(ticket.area_id) === String(analyst.area_id);
}

function toMinimalQueueCard(ticket) {
  return {
    id: ticket.id, area_id: ticket.area_id, categoria: ticket.categoria, prioridad: ticket.prioridad,
    status: ticket.status, created_at: ticket.created_at, closed_at: ticket.closed_at || null,
    sla: ticket.sla || null,
    assignment: ticket.assignment?.analyst_id ? { analyst_id: ticket.assignment.analyst_id } : null,
    queue_card: true,
  };
}

function canAccessTicket(user, analyst, ticket) {
  if (isAdmin(user)) return true;
  return analystCanAccessTicket(analyst, ticket);
}

function filterTicketsForPrincipal(tickets, user, analyst) {
  if (isAdmin(user)) return tickets;
  return tickets.flatMap(ticket => analystCanAccessTicket(analyst, ticket)
    ? [ticket]
    : analystCanSeeQueueCard(analyst, ticket) ? [toMinimalQueueCard(ticket)] : []);
}

function emitClassified(io, { event, adminPayload, areaId = null, areaPayload = null, analystId = null, analystPayload = null }) {
  if (!event || adminPayload === undefined) throw new TypeError('Explicit event and adminPayload are required.');
  if (areaPayload !== null) assertAreaPayloadSafe(areaPayload);
  io.to('admin').emit(event, adminPayload);
  if (areaId && areaPayload !== null) io.to(`area:${areaId}`).emit(event, areaPayload);
  if (analystId && analystPayload !== null) io.to(`analyst:${analystId}`).emit(event, analystPayload);
}

const AREA_PAYLOAD_DENYLIST = new Set([
  'chatId', 'chat_id', 'contactKey', 'telefono', 'phone', 'correo', 'email',
  'nombre', 'nombre_analista', 'nombre_empresa', 'company', 'situacion', 'issue',
  'message', 'messages', 'media', 'mode', 'silenced', 'silence',
]);

function assertAreaPayloadSafe(value, path = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAreaPayloadSafe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (AREA_PAYLOAD_DENYLIST.has(key)) throw new TypeError(`Area payload contains forbidden field: ${path}.${key}`);
    assertAreaPayloadSafe(nested, `${path}.${key}`);
  }
}

function emitTicketOperation(io, event, ticket, { areaId = ticket?.area_id || null, areaPayload = null } = {}) {
  const analystId = getTicketAssignment(ticket)?.analyst_id || null;
  emitClassified(io, { event, adminPayload: ticket, areaId, areaPayload, analystId, analystPayload: ticket });
}

function emitMinimalAreaOperation(io, event, payload, areaId) {
  emitClassified(io, { event, adminPayload: payload, areaId, areaPayload: payload });
}

module.exports = {
  isAdmin,
  analystCanAccessTicket,
  analystCanSeeQueueCard,
  toMinimalQueueCard,
  canAccessTicket,
  filterTicketsForPrincipal,
  emitClassified,
  emitTicketOperation,
  emitMinimalAreaOperation,
  AREA_PAYLOAD_DENYLIST,
  assertAreaPayloadSafe,
};

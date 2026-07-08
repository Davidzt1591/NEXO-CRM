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

  // Phase 1 transitional queue: unassigned tickets remain visible to authenticated
  // non-admin analyst/agent dashboards until area assignment is introduced.
  if (!ticket.area_id) return true;

  if (!analyst?.id) return false;

  const assignment = getTicketAssignment(ticket);
  if (assignment?.analyst_id && String(assignment.analyst_id) === String(analyst.id)) {
    return true;
  }

  return !!analyst.area_id && String(ticket.area_id) === String(analyst.area_id);
}

function canAccessTicket(user, analyst, ticket) {
  if (isAdmin(user)) return true;
  return analystCanAccessTicket(analyst, ticket);
}

function filterTicketsForPrincipal(tickets, user, analyst) {
  if (isAdmin(user)) return tickets;
  return tickets.filter(ticket => analystCanAccessTicket(analyst, ticket));
}

function emitOperational(io, event, payload, areaId) {
  if (areaId) {
    io.to('admin').to(`area:${areaId}`).emit(event, payload);
    return;
  }

  // Phase 1 transitional queue: null/unassigned-area operational payloads are
  // delivered only to admins and authenticated non-admin analyst/agent sockets.
  // Never use io.emit() here; tickets, messages, and Salesforce references can contain PII.
  io.to('admin').to('unassigned:agents').emit(event, payload);
}

module.exports = {
  isAdmin,
  analystCanAccessTicket,
  canAccessTicket,
  filterTicketsForPrincipal,
  emitOperational,
};

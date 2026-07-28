const OPERATIONAL_FILTERS = new Set(['all', 'alta', 'manual', 'mine', 'unassigned', 'sla', 'silenced', 'cerrados']);

export function effectiveCandidateState(error) {
  return typeof error?.data?.candidate === 'boolean' ? error.data.candidate : null;
}

export function updateCandidateContact(contacts, selectedId, candidate) {
  if (!selectedId || !contacts[selectedId]) return contacts;
  return { ...contacts, [selectedId]: { ...contacts[selectedId], candidate } };
}

export function contactMatchesSupportFilter(contact, filter, context = {}) {
  if (filter === 'candidates') return context.isAdmin && contact.candidate === true;
  if (OPERATIONAL_FILTERS.has(filter) && contact.candidate) return false;

  const open = contact.status !== 'closed';
  if (filter === 'all') return open;
  if (filter === 'alta') return contact.prioridad === 'Alta' && open;
  if (filter === 'manual') return context.chatModes?.[contact.chatId] === 'manual' && open;
  if (filter === 'mine') return String(contact.assignment?.analyst_id || '') === String(context.myAnalystId || '') && open;
  if (filter === 'unassigned') return !contact.assignment?.analyst_id && open;
  if (filter === 'sla') return ['warning', 'breached'].includes(contact.sla?.state) && open;
  if (filter === 'silenced') return context.silenced?.[contact.chatId] && open;
  if (filter === 'cerrados') return contact.status === 'closed';
  return open && !contact.candidate;
}

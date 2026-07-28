import { contactMatchesSupportFilter } from '../../lib/candidateUi';

export function deriveWorkspaceSelection({ contacts, chatMessages, selectedId, customNames }) {
  const selectedContact = contacts[selectedId];
  const selectedChatId = selectedContact?.chatId || selectedContact?.telefono;
  return { selectedContact, selectedChatId, selectedMessages: chatMessages[selectedId] || [], headerName: customNames[selectedId] || selectedContact?.nombre_analista || (selectedChatId || '').replace(/@c\.us|@lid/g, '') || selectedChatId };
}

export function deriveVisibleContacts({ contacts, filter, search, chatModes, silenced, principal }) {
  const query = search.toLowerCase();
  return Object.values(contacts).filter(contact => contactMatchesSupportFilter(contact, filter, { chatModes, silenced, myAnalystId: principal?.analyst?.id, isAdmin: principal?.user?.role === 'admin' })).filter(contact => !query || contact.nombre_analista?.toLowerCase().includes(query) || contact.nombre_empresa?.toLowerCase().includes(query) || contact.chatId?.includes(query)).sort((left, right) => new Date(right.lastTimestamp || 0) - new Date(left.lastTimestamp || 0));
}

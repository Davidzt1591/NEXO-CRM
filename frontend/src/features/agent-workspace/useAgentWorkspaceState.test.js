// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { deriveVisibleContacts, deriveWorkspaceSelection } from './workspaceSelectors';

describe('agent workspace derived state', () => {
  it('derives the selected chat without duplicating store state', () => {
    const contact = { chatId: '300@c.us', nombre_analista: 'Ana' };
    expect(deriveWorkspaceSelection({ contacts: { ticket: contact }, chatMessages: { ticket: [{ body: 'hola' }] }, selectedId: 'ticket', customNames: { ticket: 'Alias' } })).toEqual({
      selectedContact: contact, selectedChatId: '300@c.us', selectedMessages: [{ body: 'hola' }], headerName: 'Alias',
    });
  });

  it('filters and orders contacts using the support-domain selector', () => {
    const contacts = { old: { chatId: '1', nombre_empresa: 'Other', status: 'open', lastTimestamp: '2026-01-01' }, recent: { chatId: '2', nombre_empresa: 'Magneto', status: 'open', lastTimestamp: '2026-02-01' } };
    const result = deriveVisibleContacts({ contacts, filter: 'all', search: 'magneto', chatModes: {}, silenced: {}, principal: null });
    expect(result).toEqual([contacts.recent]);
  });
});

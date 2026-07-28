// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useChatActions from './useChatActions';

describe('useChatActions', () => {
  it('emits the canonical message payload and clears the draft', () => {
    const socket = { emit: vi.fn() };
    const workspace = { selectedId: 'ticket', selectedContact: { id: 7 }, selectedChatId: '300@c.us', newMessage: ' hello ', pendingMedia: { data: 'x', mimetype: 'image/png', filename: 'a.png', preview: 'ignored' }, setNewMessage: vi.fn(), setPendingMedia: vi.fn(), setShowEmojiPicker: vi.fn(), contacts: {}, chatModes: {}, silenced: {} };
    const { result } = renderHook(() => useChatActions({ socket, workspace }));
    act(() => result.current.sendMessage());
    expect(socket.emit).toHaveBeenCalledWith('send-message', { chatId: '300@c.us', message: 'hello', ticketId: 7, media: { data: 'x', mimetype: 'image/png', filename: 'a.png' } });
    expect(workspace.setNewMessage).toHaveBeenCalledWith('');
    expect(workspace.setPendingMedia).toHaveBeenCalledWith(null);
  });

  it('maps mode and silence actions to operational socket events', () => {
    const socket = { emit: vi.fn() };
    const workspace = { contacts: { ticket: { chatId: '300@c.us' } }, chatModes: { '300@c.us': 'manual' }, silenced: { '300@c.us': true }, selectedChatId: '300@c.us' };
    const { result } = renderHook(() => useChatActions({ socket, workspace }));
    act(() => { result.current.toggleMode('ticket'); result.current.toggleSilence(); });
    expect(socket.emit).toHaveBeenNthCalledWith(1, 'toggle-mode', { chatId: '300@c.us', mode: 'auto' });
    expect(socket.emit).toHaveBeenNthCalledWith(2, 'unsilence-chat', '300@c.us');
  });
});

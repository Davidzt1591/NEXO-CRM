// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkflow, transitionWorkflow } from './conversationApi';
import { useConversationWorkflow } from './useConversationWorkflow';

vi.mock('./conversationApi', () => ({ getWorkflow: vi.fn(), transitionWorkflow: vi.fn(), requestDevelopment: vi.fn(), updateDevelopment: vi.fn() }));

const socket = { on: vi.fn(), off: vi.fn() };
const ticket = { id: 1, conversation_state: 'in_progress', workflow_revision: 1 };

describe('useConversationWorkflow', () => {
  beforeEach(() => { vi.clearAllMocks(); getWorkflow.mockResolvedValue(ticket); });

  it('refreshes after a 409 without retrying the POST and explains the stale revision', async () => {
    const fresh = { ...ticket, conversation_state: 'waiting', workflow_revision: 2 };
    getWorkflow.mockResolvedValueOnce(ticket).mockResolvedValueOnce(fresh);
    transitionWorkflow.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    const setContacts = vi.fn(updater => updater({ 1: ticket }));
    const { result } = renderHook(() => useConversationWorkflow({ ticket, setContacts, socket, canReadFull: true }));
    await waitFor(() => expect(getWorkflow).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.transition('waiting', 'customer_response'); });
    expect(transitionWorkflow).toHaveBeenCalledTimes(1);
    expect(getWorkflow).toHaveBeenCalledTimes(2);
    expect(result.current.state.error).toContain('cambió en otra sesión');
  });

  it('aborts stale reads when ticket selection changes', async () => {
    const signals = [];
    getWorkflow.mockImplementation((_id, options) => { signals.push(options.signal); return new Promise(() => {}); });
    const setContacts = vi.fn();
    const { rerender } = renderHook(({ selected }) => useConversationWorkflow({ ticket: selected, setContacts, socket, canReadFull: true }), { initialProps: { selected: ticket } });
    rerender({ selected: { ...ticket, id: 2 } });
    expect(signals[0].aborted).toBe(true);
  });

  it('switches A rev5 to B rev2, ignores delayed A, and accepts B rev3', async () => {
    let resolveA;
    const pendingA = new Promise(resolve => { resolveA = resolve; });
    const a5 = { id: 1, workflow_revision: 5, conversation_state: 'waiting' };
    const b2 = { id: 2, workflow_revision: 2, conversation_state: 'in_progress' };
    const b3 = { ...b2, workflow_revision: 3, conversation_state: 'waiting' };
    getWorkflow.mockImplementation(id => id === 1 ? pendingA : Promise.resolve(b2));
    const handlers = [];
    const observableSocket = { on: vi.fn((_event, handler) => handlers.push(handler)), off: vi.fn() };
    const setContacts = vi.fn(updater => updater({ 1: a5, 2: b2 }));
    const { result, rerender } = renderHook(({ selected }) => useConversationWorkflow({ ticket: selected, setContacts, socket: observableSocket, canReadFull: true }), { initialProps: { selected: a5 } });
    expect(result.current.workflow).toEqual(a5);
    rerender({ selected: b2 });
    expect(result.current.workflow).toEqual(b2);
    await waitFor(() => expect(getWorkflow).toHaveBeenCalledWith(2, expect.anything()));
    await act(async () => { resolveA(a5); await pendingA; });
    expect(result.current.workflow).toEqual(b2);
    act(() => handlers.forEach(handler => handler(a5)));
    expect(result.current.workflow).toEqual(b2);
    act(() => handlers.forEach(handler => handler(b3)));
    expect(result.current.workflow).toEqual(b3);
  });
});

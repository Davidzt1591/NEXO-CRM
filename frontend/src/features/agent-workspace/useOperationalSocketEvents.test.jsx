// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useOperationalSocketEvents from './useOperationalSocketEvents';

vi.mock('../../hooks/useNexoSocket', () => ({ useNexoSocket: vi.fn() }));

describe('useOperationalSocketEvents', () => {
  it('unsubscribes every assignment listener with the same handler', () => {
    const socket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
    const fn = vi.fn();
    const workspace = { qrTimerRef: {}, selectedIdRef: {}, rateLimitGenerationRef: { current: 0 }, setClaimStates: fn, setSelectedId: fn, setRateLimitState: fn };
    const { unmount } = renderHook(() => useOperationalSocketEvents({ authenticated: true, socket, workspace, setAuthError: fn, setAuthenticated: fn }));
    const registrations = socket.on.mock.calls;
    unmount();
    for (const [event, handler] of registrations) expect(socket.off).toHaveBeenCalledWith(event, handler);
  });
});

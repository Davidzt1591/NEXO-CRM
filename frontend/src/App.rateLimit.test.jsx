// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./store/useAppStore', () => ({ useAppStore: vi.fn() }));
vi.mock('./hooks/useNexoSocket', () => ({ useNexoSocket: vi.fn() }));
vi.mock('./lib/authSession', () => ({
  AUTH_INVALIDATED_EVENT: 'nexo:auth-invalidated',
  restoreSessionWithRetry: vi.fn(() => Promise.resolve({ authenticated: true, principal: { user: { id: 1, role: 'admin' } } })),
  createSession: vi.fn(), deleteSession: vi.fn(() => Promise.resolve()),
}));
vi.mock('./lib/nexoSocket', () => ({
  socket: { disconnect: vi.fn(), emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('./components/AdminPanel', () => ({
  default: ({ onLogout }) => <main><h1>Admin owner</h1><button onClick={onLogout}>Cerrar sesión</button></main>,
}));

import App from './App';
import { useAppStore } from './store/useAppStore';
import { RATE_LIMITED_EVENT } from './lib/apiClient';
import { restoreSessionWithRetry } from './lib/authSession';

const noop = () => {};
const STORE = {
  qrDataUrl: null, setQrDataUrl: noop, qrCountdown: 0, setQrCountdown: noop,
  showQR: false, setShowQR: noop, contacts: {}, setContacts: noop,
  chatMessages: {}, setChatMessages: noop, selectedId: null, setSelectedId: noop,
  chatModes: {}, setChatModes: noop, silenced: {}, setSilenced: noop,
  botStatus: 'ready', setBotStatus: noop, botActivo: true, setBotActivo: noop,
  newMessage: '', setNewMessage: noop, filter: 'all', setFilter: noop,
  search: '', setSearch: noop, unread: {}, setUnread: noop,
  showEmojiPicker: false, setShowEmojiPicker: noop, pendingMedia: null, setPendingMedia: noop,
  authMode: 'qr', setAuthMode: noop, pairingPhone: '', setPairingPhone: noop,
  pairingCode: '', setPairingCode: noop, pairingError: '', setPairingError: noop,
  pairingLoading: false, setPairingLoading: noop, contactTags: {}, setContactTag: noop,
  customNames: {}, setCustomName: noop, quickReplies: [], setQuickReplies: noop,
  clearSensitiveState: noop,
};

function dispatchRateLimit(retryAfterSeconds, signature) {
  act(() => window.dispatchEvent(new CustomEvent(RATE_LIMITED_EVENT, {
    detail: { retryAfterSeconds, signature },
  })));
}

describe('App rate-limit ownership', () => {
  beforeEach(() => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(key => values.get(key) || null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn(key => values.delete(key)),
      clear: vi.fn(() => values.clear()),
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00Z'));
    window.history.replaceState(null, '', '/admin');
    useAppStore.mockReturnValue(STORE);
    restoreSessionWithRetry.mockResolvedValue({ authenticated: true, principal: { user: { id: 1, role: 'admin' } } });
  });

  it('shows a focused degraded restore state and retries without showing the token form', async () => {
    restoreSessionWithRetry.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'AUTH_UNAVAILABLE' }))
      .mockResolvedValueOnce({ authenticated: true, principal: { user: { id: 1, role: 'admin' } } });
    render(<App />);
    await act(async () => {}); act(() => vi.runOnlyPendingTimers());
    const degraded = screen.getByRole('alert');
    expect(degraded).toHaveFocus();
    expect(screen.queryByLabelText('Token de Acceso Corporativo')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Admin owner' })).toBeInTheDocument();
  });

  it('announces invalidation and moves focus into the labelled token input', async () => {
    render(<App />);
    await act(async () => {});
    screen.getByRole('heading', { name: 'Admin owner' });
    act(() => window.dispatchEvent(new CustomEvent('nexo:auth-invalidated', { detail: { code: 'AUTH_REVOKED' } })));
    const input = screen.getByLabelText('Token de Acceso Corporativo');
    act(() => vi.runOnlyPendingTimers());
    expect(input).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('revocado');
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('shows a 429 banner, removes it at expiry, and does not log out', async () => {
    render(<App />);
    await act(async () => {});
    dispatchRateLimit(2, 'GET /api/admin/queue');

    expect(screen.getByRole('status')).toHaveTextContent('2 segundos');
    expect(screen.getByRole('heading', { name: 'Admin owner' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_000));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Admin owner' })).toBeInTheDocument();
  });

  it('keeps a newer 429 visible when the superseded timer reaches its old expiry', async () => {
    render(<App />);
    await act(async () => {});
    dispatchRateLimit(1, 'GET /api/admin/queue');
    act(() => vi.advanceTimersByTime(500));
    dispatchRateLimit(3, 'GET /api/admin/analysts');

    expect(screen.getByRole('status')).toHaveTextContent('3 segundos');
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('status')).toHaveTextContent('3 segundos');

    act(() => vi.advanceTimersByTime(2_500));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });
});

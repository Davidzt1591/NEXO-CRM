// @vitest-environment jsdom
import React from 'react';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import { registerNexoSocketHandlers, useNexoSocket } from './useNexoSocket';

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,qr')),
  },
}));

function createSocket(overrides = {}) {
  return {
    connected: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    ...overrides,
  };
}

function createOptions(overrides = {}) {
  const setter = vi.fn();

  return {
    qrTimerRef: { current: 123 },
    selectedIdRef: { current: 'ticket-1' },
    setAuthError: setter,
    setAuthMode: setter,
    setBotActivo: setter,
    setBotStatus: setter,
    setChatMessages: setter,
    setChatModes: setter,
    setChatSummaries: setter,
    setContacts: setter,
    setIsAuthenticated: setter,
    setIsImprovingText: setter,
    setIsSummarizing: setter,
    setNewMessage: setter,
    setPairingCode: setter,
    setPairingError: setter,
    setPairingLoading: setter,
    setPrincipal: setter,
    setQrCountdown: setter,
    setQrDataUrl: setter,
    setSelectedId: setter,
    setSilenced: setter,
    setStats: setter,
    setSystemInfo: setter,
    setUnread: setter,
    ...overrides,
  };
}

function handlerFor(socket, event) {
  const call = socket.on.mock.calls.find(([registeredEvent]) => registeredEvent === event);
  return call?.[1];
}

function lastHandlerFor(socket, event) {
  const calls = socket.on.mock.calls.filter(([registeredEvent]) => registeredEvent === event);
  return calls.at(-1)?.[1];
}

function TestNexoSocket({ isAuthenticated, socket, options }) {
  useNexoSocket({ isAuthenticated, socket, options });
  return null;
}

describe('registerNexoSocketHandlers', () => {
  beforeEach(() => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(key => store.get(key) || null),
      setItem: vi.fn((key, value) => store.set(key, String(value))),
      removeItem: vi.fn(key => store.delete(key)),
      clear: vi.fn(() => store.clear()),
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cleans up only handlers registered by the hook', () => {
    const socket = createSocket({ connected: true });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const cleanup = registerNexoSocketHandlers(socket, createOptions());

    expect(socket.emit).toHaveBeenCalledWith('get-tickets');

    cleanup();

    expect(socket.removeAllListeners).not.toHaveBeenCalled();
    expect(socket.off).toHaveBeenCalledTimes(socket.on.mock.calls.length);
    socket.on.mock.calls.forEach(([event, handler]) => {
      expect(socket.off).toHaveBeenCalledWith(event, handler);
    });
    expect(clearIntervalSpy).toHaveBeenCalledWith(123);
  });

  it('ignores handlers after cleanup so stale StrictMode lifecycles cannot emit restored messages', () => {
    const socket = createSocket({ connected: true });
    localStorage.setItem('nexo_selected_id', '42');

    const cleanup = registerNexoSocketHandlers(socket, createOptions());
    const ticketsHandler = handlerFor(socket, 'tickets-list');

    cleanup();
    ticketsHandler([{ id: 42, telefono: '573001234567@c.us' }]);

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('get-tickets');
    expect(socket.emit).not.toHaveBeenCalledWith('get-messages', 42);
  });

  it('defers initial ticket loading until an active socket connection exists', () => {
    const socket = createSocket({ connected: false });

    const cleanupFirstLifecycle = registerNexoSocketHandlers(socket, createOptions());
    const firstConnectHandler = handlerFor(socket, 'connect');

    expect(socket.emit).not.toHaveBeenCalledWith('get-tickets');

    cleanupFirstLifecycle();
    firstConnectHandler();
    expect(socket.emit).not.toHaveBeenCalledWith('get-tickets');

    registerNexoSocketHandlers(socket, createOptions());
    lastHandlerFor(socket, 'connect')();

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('get-tickets');
  });

  it('does not update QR state or start countdown timers when async QR generation finishes after cleanup', async () => {
    const socket = createSocket();
    const setQrDataUrl = vi.fn();
    const setQrCountdown = vi.fn();
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    let resolveQr;
    QRCode.toDataURL.mockImplementationOnce(() => new Promise(resolve => {
      resolveQr = resolve;
    }));

    const cleanup = registerNexoSocketHandlers(socket, createOptions({ setQrDataUrl, setQrCountdown }));
    const qrHandler = handlerFor(socket, 'qr');
    const qrPromise = qrHandler({ qr: 'pending-qr', expiresIn: 30 });

    cleanup();
    resolveQr('data:image/png;base64,late-qr');
    await qrPromise;

    expect(setQrDataUrl).not.toHaveBeenCalled();
    expect(setQrCountdown).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('restores the saved selected ticket when tickets arrive', () => {
    const socket = createSocket({ connected: true });
    localStorage.setItem('nexo_selected_id', '42');

    registerNexoSocketHandlers(socket, createOptions());
    handlerFor(socket, 'tickets-list')([{ id: 42, telefono: '573001234567@c.us' }]);

    expect(socket.emit).toHaveBeenCalledWith('get-messages', 42);
  });

  it('disconnects the app-owned socket on authenticated lifecycle cleanup', () => {
    const socket = createSocket();

    const { unmount } = render(React.createElement(TestNexoSocket, {
      isAuthenticated: true,
      socket,
      options: createOptions(),
    }));

    expect(socket.connect).toHaveBeenCalledTimes(1);
    handlerFor(socket, 'connect')();
    expect(socket.emit).toHaveBeenCalledWith('get-tickets');

    unmount();

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.off).toHaveBeenCalledTimes(socket.on.mock.calls.length);
  });

  it('disconnects without registering handlers when auth transitions to logged out', () => {
    const socket = createSocket({ connected: true });

    const { rerender } = render(React.createElement(TestNexoSocket, {
      isAuthenticated: true,
      socket,
      options: createOptions(),
    }));

    rerender(React.createElement(TestNexoSocket, {
      isAuthenticated: false,
      socket,
      options: createOptions(),
    }));

    expect(socket.disconnect).toHaveBeenCalledTimes(2);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });
});

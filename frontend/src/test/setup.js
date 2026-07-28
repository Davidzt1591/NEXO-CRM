import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  if (typeof document !== 'undefined') {
    document.body.replaceChildren();
    document.head.querySelectorAll('[data-testid], [data-test]').forEach(node => node.remove());
  }
  if (typeof window !== 'undefined') {
    if (typeof window.localStorage?.clear === 'function') window.localStorage.clear();
    if (typeof window.sessionStorage?.clear === 'function') window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  }
});

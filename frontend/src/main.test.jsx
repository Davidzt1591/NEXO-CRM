// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('secure application bootstrap', () => {
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

  it('purges the legacy token before rendering and does not install an Authorization fetch wrapper', async () => {
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', { removeItem, getItem: vi.fn(), setItem: vi.fn() });
    const nativeFetch = vi.fn();
    vi.stubGlobal('fetch', nativeFetch);
    const render = vi.fn();
    vi.doMock('react-dom/client', () => ({ createRoot: () => ({ render }) }));
    vi.doMock('./App.jsx', () => ({ default: function App() { return null; } }));
    document.body.innerHTML = '<div id="root"></div>';

    await import('./main.jsx');

    expect(removeItem).toHaveBeenCalledWith('nexo_token');
    expect(globalThis.fetch).toBe(nativeFetch);
    expect(render).toHaveBeenCalledOnce();
  });
});

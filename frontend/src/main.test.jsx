// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

async function installFetchWrapper(originalFetch) {
  vi.resetModules();
  vi.doMock('react-dom/client', () => ({
    createRoot: vi.fn(() => ({ render: vi.fn() })),
  }));
  vi.doMock('./App.jsx', () => ({ default: function MockApp() { return null; } }));

  document.body.innerHTML = '<div id="root"></div>';
  globalThis.fetch = originalFetch;

  await import('./main.jsx');

  return globalThis.fetch;
}

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockLocalStorage() {
  const store = new Map();
  const storage = {
    getItem: vi.fn(key => store.get(key) || null),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    removeItem: vi.fn(key => store.delete(key)),
    clear: vi.fn(() => store.clear()),
  };

  vi.stubGlobal('localStorage', storage);
  return storage;
}

describe('global fetch wrapper', () => {
  afterEach(() => {
    vi.doUnmock('react-dom/client');
    vi.doUnmock('./App.jsx');
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = '';
    globalThis.fetch = nativeFetch;
  });

  it('preserves JSON Content-Type while adding dashboard auth only for trusted API calls', async () => {
    const originalFetch = vi.fn(() => Promise.resolve(okResponse()));
    mockLocalStorage();
    localStorage.setItem('nexo_token', 'admin-token');

    const wrappedFetch = await installFetchWrapper(originalFetch);

    await wrappedFetch('http://localhost:3001/api/admin/areas', {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'Billing' }),
    });

    const [, trustedOptions] = originalFetch.mock.calls[0];

    expect(trustedOptions.headers).toBeInstanceOf(Headers);
    expect(trustedOptions.headers.get('Content-Type')).toBe('application/json');
    expect(trustedOptions.headers.get('Authorization')).toBe('Bearer admin-token');

    await wrappedFetch('https://example.com/api/admin/areas', {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'External' }),
    });

    const [, externalOptions] = originalFetch.mock.calls[1];
    expect(externalOptions.headers.get('Authorization')).toBeNull();
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('HttpOnly session client', () => {
  beforeEach(() => {
    vi.resetModules();
    const values = new Map([['nexo_token', 'legacy-secret']]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(key => values.get(key) || null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn(key => values.delete(key)),
    });
  });

  it('purges legacy storage at module startup and posts the token once with credentials', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ authenticated: true, principal: { user: { id: 1 } } }), { status: 201, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetch);
    const { createSession } = await import('./authSession');
    expect(localStorage.removeItem).toHaveBeenCalledWith('nexo_token');
    await createSession('one-time-secret');
    expect(fetch).toHaveBeenCalledWith('http://localhost:3001/api/session', expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token: 'one-time-secret' });
  });

  it('restores and deletes only through credentialed session endpoints', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const { restoreSession, deleteSession } = await import('./authSession');
    expect(await restoreSession()).toEqual({ authenticated: true });
    await deleteSession();
    expect(fetch.mock.calls[0][1]).toEqual({ credentials: 'include' });
    expect(fetch.mock.calls[1][1]).toEqual({ method: 'DELETE', credentials: 'include' });
  });

  it('retries transient restore with bounded backoff and recovers without converting it to invalid auth', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'AUTH_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const sleep = vi.fn(() => Promise.resolve());
    const { restoreSessionWithRetry } = await import('./authSession');
    await expect(restoreSessionWithRetry({ sleep })).resolves.toEqual({ authenticated: true });
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry invalid sessions and surfaces exhausted availability distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 'AUTH_REVOKED' }), { status: 401, headers: { 'Content-Type': 'application/json' } }))));
    const { restoreSessionWithRetry } = await import('./authSession');
    await expect(restoreSessionWithRetry({ sleep: vi.fn() })).resolves.toEqual({ authenticated: false, code: 'AUTH_REVOKED' });
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline')));
    await expect(restoreSessionWithRetry({ attempts: 2, sleep: () => Promise.resolve() })).rejects.toMatchObject({ code: 'AUTH_UNAVAILABLE' });
  });
});

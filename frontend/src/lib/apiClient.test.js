// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, jsonBody, RATE_LIMITED_EVENT, RATE_LIMIT_RECOVERED_EVENT } from './apiClient';

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), { status: init.status || 200, headers: { 'Content-Type': 'application/json' } });
}

function htmlResponse(html, init = {}) {
  return new Response(html, { status: init.status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function mockLocalStorage() {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(key => store.get(key) || null),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    removeItem: vi.fn(key => store.delete(key)),
    clear: vi.fn(() => store.clear()),
  });
}

describe('apiRequest', () => {
  beforeEach(() => {
    mockLocalStorage();
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
  });

  it('preserves JSON headers, includes credentials, and constructs no bearer auth', async () => {
    await apiRequest('/api/admin/areas', { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json' }), body: jsonBody({ name: 'Billing' }) });
    const [, options] = fetch.mock.calls[0];
    expect(options.headers).toBeInstanceOf(Headers);
    expect(options.headers.get('Content-Type')).toBe('application/json');
    expect(options.headers.get('Authorization')).toBeNull();
    expect(options.credentials).toBe('include');
    expect(options.body).toBe(JSON.stringify({ name: 'Billing' }));
  });

  it('targets the backend directly in development instead of depending on the frontend port', async () => {
    await apiRequest('/api/admin/areas');
    expect(fetch).toHaveBeenCalledWith('http://localhost:3001/api/admin/areas', expect.objectContaining({ headers: expect.any(Headers) }));
  });

  it('does not send dashboard auth to external URLs', async () => {
    await apiRequest('https://example.com/api/admin/areas');
    expect(fetch.mock.calls[0][1].headers.get('Authorization')).toBeNull();
  });

  it('throws a friendly Spanish error with metadata when the API returns HTML instead of JSON', async () => {
    fetch.mockResolvedValueOnce(htmlResponse('<!DOCTYPE html><html><body>Vite fallback</body></html>', { status: 200 }));
    await expect(apiRequest('/api/admin/areas')).rejects.toMatchObject({
      message: expect.stringContaining('No se pudo conectar con la API del backend'), status: 200,
      contentType: 'text/html; charset=utf-8', bodySnippet: expect.stringContaining('<!DOCTYPE html>'), data: null,
    });
  });

  it('throws status and response data for 403 responses', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'Forbidden' }, { status: 403 }));
    await expect(apiRequest('/api/admin/areas')).rejects.toMatchObject({ message: 'Forbidden', status: 403, data: { error: 'Forbidden' } });
  });

  it('preserves structured response data for partial candidate mutations', async () => {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 'CANDIDATE_MARK_PARTIAL',
      error: 'Local protection could not be confirmed.',
      candidate: true,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }));

    await expect(apiRequest('/api/candidates/chat?ticket_id=5', { method: 'PUT' })).rejects.toMatchObject({
      status: 503,
      code: 'CANDIDATE_MARK_PARTIAL',
      data: { code: 'CANDIDATE_MARK_PARTIAL', candidate: true },
    });
  });

  it('sensitive responses expose no body, data, snippets, secret, or automatic retry on failure', async () => {
    const secret = 'nexo_tkn_must_never_escape';
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 'TOKEN_ACTIVATION_FAILED', error: `upstream detail ${secret}`, token: secret,
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }));

    let failure;
    try {
      await apiRequest('/api/admin/agent-tokens', { method: 'POST', body: jsonBody({ name: 'Agente' }), sensitiveResponse: true });
    } catch (error) { failure = error; }

    expect(failure).toMatchObject({ message: 'No se pudo completar la operación sensible.', status: 503 });
    expect(Object.hasOwn(failure, 'data')).toBe(false);
    expect(Object.hasOwn(failure, 'bodySnippet')).toBe(false);
    expect(Object.hasOwn(failure, 'contentType')).toBe(false);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('sensitiveResponse');
  });

  it('sensitive responses return a successful one-time credential without caching or storage', async () => {
    const payload = { token: 'nexo_tkn_once', metadata: { id: 7, name: 'Agente', role: 'agent', active: true } };
    fetch.mockResolvedValueOnce(jsonResponse(payload, { status: 201 }));

    await expect(apiRequest('/api/admin/agent-tokens', { method: 'POST', body: jsonBody({ name: 'Agente' }), sensitiveResponse: true })).resolves.toEqual(payload);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('preserves RATE_LIMITED retry metadata and announces recovery only after the same request succeeds', async () => {
    const limited = vi.fn();
    const recovered = vi.fn();
    window.addEventListener(RATE_LIMITED_EVENT, limited);
    window.addEventListener(RATE_LIMIT_RECOVERED_EVENT, recovered);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 'RATE_LIMITED', error: 'Espera antes de reintentar.', retryAfterSeconds: 12,
    }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '12' } }));

    await expect(apiRequest('/api/admin/queue')).rejects.toMatchObject({
      status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 12,
    });
    expect(limited).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ retryAfterSeconds: 12 }) }));
    expect(recovered).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await apiRequest('/api/admin/queue');
    expect(recovered).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ signature: expect.stringContaining('GET') }) }));
    window.removeEventListener(RATE_LIMITED_EVENT, limited);
    window.removeEventListener(RATE_LIMIT_RECOVERED_EVENT, recovered);
  });
});

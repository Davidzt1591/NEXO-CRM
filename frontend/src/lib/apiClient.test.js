// @vitest-environment jsdom
import { apiRequest, jsonBody } from './apiClient';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    status: init.status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
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

describe('apiRequest', () => {
  beforeEach(() => {
    mockLocalStorage();
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
  });

  it('preserves JSON headers and dashboard auth for requests with a body', async () => {
    localStorage.setItem('nexo_token', 'admin-token');

    await apiRequest('/api/admin/areas', {
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: jsonBody({ name: 'Billing' }),
    });

    const [, options] = fetch.mock.calls[0];

    expect(options.headers).toBeInstanceOf(Headers);
    expect(options.headers.get('Content-Type')).toBe('application/json');
    expect(options.headers.get('Authorization')).toBe('Bearer admin-token');
    expect(options.body).toBe(JSON.stringify({ name: 'Billing' }));
  });

  it('targets the backend directly in development instead of depending on the frontend port', async () => {
    await apiRequest('/api/admin/areas');

    expect(fetch).toHaveBeenCalledWith('http://localhost:3001/api/admin/areas', expect.objectContaining({
      headers: expect.any(Headers),
    }));
  });

  it('does not send dashboard auth to external URLs', async () => {
    localStorage.setItem('nexo_token', 'admin-token');

    await apiRequest('https://example.com/api/admin/areas');

    const [, options] = fetch.mock.calls[0];

    expect(options.headers.get('Authorization')).toBeNull();
  });

  it('throws a friendly Spanish error with metadata when the API returns HTML instead of JSON', async () => {
    fetch.mockResolvedValueOnce(htmlResponse('<!DOCTYPE html><html><body>Vite fallback</body></html>', { status: 200 }));

    await expect(apiRequest('/api/admin/areas')).rejects.toMatchObject({
      message: expect.stringContaining('No se pudo conectar con la API del backend'),
      status: 200,
      contentType: 'text/html; charset=utf-8',
      bodySnippet: expect.stringContaining('<!DOCTYPE html>'),
      data: null,
    });
  });

  it('throws status and response data for 403 responses', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'Forbidden' }, { status: 403 }));

    await expect(apiRequest('/api/admin/areas')).rejects.toMatchObject({
      message: 'Forbidden',
      status: 403,
      data: { error: 'Forbidden' },
    });
  });
});

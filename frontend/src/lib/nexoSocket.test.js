// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({})) }));

describe('NEXO socket backend configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the configured API backend', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.nexo.example');
    vi.resetModules();
    const { getNexoSocketBaseUrl } = await import('./nexoSocket');
    expect(getNexoSocketBaseUrl()).toBe('https://api.nexo.example');
  });

  it('uses the same-host backend port when no API backend is configured', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    vi.stubEnv('DEV', true);
    vi.resetModules();
    const { getNexoSocketBaseUrl } = await import('./nexoSocket');
    expect(getNexoSocketBaseUrl()).toBe('http://localhost:3001');
  });

  it('supports configured same-origin socket routing for a reverse proxy', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '/');
    vi.stubEnv('DEV', false);
    vi.resetModules();
    const { getNexoSocketBaseUrl } = await import('./nexoSocket');
    expect(getNexoSocketBaseUrl()).toBe(window.location.origin);
  });

  it('uses credentialed cookies without JS auth or query payloads', async () => {
    vi.resetModules();
    const { createNexoSocket } = await import('./nexoSocket');
    createNexoSocket();
    const options = io.mock.calls.at(-1)[1];
    expect(options.withCredentials).toBe(true);
    expect(options.auth).toBeUndefined();
    expect(options.query).toBeUndefined();
  });
});

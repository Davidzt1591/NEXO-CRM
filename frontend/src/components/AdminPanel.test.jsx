// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPanel from './AdminPanel';

const AREAS = [
  { id: 1, name: 'Billing', description: 'Payments help', welcome_msg: null, sla_minutes: 15, active: true },
];

const ANALYSTS = [
  {
    id: 2,
    display_name: 'Ada Lovelace',
    token_id: 9,
    area_id: 1,
    available: false,
    last_seen: null,
    area: { name: 'Billing' },
    token: { name: 'Ada token' },
  },
];

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
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

function mockAdminFetch() {
  globalThis.fetch = vi.fn((url, options = {}) => {
    const { pathname } = new URL(url, window.location.origin);

    if (options.method === 'POST' || options.method === 'PATCH') {
      return Promise.resolve(jsonResponse({ ok: true }));
    }

    if (pathname === '/api/admin/areas') return Promise.resolve(jsonResponse(AREAS));
    if (pathname === '/api/admin/analysts') return Promise.resolve(jsonResponse(ANALYSTS));

    return Promise.resolve(jsonResponse({ error: 'Not found' }, { status: 404 }));
  });
}

function requestFor(method, path) {
  return fetch.mock.calls.find(([url, options = {}]) => {
    const { pathname } = new URL(url, window.location.origin);
    return pathname === path && options.method === method;
  })?.[1];
}

describe('AdminPanel', () => {
  beforeEach(() => {
    mockLocalStorage();
    localStorage.setItem('nexo_token', 'admin-token');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the forbidden state in Spanish when the admin API returns 403', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse({ error: 'Forbidden' }, { status: 403 })));

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText('Se requiere acceso administrativo')).toBeInTheDocument();
    expect(screen.getByText(/no tiene permisos para ingresar al panel de administración/i)).toBeInTheDocument();
  });

  it('renders the Spanish Phase 2 admin intro, areas, and analysts from successful admin API responses', async () => {
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText('Panel de administración')).toBeInTheDocument();
    expect(screen.getByText(/En esta fase, \/admin contiene la configuración de áreas de soporte/i)).toBeInTheDocument();
    expect(screen.getByText(/Flujos del bot, reportes, carga de Salesforce/i)).toBeInTheDocument();
    expect(await screen.findAllByText('Billing')).not.toHaveLength(0);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Ada token')).toBeInTheDocument();
    expect(screen.queryByText('Admin Panel')).not.toBeInTheDocument();
    expect(screen.queryByText('Operations topology')).not.toBeInTheDocument();
  });

  it('surfaces the friendly Spanish backend connectivity error when HTML is returned', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('<!DOCTYPE html><html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })));

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText(/No se pudo conectar con la API del backend/i)).toBeInTheDocument();
    expect(screen.getByText(/Endpoint: \/api\/admin\/areas/i)).toBeInTheDocument();
  });

  it('sends JSON bodies with Content-Type for create, update, and availability toggle calls', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByText('Ada Lovelace');

    await user.type(screen.getByLabelText('Nombre'), 'Integrations');
    await user.click(screen.getByRole('button', { name: /crear área/i }));

    await waitFor(() => expect(requestFor('POST', '/api/admin/areas')).toBeTruthy());
    const createAreaRequest = requestFor('POST', '/api/admin/areas');
    expect(createAreaRequest.headers.get('Content-Type')).toBe('application/json');
    expect(createAreaRequest.headers.get('Authorization')).toBe('Bearer admin-token');
    expect(JSON.parse(createAreaRequest.body)).toMatchObject({ name: 'Integrations', sla_minutes: 30 });

    await user.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
    await user.click(screen.getByRole('button', { name: /actualizar área/i }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/areas/1')).toBeTruthy());
    const updateAreaRequest = requestFor('PATCH', '/api/admin/areas/1');
    expect(updateAreaRequest.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(updateAreaRequest.body)).toMatchObject({ name: 'Billing', sla_minutes: 15 });

    await user.click(screen.getByRole('button', { name: 'Habilitar' }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/analysts/2')).toBeTruthy());
    const toggleRequest = requestFor('PATCH', '/api/admin/analysts/2');
    expect(toggleRequest.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(toggleRequest.body)).toEqual({ available: true });
  });

  it('cleans up polling and socket listeners on unmount', async () => {
    const socket = { connected: true, on: vi.fn(), off: vi.fn() };
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    mockAdminFetch();

    const { unmount } = render(<AdminPanel socket={socket} onLogout={vi.fn()} />);
    await screen.findByText('Ada Lovelace');

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(socket.off).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('analyst-presence', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('analyst-updated', expect.any(Function));
  });
});

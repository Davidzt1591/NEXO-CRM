// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  {
    id: 3,
    display_name: 'No Area Analyst',
    token_id: null,
    area_id: null,
    available: true,
    last_seen: null,
    area: null,
    token: null,
  },
];

const QUEUE = {
  tickets: [
    {
      id: 33,
      telefono: '573001112233',
      nombre_empresa: 'Acme',
      area_id: 1,
      status: 'open',
      created_at: '2026-07-09T10:00:00.000Z',
      area: { id: 1, name: 'Billing', sla_minutes: 15 },
      assignment: null,
      sla: { state: 'warning', age_minutes: 12, due_at: '2026-07-09T10:15:00.000Z' },
    },
  ],
};

const BOT_FLOWS = {
  flows: [
    { id: 5, version_id: 1, area_id: null, step_key: 'ask_name', message: 'Por favor indica tu nombre', sort_order: 10, active: true },
    { id: 6, version_id: 1, area_id: 1, step_key: 'ask_issue', message: 'Describe la novedad técnica', sort_order: 20, active: false },
  ],
  cache: [{ key: 'global', area_id: null, source: 'database', version_id: 1, age_ms: 100, expires_in_ms: 59000 }],
};

const REPORT_SUMMARY = {
  total_tickets: 12,
  open_tickets: 5,
  closed_tickets: 7,
  sf_attachments: 4,
  avg_close_minutes: 38,
  by_area: [
    { area: 'Billing', total: 8, open: 3, closed: 5 },
    { area: 'Soporte técnico', total: 4, open: 2, closed: 2 },
  ],
};

const AUDIT_LOGS = [
  {
    id: 10,
    action: 'ticket.closed',
    actor_name: 'Admin Root',
    actor_role: 'admin',
    target_id: '33',
    metadata: { sf_case_id: '500ABC', transcript_chunks: 2 },
    created_at: '2026-07-09T11:00:00.000Z',
  },
  {
    id: 11,
    action: 'flow.cache_invalidated',
    actor_name: 'Admin Root',
    actor_role: 'admin',
    target_id: 'global',
    metadata: { area_id: null },
    created_at: '2026-07-09T10:00:00.000Z',
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
    const { pathname, searchParams } = new URL(url, window.location.origin);

    if (options.method === 'POST' || options.method === 'PATCH') {
      return Promise.resolve(jsonResponse({ ok: true }));
    }

    if (pathname === '/api/admin/areas') return Promise.resolve(jsonResponse(AREAS));
    if (pathname === '/api/admin/analysts') return Promise.resolve(jsonResponse(ANALYSTS));
    if (pathname === '/api/admin/queue') return Promise.resolve(jsonResponse(QUEUE));
    if (pathname === '/api/admin/bot-flows') return Promise.resolve(jsonResponse(BOT_FLOWS));
    if (pathname === '/api/admin/reports/summary') return Promise.resolve(jsonResponse(REPORT_SUMMARY));
    if (pathname === '/api/admin/audit') {
      const filteredLogs = searchParams.get('action')
        ? AUDIT_LOGS.filter(log => log.action === searchParams.get('action'))
        : AUDIT_LOGS;
      return Promise.resolve(jsonResponse(filteredLogs));
    }

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
    window.history.replaceState(null, '', '/');
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

  it('renders the Spanish Phase 4 admin intro and switches between real admin modules', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText('Panel de administración')).toBeInTheDocument();
    expect(screen.getByText('Módulo activo')).toBeInTheDocument();
    expect(screen.getByText(/Cola híbrida con asignación manual/i)).toBeInTheDocument();
    expect(screen.getByText(/La asignación automática solo aplica a tickets con área definida/i)).toBeInTheDocument();
    expect(screen.queryByText('Tickets actuales')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /cola y sla/i }));
    expect(screen.getByText('Tickets actuales')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText(/Por vencer/i)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Asignar ticket #33')).queryByRole('option', { name: /No Area Analyst/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /reportes/i }));
    expect(screen.getByText('Resumen operativo y Salesforce')).toBeInTheDocument();
    expect(screen.getByText('Adjuntos en Salesforce')).toBeInTheDocument();
    expect(screen.getByText('Soporte técnico')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /auditoría/i }));
    expect(screen.getByText('Eventos administrativos recientes')).toBeInTheDocument();
    expect(screen.getAllByText('Ticket cerrado')).not.toHaveLength(0);
    expect(screen.getByText(/sf_case_id: 500ABC/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /flujos del bot/i }));
    expect(screen.getByText('Mapa conversacional y plantillas de WhatsApp')).toBeInTheDocument();
    expect(screen.getByText(/rail de conversación editable/i)).toBeInTheDocument();
    expect(screen.getByText(/builder visual tipo SendPulse\/n8n/i)).toBeInTheDocument();
    expect(screen.getByText('ask_name')).toBeInTheDocument();
    expect(within(screen.getByText('ask_issue').closest('article')).getByText('Billing')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /analistas/i }));
    expect(await screen.findAllByText('Billing')).not.toHaveLength(0);
    expect(screen.getAllByText('Ada Lovelace')).not.toHaveLength(0);
    expect(screen.getByText('Ada token')).toBeInTheDocument();
    expect(screen.queryByText('Admin Panel')).not.toBeInTheDocument();
    expect(screen.queryByText('Operations topology')).not.toBeInTheDocument();
  });

  it('renders a control-map navigation that selects one admin module at a time', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByText('Centro de control');

    const expectedSections = [
      ['Resumen', 'admin-resumen'],
      ['Cola y SLA', 'admin-cola-sla'],
      ['Áreas', 'admin-areas'],
      ['Analistas', 'admin-analistas'],
      ['Flujos del bot', 'admin-flujos-bot'],
      ['Salesforce/Outbox', 'admin-salesforce-outbox'],
      ['Reportes', 'admin-reportes'],
      ['Auditoría', 'admin-auditoria'],
    ];

    const navigation = screen.getByRole('navigation', { name: /secciones de administración/i });
    const buttons = within(navigation).getAllByRole('button');
    const expectedIds = expectedSections.map(([, id]) => id);

    expect(buttons.map(button => button.getAttribute('aria-controls'))).toEqual(expectedIds.map(() => null));
    expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
    expect(document.getElementById('admin-resumen')).toBeInTheDocument();

    for (const [label, id] of expectedSections) {
      const button = within(navigation).getByRole('button', { name: new RegExp(label, 'i') });
      await user.click(button);
      expect(button).toHaveAttribute('aria-current', 'page');
      expect(document.getElementById(id)).toBeInTheDocument();
      expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
    }
  });

  it('opens the matching module from a valid initial hash', async () => {
    mockAdminFetch();
    window.history.replaceState(null, '', '/admin#admin-auditoria');

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText('Eventos administrativos recientes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /auditoría/i })).toHaveAttribute('aria-current', 'page');
    expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
  });

  it('falls back safely when the initial hash is not an admin module', async () => {
    mockAdminFetch();
    window.history.replaceState(null, '', '/admin#modulo-inexistente');

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText(/Cola híbrida con asignación manual/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resumen/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('Eventos administrativos recientes')).not.toBeInTheDocument();
  });

  it('updates the active module when the location hash changes', async () => {
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    expect(await screen.findByText(/Cola híbrida con asignación manual/i)).toBeInTheDocument();

    window.history.replaceState(null, '', '/admin#admin-reportes');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(await screen.findByText('Resumen operativo y Salesforce')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reportes/i })).toHaveAttribute('aria-current', 'page');
    expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
  });

  it('updates the URL hash when a navigation module is selected', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByText('Centro de control');

    await user.click(screen.getByRole('button', { name: /flujos del bot/i }));

    expect(window.location.hash).toBe('#admin-flujos-bot');
    expect(screen.getByText('Mapa conversacional y plantillas de WhatsApp')).toBeInTheDocument();
  });

  it('filters audit history with backend-supported query parameters', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /auditoría/i }));
    await screen.findByText('Eventos administrativos recientes');
    await screen.findAllByText('Ticket cerrado');

    await user.selectOptions(screen.getByLabelText('Acción'), 'flow.cache_invalidated');
    await user.selectOptions(screen.getByLabelText('Rol'), 'admin');
    await user.type(screen.getByLabelText('ID objetivo'), 'global');
    await user.click(screen.getByRole('button', { name: /aplicar filtros/i }));

    await waitFor(() => {
      const auditRequest = fetch.mock.calls.findLast(([url]) => new URL(url, window.location.origin).pathname === '/api/admin/audit');
      const auditUrl = new URL(auditRequest[0], window.location.origin);
      expect(auditUrl.searchParams.get('action')).toBe('flow.cache_invalidated');
      expect(auditUrl.searchParams.get('actor_role')).toBe('admin');
      expect(auditUrl.searchParams.get('target_id')).toBe('global');
      expect(auditUrl.searchParams.get('limit')).toBe('10');
      expect(auditUrl.searchParams.get('offset')).toBe('0');
    });

    expect(screen.getAllByText('Caché de flujos invalidada')).not.toHaveLength(0);
  });

  it('surfaces the friendly Spanish backend connectivity error when HTML is returned', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('<!DOCTYPE html><html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })));

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findAllByText(/No se pudo conectar con la API del backend/i)).not.toHaveLength(0);
    expect(screen.getByText(/Endpoint: \/api\/admin\/areas/i)).toBeInTheDocument();
  });

  it('sends JSON bodies with Content-Type for create, update, and availability toggle calls', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /áreas/i }));
    await screen.findAllByText('Billing');

    await user.type(screen.getByLabelText('Nombre'), 'Integrations');
    await user.click(screen.getByRole('button', { name: /crear área/i }));

    await waitFor(() => expect(requestFor('POST', '/api/admin/areas')).toBeTruthy());
    const createAreaRequest = requestFor('POST', '/api/admin/areas');
    expect(createAreaRequest.headers.get('Content-Type')).toBe('application/json');
    expect(createAreaRequest.headers.get('Authorization')).toBe('Bearer admin-token');
    expect(JSON.parse(createAreaRequest.body)).toMatchObject({ name: 'Integrations', sla_minutes: 30 });

    await user.click(within(screen.getByText('Payments help').closest('article')).getByRole('button', { name: 'Editar' }));
    await user.click(screen.getByRole('button', { name: /actualizar área/i }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/areas/1')).toBeTruthy());
    const updateAreaRequest = requestFor('PATCH', '/api/admin/areas/1');
    expect(updateAreaRequest.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(updateAreaRequest.body)).toMatchObject({ name: 'Billing', sla_minutes: 15 });

    await user.click(screen.getByRole('button', { name: /analistas/i }));
    await screen.findAllByText('Ada Lovelace');
    await user.click(screen.getByRole('button', { name: 'Habilitar' }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/analysts/2')).toBeTruthy());
    const toggleRequest = requestFor('PATCH', '/api/admin/analysts/2');
    expect(toggleRequest.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(toggleRequest.body)).toEqual({ available: true });
  });

  it('creates, edits, toggles, and invalidates bot flow steps from the admin manager', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /flujos del bot/i }));
    await screen.findByText('Mapa conversacional y plantillas de WhatsApp');

    fireEvent.change(screen.getByLabelText('Clave del paso'), { target: { value: 'confirmation' } });
    fireEvent.change(screen.getByLabelText('Mensaje'), { target: { value: 'Solicitud recibida' } });
    await user.click(screen.getByRole('button', { name: /crear paso/i }));

    await waitFor(() => expect(requestFor('POST', '/api/admin/bot-flows')).toBeTruthy());
    const createFlowRequest = requestFor('POST', '/api/admin/bot-flows');
    expect(createFlowRequest.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(createFlowRequest.body)).toMatchObject({
      version_id: 1,
      area_id: null,
      step_key: 'confirmation',
      message: 'Solicitud recibida',
      sort_order: 0,
      active: true,
    });

    await user.click(within(screen.getByText('ask_name').closest('article')).getByRole('button', { name: 'Editar' }));
    await user.click(screen.getByRole('button', { name: /actualizar paso/i }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/bot-flows/5')).toBeTruthy());
    expect(JSON.parse(requestFor('PATCH', '/api/admin/bot-flows/5').body)).toMatchObject({ step_key: 'ask_name' });

    await user.click(within(screen.getByText('ask_issue').closest('article')).getByRole('button', { name: 'Activar' }));

    await waitFor(() => expect(requestFor('POST', '/api/admin/bot-flows/6/toggle')).toBeTruthy());
    expect(JSON.parse(requestFor('POST', '/api/admin/bot-flows/6/toggle').body)).toEqual({ active: true });

    await user.click(screen.getByRole('button', { name: /invalidar caché/i }));

    await waitFor(() => expect(requestFor('POST', '/api/admin/bot-flows/cache/invalidate')).toBeTruthy());
  });

  it('cleans up polling and socket listeners on unmount', async () => {
    const socket = { connected: true, on: vi.fn(), off: vi.fn() };
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    mockAdminFetch();

    const { unmount } = render(<AdminPanel socket={socket} onLogout={vi.fn()} />);
    await screen.findByText('Panel de administración');

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(socket.off).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('analyst-presence', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('analyst-updated', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('ticket-assigned', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('queue-updated', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('sla-alert', expect.any(Function));
  });
});

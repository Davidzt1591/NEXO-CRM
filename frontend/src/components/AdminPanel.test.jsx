// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPanel from './AdminPanel';
import AgentTokenManagement from './AgentTokenManagement';
import { AUTH_INVALIDATED_EVENT } from '../lib/authSession';

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

const AGENT_TOKENS = [
  { id: 9, name: 'Token activo de Ada', role: 'agent', active: true, created_at: '2026-07-20T10:00:00.000Z' },
  { id: 10, name: 'Token revocado', role: 'agent', active: false, created_at: '2026-07-19T10:00:00.000Z' },
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
    { id: 7, version_id: 1, area_id: 1, step_key: 'ask_name', message: 'Indica el contacto de facturación', sort_order: 10, active: true },
  ],
  cache: [{ key: 'global', area_id: null, source: 'database', version_id: 1, age_ms: 100, expires_in_ms: 59000 }],
};

const FLOW_DEFINITION = {
  definition: {
    label: 'Soporte de integraciones',
    nodes: [{ node_id: 'capture-name', label: 'Capturar nombre', runtime_type: 'capture', message_key: 'ask_name', message: 'Por favor indica tu nombre', inputs: ['nombre'], branches: [], next: null }],
  },
  message_source: 'database',
  version_id: 1,
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

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
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

    if (pathname === '/api/admin/candidate-settings' && options.method === 'PUT') {
      return Promise.resolve(jsonResponse(JSON.parse(options.body)));
    }

    if (pathname === '/api/admin/areas') return Promise.resolve(jsonResponse(AREAS));
    if (pathname === '/api/admin/analysts') return Promise.resolve(jsonResponse(ANALYSTS));
    if (pathname === '/api/admin/agent-tokens') return Promise.resolve(jsonResponse({ tokens: AGENT_TOKENS }));
    if (pathname === '/api/admin/queue') return Promise.resolve(jsonResponse(QUEUE));
    if (pathname === '/api/admin/bot-flows') return Promise.resolve(jsonResponse(BOT_FLOWS));
    if (pathname === '/api/admin/bot-flow-studio/definition') return Promise.resolve(jsonResponse(FLOW_DEFINITION));
    if (pathname === '/api/admin/bot-flow-studio/layout') return Promise.resolve(jsonResponse({ revision: 0, layout: { schema_version: 1, nodes: [], edges: [] } }));
    if (pathname === '/api/admin/reports/summary') return Promise.resolve(jsonResponse(REPORT_SUMMARY));
    if (pathname === '/api/admin/candidates') return Promise.resolve(jsonResponse({ candidates: [{ chat_id: '573001234567@c.us', source: 'manual', marked_at: '2026-07-16T12:00:00Z' }] }));
    if (pathname === '/api/admin/candidate-settings') return Promise.resolve(jsonResponse({ formUrl: 'https://example.com/form', message: 'Usa el formulario oficial.' }));
    if (pathname === '/api/admin/audit') {
      const filteredLogs = searchParams.get('action')
        ? AUDIT_LOGS.filter(log => log.action === searchParams.get('action'))
        : AUDIT_LOGS;
      return Promise.resolve(jsonResponse(filteredLogs));
    }

    return Promise.resolve(jsonResponse({ error: 'Not found' }, { status: 404 }));
  });
}

const OPERATIONAL_PATHS = [
  '/api/admin/areas',
  '/api/admin/analysts',
  '/api/admin/queue',
  '/api/admin/reports/summary',
  '/api/admin/candidates',
  '/api/admin/candidate-settings',
];

function operationalState(overrides = {}) {
  return {
    '/api/admin/areas': AREAS,
    '/api/admin/analysts': ANALYSTS,
    '/api/admin/queue': QUEUE,
    '/api/admin/reports/summary': REPORT_SUMMARY,
    '/api/admin/candidates': { candidates: [] },
    '/api/admin/candidate-settings': { formUrl: 'https://initial.example/form', message: 'Initial message' },
    ...overrides,
  };
}

function mockOperationalMutationRace({ staleOverrides = {}, onMutation }) {
  const current = operationalState();
  const stale = operationalState(staleOverrides);
  const delayed = new Map(OPERATIONAL_PATHS.map(path => [path, deferred()]));
  const counts = new Map();

  globalThis.fetch = vi.fn((url, options = {}) => {
    const { pathname } = new URL(url, window.location.origin);
    const method = options.method || 'GET';
    if (method !== 'GET') {
      const result = onMutation?.({ pathname, method, body: options.body ? JSON.parse(options.body) : {}, current });
      if (result) return Promise.resolve(jsonResponse(result));
    }
    if (pathname === '/api/admin/bot-flows') return Promise.resolve(jsonResponse(BOT_FLOWS));
    if (pathname === '/api/admin/audit') return Promise.resolve(jsonResponse(AUDIT_LOGS));
    if (OPERATIONAL_PATHS.includes(pathname)) {
      const count = (counts.get(pathname) || 0) + 1;
      counts.set(pathname, count);
      if (count === 2) return delayed.get(pathname).promise;
      return Promise.resolve(jsonResponse(current[pathname]));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });

  return {
    counts,
    async resolveStale() {
      await act(async () => {
        for (const path of OPERATIONAL_PATHS) delayed.get(path).resolve(jsonResponse(stale[path]));
        await Promise.all([...delayed.values()].map(item => item.promise));
      });
      await waitFor(() => expect(OPERATIONAL_PATHS.every(path => counts.get(path) === 3)).toBe(true));
    },
  };
}

async function startDelayedOperationalRefresh(user) {
  await screen.findByText('Panel de administración');
  await user.click(screen.getByRole('button', { name: /actualizar/i }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => OPERATIONAL_PATHS.includes(new URL(url, location.origin).pathname))).toHaveLength(12));
}

function requestFor(method, path) {
  return fetch.mock.calls.find(([url, options = {}]) => {
    const { pathname } = new URL(url, window.location.origin);
    return pathname === path && options.method === method;
  })?.[1];
}

async function selectAdminModule(user, name) {
  const moduleButton = screen.queryByRole('button', { name });
  if (moduleButton) {
    fireEvent.click(moduleButton);
    return;
  }
  await user.click(screen.getByRole('button', { name: /abrir comandos/i }));
  fireEvent.click(screen.getByRole('button', { name }));
}

const ADMIN_MODULES = [
  ['Resumen', 'admin-resumen'],
  ['Cola y SLA', 'admin-cola-sla'],
  ['SLA y Escalamientos', 'admin-sla-escalamientos'],
  ['Áreas', 'admin-areas'],
  ['Analistas', 'admin-analistas'],
  ['Candidatos', 'admin-candidatos'],
  ['Flujos del bot', 'admin-flujos-bot'],
  ['Salesforce/Outbox', 'admin-salesforce-outbox'],
  ['Reportes', 'admin-reportes'],
  ['Auditoría', 'admin-auditoria'],
];

describe('AgentTokenManagement', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('discards a revealed token on direct unmount and removes the exact auth listener', async () => {
    const user = userEvent.setup();
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    globalThis.fetch = vi.fn((url, options = {}) => options.method === 'POST'
      ? Promise.resolve(jsonResponse({ token: 'nexo_tkn_unmount_only', metadata: { id: 13, name: 'Temporal', role: 'agent', active: true } }, { status: 201 }))
      : Promise.resolve(jsonResponse({ tokens: [] })));

    const view = render(<AgentTokenManagement onInventoryChange={vi.fn()} />);
    await screen.findByText(/aún no hay tokens de agentes/i);
    await user.type(screen.getByLabelText('Nombre del nuevo token'), 'Temporal');
    await user.click(screen.getByRole('button', { name: 'Crear token de agente' }));
    expect(await screen.findByText('nexo_tkn_unmount_only')).toBeInTheDocument();

    const authListener = addListener.mock.calls.find(([eventName]) => eventName === AUTH_INVALIDATED_EVENT)?.[1];
    expect(authListener).toEqual(expect.any(Function));
    view.unmount();
    expect(removeListener).toHaveBeenCalledWith(AUTH_INVALIDATED_EVENT, authListener);

    render(<AgentTokenManagement onInventoryChange={vi.fn()} />);
    await screen.findByText(/aún no hay tokens de agentes/i);
    expect(screen.queryByText('nexo_tkn_unmount_only')).not.toBeInTheDocument();
  });

  it('warns about clipboard retention and gives the copy control an accessible description', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn((url, options = {}) => options.method === 'POST'
      ? Promise.resolve(jsonResponse({ token: 'nexo_tkn_clipboard_only', metadata: { id: 14, name: 'Portapapeles', role: 'agent', active: true } }, { status: 201 }))
      : Promise.resolve(jsonResponse({ tokens: [] })));
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<AgentTokenManagement onInventoryChange={vi.fn()} />);
    await screen.findByText(/aún no hay tokens de agentes/i);
    await user.type(screen.getByLabelText('Nombre del nuevo token'), 'Portapapeles');
    await user.click(screen.getByRole('button', { name: 'Crear token de agente' }));
    const copyButton = await screen.findByRole('button', { name: 'Copiar token' });
    expect(copyButton).toHaveAccessibleDescription(/el sistema operativo o el gestor del portapapeles puede conservar el token/i);
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith('nexo_tkn_clipboard_only');
    expect(screen.getByRole('status')).toHaveTextContent('Token copiado al portapapeles.');
    expect(screen.getByText(/NEXO no puede eliminarlo del portapapeles/i)).toBeInTheDocument();
  });

  it('announces loading and inventory errors without exposing inventory content', async () => {
    const pendingInventory = deferred();
    globalThis.fetch = vi.fn(() => pendingInventory.promise);
    const view = render(<AgentTokenManagement onInventoryChange={vi.fn()} />);
    expect(screen.getByText('Cargando tokens de agentes…')).toHaveAttribute('role', 'status');
    view.unmount();

    globalThis.fetch = vi.fn(() => Promise.reject(new Error('upstream inventory detail')));
    render(<AgentTokenManagement onInventoryChange={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar el inventario de tokens.');
    expect(screen.queryByText('upstream inventory detail')).not.toBeInTheDocument();
  });
});

describe('AdminPanel', () => {
  beforeEach(() => {
    mockLocalStorage();
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

    await selectAdminModule(user, /cola y sla/i);
    expect(screen.getByText('Tickets actuales')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText(/Por vencer/i)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Asignar ticket #33')).queryByRole('option', { name: /No Area Analyst/i })).not.toBeInTheDocument();

    await selectAdminModule(user, /reportes/i);
    expect(screen.getByText('Resumen operativo y Salesforce')).toBeInTheDocument();
    expect(screen.getByText('Adjuntos en Salesforce')).toBeInTheDocument();
    expect(screen.getByText('Soporte técnico')).toBeInTheDocument();

    await selectAdminModule(user, /auditoría/i);
    expect(screen.getByText('Eventos administrativos recientes')).toBeInTheDocument();
    expect(screen.getAllByText('Ticket cerrado')).not.toHaveLength(0);
    expect(screen.getByText(/sf_case_id: 500ABC/i)).toBeInTheDocument();

    await selectAdminModule(user, /analistas/i);
    expect(await screen.findAllByText('Billing')).not.toHaveLength(0);
    expect(screen.getAllByText('Ada Lovelace')).not.toHaveLength(0);
    expect(screen.getByText('Ada token')).toBeInTheDocument();
    expect(screen.queryByText('Admin Panel')).not.toBeInTheDocument();
    expect(screen.queryByText('Operations topology')).not.toBeInTheDocument();
  });

  it('activates the Studio module without waiting for Studio internals', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByText('Panel de administración');
    await selectAdminModule(user, /flujos del bot/i);

    await waitFor(() => expect(screen.getByRole('button', { name: /abrir comandos/i })).toHaveAttribute('data-active-module', 'admin-flujos-bot'));
    const studioModule = document.getElementById('admin-flujos-bot');
    expect(studioModule).toBeInTheDocument();
    expect(within(studioModule).getByRole('heading', { name: 'Mapa de la conversación de soporte' })).toBeInTheDocument();
  });

  it('uses the selected area and version for Studio definition, selection, and save', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByText('Panel de administración');
    await selectAdminModule(user, /flujos del bot/i);
    await screen.findByRole('heading', { name: 'Mapa de la conversación de soporte' });
    await user.selectOptions(screen.getByLabelText('Área del flujo'), '1');
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => {
      const parsed = new URL(url, location.origin);
      return parsed.pathname === '/api/admin/bot-flow-studio/definition' && parsed.searchParams.get('area_id') === '1' && parsed.searchParams.get('version_id') === '1';
    })).toBe(true));
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    const inspector = screen.getByLabelText('Inspector del bloque seleccionado');
    expect(within(inspector).getByLabelText('Mensaje del bot')).toHaveValue('Indica el contacto de facturación');
    fireEvent.change(within(inspector).getByLabelText('Mensaje del bot'), { target: { value: 'Nuevo mensaje de facturación' } });
    await user.click(within(inspector).getByRole('button', { name: /guardar solo el mensaje/i }));
    await waitFor(() => expect(requestFor('PATCH', '/api/admin/bot-flows/7')).toBeTruthy());
    expect(JSON.parse(requestFor('PATCH', '/api/admin/bot-flows/7').body)).toEqual(expect.objectContaining({ version_id: 1, area_id: 1, step_key: 'ask_name' }));
  });

  it('guards scope changes when the Studio draft has unsaved work', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByText('Panel de administración');
    await selectAdminModule(user, /flujos del bot/i);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    expect(screen.getAllByText('Borrador local sin guardar — no afecta WhatsApp activo').length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByLabelText('Área del flujo'), '1');
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('Área del flujo')).toHaveValue('');
    expect(screen.getByText('Bloque en preparación')).toBeInTheDocument();
  });

  it('renders the complete control-map navigation with one active module', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /abrir comandos/i }));

    const navigation = screen.getByRole('navigation', { name: /secciones de administración/i });
    const buttons = within(navigation).getAllByRole('button');

    expect(buttons).toHaveLength(ADMIN_MODULES.length);
    for (const [label] of ADMIN_MODULES) {
      expect(within(navigation).getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
    expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
    expect(document.getElementById('admin-resumen')).toBeInTheDocument();
  });

  it.each(ADMIN_MODULES.slice(1))('selects the %s module from the control map', async (label, id) => {
    const user = userEvent.setup();
    if (id === 'admin-sla-escalamientos') await import('../features/admin-sla/SlaAdministration');
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /abrir comandos/i }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }));

    await waitFor(() => expect(document.getElementById(id)).toBeInTheDocument());
    expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
  });

  it('shows candidate classifications and saves bounded guidance settings', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByText('Panel de administración');
    await selectAdminModule(user, /candidatos/i);
    expect(screen.getByText('573001234567@c.us')).toBeInTheDocument();
    expect(screen.getByText(/WhatsApp continúa recibiendo/i)).toBeInTheDocument();
    const url = screen.getByLabelText(/Enlace del formulario para candidatos/i);
    expect(screen.getByText(/se envían de inmediato cuando el contacto es marcado o identificado/i)).toBeInTheDocument();
    expect(screen.getByText(/cuando vuelva a escribir, siempre que haya terminado el tiempo de espera/i)).toBeInTheDocument();
    expect(screen.getByText(/Si dejás el enlace vacío, se envía solo el mensaje/i)).toBeInTheDocument();
    expect(screen.getByText(/NEXO usa la orientación segura predeterminada/i)).toBeInTheDocument();
    expect(screen.getByText(/Studio > Salida de candidato/i)).toBeInTheDocument();
    expect(screen.queryByText(/URL HTTPS/i)).not.toBeInTheDocument();
    await user.clear(url);
    await user.type(url, 'https://careers.example.com/help');
    await user.click(screen.getByRole('button', { name: /guardar orientación/i }));
    await waitFor(() => expect(requestFor('PUT', '/api/admin/candidate-settings')).toBeTruthy());
    expect(JSON.parse(requestFor('PUT', '/api/admin/candidate-settings').body).formUrl).toBe('https://careers.example.com/help');
  });

  it('opens the matching module from a valid initial hash', async () => {
    mockAdminFetch();
    window.history.replaceState(null, '', '/admin#admin-auditoria');

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText('Eventos administrativos recientes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /abrir comandos/i })).toHaveAttribute('data-active-module', 'admin-auditoria');
    expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
  });

  it('falls back safely when the initial hash is not an admin module', async () => {
    mockAdminFetch();
    window.history.replaceState(null, '', '/admin#modulo-inexistente');

    render(<AdminPanel onLogout={vi.fn()} />);

    expect(await screen.findByText(/Cola híbrida con asignación manual/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /abrir comandos/i })).toHaveAttribute('data-active-module', 'admin-resumen');
    expect(screen.queryByText('Eventos administrativos recientes')).not.toBeInTheDocument();
  });

  it('updates the active module when the location hash changes', async () => {
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    expect(await screen.findByText(/Cola híbrida con asignación manual/i)).toBeInTheDocument();

    window.history.replaceState(null, '', '/admin#admin-reportes');
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    expect(await screen.findByText('Resumen operativo y Salesforce')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /abrir comandos/i })).toHaveAttribute('data-active-module', 'admin-reportes');
    expect(document.querySelectorAll('.admin-section-anchor')).toHaveLength(1);
  });

  it('updates the URL hash when a navigation module is selected', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await screen.findByRole('button', { name: /abrir comandos/i });

    await selectAdminModule(user, /flujos del bot/i);

    expect(window.location.hash).toBe('#admin-flujos-bot');
    expect(screen.getByText('Mapa de la conversación de soporte')).toBeInTheDocument();
  });

  it('filters audit history with backend-supported query parameters', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /auditoría/i);
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

  it('clears only a current AUTH_UNAVAILABLE outage after socket refresh and ignores a stale failure', async () => {
    const listeners = new Map();
    const socket = { connected: false, on: vi.fn((event, handler) => listeners.set(event, handler)), off: vi.fn() };
    let outage = true;
    const late = deferred();
    let lateAreas = false;
    mockAdminFetch();
    const healthyFetch = fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      const path = new URL(url, window.location.origin).pathname;
      if (lateAreas && path === '/api/admin/areas') return late.promise;
      if (outage && path !== '/api/admin/audit') return Promise.resolve(jsonResponse({ code: 'AUTH_UNAVAILABLE', error: 'Validación temporalmente no disponible.' }, { status: 503 }));
      return healthyFetch(url, options);
    });

    render(<AdminPanel socket={socket} onLogout={vi.fn()} />);
    expect(await screen.findByText(/autenticación administrativa no está disponible/i)).toBeInTheDocument();

    outage = false;
    listeners.get('connect')();
    await waitFor(() => expect(screen.queryByText(/autenticación administrativa no está disponible/i)).not.toBeInTheDocument());

    lateAreas = true;
    listeners.get('connect')();
    lateAreas = false;
    listeners.get('connect')();
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => new URL(url, location.origin).pathname === '/api/admin/areas').length).toBeGreaterThanOrEqual(3));
    late.resolve(jsonResponse({ code: 'AUTH_UNAVAILABLE', error: 'Falla anterior.' }, { status: 503 }));
    await late.promise;
    await act(async () => {});
    expect(screen.queryByText(/autenticación administrativa no está disponible/i)).not.toBeInTheDocument();
  });

  it('does not clear an unrelated admin error after a successful authenticated refresh', async () => {
    const listeners = new Map();
    const socket = { connected: true, on: vi.fn((event, handler) => listeners.set(event, handler)), off: vi.fn() };
    let failNextFlow = false;
    mockAdminFetch();
    const healthyFetch = fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      const path = new URL(url, window.location.origin).pathname;
      if (failNextFlow && path === '/api/admin/bot-flows') { failNextFlow = false; return Promise.resolve(jsonResponse({ code: 'FLOW_UNAVAILABLE', error: 'No se pudieron leer los flujos.' }, { status: 500 })); }
      return healthyFetch(url, options);
    });
    render(<AdminPanel socket={socket} onLogout={vi.fn()} />);
    await screen.findByText('Panel de administración');
    failNextFlow = true;
    listeners.get('bot-flow-updated')();
    expect(await screen.findByText('No se pudieron leer los flujos.')).toBeInTheDocument();
    listeners.get('connect')();
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => new URL(url, location.origin).pathname === '/api/admin/queue').length).toBeGreaterThan(1));
    expect(screen.getByText('No se pudieron leer los flujos.')).toBeInTheDocument();
  });

  it('sends JSON bodies with Content-Type for create, update, and availability toggle calls', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /áreas/i);
    await screen.findAllByText('Billing');

    await user.type(screen.getByLabelText('Nombre'), 'Integrations');
    await user.click(screen.getByRole('button', { name: /crear área/i }));

    await waitFor(() => expect(requestFor('POST', '/api/admin/areas')).toBeTruthy());
    const createAreaRequest = requestFor('POST', '/api/admin/areas');
    expect(createAreaRequest.headers.get('Content-Type')).toBe('application/json');
    expect(createAreaRequest.headers.get('Authorization')).toBeNull();
    expect(JSON.parse(createAreaRequest.body)).toMatchObject({ name: 'Integrations', sla_minutes: 30 });

    await user.click(within(screen.getByText('Payments help').closest('article')).getByRole('button', { name: 'Editar' }));
    await user.click(screen.getByRole('button', { name: /actualizar área/i }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/areas/1')).toBeTruthy());
    const updateAreaRequest = requestFor('PATCH', '/api/admin/areas/1');
    expect(updateAreaRequest.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(updateAreaRequest.body)).toMatchObject({ name: 'Billing', sla_minutes: 15 });

    await selectAdminModule(user, /analistas/i);
    await screen.findAllByText('Ada Lovelace');
    await user.click(screen.getByRole('button', { name: 'Habilitar' }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/analysts/2')).toBeTruthy());
    const toggleRequest = requestFor('PATCH', '/api/admin/analysts/2');
    expect(toggleRequest.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(toggleRequest.body)).toEqual({ available: true });
  });

  it('shows professional token inventory and replaces manual token ID with an active-only selector', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    render(<AdminPanel onLogout={vi.fn()} />);

    await selectAdminModule(user, /analistas/i);
    expect(await screen.findByRole('heading', { name: 'Credenciales de agentes' })).toBeInTheDocument();
    expect(screen.getByText('Token activo de Ada')).toBeInTheDocument();
    expect(screen.getByText('Token revocado')).toBeInTheDocument();
    expect(screen.queryByLabelText(/id del token/i)).not.toBeInTheDocument();
    const selector = screen.getByLabelText('Token activo del agente');
    expect(within(selector).getByRole('option', { name: /token activo de ada.*activo/i })).toHaveValue('9');
    expect(within(selector).queryByRole('option', { name: /token revocado/i })).not.toBeInTheDocument();
  });

  it('explains the empty active-token state and prevents analyst submission without a selection', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    const originalFetch = fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      if (new URL(url, location.origin).pathname === '/api/admin/agent-tokens' && (!options.method || options.method === 'GET')) {
        return Promise.resolve(jsonResponse({ tokens: [{ ...AGENT_TOKENS[1] }] }));
      }
      return originalFetch(url, options);
    });
    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /analistas/i);

    expect(await screen.findByText('Crea un token activo antes de vincular un analista.')).toBeInTheDocument();
    expect(screen.getByLabelText('Token activo del agente')).toBeDisabled();
  });

  it('reveals a new token once, copies explicitly, and clears it on dismiss and auth invalidation', async () => {
    const user = userEvent.setup();
    const storage = mockLocalStorage();
    mockAdminFetch();
    const originalFetch = fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path === '/api/admin/agent-tokens' && options.method === 'POST') {
        return Promise.resolve(jsonResponse({ token: 'nexo_tkn_one_time', metadata: { id: 11, name: 'Integraciones', role: 'agent', active: true } }, { status: 201 }));
      }
      return originalFetch(url, options);
    });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /analistas/i);

    await user.type(screen.getByLabelText('Nombre del nuevo token'), 'Integraciones');
    await user.click(screen.getByRole('button', { name: 'Crear token de agente' }));
    expect(await screen.findByText('nexo_tkn_one_time')).toBeInTheDocument();
    expect(storage.setItem).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Copiar token' }));
    expect(writeText).toHaveBeenCalledWith('nexo_tkn_one_time');
    await user.click(screen.getByRole('button', { name: 'Ocultar token' }));
    expect(screen.queryByText('nexo_tkn_one_time')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Nombre del nuevo token'), 'Integraciones 2');
    await user.click(screen.getByRole('button', { name: 'Crear token de agente' }));
    expect(await screen.findByText('nexo_tkn_one_time')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(AUTH_INVALIDATED_EVENT, { detail: { code: 'AUTH_REVOKED' } }));
    });
    expect(screen.queryByText('nexo_tkn_one_time')).not.toBeInTheDocument();
  });

  it('clears one-time reveal on module exit and never restores it on return', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    const originalFetch = fetch;
    globalThis.fetch = vi.fn((url, options = {}) => new URL(url, location.origin).pathname === '/api/admin/agent-tokens' && options.method === 'POST'
      ? Promise.resolve(jsonResponse({ token: 'nexo_tkn_module_exit', metadata: { id: 12, name: 'Temporal', role: 'agent', active: true } }, { status: 201 }))
      : originalFetch(url, options));
    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /analistas/i);
    await user.type(screen.getByLabelText('Nombre del nuevo token'), 'Temporal');
    await user.click(screen.getByRole('button', { name: 'Crear token de agente' }));
    expect(await screen.findByText('nexo_tkn_module_exit')).toBeInTheDocument();
    await selectAdminModule(user, /áreas/i);
    expect(screen.queryByText('nexo_tkn_module_exit')).not.toBeInTheDocument();
    await selectAdminModule(user, /analistas/i);
    expect(screen.queryByText('nexo_tkn_module_exit')).not.toBeInTheDocument();
  });

  it('confirms revocation, announces status, and removes revoked credentials from analyst selection', async () => {
    const user = userEvent.setup();
    let tokens = [...AGENT_TOKENS];
    mockAdminFetch();
    const originalFetch = fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path === '/api/admin/agent-tokens' && (!options.method || options.method === 'GET')) return Promise.resolve(jsonResponse({ tokens }));
      if (path === '/api/admin/agent-tokens/9/revoke' && options.method === 'POST') {
        tokens = tokens.map(token => token.id === 9 ? { ...token, active: false } : token);
        return Promise.resolve(jsonResponse({ outcome: 'revoked', metadata: tokens[0] }));
      }
      return originalFetch(url, options);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /analistas/i);
    await screen.findByText('Token activo de Ada');
    await user.click(screen.getByRole('button', { name: 'Revocar Token activo de Ada' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Token revocado correctamente.');
    expect(screen.getByLabelText('Token activo del agente')).toBeDisabled();
  });

  it('edits a bot flow message and invalidates cache from Studio', async () => {
    const user = userEvent.setup();
    mockAdminFetch();

    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /flujos del bot/i);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Indica tu nombre completo' } });
    await user.click(screen.getByRole('button', { name: /guardar solo el mensaje/i }));

    await waitFor(() => expect(requestFor('PATCH', '/api/admin/bot-flows/5')).toBeTruthy());
    expect(JSON.parse(requestFor('PATCH', '/api/admin/bot-flows/5').body)).toMatchObject({ step_key: 'ask_name', message: 'Indica tu nombre completo' });

    expect(screen.getByText(/no publica ni aplica el borrador visual/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /actualizar mensajes activos/i }));

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
    expect(socket.off).toHaveBeenCalledWith('bot-flow-updated', expect.any(Function));
    expect(socket.off).toHaveBeenCalledWith('bot-flow-cache-invalidated', expect.any(Function));
  });

  it('does not reload bot flows for operational socket refreshes', async () => {
    const listeners = new Map();
    const socket = { connected: true, on: vi.fn((event, handler) => listeners.set(event, handler)), off: vi.fn() };
    mockAdminFetch();
    render(<AdminPanel socket={socket} onLogout={vi.fn()} />);
    await screen.findByText('Panel de administración');
    const flowRequests = () => fetch.mock.calls.filter(([url]) => new URL(url, location.origin).pathname === '/api/admin/bot-flows').length;
    const before = flowRequests();
    listeners.get('queue-updated')();
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => new URL(url, location.origin).pathname === '/api/admin/queue').length).toBeGreaterThan(1));
    expect(flowRequests()).toBe(before);
    listeners.get('bot-flow-updated')();
    await waitFor(() => expect(flowRequests()).toBe(before + 1));
  });

  it('keeps a saved bot flow when an older refresh resolves and accepts the next fresh refresh', async () => {
    const user = userEvent.setup();
    const listeners = new Map();
    const socket = { connected: true, on: vi.fn((event, handler) => listeners.set(event, handler)), off: vi.fn() };
    const staleRefresh = deferred();
    const freshRefresh = deferred();
    let flowGetCount = 0;

    mockAdminFetch();
    const defaultFetch = fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      const { pathname } = new URL(url, window.location.origin);
      if (pathname === '/api/admin/bot-flows' && (!options.method || options.method === 'GET')) {
        flowGetCount += 1;
        if (flowGetCount === 2) return staleRefresh.promise;
        if (flowGetCount === 3) return freshRefresh.promise;
      }
      if (pathname === '/api/admin/bot-flows/5' && options.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...BOT_FLOWS.flows[0], message: 'Guardado nuevo' }));
      }
      return defaultFetch(url, options);
    });

    render(<AdminPanel socket={socket} onLogout={vi.fn()} />);
    await selectAdminModule(user, /flujos del bot/i);
    await screen.findByText('Soporte de integraciones');
    listeners.get('bot-flow-updated')();
    await waitFor(() => expect(flowGetCount).toBe(2));

    fireEvent.click(screen.getByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Guardado nuevo' } });
    await user.click(screen.getByRole('button', { name: /guardar solo el mensaje/i }));
    await waitFor(() => expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Guardado nuevo'));
    await waitFor(() => expect(flowGetCount).toBe(3));

    staleRefresh.resolve(jsonResponse(BOT_FLOWS));
    await staleRefresh.promise;
    expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Guardado nuevo');

    freshRefresh.resolve(jsonResponse({
      ...BOT_FLOWS,
      flows: BOT_FLOWS.flows.map(flow => flow.id === 5 ? { ...flow, message: 'Actualización fresca' } : flow),
    }));
    await waitFor(() => expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Actualización fresca'));
  });

  it('applies only the trailing operational refresh across areas, analysts, queue, reports, candidates, and settings', async () => {
    const user = userEvent.setup();
    const listeners = new Map();
    const socket = { connected: true, on: vi.fn((event, handler) => listeners.set(event, handler)), off: vi.fn() };
    const paths = ['/api/admin/areas', '/api/admin/analysts', '/api/admin/queue', '/api/admin/reports/summary', '/api/admin/candidates', '/api/admin/candidate-settings'];
    const counts = new Map();
    const stale = new Map(paths.map(path => [path, deferred()]));
    const fresh = {
      '/api/admin/areas': [{ ...AREAS[0], name: 'Fresh Area' }],
      '/api/admin/analysts': [{ ...ANALYSTS[0], display_name: 'Fresh Analyst', available: true }],
      '/api/admin/queue': { tickets: [{ ...QUEUE.tickets[0], nombre_empresa: 'Fresh Queue' }] },
      '/api/admin/reports/summary': { ...REPORT_SUMMARY, total_tickets: 987 },
      '/api/admin/candidates': { candidates: [{ chat_id: 'fresh-candidate@c.us', source: 'manual' }] },
      '/api/admin/candidate-settings': { formUrl: 'https://fresh.example/form', message: 'Fresh candidate message' },
    };
    globalThis.fetch = vi.fn((url) => {
      const { pathname } = new URL(url, window.location.origin);
      if (pathname === '/api/admin/bot-flows') return Promise.resolve(jsonResponse(BOT_FLOWS));
      if (pathname === '/api/admin/audit') return Promise.resolve(jsonResponse(AUDIT_LOGS));
      const count = (counts.get(pathname) || 0) + 1;
      counts.set(pathname, count);
      if (count === 1) return Promise.resolve(jsonResponse(fresh[pathname]));
      if (count === 2) return stale.get(pathname).promise;
      return Promise.resolve(jsonResponse(fresh[pathname]));
    });

    render(<AdminPanel socket={socket} onLogout={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /actualizar/i })).toBeEnabled());
    act(() => {
      listeners.get('queue-updated')();
      listeners.get('analyst-updated')();
    });
    await act(async () => {
      stale.get('/api/admin/areas').resolve(jsonResponse([{ ...AREAS[0], name: 'Stale Area' }]));
      stale.get('/api/admin/analysts').resolve(jsonResponse([{ ...ANALYSTS[0], display_name: 'Stale Analyst' }]));
      stale.get('/api/admin/queue').resolve(jsonResponse({ tickets: [{ ...QUEUE.tickets[0], nombre_empresa: 'Stale Queue' }] }));
      stale.get('/api/admin/reports/summary').resolve(jsonResponse({ ...REPORT_SUMMARY, total_tickets: 111 }));
      stale.get('/api/admin/candidates').resolve(jsonResponse({ candidates: [{ chat_id: 'stale-candidate@c.us' }] }));
      stale.get('/api/admin/candidate-settings').resolve(jsonResponse({ formUrl: 'https://stale.example/form', message: 'Stale candidate message' }));
      await Promise.all([...stale.values()].map(item => item.promise));
    });

    await waitFor(() => expect(counts.get('/api/admin/areas')).toBe(3));
    expect([...counts.values()]).toEqual(expect.arrayContaining([3, 3, 3, 3, 3, 3]));
    expect(screen.queryByText(/Stale Area|Stale Analyst|Stale Queue|Stale candidate message/)).not.toBeInTheDocument();
    await selectAdminModule(user, /áreas/i);
    expect(screen.getByText('Fresh Area')).toBeInTheDocument();
    await selectAdminModule(user, /analistas/i);
    expect(screen.getByText('Fresh Analyst')).toBeInTheDocument();

    await selectAdminModule(user, /cola y sla/i);
    expect(screen.getByText('Fresh Queue')).toBeInTheDocument();
    await selectAdminModule(user, /reportes/i);
    expect(screen.getByText('987')).toBeInTheDocument();
    await selectAdminModule(user, /candidatos/i);
    expect(screen.getByDisplayValue('Fresh candidate message')).toBeInTheDocument();
    expect(screen.getByText(/fresh-candidate/)).toBeInTheDocument();
  });

  it('keeps an area update ahead of a delayed stale refresh and applies one trailing refresh', async () => {
    const user = userEvent.setup();
    const race = mockOperationalMutationRace({
      staleOverrides: { '/api/admin/areas': [{ ...AREAS[0], name: 'Stale Area' }] },
      onMutation: ({ pathname, method, body, current }) => {
        if (pathname !== '/api/admin/areas/1' || method !== 'PATCH') return null;
        current['/api/admin/areas'] = [{ ...AREAS[0], ...body, name: 'Fresh Area' }];
        return current['/api/admin/areas'][0];
      },
    });
    render(<AdminPanel onLogout={vi.fn()} />);
    await startDelayedOperationalRefresh(user);
    await selectAdminModule(user, /áreas/i);
    await user.click(within(screen.getByText('Payments help').closest('article')).getByRole('button', { name: 'Editar' }));
    await user.clear(screen.getByLabelText('Nombre'));
    await user.type(screen.getByLabelText('Nombre'), 'Fresh Area');
    await user.click(screen.getByRole('button', { name: /actualizar área/i }));
    await waitFor(() => expect(requestFor('PATCH', '/api/admin/areas/1')).toBeTruthy());

    await race.resolveStale();
    expect(screen.queryByText('Stale Area')).not.toBeInTheDocument();
    expect(await screen.findByText('Fresh Area')).toBeInTheDocument();
  });

  it('keeps an analyst update ahead of a delayed stale refresh and applies one trailing refresh', async () => {
    const user = userEvent.setup();
    const race = mockOperationalMutationRace({
      staleOverrides: { '/api/admin/analysts': [{ ...ANALYSTS[0], display_name: 'Stale Analyst' }] },
      onMutation: ({ pathname, method, body, current }) => {
        if (pathname !== '/api/admin/analysts/2' || method !== 'PATCH') return null;
        current['/api/admin/analysts'] = [{ ...ANALYSTS[0], ...body, display_name: 'Fresh Analyst' }, ANALYSTS[1]];
        return current['/api/admin/analysts'][0];
      },
    });
    render(<AdminPanel onLogout={vi.fn()} />);
    await startDelayedOperationalRefresh(user);
    await selectAdminModule(user, /analistas/i);
    await user.click(within(screen.getByText('Ada Lovelace').closest('tr')).getByRole('button', { name: 'Editar' }));
    await user.clear(screen.getByLabelText('Nombre visible'));
    await user.type(screen.getByLabelText('Nombre visible'), 'Fresh Analyst');
    await user.click(screen.getByRole('button', { name: /actualizar analista/i }));
    await waitFor(() => expect(requestFor('PATCH', '/api/admin/analysts/2')).toBeTruthy());

    await race.resolveStale();
    expect(screen.queryByText('Stale Analyst')).not.toBeInTheDocument();
    expect(await screen.findByText('Fresh Analyst')).toBeInTheDocument();
  });

  it('keeps an availability change ahead of a delayed stale refresh and applies one trailing refresh', async () => {
    const user = userEvent.setup();
    const race = mockOperationalMutationRace({
      staleOverrides: { '/api/admin/analysts': ANALYSTS },
      onMutation: ({ pathname, method, body, current }) => {
        if (pathname !== '/api/admin/analysts/2' || method !== 'PATCH') return null;
        current['/api/admin/analysts'] = [{ ...ANALYSTS[0], available: body.available }, ANALYSTS[1]];
        return current['/api/admin/analysts'][0];
      },
    });
    render(<AdminPanel onLogout={vi.fn()} />);
    await startDelayedOperationalRefresh(user);
    await selectAdminModule(user, /analistas/i);
    await user.click(within(screen.getByText('Ada Lovelace').closest('tr')).getByRole('button', { name: 'Habilitar' }));
    await waitFor(() => expect(requestFor('PATCH', '/api/admin/analysts/2')).toBeTruthy());

    await race.resolveStale();
    expect(within(screen.getByText('Ada Lovelace').closest('tr')).getByText('Disponible')).toBeInTheDocument();
  });

  it('keeps a ticket assignment ahead of a delayed stale refresh and applies one trailing refresh', async () => {
    const user = userEvent.setup();
    const race = mockOperationalMutationRace({
      staleOverrides: { '/api/admin/queue': QUEUE },
      onMutation: ({ pathname, method, current }) => {
        if (pathname !== '/api/admin/tickets/33/assign' || method !== 'POST') return null;
        current['/api/admin/queue'] = { tickets: [{ ...QUEUE.tickets[0], assignment: { analyst_id: 2, analyst: ANALYSTS[0] } }] };
        return { ok: true };
      },
    });
    render(<AdminPanel onLogout={vi.fn()} />);
    await startDelayedOperationalRefresh(user);
    await selectAdminModule(user, /cola y sla/i);
    await user.selectOptions(screen.getByLabelText('Asignar ticket #33'), '2');
    await waitFor(() => expect(requestFor('POST', '/api/admin/tickets/33/assign')).toBeTruthy());

    await race.resolveStale();
    expect(screen.getByLabelText('Asignar ticket #33')).toHaveValue('2');
    expect(screen.getAllByText('Ada Lovelace')).not.toHaveLength(0);
  });

  it('keeps candidate settings ahead of a delayed stale refresh and applies one trailing refresh', async () => {
    const user = userEvent.setup();
    const race = mockOperationalMutationRace({
      staleOverrides: { '/api/admin/candidate-settings': { formUrl: 'https://stale.example/form', message: 'Stale message' } },
      onMutation: ({ pathname, method, body, current }) => {
        if (pathname !== '/api/admin/candidate-settings' || method !== 'PUT') return null;
        current['/api/admin/candidate-settings'] = body;
        return body;
      },
    });
    render(<AdminPanel onLogout={vi.fn()} />);
    await startDelayedOperationalRefresh(user);
    await selectAdminModule(user, /candidatos/i);
    const message = screen.getByLabelText(/Mensaje de orientación/i);
    await user.clear(message);
    await user.type(message, 'Fresh candidate message');
    await user.click(screen.getByRole('button', { name: /guardar orientación/i }));
    await waitFor(() => expect(requestFor('PUT', '/api/admin/candidate-settings')).toBeTruthy());

    await race.resolveStale();
    expect(screen.queryByDisplayValue('Stale message')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Fresh candidate message')).toBeInTheDocument();
  });

  it('prevents an older operational response from rolling back saved candidate settings', async () => {
    const user = userEvent.setup();
    const staleSettings = deferred();
    let settingsGets = 0;
    let savedSettings = { formUrl: 'https://initial.example/form', message: 'Initial message' };
    globalThis.fetch = vi.fn((url, options = {}) => {
      const { pathname } = new URL(url, window.location.origin);
      if (pathname === '/api/admin/candidate-settings' && options.method === 'PUT') {
        savedSettings = JSON.parse(options.body);
        return Promise.resolve(jsonResponse(savedSettings));
      }
      if (pathname === '/api/admin/candidate-settings') {
        settingsGets += 1;
        if (settingsGets === 2) return staleSettings.promise;
        return Promise.resolve(jsonResponse(savedSettings));
      }
      if (pathname === '/api/admin/areas') return Promise.resolve(jsonResponse(AREAS));
      if (pathname === '/api/admin/analysts') return Promise.resolve(jsonResponse(ANALYSTS));
      if (pathname === '/api/admin/queue') return Promise.resolve(jsonResponse(QUEUE));
      if (pathname === '/api/admin/reports/summary') return Promise.resolve(jsonResponse(REPORT_SUMMARY));
      if (pathname === '/api/admin/candidates') return Promise.resolve(jsonResponse({ candidates: [] }));
      if (pathname === '/api/admin/bot-flows') return Promise.resolve(jsonResponse(BOT_FLOWS));
      if (pathname === '/api/admin/audit') return Promise.resolve(jsonResponse(AUDIT_LOGS));
      return Promise.resolve(jsonResponse({}));
    });

    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /candidatos/i);
    const message = await screen.findByDisplayValue('Initial message');
    await user.click(screen.getByRole('button', { name: /actualizar/i }));
    await user.clear(message);
    await user.type(message, 'Saved message');
    await user.click(screen.getByRole('button', { name: /guardar orientación/i }));
    await waitFor(() => expect(screen.getByDisplayValue('Saved message')).toBeInTheDocument());

    staleSettings.resolve(jsonResponse({ formUrl: 'https://stale.example/form', message: 'Stale message' }));
    await staleSettings.promise;
    expect(settingsGets).toBe(2);
    expect(screen.queryByDisplayValue('Stale message')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Saved message')).toBeInTheDocument();
  });

  it('guards scope and module navigation for unsaved canonical messages', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /flujos del bot/i);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Mensaje pendiente' } });
    await user.selectOptions(screen.getByLabelText('Área del flujo'), '1');
    expect(screen.getByLabelText('Área del flujo')).toHaveValue('');
    await selectAdminModule(user, /reportes/i);
    expect(screen.getByText('Mapa de la conversación de soporte')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('discards unsaved Studio work after confirmed scope and module transitions', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /flujos del bot/i);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Mensaje que se descartará' } });
    await user.selectOptions(screen.getByLabelText('Área del flujo'), '1');
    expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/se descartarán/i));
    expect(screen.getByLabelText('Área del flujo')).toHaveValue('1');
    expect(screen.queryByDisplayValue('Mensaje que se descartará')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Área del flujo'), '');
    await waitFor(() => expect(screen.queryByText('Bloque en preparación')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    await selectAdminModule(user, /reportes/i);
    expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/se descartarán/i));
    expect(screen.getByText('Resumen operativo y Salesforce')).toBeInTheDocument();
    const unloadAfterDiscard = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadAfterDiscard);
    expect(unloadAfterDiscard.defaultPrevented).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    await selectAdminModule(user, /flujos del bot/i);
    await screen.findByText('Soporte de integraciones');
    expect(screen.queryByText('Bloque en preparación')).not.toBeInTheDocument();
  });

  it('exits Studio focus mode when another module is selected', async () => {
    const user = userEvent.setup();
    mockAdminFetch();
    render(<AdminPanel onLogout={vi.fn()} />);
    await selectAdminModule(user, /flujos del bot/i);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: 'Modo enfoque' }));
    expect(document.querySelector('.admin-shell')).toHaveClass('admin-shell--studio-focus');
    await selectAdminModule(user, /reportes/i);
    expect(await screen.findByText('Resumen operativo y Salesforce')).toBeInTheDocument();
    expect(document.querySelector('.admin-shell')).not.toHaveClass('admin-shell--studio-focus');
  });

  it('guards panel exit, logout, and browser unload while Studio is dirty', async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockAdminFetch();
    render(<AdminPanel onLogout={onLogout} />);
    await selectAdminModule(user, /flujos del bot/i);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));

    await user.click(screen.getByRole('link', { name: 'Panel operativo' }));
    await user.click(screen.getByRole('button', { name: /cerrar sesión/i }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(onLogout).not.toHaveBeenCalled();

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /cerrar sesión/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});

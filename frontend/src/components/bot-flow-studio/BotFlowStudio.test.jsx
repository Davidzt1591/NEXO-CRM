// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BotFlowStudio from './BotFlowStudio';

const flowHarness = vi.hoisted(() => ({ props: null, fitView: vi.fn() }));
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal();
  const React = await import('react');
  return { ...actual, ReactFlow: props => { flowHarness.props = props; return React.createElement(actual.ReactFlow, props); }, useReactFlow: () => ({ ...actual.useReactFlow(), fitView: flowHarness.fitView }) };
});

const DEFINITION = { definition: { label: 'Soporte de integraciones', entry_node_id: 'start', nodes: [
  { node_id: 'start', label: 'Filtro inicial', runtime_type: 'entry', message_key: 'initial_filter', message: '¿Tu solicitud es sobre integraciones?', inputs: ['text'], branches: [{ branch_id: 'yes', label: 'Sí', target: 'name' }], next: null },
  { node_id: 'name', label: 'Capturar nombre', runtime_type: 'capture', message_key: 'ask_name', message: 'Indica tu nombre', inputs: ['nombre'], branches: [], next: 'end' },
  { node_id: 'end', label: 'Confirmación', runtime_type: 'terminal', message_key: 'confirmation', message: 'Gracias', inputs: [], branches: [], next: null },
  { node_id: 'candidate-exit', label: 'Salida de candidato', runtime_type: 'terminal', message_key: 'candidate_exit', message: 'Consulta el portal de candidatos', inputs: [], branches: [], next: null },
] }, version_id: 2 };
const FLOWS = [{ id: 7, version_id: 2, area_id: null, step_key: 'ask_name', message: 'Indica tu nombre', sort_order: 10, active: true }];
const EMPTY_LAYOUT = { schema_version: 1, nodes: [], edges: [] };
const EXHAUSTED_DECISION_LAYOUT = {
  schema_version: 1,
  nodes: [
    { id: 'decision-exhausted', kind: 'draft', draft_only: true, type: 'decision', position: { x: 400, y: 100 }, label: 'Decisión completa' },
    ...['Sí', 'No', 'Otra respuesta'].map((label, index) => ({ id: `target-${index}`, kind: 'draft', draft_only: true, type: 'capture', position: { x: 700, y: index * 180 }, label: `Destino ${label}` })),
  ],
  edges: ['Sí', 'No', 'Otra respuesta'].map((label, index) => ({ id: `route-${index}`, source: 'decision-exhausted', target: `target-${index}`, draft_only: true, label })),
};
const CANDIDATE_BOOTSTRAP = { session: { paso: 0, scope: 'global' }, path: ['start'], outputs: [{ node_id: 'start', text: '¿Tu solicitud es sobre integraciones?' }], effects: [] };
const CANDIDATE_RESULT = { session: null, path: ['start', 'candidate-exit'], outputs: [{ node_id: 'candidate-exit', message_key: 'candidate_exit', text: 'Consulta el portal de candidatos' }], effects: [], provenance: { 'candidate-exit': { node_id: 'candidate-exit', message_key: 'candidate_exit', source: 'fallback', edit_context: { version_id: 2, area_id: null } } } };
let layoutFixture;
function response(payload, status = 200) { return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })); }

describe('BotFlowStudio', () => {
  beforeEach(() => {
    flowHarness.fitView.mockClear();
    layoutFixture = EMPTY_LAYOUT;
    vi.stubGlobal('localStorage', { getItem: () => 'admin-token' });
    globalThis.fetch = vi.fn((url, options = {}) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout')) return response({ version_id: 2, area_id: null, revision: 0, layout: layoutFixture });
      if (path.endsWith('/simulate')) {
        const body = JSON.parse(options.body);
        if (body.session === null && body.input === '') return response({ session: { paso: 0 }, path: ['start'], outputs: [{ node_id: 'start', text: '¿Tu solicitud es sobre integraciones?' }], effects: [] });
        if (body.input === '2') return response({ session: null, path: ['start', 'candidate-exit'], outputs: [{ node_id: 'candidate-exit', message_key: 'candidate_exit', text: 'Consulta el portal de candidatos' }], effects: [], provenance: { 'candidate-exit': { node_id: 'candidate-exit', message_key: 'candidate_exit', source: 'fallback', edit_context: { version_id: 2, area_id: null } } } });
        return response({ session: { paso: 1 }, path: ['start', 'name'], outputs: [{ node_id: 'name', text: 'Indica tu nombre' }], effects: [] });
      }
      return response({});
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('bootstraps the backend contract and advances Sí exactly once', async () => {
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    expect(await screen.findByText('¿Tu solicitud es sobre integraciones?')).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls.find(([url]) => new URL(url, location.origin).pathname.endsWith('/simulate'))[1].body)).toEqual({ session: null, input: '', version_id: 2, area_id: null });
    const input = screen.getByLabelText('Mensaje de prueba');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'Sí' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar al simulador' }));
    expect(await screen.findByText(/2 pasos recorridos/)).toBeInTheDocument();
    expect(screen.getAllByText('Indica tu nombre').length).toBeGreaterThan(0);
    expect(fetch.mock.calls.filter(([url]) => new URL(url, location.origin).pathname.endsWith('/simulate'))).toHaveLength(2);
  });

  it('adds an unmistakably local draft block with validation and actions', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    expect(screen.getByText(/Guardado en NEXO sobrevive al recargar/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    expect(screen.getAllByText(/borrador local sin guardar — no afecta WhatsApp activo/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /duplicar/i })).toBeInTheDocument();
    expect(screen.getByText(/necesita la ruta “Sí”/i)).toBeInTheDocument();
  });

  it('reveals candidate provenance and opens the canonical fallback editor', async () => {
    const navigate = vi.fn();
    const simulationRequests = [];
    window.history.replaceState(null, '', '/admin#bot-flow-studio');
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'admin-token'), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() });
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout')) return response({ version_id: 2, area_id: null, revision: 0, layout: EMPTY_LAYOUT });
      if (path.endsWith('/simulate')) {
        const body = JSON.parse(options.body);
        simulationRequests.push(body);
        if (body.session === null && body.input === '') return response(CANDIDATE_BOOTSTRAP);
        if (body.session?.scope === 'global' && body.input === '2') return response(CANDIDATE_RESULT);
        return response({ error: 'Unexpected candidate simulation fixture request' }, 400);
      }
      return response({ error: 'Unexpected candidate fixture request' }, 404);
    });
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} onNavigateCandidateSettings={navigate} messageScope={{ versionId: 2, areaId: null }} focusMode />);
    const simulatorInput = await screen.findByLabelText('Mensaje de prueba');
    await waitFor(() => {
      expect(within(screen.getByRole('log', { name: 'Mensajes de la prueba' })).getByText('¿Tu solicitud es sobre integraciones?')).toBeInTheDocument();
      expect(simulatorInput).toBeEnabled();
      expect(simulationRequests).toEqual([{ session: null, input: '', version_id: 2, area_id: null }]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
    fireEvent.change(simulatorInput, { target: { value: '2' } });
    const send = screen.getByRole('button', { name: 'Enviar al simulador' });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    const branchHeading = await screen.findByRole('heading', { name: /Rama seleccionada: Candidato.*se edita aquí.*distinto de la orientación segura/i });
    const provenance = screen.getByRole('complementary', { name: 'Proveniencia del mensaje' });
    expect(provenance).not.toHaveAttribute('role', 'status');
    expect(provenance).not.toHaveAttribute('aria-live');
    expect(within(provenance).queryByRole('status')).not.toBeInTheDocument();
    expect(branchHeading).toHaveAttribute('tabindex', '-1');
    await waitFor(() => expect(branchHeading).toHaveFocus());
    expect(within(screen.getByRole('log', { name: 'Mensajes de la prueba' })).queryByText('Rama seleccionada: Candidato')).not.toBeInTheDocument();
    expect(screen.getByText('Este mensaje pertenece al flujo de prueba.')).toBeInTheDocument();
    expect(screen.getByText(/mensaje de respaldo/i)).toBeInTheDocument();
    expect(flowHarness.fitView).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'candidate-exit' }] }));
    const editMessage = screen.getByRole('button', { name: /editar este mensaje/i });
    editMessage.focus();
    expect(editMessage).toHaveFocus();
    fireEvent.keyDown(editMessage, { key: 'Enter', code: 'Enter' });
    fireEvent.click(editMessage);
    const inspector = screen.getByLabelText('Inspector del bloque seleccionado');
    expect(within(inspector).getByText('Salida de candidato')).toBeInTheDocument();
    expect(within(inspector).getByRole('button', { name: 'Crear mensaje' })).toBeInTheDocument();
    await waitFor(() => expect(inspector).toContainElement(document.activeElement));
    fireEvent.click(screen.getByRole('button', { name: /administración > candidatos > orientación segura/i }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(simulationRequests).toEqual([
      { session: null, input: '', version_id: 2, area_id: null },
      { session: CANDIDATE_BOOTSTRAP.session, input: '2', version_id: 2, area_id: null },
    ]);
  });

  it('deletes a draft node and supports undo and redo', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByLabelText('Hacer pregunta: Capturar nombre');
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    await user.click(await screen.findByRole('button', { name: /^eliminar$/i }));
    await waitFor(() => expect(screen.queryByText('Bloque en preparación')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Deshacer' }));
    await waitFor(() => expect(screen.getAllByText('Tomar decisión').length).toBeGreaterThan(1));
    await user.click(screen.getByRole('button', { name: 'Rehacer' }));
    await waitFor(() => expect(screen.queryByText('Bloque en preparación')).not.toBeInTheDocument());
  });

  it('uses active scope and updates the visible node after save', async () => {
    const user = userEvent.setup();
    let resolveSave;
    const onSaveFlow = vi.fn(() => new Promise(resolve => { resolveSave = resolve; }));
    render(<BotFlowStudio flows={[...FLOWS, { ...FLOWS[0], id: 8, version_id: 1, message: 'Mensaje anterior' }]} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByLabelText('Hacer pregunta: Capturar nombre');
    fireEvent.click(screen.getByLabelText('Hacer pregunta: Capturar nombre'));
    const inspector = screen.getByLabelText('Inspector del bloque seleccionado');
    expect(within(inspector).getByLabelText('Mensaje del bot')).toHaveValue('Indica tu nombre');
    fireEvent.change(within(inspector).getByLabelText('Mensaje del bot'), { target: { value: '¿Cuál es tu nombre completo?' } });
    await user.click(within(inspector).getByRole('button', { name: /guardar solo el mensaje/i }));
    resolveSave();
    await waitFor(() => expect(screen.getByLabelText('Hacer pregunta: Capturar nombre')).toHaveTextContent('¿Cuál es tu nombre completo?'));
    expect(onSaveFlow).toHaveBeenCalledWith(expect.objectContaining({ id: 7, version_id: 2, step_key: 'ask_name' }));
  });

  it('shows a definition error with retry', async () => {
    fetch.mockImplementationOnce(() => response({ error: 'falló' }, 500));
    const user = userEvent.setup();
    render(<BotFlowStudio flows={[]} areas={[]} onSaveFlow={vi.fn()} />);
    expect(await screen.findByText('No pudimos abrir la conversación')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /intentar de nuevo/i }));
    expect(await screen.findByText('Soporte de integraciones')).toBeInTheDocument();
  });

  it('retains the normal internal scope cache when no discard was confirmed', async () => {
    const user = userEvent.setup();
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    expect(screen.getByText('Bloque en preparación')).toBeInTheDocument();
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: 9 }} />);
    await waitFor(() => expect(screen.queryByText('Bloque en preparación')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await waitFor(() => expect(flowHarness.props.nodes.filter(node => !node.data.canonical)).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeEnabled();
  });

  it('erases the discarded scope cache before switching and loads persisted state on return', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const baseProps = { flows: FLOWS, areas: [], onSaveFlow: vi.fn(), onDirtyChange };
    const view = render(<BotFlowStudio {...baseProps} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    expect(screen.getByText('Bloque en preparación')).toBeInTheDocument();

    view.rerender(<BotFlowStudio {...baseProps} messageScope={{ versionId: 2, areaId: 9 }} discardScopeCommand={{ id: 1, scopeKey: '2:global' }} />);
    await waitFor(() => expect(screen.queryByText('Bloque en preparación')).not.toBeInTheDocument());
    view.rerender(<BotFlowStudio {...baseProps} messageScope={{ versionId: 2, areaId: null }} discardScopeCommand={{ id: 1, scopeKey: '2:global' }} />);

    await waitFor(() => expect(flowHarness.props.nodes.filter(node => !node.data.canonical)).toHaveLength(0));
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('clears simulator state on scope change, ignores stale responses, and bootstraps the matching definition once', async () => {
    let resolveOldProgress;
    const oldProgress = new Promise(resolve => { resolveOldProgress = resolve; });
    fetch.mockImplementation((url, options = {}) => {
      const requestUrl = new URL(url, location.origin);
      if (requestUrl.pathname.endsWith('/definition')) {
        const areaId = requestUrl.searchParams.get('area_id');
        return response(areaId === '9' ? { ...DEFINITION, definition: { ...DEFINITION.definition, label: 'Soporte área 9' } } : DEFINITION);
      }
      if (requestUrl.pathname.endsWith('/simulate')) {
        const body = JSON.parse(options.body);
        if (body.input === 'Sí') return oldProgress;
        const scoped = body.area_id === 9;
        return response({ session: { paso: 0, scope: scoped ? 'area-9' : 'global' }, path: ['start'], outputs: [{ node_id: 'start', text: scoped ? 'Inicio área 9' : 'Inicio global' }], effects: [] });
      }
      return response({});
    });
    const user = userEvent.setup();
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    expect(await screen.findByText('Inicio global')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Mensaje de prueba'), 'Sí');
    await user.click(screen.getByRole('button', { name: 'Enviar al simulador' }));
    expect(screen.getByText('Sí')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Mensaje de prueba'), 'Texto pendiente del alcance anterior');

    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: 9 }} />);
    expect(screen.queryByText('Inicio global')).not.toBeInTheDocument();
    expect(screen.queryByText('Sí')).not.toBeInTheDocument();
    expect(await screen.findByText('Inicio área 9')).toBeInTheDocument();
    expect(screen.getByLabelText('Mensaje de prueba')).toHaveValue('');
    const scopedSend = screen.getByRole('button', { name: 'Enviar al simulador' });
    expect(scopedSend).toBeDisabled();
    await user.click(scopedSend);
    expect(fetch.mock.calls.some(([url, options = {}]) => {
      const requestUrl = new URL(url, location.origin);
      if (!requestUrl.pathname.endsWith('/simulate')) return false;
      const body = JSON.parse(options.body);
      return body.area_id === 9 && body.input === 'Texto pendiente del alcance anterior';
    })).toBe(false);
    resolveOldProgress(await response({ session: { paso: 99 }, path: ['start', 'name'], outputs: [{ node_id: 'name', text: 'Respuesta vieja' }], effects: [] }));
    await act(async () => {});
    expect(screen.queryByText('Respuesta vieja')).not.toBeInTheDocument();
    expect(flowHarness.props.nodes.filter(node => node.className === 'studio-flow-node--active')).toHaveLength(1);

    const scopedBootstraps = fetch.mock.calls.filter(([url, options = {}]) => {
      const requestUrl = new URL(url, location.origin);
      if (!requestUrl.pathname.endsWith('/simulate')) return false;
      const body = JSON.parse(options.body);
      return body.area_id === 9 && body.session === null && body.input === '';
    });
    expect(scopedBootstraps).toHaveLength(1);
  });

  it('undoes and redoes canonical visible labels within their scope', async () => {
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByLabelText('Hacer pregunta: Capturar nombre');
    fireEvent.click(screen.getByLabelText('Hacer pregunta: Capturar nombre'));
    const inspector = screen.getByLabelText('Inspector del bloque seleccionado');
    fireEvent.change(within(inspector).getByLabelText(/Nombre visible/), { target: { value: 'Pedir nombre completo' } });
    expect(await screen.findByLabelText('Hacer pregunta: Pedir nombre completo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(await screen.findByLabelText('Hacer pregunta: Capturar nombre')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Rehacer' }));
    expect(await screen.findByLabelText('Hacer pregunta: Pedir nombre completo')).toBeInTheDocument();

    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: 9 }} />);
    expect(await screen.findByLabelText('Hacer pregunta: Capturar nombre')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deshacer' })).toBeDisabled());
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await waitFor(() => expect(screen.getByLabelText('Hacer pregunta: Pedir nombre completo')).toBeInTheDocument());
  });

  it('drives connect, reconnect, edge delete and drag undo through React Flow callbacks', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByLabelText('Hacer pregunta: Capturar nombre');
    await user.click(screen.getByRole('button', { name: /hacer pregunta/i }));
    await user.click(screen.getByRole('button', { name: /finalizar/i }));
    let drafts = flowHarness.props.nodes.filter(node => !node.data.canonical);
    act(() => flowHarness.props.onConnect({ source: 'start', target: drafts[0].id }));
    await waitFor(() => expect(flowHarness.props.edges.some(edge => edge.target === drafts[0].id)).toBe(true));
    const edge = flowHarness.props.edges.find(item => item.target === drafts[0].id);
    act(() => flowHarness.props.onReconnect(edge, { source: drafts[0].id, target: drafts[1].id }));
    await waitFor(() => expect(flowHarness.props.edges.some(item => item.source === drafts[0].id && item.target === drafts[1].id)).toBe(true));
    const reconnected = flowHarness.props.edges.find(item => item.source === drafts[0].id && item.target === drafts[1].id);
    act(() => flowHarness.props.onEdgeClick({}, reconnected));
    await user.click(await screen.findByRole('button', { name: /eliminar ruta seleccionada/i }));
    expect(flowHarness.props.edges.some(item => item.id === reconnected.id)).toBe(false);
    drafts = flowHarness.props.nodes.filter(node => !node.data.canonical);
    const moved = { ...drafts[0], position: { x: 500, y: 500 } };
    act(() => { flowHarness.props.onNodeDragStart({}, drafts[0]); flowHarness.props.onNodesChange([{ id: drafts[0].id, type: 'position', position: moved.position }]); flowHarness.props.onNodeDragStop({}, moved); });
    await user.click(screen.getByRole('button', { name: 'Deshacer' }));
    await waitFor(() => expect(flowHarness.props.nodes.find(node => node.id === drafts[0].id).position).toEqual(drafts[0].position));
    await user.click(screen.getByRole('button', { name: 'Rehacer' }));
    await waitFor(() => expect(flowHarness.props.nodes.find(node => node.id === drafts[0].id).position).toEqual(moved.position));
  });

  it('connects a selected source to a highlighted destination without dragging', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /hacer pregunta/i }));
    const source = flowHarness.props.nodes.find(node => !node.data.canonical);
    await user.click(screen.getByRole('button', { name: /finalizar/i }));
    const target = flowHarness.props.nodes.find(node => !node.data.canonical && node.id !== source.id);
    fireEvent.click(screen.getByLabelText(`Hacer pregunta: ${source.data.displayLabel}`));
    await user.click(screen.getByRole('button', { name: /^conectar bloque$/i }));
    const destinationAction = within(document.querySelector('.studio-destination-choices')).getByText(target.data.displayLabel).closest('button');
    expect(destinationAction).toHaveAccessibleName();
    await user.click(destinationAction);
    expect(flowHarness.props.edges).toContainEqual(expect.objectContaining({ source: source.id, target: target.id, label: 'Continuar', data: expect.objectContaining({ draft: true }) }));
    await user.click(screen.getByRole('button', { name: /guardar en NEXO/i }));
    const layoutSave = fetch.mock.calls.find(([url, options = {}]) => new URL(url, location.origin).pathname.endsWith('/layout') && options.method === 'PUT');
    expect(JSON.parse(layoutSave[1].body).layout.edges).toContainEqual(expect.objectContaining({ source: source.id, target: target.id, draft_only: true }));
  });

  it('asks for Sí and No before creating labeled decision branches', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    const palette = within(document.querySelector('.studio-palette'));
    fireEvent.click(palette.getByRole('button', { name: /tomar decisión/i }));
    const decision = flowHarness.props.nodes.find(node => !node.data.canonical);
    fireEvent.click(palette.getByRole('button', { name: /hacer pregunta/i }));
    const yesTarget = flowHarness.props.nodes.find(node => !node.data.canonical && node.id !== decision.id);
    fireEvent.click(await screen.findByLabelText(`Tomar decisión: ${decision.data.displayLabel}`));
    await user.click(await screen.findByRole('button', { name: /^conectar bloque$/i }));
    await user.click(await screen.findByRole('button', { name: 'Sí' }));
    await user.click(await screen.findByRole('button', { name: `Conectar con ${yesTarget.data.displayLabel}` }));
    await waitFor(() => expect(flowHarness.props.edges).toContainEqual(expect.objectContaining({ source: decision.id, target: yesTarget.id, label: 'Sí', data: expect.objectContaining({ branch_id: 'yes' }) })));

    fireEvent.click(palette.getByRole('button', { name: /finalizar/i }));
    const noTarget = flowHarness.props.nodes.find(node => !node.data.canonical && ![decision.id, yesTarget.id].includes(node.id));
    fireEvent.click(await screen.findByLabelText(`Tomar decisión: ${decision.data.displayLabel}`));
    await user.click(await screen.findByRole('button', { name: /^conectar bloque$/i }));
    await user.click(await screen.findByRole('button', { name: 'No' }));
    await user.click(await screen.findByRole('button', { name: `Conectar con ${noTarget.data.displayLabel}` }));
    await waitFor(() => expect(flowHarness.props.edges).toContainEqual(expect.objectContaining({ source: decision.id, target: noTarget.id, label: 'No', data: expect.objectContaining({ branch_id: 'no' }) })));
  });

  it('disables exhausted decision actions and offers route deletion or another source', async () => {
    layoutFixture = EXHAUSTED_DECISION_LAYOUT;
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByLabelText('Tomar decisión: Decisión completa');
    const decision = flowHarness.props.nodes.find(node => node.id === 'decision-exhausted');
    act(() => flowHarness.props.onNodeClick({}, decision));
    expect(screen.getAllByText('Todas las rutas están configuradas').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^conectar bloque$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /conectar bloque desde editar/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Elegir otro origen' })).toBeEnabled();
    expect(screen.queryByText(/elige qué respuesta/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByRole('button', { name: /conectar bloque desde editar/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Seleccionar ruta Sí' }));
    expect(screen.getByRole('button', { name: /eliminar ruta seleccionada/i })).toBeInTheDocument();
  });

  it('keeps one focus owner and blocks a repeated guided decision route', async () => {
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    fireEvent.click(screen.getByRole('button', { name: /tomar decisión/i }));
    const decision = flowHarness.props.nodes.find(node => !node.data.canonical);
    fireEvent.click(screen.getByRole('button', { name: /hacer pregunta/i }));
    const first = flowHarness.props.nodes.find(node => !node.data.canonical && node.id !== decision.id);
    fireEvent.click(screen.getByLabelText(`Tomar decisión: ${decision.data.displayLabel}`));
    fireEvent.click(screen.getAllByRole('button', { name: /^conectar bloque$/i })[0]);
    expect(screen.getByRole('button', { name: 'Sí' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Sí' }));
    expect(document.querySelector('.studio-destination-choices').contains(document.activeElement)).toBe(true);
    expect(document.querySelector('.studio-guided-destination:focus')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Conectar con ${first.data.displayLabel}` }));
    await waitFor(() => expect(flowHarness.props.edges.some(edge => edge.source === decision.id && edge.data?.branch_id === 'yes')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /finalizar/i }));
    fireEvent.click(screen.getByLabelText(`Tomar decisión: ${decision.data.displayLabel}`));
    fireEvent.click(screen.getAllByRole('button', { name: /^conectar bloque$/i })[0]);
    expect(screen.queryByRole('button', { name: 'Sí' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'No' })).toHaveFocus());
  });

  it('blocks direct decision drag while preserving nondecision drag and decision reconnect metadata', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    const decision = flowHarness.props.nodes.find(node => !node.data.canonical);
    await user.click(screen.getByRole('button', { name: /hacer pregunta/i }));
    const capture = flowHarness.props.nodes.find(node => !node.data.canonical && node.id !== decision.id);
    await user.click(screen.getByRole('button', { name: /finalizar/i }));
    const terminal = flowHarness.props.nodes.find(node => !node.data.canonical && ![decision.id, capture.id].includes(node.id));

    act(() => flowHarness.props.onConnect({ source: decision.id, target: capture.id }));
    expect(flowHarness.props.edges).not.toContainEqual(expect.objectContaining({ source: decision.id, target: capture.id }));
    expect(screen.getByText(/decisiones deben conectarse con el asistente/i)).toBeInTheDocument();

    act(() => flowHarness.props.onConnect({ source: capture.id, target: terminal.id }));
    await waitFor(() => expect(flowHarness.props.edges).toContainEqual(expect.objectContaining({ source: capture.id, target: terminal.id, data: expect.objectContaining({ branch_id: null }) })));
    const routeLess = flowHarness.props.edges.find(edge => edge.source === capture.id && edge.target === terminal.id);
    act(() => flowHarness.props.onReconnect(routeLess, { source: decision.id, target: terminal.id }));
    expect(flowHarness.props.edges.find(edge => edge.id === routeLess.id)).toMatchObject({ source: capture.id, target: terminal.id, data: { branch_id: null, branch_color: null, draft: true, locked: false } });
    expect(screen.getByText(/decisiones deben conectarse con el asistente/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(`Tomar decisión: ${decision.data.displayLabel}`));
    await user.click(screen.getAllByRole('button', { name: /^conectar bloque$/i })[0]);
    await user.click(screen.getByRole('button', { name: 'Sí' }));
    await user.click(screen.getByRole('button', { name: `Conectar con ${capture.data.displayLabel}` }));
    const yesEdge = flowHarness.props.edges.find(edge => edge.source === decision.id && edge.data?.branch_id === 'yes');
    act(() => flowHarness.props.onReconnect(yesEdge, { source: decision.id, target: terminal.id }));
    await waitFor(() => expect(flowHarness.props.edges.find(edge => edge.source === decision.id && edge.target === terminal.id)).toMatchObject({ label: 'Sí', data: { branch_id: 'yes', branch_color: '#35d3c8', draft: true, locked: false } }));
  });

  it('returns to available route choices when the selected route becomes unavailable', async () => {
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    const palette = within(document.querySelector('.studio-palette'));
    fireEvent.click(palette.getByRole('button', { name: /tomar decisión/i }));
    const firstDecision = flowHarness.props.nodes.find(node => !node.data.canonical);
    fireEvent.click(palette.getByRole('button', { name: /tomar decisión/i }));
    const secondDecision = flowHarness.props.nodes.find(node => !node.data.canonical && node.id !== firstDecision.id);
    fireEvent.click(palette.getByRole('button', { name: /hacer pregunta/i }));
    const firstTarget = flowHarness.props.nodes.find(node => !node.data.canonical && ![firstDecision.id, secondDecision.id].includes(node.id));
    fireEvent.click(palette.getByRole('button', { name: /finalizar/i }));
    const secondTarget = flowHarness.props.nodes.find(node => !node.data.canonical && ![firstDecision.id, secondDecision.id, firstTarget.id].includes(node.id));

    act(() => flowHarness.props.onNodeClick({}, secondDecision));
    fireEvent.click(screen.getAllByRole('button', { name: /^conectar bloque$/i })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Sí' }));
    fireEvent.click(await screen.findByRole('button', { name: `Conectar con ${secondTarget.data.displayLabel}` }));
    await waitFor(() => expect(flowHarness.props.edges.some(edge => edge.source === secondDecision.id && edge.data?.branch_id === 'yes')).toBe(true));
    const secondYes = flowHarness.props.edges.find(edge => edge.source === secondDecision.id && edge.data?.branch_id === 'yes');

    act(() => flowHarness.props.onNodeClick({}, firstDecision));
    fireEvent.click(screen.getAllByRole('button', { name: /^conectar bloque$/i })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Sí' }));
    act(() => flowHarness.props.onReconnect(secondYes, { source: firstDecision.id, target: firstTarget.id }));

    expect(await screen.findAllByText(/ruta “Sí” ya no está disponible.*elige una ruta disponible o cancela/i)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Sí' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'No' })).toHaveFocus());
    expect(screen.queryByRole('button', { name: /crear bloque/i })).not.toBeInTheDocument();
  });

  it('cancels guided connection with its action and Escape', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    const entryNode = (await screen.findByText('Filtro inicial')).closest('.studio-node');
    expect(entryNode).toHaveAttribute('aria-label', expect.stringContaining('Filtro inicial'));
    fireEvent.click(entryNode);
    await user.click(screen.getByRole('button', { name: /^conectar bloque$/i }));
    await user.click(screen.getByRole('button', { name: /cancelar/i }));
    expect(screen.getByText('Conexión cancelada.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^conectar bloque$/i }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: /cancelar/i })).not.toBeInTheDocument();
  });

  it('persists tutorial dismissal and can reopen it from Help', async () => {
    const storage = new Map();
    vi.stubGlobal('localStorage', { getItem: key => storage.get(key) || (key === 'nexo_token' ? 'admin-token' : null), setItem: (key, value) => storage.set(key, value) });
    const user = userEvent.setup();
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    expect(await screen.findByLabelText('Guía para conectar bloques')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cerrar guía' }));
    expect(storage.get('nexo.bot-flow-studio.connect-tutorial.v1')).toBe('dismissed');
    expect(screen.queryByLabelText('Guía para conectar bloques')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ayuda' }));
    expect(screen.getByLabelText('Guía para conectar bloques')).toBeInTheDocument();
    view.unmount();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    expect(screen.queryByLabelText('Guía para conectar bloques')).not.toBeInTheDocument();
  });

  it('never sends draft topology or saves it while simulation stays canonical', async () => {
    const user = userEvent.setup();
    const onSaveFlow = vi.fn();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: 3 }} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /hacer pregunta/i }));
    const draft = flowHarness.props.nodes.find(node => !node.data.canonical);
    act(() => flowHarness.props.onConnect({ source: 'start', target: draft.id }));
    await user.click(screen.getByRole('button', { name: 'Probar' }));
    await user.type(screen.getByLabelText('Mensaje de prueba'), 'Sí');
    await user.click(screen.getByRole('button', { name: 'Enviar al simulador' }));
    const simulationBodies = fetch.mock.calls.filter(([url]) => new URL(url, location.origin).pathname.endsWith('/simulate')).map(([, options]) => JSON.parse(options.body));
    expect(simulationBodies.every(body => !Object.hasOwn(body, 'nodes') && !Object.hasOwn(body, 'edges') && !Object.hasOwn(body, 'topology'))).toBe(true);
    expect(onSaveFlow).not.toHaveBeenCalled();
  });

  it('keeps the prior visible message and reports a rejected save', async () => {
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn().mockRejectedValue(new Error('No autorizado'))} messageScope={{ versionId: 2, areaId: null }} />);
    const nameNode = await screen.findByLabelText('Hacer pregunta: Capturar nombre');
    fireEvent.click(nameNode);
    const inspector = screen.getByLabelText('Inspector del bloque seleccionado');
    fireEvent.change(within(inspector).getByLabelText('Mensaje del bot'), { target: { value: 'Texto rechazado' } });
    await user.click(within(inspector).getByRole('button', { name: /guardar solo el mensaje/i }));
    expect(await within(inspector).findByRole('alert')).toHaveTextContent('No autorizado');
    expect(screen.getByLabelText('Hacer pregunta: Capturar nombre')).toHaveTextContent('Indica tu nombre');
  });

  it('loads persisted layout and saves draft-only data with optimistic revision', async () => {
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout') && options.method !== 'PUT') return response({ revision: 4, layout: { schema_version: 1, nodes: [{ id: 'name', kind: 'canonical', position: { x: 401, y: 202 }, label: 'Nombre persistido' }, { id: 'draft-loaded', kind: 'draft', draft_only: true, type: 'capture', position: { x: 500, y: 300 }, label: 'Pregunta guardada', message: 'Mensaje guardado' }], edges: [{ id: 'edge-loaded', source: 'name', target: 'draft-loaded', draft_only: true }] } });
      if (path.endsWith('/layout')) return response({ revision: 5, layout: JSON.parse(options.body).layout });
      return response({ session: { paso: 0 }, path: ['start'], outputs: [], effects: [] });
    });
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    expect(await screen.findByText('Pregunta guardada')).toBeInTheDocument();
    expect(flowHarness.props.nodes.find(node => node.id === 'name').position).toEqual({ x: 401, y: 202 });
    await user.click(screen.getByRole('button', { name: /tomar decisión/i }));
    await user.click(screen.getByRole('button', { name: /guardar en nexo/i }));
    expect((await screen.findAllByText('Borrador guardado en NEXO — no afecta WhatsApp activo')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/borrador local sin guardar/i)).not.toBeInTheDocument();
    const request = fetch.mock.calls.find(([url, options = {}]) => new URL(url, location.origin).pathname.endsWith('/layout') && options.method === 'PUT');
    const body = JSON.parse(request[1].body);
    expect(body.revision).toBe(4);
    expect(body.layout.edges.every(edge => edge.draft_only === true)).toBe(true);
    expect(JSON.stringify(body)).not.toContain('runtime topology');
  });

  it('preserves newer layout edits while a save is pending and advances the persisted revision', async () => {
    let resolveSave;
    const pendingSave = new Promise(resolve => { resolveSave = resolve; });
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout') && options.method === 'PUT') return pendingSave;
      if (path.endsWith('/layout')) return response({ revision: 4, layout: { schema_version: 1, nodes: [], edges: [] } });
      return response({ session: {}, path: ['start'], outputs: [], effects: [] });
    });
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /hacer pregunta/i }));
    await user.click(screen.getByRole('button', { name: /guardar en nexo/i }));
    await user.click(screen.getByRole('button', { name: /finalizar/i }));
    expect(flowHarness.props.nodes.filter(node => !node.data.canonical)).toHaveLength(2);

    const savedLayout = JSON.parse(fetch.mock.calls.find(([url, options = {}]) => new URL(url, location.origin).pathname.endsWith('/layout') && options.method === 'PUT')[1].body).layout;
    resolveSave(await response({ revision: 5, layout: savedLayout }));

    await waitFor(() => expect(screen.getAllByText('Borrador local sin guardar — no afecta WhatsApp activo').length).toBeGreaterThan(0));
    expect(flowHarness.props.nodes.filter(node => !node.data.canonical)).toHaveLength(2);
    expect(screen.getByRole('button', { name: /guardar en nexo/i })).toBeEnabled();
  });

  it('ignores a layout save response after the active scope changes', async () => {
    let resolveSave;
    const pendingSave = new Promise(resolve => { resolveSave = resolve; });
    fetch.mockImplementation((url, options = {}) => {
      const requestUrl = new URL(url, location.origin);
      if (requestUrl.pathname.endsWith('/definition')) return response(DEFINITION);
      if (requestUrl.pathname.endsWith('/layout') && options.method === 'PUT') return pendingSave;
      if (requestUrl.pathname.endsWith('/layout')) return response({ revision: requestUrl.searchParams.get('area_id') ? 8 : 4, layout: { schema_version: 1, nodes: [], edges: [] } });
      return response({ session: {}, path: ['start'], outputs: [], effects: [] });
    });
    const user = userEvent.setup();
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /hacer pregunta/i }));
    await user.click(screen.getByRole('button', { name: /guardar en nexo/i }));

    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: 9 }} />);
    await waitFor(() => expect(flowHarness.props.nodes.filter(node => !node.data.canonical)).toHaveLength(0));
    resolveSave(await response({ revision: 5, layout: { schema_version: 1, nodes: [{ id: 'stale-draft', kind: 'draft', draft_only: true, type: 'capture', position: { x: 10, y: 10 }, label: 'Respuesta vieja' }], edges: [] } }));
    await act(async () => {});

    expect(flowHarness.props.nodes.some(node => node.id === 'stale-draft')).toBe(false);
    expect(screen.queryByText('Respuesta vieja')).not.toBeInTheDocument();
    expect(screen.getAllByText('Borrador guardado en NEXO — no afecta WhatsApp activo').length).toBeGreaterThan(0);
  });

  it('shows a conflict and only reloads latest when the user chooses it', async () => {
    let gets = 0;
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout') && options.method !== 'PUT') { gets += 1; return response({ revision: gets, layout: { schema_version: 1, nodes: [], edges: [] } }); }
      if (path.endsWith('/layout')) return response({ error: 'El borrador cambió en otra sesión.' }, 409);
      return response({ session: { paso: 0 }, path: ['start'], outputs: [], effects: [] });
    });
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /finalizar/i }));
    await user.click(screen.getByRole('button', { name: /guardar en nexo/i }));
    expect((await screen.findAllByText('Hay cambios guardados en otra sesión — tu borrador local no se sobrescribió')).length).toBeGreaterThan(0);
    expect(screen.getByText('Bloque en preparación')).toBeInTheDocument();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /descartar cambios y recargar/i }));
    expect(screen.getByText('Bloque en preparación')).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/descartará el trabajo local sin guardar/i));
    window.confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /descartar cambios y recargar/i }));
    await waitFor(() => expect(screen.queryByText('Bloque en preparación')).not.toBeInTheDocument());
  });

  it('labels layout load failures as loading errors and retries the load operation', async () => {
    let layoutLoads = 0;
    fetch.mockImplementation((url) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout')) {
        layoutLoads += 1;
        return layoutLoads === 1 ? response({ error: 'Servicio de borradores no disponible' }, 500) : response({ revision: 3, layout: { schema_version: 1, nodes: [], edges: [] } });
      }
      return response({ session: {}, path: ['start'], outputs: [], effects: [] });
    });
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    expect(screen.getAllByText('No se pudo cargar el borrador guardado en NEXO')).toHaveLength(2);
    expect(screen.queryByText(/no se pudo guardar el borrador en NEXO/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reintentar carga/i }));
    expect((await screen.findAllByText('Borrador guardado en NEXO — no afecta WhatsApp activo')).length).toBeGreaterThan(0);
    expect(layoutLoads).toBe(2);
  });

  it('labels layout save failures as saving errors while preserving the local claim', async () => {
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout') && options.method === 'PUT') return response({ error: 'No hay conexión para guardar' }, 500);
      if (path.endsWith('/layout')) return response({ revision: 2, layout: { schema_version: 1, nodes: [], edges: [] } });
      return response({ session: {}, path: ['start'], outputs: [], effects: [] });
    });
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /finalizar/i }));
    await user.click(screen.getByRole('button', { name: /guardar en nexo/i }));
    expect((await screen.findAllByText('No se pudo guardar el borrador en NEXO — tus cambios siguen locales')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/no se pudo cargar el borrador guardado/i)).not.toBeInTheDocument();
  });

  it('ignores a delayed save response after a confirmed scope switch', async () => {
    let resolveSave;
    const delayedSave = new Promise(resolve => { resolveSave = resolve; });
    fetch.mockImplementation((url, options = {}) => {
      const requestUrl = new URL(url, location.origin);
      if (requestUrl.pathname.endsWith('/definition')) return response(requestUrl.searchParams.get('area_id') === '9' ? { ...DEFINITION, definition: { ...DEFINITION.definition, label: 'Área nueve' } } : DEFINITION);
      if (requestUrl.pathname.endsWith('/layout') && options.method === 'PUT') return delayedSave;
      if (requestUrl.pathname.endsWith('/layout')) return response({ revision: requestUrl.searchParams.get('area_id') === '9' ? 8 : 2, layout: { schema_version: 1, nodes: [], edges: [] } });
      return response({ session: {}, path: ['start'], outputs: [], effects: [] });
    });
    const user = userEvent.setup();
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: /finalizar/i }));
    await user.click(screen.getByRole('button', { name: /guardar en nexo/i }));
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: 9 }} />);
    expect(await screen.findByText('Área nueve')).toBeInTheDocument();
    resolveSave(await response({ revision: 3, layout: { schema_version: 1, nodes: [{ id: 'old-draft', kind: 'draft', draft_only: true, type: 'terminal', position: { x: 1, y: 1 }, label: 'Respuesta vieja' }], edges: [] } }));
    await act(async () => {});
    expect(screen.queryByText('Respuesta vieja')).not.toBeInTheDocument();
    expect(screen.queryByText('Respuesta vieja')).not.toBeInTheDocument();
  });

  it('keeps canonical persisted positions isolated across A/B/A scopes', async () => {
    fetch.mockImplementation((url) => {
      const requestUrl = new URL(url, location.origin);
      if (requestUrl.pathname.endsWith('/definition')) return response(DEFINITION);
      if (requestUrl.pathname.endsWith('/layout')) {
        const area = requestUrl.searchParams.get('area_id');
        return response({ revision: area === '9' ? 9 : 4, layout: { schema_version: 1, nodes: [{ id: 'name', kind: 'canonical', position: area === '9' ? { x: 900, y: 90 } : { x: 400, y: 40 } }], edges: [] } });
      }
      return response({ session: {}, path: ['start'], outputs: [], effects: [] });
    });
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await waitFor(() => expect(flowHarness.props.nodes.find(node => node.id === 'name')?.position).toEqual({ x: 400, y: 40 }));
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: 9 }} />);
    await waitFor(() => expect(flowHarness.props.nodes.find(node => node.id === 'name')?.position).toEqual({ x: 900, y: 90 }));
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await waitFor(() => expect(flowHarness.props.nodes.find(node => node.id === 'name')?.position).toEqual({ x: 400, y: 40 }));
  });

  it('offers retry after simulation bootstrap fails', async () => {
    fetch.mockImplementation((url) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout')) return response({ revision: 0, layout: { schema_version: 1, nodes: [], edges: [] } });
      return response({ error: 'simulación caída' }, 500);
    });
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('simulación caída');
    expect(screen.getByRole('button', { name: /reiniciar simulación/i })).toBeEnabled();
  });

  it('preserves a rate-limited mid-turn and retries the exact request without a duplicate user bubble', async () => {
    const user = userEvent.setup();
    let answerAttempts = 0;
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout')) return response({ revision: 0, layout: { schema_version: 1, nodes: [], edges: [] } });
      const body = JSON.parse(options.body);
      if (body.input === '') return response({ session: { paso: 0 }, path: ['start'], outputs: [{ node_id: 'start', text: 'Pregunta inicial' }] });
      answerAttempts += 1;
      if (answerAttempts === 1) return response({ code: 'RATE_LIMITED', error: 'Reintenta en 12 segundos.', retryAfterSeconds: 12 }, 429);
      return response({ session: { paso: 1 }, path: ['start', 'name'], outputs: [{ node_id: 'name', text: 'Respuesta recuperada' }] });
    });
    const { container } = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await screen.findByText('Pregunta inicial');
    await user.type(screen.getByLabelText('Mensaje de prueba'), 'Sí');
    await user.click(screen.getByRole('button', { name: 'Enviar al simulador' }));
    await screen.findByRole('button', { name: 'Reintentar respuesta' });
    expect(screen.getByLabelText('Mensaje de prueba')).toBeDisabled();
    expect(container.querySelectorAll('.studio-bubble--user')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Reintentar respuesta' }));
    await screen.findByText('Respuesta recuperada');
    expect(container.querySelectorAll('.studio-bubble--user')).toHaveLength(1);
    const requests = fetch.mock.calls.filter(([url]) => new URL(url, location.origin).pathname.endsWith('/simulate')).slice(-2).map(([, options]) => JSON.parse(options.body));
    expect(requests[1]).toEqual(requests[0]);
  });

  it('aborts the active simulation request on unmount', async () => {
    let simulationSignal;
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout')) return response({ revision: 0, layout: { schema_version: 1, nodes: [], edges: [] } });
      simulationSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    await waitFor(() => expect(simulationSignal).toBeDefined());
    view.unmount();
    expect(simulationSignal.aborted).toBe(true);
  });

  it('guards rapid retry activation synchronously and appends one bot response', async () => {
    let answerAttempts = 0;
    let resolveRetry;
    fetch.mockImplementation((url, options = {}) => {
      const path = new URL(url, location.origin).pathname;
      if (path.endsWith('/definition')) return response(DEFINITION);
      if (path.endsWith('/layout')) return response({ revision: 0, layout: { schema_version: 1, nodes: [], edges: [] } });
      const body = JSON.parse(options.body);
      if (!body.input) return response({ session: {}, path: ['start'], outputs: [{ node_id: 'start', text: 'Pregunta inicial' }] });
      answerAttempts += 1;
      if (answerAttempts === 1) return response({ code: 'AUTH_UNAVAILABLE', error: 'Temporal' }, 503);
      return new Promise(resolve => { resolveRetry = resolve; });
    });
    const { container } = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Pregunta inicial');
    fireEvent.change(screen.getByLabelText('Mensaje de prueba'), { target: { value: 'Sí' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar al simulador' }));
    const retry = await screen.findByRole('button', { name: 'Reintentar respuesta' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(answerAttempts).toBe(2);
    resolveRetry(await response({ session: {}, path: ['start', 'name'], outputs: [{ node_id: 'name', text: 'Respuesta única' }] }));
    await screen.findByText('Respuesta única');
    expect(container.querySelectorAll('.studio-bubble--bot')).toHaveLength(2);
  });

  it('reconciles canonical server refreshes without overwriting dirty text', async () => {
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    const input = screen.getByLabelText('Mensaje del bot');

    view.rerender(<BotFlowStudio flows={[{ ...FLOWS[0], message: 'Texto fresco del servidor' }]} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    await waitFor(() => expect(input).toHaveValue('Texto fresco del servidor'));

    fireEvent.change(input, { target: { value: 'Mi edición local' } });
    view.rerender(<BotFlowStudio flows={[{ ...FLOWS[0], message: 'Versión externa' }]} areas={[]} onSaveFlow={vi.fn()} messageScope={{ versionId: 2, areaId: null }} />);
    expect(input).toHaveValue('Mi edición local');
    expect(await screen.findByText('Hay una versión más reciente')).toBeInTheDocument();
    expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Mi edición local');

    fireEvent.click(screen.getByRole('button', { name: 'Usar cambios guardados' }));
    expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Versión externa');
  });

  it('keeps a newer edit dirty when an older save finishes', async () => {
    let resolveSave;
    const onSaveFlow = vi.fn(() => new Promise(resolve => { resolveSave = resolve; }));
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: null }} />);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    const input = screen.getByLabelText('Mensaje del bot');
    fireEvent.change(input, { target: { value: 'Texto enviado' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar solo el mensaje/i }));
    fireEvent.change(input, { target: { value: 'Texto más nuevo' } });
    resolveSave({ ...FLOWS[0], message: 'Texto enviado' });

    await waitFor(() => expect(input).toHaveValue('Texto más nuevo'));
    expect(screen.getByRole('button', { name: /guardar solo el mensaje/i })).toBeEnabled();
  });

  it('ignores a message save response after the scope changes', async () => {
    let resolveSave;
    const onSaveFlow = vi.fn(() => new Promise(resolve => { resolveSave = resolve; }));
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: null }} />);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Texto del alcance anterior' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar solo el mensaje/i }));
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: 9 }} />);
    await waitFor(() => expect(screen.queryByLabelText('Inspector del bloque seleccionado')).not.toBeInTheDocument());
    resolveSave({ ...FLOWS[0], message: 'Respuesta atrasada' });
    await act(async () => {});

    expect(screen.queryByText('Respuesta atrasada')).not.toBeInTheDocument();
    expect(flowHarness.props.nodes.find(node => node.id === 'name')?.data.message).toBe('Indica tu nombre');
  });

  it('keeps all canonical draft fields stable through refresh and failed save', async () => {
    const onSaveFlow = vi.fn().mockRejectedValue(new Error('Sin conexión'));
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: null }} />);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Texto pendiente' } });
    fireEvent.click(screen.getByLabelText('Mensaje activo'));
    view.rerender(<BotFlowStudio flows={[{ ...FLOWS[0], message: 'Cambio remoto', active: true }]} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: null }} />);
    expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Texto pendiente');
    expect(screen.getByLabelText('Mensaje activo')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /guardar solo el mensaje/i }));
    expect(await screen.findByText('Sin conexión')).toBeInTheDocument();
    expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Texto pendiente');
  });

  it('commits a successful save before an older broad refresh can roll it back', async () => {
    const onSaveFlow = vi.fn(flow => Promise.resolve({ ...flow, message: flow.message }));
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: null }} />);
    fireEvent.click(await screen.findByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Guardado nuevo' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar solo el mensaje/i }));
    await waitFor(() => expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Guardado nuevo'));
    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={onSaveFlow} messageScope={{ versionId: 2, areaId: null }} />);
    expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Guardado nuevo');
  });

  it('toggles app focus mode and keeps contextual drawer state while panels remain exclusive', async () => {
    const user = userEvent.setup();
    const onFocusModeChange = vi.fn();
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} focusMode={false} onFocusModeChange={onFocusModeChange} />);
    await screen.findByText('Soporte de integraciones');
    await user.click(screen.getByRole('button', { name: 'Modo enfoque' }));
    expect(onFocusModeChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByLabelText('Hacer pregunta: Capturar nombre'));
    fireEvent.change(screen.getByLabelText('Mensaje del bot'), { target: { value: 'Edición conservada' } });
    expect(document.querySelector('.studio-workbench')).toHaveClass('studio-mobile-view--inspector');
    await user.click(screen.getByRole('button', { name: 'Probar' }));
    expect(document.querySelector('.studio-workbench')).toHaveClass('studio-mobile-view--simulator');
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByLabelText('Mensaje del bot')).toHaveValue('Edición conservada');

    view.rerender(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} focusMode onFocusModeChange={onFocusModeChange} />);
    expect(screen.getByLabelText('Bot Flow Studio')).toHaveClass('studio-shell--focus');
    await user.click(screen.getByRole('button', { name: 'Salir de enfoque' }));
    expect(onFocusModeChange).toHaveBeenLastCalledWith(false);
  });

  it('contains focus, makes the background inert, and restores both state and trigger focus on close', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const user = userEvent.setup();
    render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    const blocks = screen.getByRole('button', { name: 'Bloques' });
    await user.click(blocks);
    await waitFor(() => expect(screen.getByText('¿Qué quieres que ocurra?')).toHaveFocus());
    const palette = screen.getByRole('dialog', { name: 'Bloques disponibles' });
    expect(palette).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('.studio-toolbar')).toHaveAttribute('inert');
    expect(document.querySelector('.studio-canvas-wrap')).toHaveAttribute('inert');
    await user.tab({ shift: true });
    const paletteActions = within(palette).getAllByRole('button').filter(button => !button.disabled);
    expect(paletteActions.at(-1)).toHaveFocus();
    await user.tab();
    expect(paletteActions[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(blocks).toHaveFocus());
    expect(document.querySelector('.studio-toolbar')).not.toHaveAttribute('inert');
    expect(document.querySelector('.studio-canvas-wrap')).not.toHaveAttribute('inert');

    const simulator = screen.getByRole('button', { name: 'Probar' });
    await user.click(simulator);
    await waitFor(() => expect(screen.getByRole('button', { name: /reiniciar simulación/i })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Cerrar panel contextual' }));
    await waitFor(() => expect(simulator).toHaveFocus());
    expect(document.querySelector('.studio-toolbar')).not.toHaveAttribute('inert');
  });

  it('coalesces ResizeObserver fits, refits on transitions, and disconnects on unmount', async () => {
    let resizeCallback;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { this.callback = callback; }
      observe(element) { if (element.classList?.contains('studio-canvas-wrap')) resizeCallback = this.callback; }
      unobserve() {}
      disconnect() { disconnect(); }
    });
    const frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const view = render(<BotFlowStudio flows={FLOWS} areas={[]} onSaveFlow={vi.fn()} />);
    await screen.findByText('Soporte de integraciones');
    await waitFor(() => expect(resizeCallback).toEqual(expect.any(Function)));
    frames.splice(0).forEach(callback => callback());
    const initialFitCount = flowHarness.fitView.mock.calls.length;

    act(() => { resizeCallback(); resizeCallback(); });
    expect(cancel).toHaveBeenCalled();
    expect(frames).toHaveLength(2);
    act(() => frames.at(-1)());
    expect(flowHarness.fitView).toHaveBeenCalledTimes(initialFitCount + 1);

    await userEvent.click(screen.getByRole('button', { name: 'Bloques' }));
    expect(frames.length).toBeGreaterThan(2);
    act(() => frames.slice(2).forEach(callback => callback()));
    expect(flowHarness.fitView.mock.calls.length).toBeGreaterThan(initialFitCount + 1);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });
});

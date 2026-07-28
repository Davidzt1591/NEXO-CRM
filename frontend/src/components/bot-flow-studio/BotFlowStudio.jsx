import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addEdge, Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, reconnectEdge, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, CheckCircle2, HelpCircle, LockKeyhole, Maximize2, Minimize2, Plus, Redo2, RefreshCw, Save, Undo2, X } from 'lucide-react';
import { apiRequest, jsonBody } from '../../lib/apiClient';
import StudioNode from './StudioNode';
import StudioInspector from './StudioInspector';
import SimulatorPanel from './SimulatorPanel';
import { activeEdgeIds, buildStudioGraph, canConnectDraft, DECISION_ROUTES, DRAFT_KINDS, draftConnectionError, draftEdge, makeDraftNode, selectScopedFlow, validateDraft } from './flowModel';
import './studio.css';

const NODE_TYPES = Object.freeze({ inicio: StudioNode, preguntar: StudioNode, decidir: StudioNode, accion: StudioNode, finalizar: StudioNode });
const TUTORIAL_KEY = 'nexo.bot-flow-studio.connect-tutorial.v1';
const PANEL_FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
export default function BotFlowStudio(props) { return <ReactFlowProvider><StudioWorkspace {...props} /></ReactFlowProvider>; }

function StudioWorkspace({ flows, areas, onSaveFlow, saving, messageScope = { versionId: 1, areaId: null }, discardScopeCommand = null, onDirtyChange = () => {}, focusMode = false, onFocusModeChange = () => {}, onNavigateCandidateSettings = () => {} }) {
  const [definitionState, setDefinitionState] = useState({ loading: true, data: null, error: null });
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [labels, setLabels] = useState({});
  const [flowDraft, setFlowDraft] = useState(null);
  const [messageEditor, setMessageEditor] = useState({ identity: null, baseline: null, dirty: false, serverVersion: null, ignoredServerSignature: null, dismissedServerSignature: null });
  const [session, setSession] = useState(null);
  const [chat, setChat] = useState([]);
  const [path, setPath] = useState([]);
  const [simulating, setSimulating] = useState(false);
  const [simulationError, setSimulationError] = useState(null);
  const [pendingTurn, setPendingTurn] = useState(null);
  const [simulationSelection, setSimulationSelection] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [layoutSave, setLayoutSave] = useState({ revision: 0, state: 'loading', error: null, operation: 'load' });
  const [dirty, setDirty] = useState(false);
  const [mobileView, setMobileView] = useState('canvas');
  const [modalPanels, setModalPanels] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1100px)').matches);
  const canvasRef = useRef(null);
  const shellRef = useRef(null);
  const panelRef = useRef(null);
  const panelTriggerRef = useRef(null);
  const fitFrameRef = useRef(null);
  const { fitView } = useReactFlow();
  const [guidedConnect, setGuidedConnect] = useState(null);
  const [connectMessage, setConnectMessage] = useState('');
  const [showTutorial, setShowTutorial] = useState(() => { try { return localStorage.getItem(TUTORIAL_KEY) !== 'dismissed'; } catch { return true; } });
  const [, setHistoryRevision] = useState(0);
  const history = useRef({ past: [], future: [] });
  const scopeDrafts = useRef(new Map());
  const activeScope = useRef(null);
  const dragSnapshot = useRef(null);
  const draftCounter = useRef(0);
  const messageCounter = useRef(0);
  const messageEditRevision = useRef(0);
  const layoutEditRevision = useRef(0);
  const currentMessageIdentity = useRef(null);
  const requestGeneration = useRef(0);
  const definitionAbort = useRef(null);
  const simulationAborts = useRef(new Set());
  const activeSimulation = useRef(null);
  const firstRouteChoice = useRef(null);
  const bootstrappedScope = useRef(null);
  const persistedCanonical = useRef(new Map());
  const scopeKey = `${messageScope.versionId || 1}:${messageScope.areaId ?? 'global'}`;
  const scheduleFitView = useCallback(() => {
    window.cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = window.requestAnimationFrame(() => fitView({ padding: 0.18, duration: 0 }));
  }, [fitView]);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(scheduleFitView);
    observer.observe(element);
    return () => { observer.disconnect(); window.cancelAnimationFrame(fitFrameRef.current); };
  }, [definitionState.loading, scheduleFitView]);
  useEffect(() => { scheduleFitView(); }, [focusMode, mobileView, scheduleFitView]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(max-width: 1100px)');
    const update = event => setModalPanels(event.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  const layoutParams = useCallback(() => { const params = new URLSearchParams({ version_id: String(messageScope.versionId || 1) }); if (messageScope.areaId !== null && messageScope.areaId !== '' && messageScope.areaId !== undefined) params.set('area_id', String(messageScope.areaId)); return params; }, [messageScope.areaId, messageScope.versionId]);
  const markDirty = useCallback(() => {
    layoutEditRevision.current += 1;
    setDirty(true);
    setLayoutSave(previous => previous.state === 'saving' ? previous : { ...previous, state: 'idle', error: null, operation: null });
  }, []);
  useEffect(() => { onDirtyChange(dirty || messageEditor.dirty); }, [dirty, messageEditor.dirty, onDirtyChange]);

  const applyPersistedLayout = useCallback(payload => {
    const persisted = { nodes: [], edges: [], ...(payload.layout || {}) };
    const canonical = new Map(persisted.nodes.filter(node => node.kind === 'canonical').map(node => [node.id, node]));
    persistedCanonical.current = canonical;
    const nodeType = { entry: 'inicio', capture: 'preguntar', decision: 'decidir', effect: 'accion', terminal: 'finalizar' };
    const drafts = persisted.nodes.filter(node => node.kind === 'draft').map(node => ({ id: node.id, type: nodeType[node.type], position: node.position, data: { node_id: node.id, runtime_type: node.type, label: node.label, displayLabel: node.label, intentLabel: DRAFT_KINDS.find(item => item.runtimeType === node.type)?.label, message: node.message || '', branches: [], canonical: false } }));
    const draftEdges = persisted.edges.map(edge => { const route = DECISION_ROUTES.find(item => item.label === edge.label); return { id: edge.id, source: edge.source, target: edge.target, label: edge.label || 'Continuar', type: 'smoothstep', style: route ? { stroke: route.color } : undefined, data: { locked: false, draft: true, branch_id: route?.id || null, branch_color: route?.color || null } }; });
    setLabels(Object.fromEntries([...canonical].filter(([, node]) => node.label).map(([id, node]) => [id, node.label])));
    setNodes(current => current.filter(node => node.data.canonical).map(node => canonical.has(node.id) ? { ...node, position: canonical.get(node.id).position } : node).concat(drafts));
    setEdges(current => current.filter(edge => edge.data?.locked).concat(draftEdges));
    setLayoutSave({ revision: Number(payload.revision || 0), state: payload.revision ? 'saved' : 'idle', error: null, operation: null });
    setDirty(false);
  }, [setEdges, setNodes]);

  const loadLayout = useCallback(async () => {
    const local = scopeDrafts.current.get(scopeKey);
    if (local?.dirty) { setLayoutSave(local.layoutSave); setDirty(true); return; }
    const requestScope = scopeKey; const generation = requestGeneration.current;
    setLayoutSave(previous => ({ ...previous, state: 'loading', error: null, operation: 'load' }));
    try { const payload = await apiRequest(`/api/admin/bot-flow-studio/layout?${layoutParams()}`); if (generation === requestGeneration.current && requestScope === activeScope.current) applyPersistedLayout(payload); }
    catch (error) { if (generation === requestGeneration.current && requestScope === activeScope.current) setLayoutSave(previous => ({ ...previous, state: 'error', error: error.message || 'No se pudo cargar el borrador guardado.', operation: 'load' })); }
  }, [applyPersistedLayout, layoutParams, scopeKey]);

  const loadDefinition = useCallback(async () => {
    const requestScope = scopeKey;
    const generation = requestGeneration.current;
    definitionAbort.current?.abort();
    const controller = new AbortController();
    definitionAbort.current = controller;
    setDefinitionState(previous => ({ ...previous, loading: true, error: null }));
    const params = new URLSearchParams({ version_id: String(messageScope.versionId || 1) });
    if (messageScope.areaId !== null && messageScope.areaId !== '' && messageScope.areaId !== undefined) params.set('area_id', String(messageScope.areaId));
    try {
      const data = await apiRequest(`/api/admin/bot-flow-studio/definition?${params}`, { signal: controller.signal });
      if (generation === requestGeneration.current && requestScope === activeScope.current) setDefinitionState({ loading: false, data, scopeKey: requestScope, error: null });
    } catch (error) {
      if (error.name !== 'AbortError' && generation === requestGeneration.current && requestScope === activeScope.current) setDefinitionState({ loading: false, data: null, scopeKey: requestScope, error: error.message || 'No se pudo cargar la conversación.' });
    }
  }, [messageScope.areaId, messageScope.versionId, scopeKey]);

  const runSimulation = useCallback(async (nextSession, input, addUser = false) => {
    if (activeSimulation.current) return;
    const requestScope = scopeKey;
    const generation = requestGeneration.current;
    const controller = new AbortController();
    activeSimulation.current = controller;
    simulationAborts.current.add(controller);
    setSimulating(true); setSimulationError(null);
    const turn = { session: nextSession, input };
    if (addUser) setChat(previous => [...previous, { id: `user-${messageCounter.current++}`, role: 'user', text: input }]);
    try {
      const result = await apiRequest('/api/admin/bot-flow-studio/simulate', { method: 'POST', signal: controller.signal, body: jsonBody({ session: nextSession, input, version_id: Number(messageScope.versionId || 1), area_id: messageScope.areaId === '' || messageScope.areaId === undefined ? null : messageScope.areaId }) });
      if (generation !== requestGeneration.current || requestScope !== activeScope.current) return;
      setSession(result.session); setPath(previous => addUser ? [...new Set([...previous, ...(result.path || [])])] : (result.path || []));
      setPendingTurn(null);
      const currentOutput = result.outputs?.at(-1);
      const selectedProvenance = currentOutput ? result.provenance?.[currentOutput.node_id] : null;
      setSimulationSelection(selectedProvenance || null);
      setChat(previous => [...previous, ...(result.outputs || []).map(output => ({ id: `bot-${messageCounter.current++}`, role: 'bot', text: output.text, nodeId: output.node_id }))]);
      const currentId = currentOutput?.node_id || result.path?.at(-1);
      if (currentId) { setSelectedId(currentId); if (selectedProvenance?.message_key === 'candidate_exit') window.requestAnimationFrame(() => fitView({ nodes: [{ id: currentId }], padding: 0.35, duration: 200 })); }
    } catch (error) {
      if (error.name !== 'AbortError' && generation === requestGeneration.current && requestScope === activeScope.current) {
        setSimulationError(error.message || 'La prueba no pudo continuar. Intenta nuevamente.');
        if (addUser) setPendingTurn(turn);
      }
    } finally {
      simulationAborts.current.delete(controller);
      if (activeSimulation.current === controller) activeSimulation.current = null;
      if (generation === requestGeneration.current && requestScope === activeScope.current) setSimulating(false);
    }
  }, [fitView, messageScope.areaId, messageScope.versionId, scopeKey]);

  useEffect(() => () => {
    definitionAbort.current?.abort();
    simulationAborts.current.forEach(controller => controller.abort());
    simulationAborts.current.clear();
    activeSimulation.current = null;
  }, []);

  useLayoutEffect(() => {
    if (!activeScope.current) { activeScope.current = scopeKey; return; }
    const previousScope = activeScope.current;
    const discardPreviousScope = discardScopeCommand?.scopeKey === previousScope;
    if (discardPreviousScope) scopeDrafts.current.delete(previousScope);
    else scopeDrafts.current.set(previousScope, { nodes: nodes.filter(node => !node.data.canonical), edges: edges.filter(edge => !edge.data?.locked), labels, canonical: new Map(persistedCanonical.current), history: history.current, dirty, layoutSave });
    requestGeneration.current += 1;
    definitionAbort.current?.abort();
    simulationAborts.current.forEach(controller => controller.abort());
    simulationAborts.current.clear();
    activeSimulation.current = null;
    bootstrappedScope.current = null;
    const saved = scopeDrafts.current.get(scopeKey);
    persistedCanonical.current = new Map(saved?.canonical || []);
    history.current = saved?.history || { past: [], future: [] };
    setNodes(saved?.nodes || []); setEdges(saved?.edges || []); setLabels(saved?.labels || {}); setDirty(saved?.dirty || false); setLayoutSave(saved?.layoutSave || { revision: 0, state: 'loading', error: null, operation: 'load' });
    setSelectedId(null); setSelectedEdgeId(null); setFlowDraft(null); setMessageEditor({ identity: null, baseline: null, dirty: false, serverVersion: null, ignoredServerSignature: null, dismissedServerSignature: null }); setSaveError(null); setGuidedConnect(null); setConnectMessage('');
    setSession(null); setChat([]); setPath([]); setPendingTurn(null); setSimulationSelection(null); setSimulationError(null); setSimulating(false);
    setDefinitionState({ loading: true, data: null, scopeKey: null, error: null });
    setHistoryRevision(value => value + 1); activeScope.current = scopeKey;
  // Scope transitions intentionally snapshot the previous render before restoring the next local draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => { loadDefinition(); loadLayout(); }, [loadDefinition, loadLayout]);
  useEffect(() => {
    if (!definitionState.data?.definition) return;
    const graph = buildStudioGraph(definitionState.data.definition, labels);
    setNodes(current => [...graph.nodes.map(node => { const existing = current.find(item => item.id === node.id); const saved = persistedCanonical.current.get(node.id); return saved ? { ...node, position: saved.position } : existing?.data?.canonical ? { ...node, position: existing.position } : node; }), ...current.filter(node => !node.data.canonical)]);
    setEdges(current => [...graph.edges, ...current.filter(edge => !edge.data?.locked)]);
  }, [definitionState.data, labels, setEdges, setNodes]);
  useEffect(() => {
    if (!definitionState.data?.definition || definitionState.scopeKey !== scopeKey || bootstrappedScope.current === scopeKey) return;
    bootstrappedScope.current = scopeKey;
    runSimulation(null, '');
  }, [definitionState.data, definitionState.scopeKey, runSimulation, scopeKey]);

  const selectedGraphNode = nodes.find(node => node.id === selectedId);
  const selectedEdge = edges.find(edge => edge.id === selectedEdgeId) || null;
  const selectedNode = selectedGraphNode?.data || null;
  const canonicalVersionId = messageScope.versionId || definitionState.data?.version_id || 1;
  const selectedPersistedFlow = selectedNode?.canonical ? selectScopedFlow(flows, selectedNode.message_key, canonicalVersionId, messageScope.areaId) : null;
  const canonicalServerFlow = selectedNode?.canonical
    ? (selectedPersistedFlow ? { ...selectedPersistedFlow } : { id: null, version_id: canonicalVersionId, area_id: messageScope.areaId ?? '', step_key: selectedNode.message_key, message: selectedNode.message || '', sort_order: 0, active: true })
    : null;
  const canonicalEditorIdentity = selectedNode?.canonical ? `${scopeKey}:${selectedNode.node_id}:${canonicalServerFlow.id ?? `new:${selectedNode.message_key}`}` : null;
  currentMessageIdentity.current = canonicalEditorIdentity;
  const canonicalServerSignature = canonicalServerFlow ? JSON.stringify(canonicalServerFlow) : '';
  useEffect(() => {
    if (!selectedNode) return;
    if (!selectedNode.canonical) { setFlowDraft({ message: selectedNode.message || '' }); setMessageEditor({ identity: null, baseline: null, dirty: false, serverVersion: null, ignoredServerSignature: null, dismissedServerSignature: null }); return; }
    setMessageEditor(previous => {
      if (previous.identity !== canonicalEditorIdentity) {
        setFlowDraft(canonicalServerFlow);
        return { identity: canonicalEditorIdentity, baseline: canonicalServerFlow, dirty: false, serverVersion: null, ignoredServerSignature: null, dismissedServerSignature: null };
      }
      if (JSON.stringify(previous.baseline) === canonicalServerSignature) return previous.ignoredServerSignature ? { ...previous, ignoredServerSignature: null } : previous;
      if (previous.ignoredServerSignature === canonicalServerSignature || previous.dismissedServerSignature === canonicalServerSignature) return previous;
      if (previous.dirty) return { ...previous, serverVersion: canonicalServerFlow };
      setFlowDraft(canonicalServerFlow);
      return { ...previous, baseline: canonicalServerFlow, serverVersion: null };
    });
  // The stable identity/signature primitives intentionally gate reconciliation; object dependencies would retrigger on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonicalEditorIdentity, canonicalServerSignature, selectedId, selectedNode?.canonical]);

  const checkpoint = useCallback((state = { nodes, edges, labels }) => { history.current.past.push(state); history.current.future = []; setHistoryRevision(value => value + 1); }, [edges, labels, nodes]);
  const restore = (from, to) => { const state = from.pop(); if (!state) return; markDirty(); to.push({ nodes, edges, labels }); setNodes(state.nodes); setEdges(state.edges); setLabels(state.labels || {}); setSelectedId(null); setSelectedEdgeId(null); setFlowDraft(null); setHistoryRevision(value => value + 1); };
  const addDraft = runtimeType => { checkpoint(); markDirty(); const node = makeDraftNode(runtimeType, draftCounter.current++); setNodes(previous => [...previous, node]); setSelectedId(node.id); };
  const deleteSelected = () => { if (!selectedGraphNode || selectedGraphNode.data.canonical) return; checkpoint(); markDirty(); setNodes(previous => previous.filter(node => node.id !== selectedId)); setEdges(previous => previous.filter(edge => edge.source !== selectedId && edge.target !== selectedId)); setSelectedId(null); };
  const duplicateSelected = () => { if (!selectedGraphNode || selectedGraphNode.data.canonical) return; checkpoint(); markDirty(); const id = `draft-${Date.now()}-${draftCounter.current++}`; const copy = { ...selectedGraphNode, id, position: { x: selectedGraphNode.position.x + 36, y: selectedGraphNode.position.y + 36 }, data: { ...selectedGraphNode.data, node_id: id, displayLabel: `${selectedGraphNode.data.displayLabel} (copia)` } }; setNodes(previous => [...previous, copy]); setSelectedId(copy.id); };
  const updateSelectedDraft = (patch, withCheckpoint = false) => { if (withCheckpoint) checkpoint(); markDirty(); setNodes(previous => previous.map(node => node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node)); };
  const addDraftConnection = useCallback((connection, route = null) => {
    const error = draftConnectionError(nodes, edges, connection, route);
    if (error) { setConnectMessage(error); return false; }
    checkpoint(); markDirty(); setEdges(previous => addEdge(draftEdge(connection, route), previous)); setConnectMessage(route ? `Ruta “${route.label}” creada en el borrador.` : 'Conexión creada en el borrador.'); return true;
  }, [checkpoint, edges, markDirty, nodes, setEdges]);
  const onConnect = connection => { addDraftConnection(connection); };
  const onReconnect = (oldEdge, connection) => { const otherEdges = edges.filter(edge => edge.id !== oldEdge.id); const route = oldEdge.data?.branch_id ? { id: oldEdge.data.branch_id, label: oldEdge.label, color: oldEdge.data.branch_color } : null; const error = oldEdge.data?.locked ? null : draftConnectionError(nodes, otherEdges, connection, route); if (oldEdge.data?.locked || error) { if (error) setConnectMessage(error); return; } checkpoint(); markDirty(); setEdges(previous => reconnectEdge(oldEdge, connection, previous)); };
  const deleteSelectedEdge = () => { if (!selectedEdge || selectedEdge.data?.locked) return; checkpoint(); markDirty(); setEdges(previous => previous.filter(edge => edge.id !== selectedEdge.id)); setSelectedEdgeId(null); };
  const startNodeDrag = () => { dragSnapshot.current = { nodes, edges }; };
  const stopNodeDrag = (_, node) => { const before = dragSnapshot.current; dragSnapshot.current = null; const previousNode = before?.nodes.find(item => item.id === node.id); if (previousNode && (previousNode.position.x !== node.position.x || previousNode.position.y !== node.position.y)) { checkpoint(before); markDirty(); } };
  const cancelGuidedConnect = useCallback(() => { setGuidedConnect(null); setConnectMessage('Conexión cancelada.'); }, []);
  const startGuidedConnect = () => {
    if (!selectedGraphNode || selectedNode?.runtime_type === 'terminal') { setConnectMessage('Selecciona un bloque que pueda tener una salida.'); return; }
    const usedDecisionRoutes = new Set(edges.filter(edge => edge.source === selectedGraphNode.id).map(edge => edge.data?.branch_id).filter(Boolean));
    if (selectedNode.runtime_type === 'decision' && DECISION_ROUTES.every(route => usedDecisionRoutes.has(route.id))) { setConnectMessage('Todas las rutas están configuradas. Selecciona y elimina una ruta del borrador o elige otro bloque de origen.'); return; }
    setGuidedConnect({ source: selectedGraphNode.id, route: null }); setConnectMessage(selectedNode.runtime_type === 'decision' ? 'Paso 1 de 2: elige qué respuesta seguirá esta ruta.' : 'Paso 2 de 2: elige uno de los bloques resaltados como destino.'); setMobileView('canvas');
  };
  const chooseDecisionRoute = route => { setGuidedConnect(previous => ({ ...previous, route })); setConnectMessage(`Ruta “${route.label}”: ahora elige un bloque resaltado como destino.`); };
  const createGuidedDestination = () => { checkpoint(); markDirty(); const node = makeDraftNode('capture', draftCounter.current++); setNodes(previous => [...previous, node]); setConnectMessage('Bloque creado. Ahora elígelo como destino en esta lista.'); };
  const finishGuidedConnect = useCallback(target => {
    if (!guidedConnect) return;
    const source = nodes.find(node => node.id === guidedConnect.source);
    if (source?.data.runtime_type === 'decision' && !guidedConnect.route) { setConnectMessage('Primero elige Sí, No u Otra respuesta.'); return; }
    if (addDraftConnection({ source: guidedConnect.source, target }, guidedConnect.route)) setGuidedConnect(null);
  }, [addDraftConnection, guidedConnect, nodes]);
  useEffect(() => {
    if (!guidedConnect) return undefined;
    const onKeyDown = event => { if (event.key === 'Escape') { event.preventDefault(); cancelGuidedConnect(); } };
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelGuidedConnect, guidedConnect]);

  const closeContextPanel = useCallback((returnFocus = true) => {
    if (mobileView === 'canvas') return false;
    setMobileView('canvas');
    if (returnFocus) window.requestAnimationFrame(() => panelTriggerRef.current?.focus());
    return true;
  }, [mobileView]);
  const openContextPanel = useCallback((view, trigger) => {
    panelTriggerRef.current = trigger || document.activeElement;
    setMobileView(current => current === view ? 'canvas' : view);
  }, []);
  useEffect(() => {
    if (mobileView === 'canvas') return undefined;
    const panel = panelRef.current;
    if (modalPanels) {
      panel?.setAttribute('role', 'dialog');
      panel?.setAttribute('aria-modal', 'true');
    } else {
      panel?.removeAttribute('role');
      panel?.removeAttribute('aria-modal');
    }
    if (!modalPanels) {
      window.requestAnimationFrame(() => panel?.querySelector(`${PANEL_FOCUSABLE}, [tabindex="-1"]`)?.focus());
      const closeOnEscape = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        closeContextPanel(true);
      };
      window.addEventListener('keydown', closeOnEscape, true);
      return () => { window.removeEventListener('keydown', closeOnEscape, true); panel?.removeAttribute('role'); };
    }
    const shell = shellRef.current;
    const backdrop = shell?.querySelector('.studio-panel-backdrop');
    const inertElements = [];
    const makeInert = element => {
      if (!element || element === panel || element === backdrop || element.contains(panel) || element.contains(backdrop)) return;
      element.setAttribute('inert', '');
      inertElements.push(element);
    };
    [...(shell?.children || [])].forEach(makeInert);
    [...(shell?.querySelector('.studio-workbench')?.children || [])].forEach(makeInert);
    window.requestAnimationFrame(() => panel?.querySelector(`${PANEL_FOCUSABLE}, [tabindex="-1"]`)?.focus());
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeContextPanel(true);
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = [...panel.querySelectorAll(PANEL_FOCUSABLE)].filter(element => !element.closest('[inert]'));
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      inertElements.forEach(element => element.removeAttribute('inert'));
      panel?.removeAttribute('role');
      panel?.removeAttribute('aria-modal');
    };
  }, [closeContextPanel, mobileView, modalPanels]);

  const guidedSourceIsDecision = nodes.find(node => node.id === guidedConnect?.source)?.data.runtime_type === 'decision';
  const availableDecisionRoutes = useMemo(() => {
    if (!guidedConnect) return [];
    const used = new Set(edges.filter(edge => edge.source === guidedConnect.source).map(edge => edge.data?.branch_id).filter(Boolean));
    return DECISION_ROUTES.filter(route => !used.has(route.id));
  }, [edges, guidedConnect]);
  const selectedDecisionEdges = selectedNode?.runtime_type === 'decision' ? edges.filter(edge => edge.source === selectedId && edge.data?.branch_id) : [];
  const selectedDecisionRoutesExhausted = selectedNode?.runtime_type === 'decision' && DECISION_ROUTES.every(route => selectedDecisionEdges.some(edge => edge.data?.branch_id === route.id));
  const guidedDecisionRoutesExhausted = guidedSourceIsDecision && availableDecisionRoutes.length === 0;
  const chooseAnotherSource = () => { setGuidedConnect(null); setSelectedId(null); setConnectMessage('Selecciona otro bloque de origen.'); setMobileView('canvas'); };
  const selectDraftRoute = edge => { setGuidedConnect(null); setSelectedId(null); setSelectedEdgeId(edge.id); setConnectMessage(`Ruta “${edge.label}” seleccionada. Puedes eliminarla desde Editar.`); setMobileView('inspector'); };
  useEffect(() => {
    if (guidedConnect && guidedSourceIsDecision && !guidedConnect.route) firstRouteChoice.current?.focus();
  }, [guidedConnect, guidedSourceIsDecision, availableDecisionRoutes]);
  useEffect(() => {
    if (!guidedConnect?.route || availableDecisionRoutes.some(route => route.id === guidedConnect.route.id)) return;
    setGuidedConnect(previous => previous ? { ...previous, route: null } : previous);
    setConnectMessage(`La ruta “${guidedConnect.route.label}” ya no está disponible. Elige una ruta disponible o cancela la conexión.`);
  }, [availableDecisionRoutes, guidedConnect]);

  const saveLayout = async () => {
    const requestScope = scopeKey;
    const generation = requestGeneration.current;
    const requestEditRevision = layoutEditRevision.current;
    const layout = { schema_version: 1, nodes: nodes.map(node => node.data.canonical ? { id: node.id, kind: 'canonical', position: node.position, ...(labels[node.id]?.trim() ? { label: labels[node.id].trim() } : {}) } : { id: node.id, kind: 'draft', draft_only: true, type: node.data.runtime_type, position: node.position, label: node.data.displayLabel || node.data.label, ...(node.data.message?.trim() ? { message: node.data.message.trim() } : {}) }), edges: edges.filter(edge => !edge.data?.locked).map(edge => ({ id: edge.id, source: edge.source, target: edge.target, draft_only: true, ...(edge.label ? { label: String(edge.label) } : {}) })) };
    setLayoutSave(previous => ({ ...previous, state: 'saving', error: null, operation: 'save' }));
    try {
      const payload = await apiRequest(`/api/admin/bot-flow-studio/layout?${layoutParams()}`, { method: 'PUT', body: jsonBody({ revision: layoutSave.revision, layout }) });
      if (generation !== requestGeneration.current || requestScope !== activeScope.current) return;
      if (layoutEditRevision.current !== requestEditRevision) {
        setLayoutSave(previous => ({ ...previous, revision: Number(payload.revision ?? previous.revision), state: 'idle', error: null, operation: null }));
        setDirty(true);
        return;
      }
      applyPersistedLayout(payload);
    }
    catch (error) { if (generation === requestGeneration.current && requestScope === activeScope.current) setLayoutSave(previous => ({ ...previous, state: error.status === 409 ? 'conflict' : 'error', error: error.message || 'No se pudo guardar el borrador. Revisa tu conexión e intenta nuevamente.', operation: 'save' })); }
  };

  const highlightedEdges = useMemo(() => activeEdgeIds(path), [path]);
  const validDestinations = useMemo(() => {
    if (!guidedConnect) return new Set();
    const source = nodes.find(node => node.id === guidedConnect.source);
    if (source?.data.runtime_type === 'decision' && !guidedConnect.route) return new Set();
    return new Set(nodes.filter(node => !draftConnectionError(nodes, edges, { source: guidedConnect.source, target: node.id }, guidedConnect.route)).map(node => node.id));
  }, [edges, guidedConnect, nodes]);
  const displayNodes = useMemo(() => nodes.map(node => ({ ...node, className: [path.includes(node.id) ? 'studio-flow-node--active' : '', validDestinations.has(node.id) ? 'studio-flow-node--destination' : '', guidedConnect && !validDestinations.has(node.id) ? 'studio-flow-node--dimmed' : ''].filter(Boolean).join(' '), data: { ...node.data, guidedDestination: validDestinations.has(node.id), onGuidedDestination: finishGuidedConnect } })), [finishGuidedConnect, guidedConnect, nodes, path, validDestinations]);
  const guidedRouteAlreadyExists = guidedConnect?.route && edges.some(edge => edge.source === guidedConnect.source && edge.data?.branch_id === guidedConnect.route.id);
  const destinationBlockReason = guidedRouteAlreadyExists ? `La decisión ya tiene una ruta “${guidedConnect.route.label}”. Elige otra respuesta.` : guidedConnect && (!guidedSourceIsDecision || guidedConnect.route) && !validDestinations.size ? (nodes.some(node => !node.data.canonical) ? 'No quedan destinos válidos: ya están conectados, están protegidos o no pueden recibir esta ruta.' : 'No hay bloques de borrador que puedan recibir esta conexión.') : '';
  const displayEdges = useMemo(() => edges.map(edge => ({ ...edge, animated: highlightedEdges.has(`${edge.source}:${edge.target}`), className: highlightedEdges.has(`${edge.source}:${edge.target}`) ? 'studio-flow-edge--active' : edge.data?.locked ? 'studio-flow-edge--locked' : 'studio-flow-edge--draft' })), [edges, highlightedEdges]);
  const issues = useMemo(() => validateDraft(nodes, edges, definitionState.data?.definition?.entry_node_id), [definitionState.data, edges, nodes]);

  const resetSimulation = () => { setSession(null); setChat([]); setPath([]); setPendingTurn(null); setSimulationSelection(null); setSimulationError(null); runSimulation(null, ''); };
  const editSimulationMessage = () => { const nodeId = simulationSelection?.node_id; if (!nodeId) return; setSelectedEdgeId(null); setSelectedId(nodeId); setMobileView('inspector'); window.requestAnimationFrame(() => fitView({ nodes: [{ id: nodeId }], padding: 0.35, duration: 200 })); };
  const saveFlow = async event => {
    event.preventDefault();
    if (!selectedNode?.canonical) { updateSelectedDraft({ message: flowDraft?.message || '' }, true); return; }
    const requestScope = scopeKey;
    const generation = requestGeneration.current;
    const requestIdentity = canonicalEditorIdentity;
    const requestNodeId = selectedId;
    const requestRevision = messageEditRevision.current;
    const requestDraft = { ...flowDraft };
    setSaveError(null);
    try {
      const saved = await onSaveFlow(requestDraft);
      if (generation !== requestGeneration.current || requestScope !== activeScope.current || requestIdentity !== currentMessageIdentity.current) return;
      const committed = saved && typeof saved === 'object' ? { ...requestDraft, ...saved } : requestDraft;
      const hasNewerEdit = messageEditRevision.current !== requestRevision;
      if (!hasNewerEdit) setFlowDraft(committed);
      setMessageEditor(previous => ({ ...previous, identity: `${requestScope}:${requestNodeId}:${committed.id ?? `new:${committed.step_key}`}`, baseline: committed, dirty: hasNewerEdit, serverVersion: null, ignoredServerSignature: canonicalServerSignature, dismissedServerSignature: null }));
      updateVisibleMessage(requestNodeId, committed.message);
    }
    catch (error) { setSaveError(error?.message || 'No se pudo guardar el mensaje. El texto anterior sigue vigente.'); }
  };
  const updateVisibleMessage = (id, message) => setNodes(previous => previous.map(node => node.id === id ? { ...node, data: { ...node.data, message } } : node));
  const keepLocalMessage = () => setMessageEditor(previous => ({ ...previous, serverVersion: null, dismissedServerSignature: previous.serverVersion ? JSON.stringify(previous.serverVersion) : previous.dismissedServerSignature }));
  const reloadServerMessage = () => setMessageEditor(previous => {
    if (!previous.serverVersion) return previous;
    setFlowDraft(previous.serverVersion);
    updateVisibleMessage(selectedId, previous.serverVersion.message);
    return { ...previous, baseline: previous.serverVersion, dirty: false, serverVersion: null, ignoredServerSignature: null, dismissedServerSignature: null };
  });

  if (definitionState.loading) return <div className="studio-state"><div className="qr-loading__spinner" /><strong>Preparando la conversación…</strong><span>Estamos organizando sus pasos.</span></div>;
  if (definitionState.error) return <div className="studio-state studio-state--error"><AlertTriangle /><strong>No pudimos abrir la conversación</strong><span>{definitionState.error}</span><button onClick={loadDefinition}><RefreshCw size={15} /> Intentar de nuevo</button></div>;
  if (!definitionState.data?.definition?.nodes?.length) return <div className="studio-state"><strong>Esta conversación todavía no tiene pasos</strong><span>Cuando exista una versión vigente, aparecerá aquí.</span><button onClick={loadDefinition}><RefreshCw size={15} /> Volver a consultar</button></div>;

  const pathLabel = path.length ? `${path.length} pasos recorridos · ${selectedNode?.displayLabel || selectedNode?.label || 'Conversación en curso'}` : 'Preparando el primer mensaje';
  const persistenceLabel = layoutSave.state === 'loading' ? 'Cargando borrador guardado en NEXO…'
    : layoutSave.state === 'saving' ? 'Guardando borrador en NEXO…'
      : layoutSave.state === 'conflict' ? 'Hay cambios guardados en otra sesión — tu borrador local no se sobrescribió'
        : layoutSave.state === 'error' && layoutSave.operation === 'load' ? 'No se pudo cargar el borrador guardado en NEXO'
          : layoutSave.state === 'error' ? 'No se pudo guardar el borrador en NEXO — tus cambios siguen locales'
            : layoutSave.state === 'saved' && !dirty ? 'Borrador guardado en NEXO — no afecta WhatsApp activo'
              : dirty ? 'Borrador local sin guardar — no afecta WhatsApp activo'
                : 'Sin cambios locales — no afecta WhatsApp activo';
  return (
    <section ref={shellRef} className={`studio-shell ${focusMode ? 'studio-shell--focus' : ''}`} aria-label="Bot Flow Studio">
       <header className="studio-toolbar"><div><span className="studio-eyebrow">Diseñador de conversaciones</span><h3>{definitionState.data.definition.label}</h3></div><div className="studio-draft-save"><span role="status">{persistenceLabel}</span><button type="button" className="admin-primary-btn" onClick={saveLayout} disabled={!dirty || layoutSave.state === 'saving' || layoutSave.state === 'loading'}><Save size={15} /> Guardar en NEXO</button>{layoutSave.state === 'error' && layoutSave.operation === 'load' ? <button type="button" className="admin-soft-btn" onClick={loadLayout}><RefreshCw size={15} /> Reintentar carga</button> : null}{layoutSave.state === 'conflict' ? <button type="button" className="admin-soft-btn" onClick={() => { if (window.confirm('Recargar descartará el trabajo local sin guardar. ¿Quieres continuar?')) loadLayout(); }}>Descartar cambios y recargar</button> : null}{layoutSave.error ? <span role="alert">{layoutSave.error}</span> : null}</div><button type="button" className="studio-focus-toggle" aria-pressed={focusMode} onClick={() => onFocusModeChange(!focusMode)}>{focusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}{focusMode ? 'Salir de enfoque' : 'Modo enfoque'}</button><div className="studio-runtime-status"><LockKeyhole size={15} /> Guardado en NEXO sobrevive al recargar. Un borrador temporal/local solo dura esta sesión. Ninguno cambia el bot activo de WhatsApp.</div><div className={`studio-mobile-validation ${issues.length ? 'has-issues' : ''}`}>{issues.length ? `${issues.length} por revisar` : 'Borrador revisado'}</div></header>
        <div className={`studio-connect-ribbon ${guidedConnect ? 'active' : ''}`} role="region" aria-label="Asistente para conectar bloques"><strong>{guidedConnect ? 'Conectar bloque' : 'Diseña sin arrastrar'}</strong><span aria-live="polite">{guidedDecisionRoutesExhausted || selectedDecisionRoutesExhausted ? 'Todas las rutas están configuradas. Selecciona y elimina una ruta del borrador o elige otro bloque de origen.' : guidedConnect ? (destinationBlockReason || connectMessage) : 'Selecciona un bloque y usa “Conectar bloque”.'}</span>{guidedConnect?.source && guidedSourceIsDecision && !guidedConnect.route && !guidedDecisionRoutesExhausted ? <div className="studio-route-choices" aria-label="Respuesta de la decisión">{availableDecisionRoutes.map((route, index) => <button type="button" key={route.id} ref={index === 0 ? firstRouteChoice : null} onClick={() => chooseDecisionRoute(route)}>{route.label}</button>)}</div> : null}{guidedConnect && validDestinations.size ? <div className="studio-destination-choices" aria-label="Destinos válidos">{nodes.filter(node => validDestinations.has(node.id)).map((node, index) => <button type="button" key={node.id} autoFocus={index === 0} onClick={() => finishGuidedConnect(node.id)} aria-label={`Conectar con ${node.data.displayLabel}`}>{node.data.displayLabel}</button>)}</div> : null}{(guidedDecisionRoutesExhausted || selectedDecisionRoutesExhausted) ? <div className="studio-connect-recovery">{selectedDecisionEdges.filter(edge => !edge.data?.locked).map(edge => <button type="button" key={edge.id} onClick={() => selectDraftRoute(edge)}>Seleccionar ruta {edge.label}</button>)}<button type="button" onClick={chooseAnotherSource}>Elegir otro origen</button></div> : guidedConnect && !validDestinations.size && (!guidedSourceIsDecision || guidedConnect.route) ? <div className="studio-connect-recovery"><button type="button" onClick={createGuidedDestination}><Plus size={15} /> Crear bloque</button><button type="button" onClick={chooseAnotherSource}>Elegir otro origen</button></div> : null}{!guidedConnect && selectedGraphNode && selectedNode?.runtime_type !== 'terminal' && !selectedDecisionRoutesExhausted ? <button type="button" onClick={startGuidedConnect} className="studio-connect-toolbar-action">Conectar bloque</button> : null}{guidedConnect ? <button type="button" onClick={cancelGuidedConnect} className="studio-connect-cancel"><X size={15} /> Cancelar <kbd>Esc</kbd></button> : <button type="button" onClick={() => setShowTutorial(true)} className="studio-help-button"><HelpCircle size={15} /> Ayuda</button>}</div>
       <div className="sr-only" aria-live="assertive">{connectMessage}</div>
        {showTutorial ? <aside className="studio-connect-tutorial" aria-label="Guía para conectar bloques"><header><strong>Conecta tu conversación</strong><button type="button" aria-label="Cerrar guía" onClick={() => { setShowTutorial(false); try { localStorage.setItem(TUTORIAL_KEY, 'dismissed'); } catch { /* Storage may be unavailable. */ } }}><X size={16} /></button></header><ol><li>En <strong>Diseñar</strong>, selecciona el bloque de origen.</li><li>Presiona <strong>Conectar bloque</strong> en la franja superior.</li><li>Si es una decisión, elige <strong>Sí, No u Otra respuesta</strong>.</li><li>Elige un destino en la lista resaltada.</li></ol><p>Las conexiones son solo del borrador y no cambian WhatsApp activo.</p></aside> : null}
       <div className="studio-path-ribbon" role="status"><span className={simulating ? 'pulse' : ''} /><strong>Recorrido de prueba</strong><span>{pathLabel}</span></div>
       <nav className="studio-mobile-tabs" aria-label="Paneles del diseñador">{[['canvas',`Lienzo${issues.length ? ` · ${issues.length}` : ''}`],['palette','Bloques'],['inspector','Editar'],['simulator','Probar']].map(([id,label]) => <button key={id} type="button" aria-pressed={mobileView === id} className={mobileView === id ? 'active' : ''} onClick={event => id === 'canvas' ? closeContextPanel(false) : openContextPanel(id, event.currentTarget)}>{label}</button>)}</nav>
       <div className={`studio-workbench studio-mobile-view--${mobileView}`}>
         {mobileView !== 'canvas' ? <button type="button" className="studio-panel-backdrop" aria-label="Cerrar panel contextual" onClick={() => closeContextPanel(true)} /> : null}
         <aside ref={mobileView === 'palette' ? panelRef : null} className="studio-palette" aria-label="Bloques disponibles"><strong tabIndex={-1}>¿Qué quieres que ocurra?</strong><button type="button" className="studio-panel-close" aria-label="Cerrar bloques" onClick={() => closeContextPanel(true)}><X size={16} /></button><span>Agrega pasos al borrador local.</span>{DRAFT_KINDS.map(item => <button key={item.runtimeType} onClick={() => addDraft(item.runtimeType)}><Plus size={15} /> {item.label}</button>)}<div className="studio-history"><button aria-label="Deshacer" disabled={!history.current.past.length} onClick={() => restore(history.current.past, history.current.future)}><Undo2 size={16} /></button><button aria-label="Rehacer" disabled={!history.current.future.length} onClick={() => restore(history.current.future, history.current.past)}><Redo2 size={16} /></button></div></aside>
           <div ref={canvasRef} className={`studio-canvas-wrap studio-mobile-view--${mobileView}`}><div className="studio-unsaved" role="status">{persistenceLabel}</div><ReactFlow nodes={displayNodes} edges={displayEdges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onReconnect={onReconnect} onNodeDragStart={startNodeDrag} onNodeDragStop={stopNodeDrag} onNodeClick={(event, node) => { setSelectedEdgeId(null); setSelectedId(node.id); openContextPanel('inspector', event.currentTarget); }} onEdgeClick={(event, edge) => { if (!edge.data?.locked) { setSelectedId(null); setSelectedEdgeId(edge.id); openContextPanel('inspector', event.currentTarget); } }} isValidConnection={connection => canConnectDraft(nodes, connection, edges)} fitView minZoom={0.25} maxZoom={1.7} deleteKeyCode={null} nodesConnectable edgesReconnectable aria-label="Mapa de la conversación"><Background variant={BackgroundVariant.Dots} gap={24} size={1} /><Controls showInteractive={false} position="bottom-left" /><MiniMap pannable zoomable nodeStrokeWidth={3} position="bottom-right" /></ReactFlow></div>
           <div ref={mobileView === 'inspector' ? panelRef : null} className={`studio-inspector-wrap studio-mobile-view--${mobileView}`}><StudioInspector node={selectedNode} edge={selectedEdge} flow={flowDraft} areas={areas} label={labels[selectedId] ?? selectedNode?.displayLabel ?? selectedNode?.label ?? ''} saveError={saveError} serverConflict={messageEditor.serverVersion} onKeepLocal={keepLocalMessage} onReloadServer={reloadServerMessage} onLabelChange={value => { if (selectedNode?.canonical) { checkpoint(); markDirty(); setLabels(previous => ({ ...previous, [selectedId]: value })); } else updateSelectedDraft({ displayLabel: value, label: value }, true); }} onFlowChange={patch => { setFlowDraft(previous => { const next = { ...previous, ...patch }; if (selectedNode?.canonical) { messageEditRevision.current += 1; setMessageEditor(editor => ({ ...editor, dirty: JSON.stringify(next) !== JSON.stringify(editor.baseline) })); } return next; }); if (!selectedNode?.canonical && Object.hasOwn(patch, 'message')) updateSelectedDraft({ message: patch.message }, true); }} onSave={saveFlow} saving={saving} onDelete={deleteSelected} onDuplicate={duplicateSelected} onDeleteEdge={deleteSelectedEdge} onStartConnect={startGuidedConnect} onClose={() => closeContextPanel(true)} connecting={guidedConnect?.source === selectedId} connectDisabled={selectedDecisionRoutesExhausted} connectStatus={selectedDecisionRoutesExhausted ? 'Todas las rutas están configuradas' : ''} /></div>
      </div>
      <section className={`studio-validation studio-mobile-view--${mobileView}`}><header><div><strong>Revisión del borrador</strong><span>{issues.length ? `${issues.length} asuntos por resolver` : 'Listo para seguir diseñando'}</span></div>{issues.length ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}</header>{issues.length ? <ul>{issues.map((issue, index) => <li key={`${issue.nodeId}-${index}`}><button onClick={() => { setSelectedEdgeId(null); setSelectedId(issue.nodeId); setMobileView('inspector'); }}>{issue.text}</button></li>)}</ul> : <p>Los bloques del borrador tienen contenido y rutas comprensibles. Aun así, no pueden publicarse en esta etapa.</p>}</section>
       <div ref={mobileView === 'simulator' ? panelRef : null} className={`studio-simulator-wrap studio-mobile-view--${mobileView}`}><SimulatorPanel key={scopeKey} messages={chat} busy={simulating} error={simulationError} pending={pendingTurn} selection={simulationSelection} onEditSelected={editSimulationMessage} onNavigateCandidateSettings={onNavigateCandidateSettings} onSend={input => runSimulation(session, input, true)} onRetry={() => pendingTurn && runSimulation(pendingTurn.session, pendingTurn.input, false)} onReset={resetSimulation} onClose={() => closeContextPanel(true)} /></div>
    </section>
  );
}

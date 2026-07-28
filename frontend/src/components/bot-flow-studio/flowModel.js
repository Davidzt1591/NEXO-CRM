export const NODE_INTENTS = Object.freeze({
  entry: { type: 'inicio', label: 'Enviar mensaje' },
  capture: { type: 'preguntar', label: 'Hacer pregunta' },
  decision: { type: 'decidir', label: 'Tomar decisión' },
  effect: { type: 'accion', label: 'Ejecutar acción' },
  terminal: { type: 'finalizar', label: 'Finalizar' },
});

export const DRAFT_KINDS = Object.freeze([
  { runtimeType: 'entry', label: 'Enviar mensaje' },
  { runtimeType: 'capture', label: 'Hacer pregunta' },
  { runtimeType: 'decision', label: 'Tomar decisión' },
  { runtimeType: 'effect', label: 'Ejecutar acción' },
  { runtimeType: 'terminal', label: 'Finalizar' },
]);

export function definitionEdges(definition) {
  const edges = [];
  for (const node of definition?.nodes || []) {
    if (node.next) edges.push(runtimeEdge(node.node_id, node.next, 'Continuar'));
    for (const branch of node.branches || []) edges.push(runtimeEdge(node.node_id, branch.target, branch.label, branch.branch_id));
  }
  return edges;
}

export function layoutDepths(definition) {
  const nodes = definition?.nodes || [];
  const entry = definition?.entry_node_id || nodes[0]?.node_id;
  const outgoing = new Map(nodes.map(node => [node.node_id, []]));
  for (const edge of definitionEdges(definition)) outgoing.get(edge.source)?.push(edge.target);
  const depths = new Map(entry ? [[entry, 0]] : []);
  const queue = entry ? [entry] : [];
  while (queue.length) {
    const source = queue.shift();
    for (const target of outgoing.get(source) || []) {
      const depth = (depths.get(source) || 0) + 1;
      if (!depths.has(target) || depth < depths.get(target)) {
        depths.set(target, depth);
        queue.push(target);
      }
    }
  }
  let orphanDepth = Math.max(0, ...depths.values()) + 1;
  for (const node of nodes) if (!depths.has(node.node_id)) depths.set(node.node_id, orphanDepth++);
  return depths;
}

export function buildStudioGraph(definition, labelDrafts = {}) {
  const depths = layoutDepths(definition);
  const rows = new Map();
  const nodes = (definition?.nodes || []).map(node => {
    const depth = depths.get(node.node_id) || 0;
    const row = rows.get(depth) || 0;
    rows.set(depth, row + 1);
    const intent = NODE_INTENTS[node.runtime_type] || NODE_INTENTS.capture;
    return {
      id: node.node_id,
      type: intent.type,
      position: { x: 64 + depth * 300, y: 72 + row * 190 },
      data: { ...node, displayLabel: labelDrafts[node.node_id] ?? node.label, intentLabel: intent.label, canonical: true },
      deletable: false,
    };
  });
  return { nodes, edges: definitionEdges(definition) };
}

export function makeDraftNode(runtimeType, index, position) {
  const intent = NODE_INTENTS[runtimeType] || NODE_INTENTS.capture;
  const id = `draft-${Date.now()}-${index}`;
  return {
    id,
    type: intent.type,
    position: position || { x: 110 + index * 28, y: 110 + index * 34 },
    data: { node_id: id, runtime_type: runtimeType, label: intent.label, displayLabel: intent.label, intentLabel: intent.label, message: '', branches: [], canonical: false },
  };
}

export const DECISION_ROUTES = Object.freeze([
  { id: 'yes', label: 'Sí', color: '#35d3c8' },
  { id: 'no', label: 'No', color: '#ef7883' },
  { id: 'other', label: 'Otra respuesta', color: '#e4b85a' },
]);

export function draftEdge(connection, route = null) {
  return { ...connection, id: `draft-edge-${Date.now()}-${connection.source}-${connection.target}`, type: 'smoothstep', label: route?.label || 'Continuar', style: route?.color ? { stroke: route.color } : undefined, data: { locked: false, draft: true, branch_id: route?.id || null, branch_color: route?.color || null } };
}

function runtimeEdge(source, target, label, branchId = 'next') {
  return { id: `${source}:${branchId}:${target}`, source, target, label, type: 'smoothstep', data: { locked: true } };
}

export function activeEdgeIds(path = []) {
  const traversed = new Set();
  for (let index = 0; index < path.length - 1; index += 1) traversed.add(`${path[index]}:${path[index + 1]}`);
  return traversed;
}

export function validateDraft(nodes, edges, entryId) {
  const drafts = nodes.filter(node => !node.data.canonical);
  const reachable = new Set(entryId ? [entryId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) if (reachable.has(edge.source) && !reachable.has(edge.target)) { reachable.add(edge.target); changed = true; }
  }
  const issues = [];
  for (const node of drafts) {
    const connected = edges.some(edge => edge.source === node.id || edge.target === node.id);
    if (!connected) issues.push({ nodeId: node.id, text: `“${node.data.displayLabel}” está sin conectar.` });
    if (!node.data.displayLabel?.trim()) issues.push({ nodeId: node.id, text: 'Hay un bloque sin nombre.' });
    if (['entry', 'capture'].includes(node.data.runtime_type) && !node.data.message?.trim()) issues.push({ nodeId: node.id, text: `“${node.data.displayLabel || 'Bloque'}” necesita un mensaje.` });
    if (node.data.runtime_type === 'decision') {
      const routeIds = edges.filter(edge => edge.source === node.id).map(edge => edge.data?.branch_id).filter(Boolean);
      const routes = new Set(routeIds);
      if (!routes.has('yes')) issues.push({ nodeId: node.id, text: `“${node.data.displayLabel}” necesita la ruta “Sí”.` });
      if (!routes.has('no')) issues.push({ nodeId: node.id, text: `“${node.data.displayLabel}” necesita la ruta “No”.` });
      for (const route of DECISION_ROUTES) if (routeIds.filter(id => id === route.id).length > 1) issues.push({ nodeId: node.id, text: `“${node.data.displayLabel}” tiene más de una ruta “${route.label}”. Deja solo una.` });
    }
    if (entryId && !reachable.has(node.id)) issues.push({ nodeId: node.id, text: `“${node.data.displayLabel}” no puede alcanzarse desde el inicio.` });
  }
  return issues;
}

export function draftConnectionError(nodes, edges, connection, route = null) {
  if (!connection.source || !connection.target) return 'Selecciona un bloque de origen y uno de destino.';
  if (connection.source === connection.target) return 'Un bloque no puede conectarse consigo mismo.';
  const source = nodes.find(node => node.id === connection.source);
  const target = nodes.find(node => node.id === connection.target);
  if (!source || !target) return 'No encontramos uno de los bloques seleccionados.';
  if (source.data.runtime_type === 'terminal') return 'Un bloque “Finalizar” no puede tener una salida.';
  if (target.data.canonical) return 'Las entradas de la conversación vigente están protegidas.';
  if (edges.some(edge => edge.source === connection.source && edge.target === connection.target)) return 'Esa conexión ya existe.';
  const routeId = route?.id || route?.branch_id;
  if (source.data.runtime_type === 'decision' && !routeId) return 'Las decisiones deben conectarse con el asistente para elegir una ruta Sí, No u Otra respuesta.';
  if (source.data.runtime_type === 'decision' && routeId && edges.some(edge => edge.source === connection.source && edge.data?.branch_id === routeId)) {
    const routeLabel = DECISION_ROUTES.find(item => item.id === routeId)?.label || route?.label || routeId;
    return `La decisión ya tiene una ruta “${routeLabel}”. Elige otra respuesta.`;
  }
  return null;
}

export function canConnectDraft(nodes, connection, edges = [], route = null) {
  return !draftConnectionError(nodes, edges, connection, route);
}

export function connectDraft(nodes, edges, connection) {
  return canConnectDraft(nodes, connection, edges) ? [...edges, draftEdge(connection)] : edges;
}

export function reconnectDraft(nodes, edges, edgeId, connection) {
  const edge = edges.find(item => item.id === edgeId);
  const otherEdges = edges.filter(item => item.id !== edgeId);
  if (!edge || !canConnectDraft(nodes, connection, otherEdges, { id: edge.data?.branch_id, label: edge.label })) return edges;
  return edges.map(edge => edge.id === edgeId && !edge.data?.locked ? { ...edge, ...connection } : edge);
}

export function deleteDraftNode(nodes, edges, nodeId) {
  const node = nodes.find(item => item.id === nodeId);
  if (!node || node.data.canonical) return { nodes, edges };
  return { nodes: nodes.filter(item => item.id !== nodeId), edges: edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId) };
}

export function deleteDraftEdge(edges, edgeId) {
  return edges.filter(edge => edge.id !== edgeId || edge.data?.locked);
}

export function selectScopedFlow(flows, stepKey, versionId, areaId) {
  const normalizedArea = areaId === '' || areaId === undefined ? null : areaId;
  return flows.find(flow => flow.step_key === stepKey && Number(flow.version_id) === Number(versionId) && String(flow.area_id ?? '') === String(normalizedArea ?? '')) || null;
}

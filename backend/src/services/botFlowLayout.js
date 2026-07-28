const { BOT_FLOW_DEFINITION } = require('./botFlowDefinition');

const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_NODES = 120;
const MAX_EDGES = 240;
const MAX_TEXT = 2000;
const MAX_LABEL = 120;
const DRAFT_TYPES = Object.freeze(['entry', 'capture', 'decision', 'effect', 'terminal']);
const CANONICAL_IDS = new Set(BOT_FLOW_DEFINITION.nodes.map(node => node.node_id));
const ID_PATTERN = /^draft-[A-Za-z0-9_-]{1,100}$/;

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'INVALID_BOT_FLOW_LAYOUT';
  return error;
}

function assertClosedObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} debe ser un objeto.`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw invalid(`${label} contiene campos no soportados.`);
}

function text(value, label, max, optional = false) {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /<\/?[a-z][^>]*>/i.test(value)) throw invalid(`${label} no es válido.`);
  return value.trim();
}

function position(value, label) {
  assertClosedObject(value, ['x', 'y'], label);
  if (![value.x, value.y].every(number => Number.isFinite(number) && Math.abs(number) <= 100000)) throw invalid(`${label} debe contener coordenadas acotadas.`);
  return { x: Math.round(value.x * 100) / 100, y: Math.round(value.y * 100) / 100 };
}

function validateLayoutRequest(body, contentLength) {
  if (Number(contentLength || 0) > MAX_REQUEST_BYTES) throw invalid('El borrador excede el tamaño permitido.');
  assertClosedObject(body, ['revision', 'layout'], 'La solicitud');
  if (!Number.isInteger(body.revision) || body.revision < 0 || body.revision > 2147483647) throw invalid('revision debe ser un entero no negativo.');
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) throw invalid('El borrador excede el tamaño permitido.');
  return { revision: body.revision, layout: normalizeLayout(body.layout) };
}

function normalizeLayout(layout) {
  assertClosedObject(layout, ['schema_version', 'nodes', 'edges'], 'layout');
  if (layout.schema_version !== 1) throw invalid('schema_version debe ser 1.');
  if (!Array.isArray(layout.nodes) || layout.nodes.length > MAX_NODES) throw invalid(`layout.nodes admite máximo ${MAX_NODES} elementos.`);
  if (!Array.isArray(layout.edges) || layout.edges.length > MAX_EDGES) throw invalid(`layout.edges admite máximo ${MAX_EDGES} elementos.`);
  const ids = new Set();
  const nodes = layout.nodes.map((node, index) => {
    assertClosedObject(node, ['id', 'kind', 'position', 'label', 'message', 'type', 'draft_only'], `nodes[${index}]`);
    const id = text(node.id, `nodes[${index}].id`, 120);
    if (ids.has(id)) throw invalid(`El nodo ${id} está duplicado.`);
    ids.add(id);
    if (node.kind === 'canonical') {
      if (!CANONICAL_IDS.has(id)) throw invalid(`El node id canónico ${id} no está permitido.`);
      if (node.message !== undefined || node.type !== undefined || node.draft_only !== undefined) throw invalid('Los nodos canónicos solo admiten posición y nombre visible.');
      return compact({ id, kind: 'canonical', position: position(node.position, `nodes[${index}].position`), label: text(node.label, `nodes[${index}].label`, MAX_LABEL, true) });
    }
    if (node.kind !== 'draft' || node.draft_only !== true || !ID_PATTERN.test(id) || !DRAFT_TYPES.includes(node.type)) throw invalid(`El nodo ${id} no es un borrador permitido.`);
    return compact({ id, kind: 'draft', draft_only: true, type: node.type, position: position(node.position, `nodes[${index}].position`), label: text(node.label, `nodes[${index}].label`, MAX_LABEL), message: text(node.message, `nodes[${index}].message`, MAX_TEXT, true) });
  });
  const edges = layout.edges.map((edge, index) => {
    assertClosedObject(edge, ['id', 'source', 'target', 'label', 'draft_only'], `edges[${index}]`);
    const id = text(edge.id, `edges[${index}].id`, 160);
    const source = text(edge.source, `edges[${index}].source`, 120);
    const target = text(edge.target, `edges[${index}].target`, 120);
    if (edge.draft_only !== true || !ids.has(source) || !ids.has(target) || CANONICAL_IDS.has(target)) throw invalid(`La ruta ${id} debe ser draft_only y terminar en un borrador.`);
    return compact({ id, source, target, draft_only: true, label: text(edge.label, `edges[${index}].label`, MAX_LABEL, true) });
  });
  return { schema_version: 1, nodes, edges };
}

function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function serializeLayoutRow(row, versionId, areaId) {
  return { version_id: Number(row?.version_id ?? versionId), area_id: row?.area_id ?? areaId ?? null, revision: Number(row?.revision || 0), layout: row?.layout || { schema_version: 1, nodes: [], edges: [] }, updated_at: row?.updated_at || null };
}
function isSchemaMissingError(error) { return ['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error?.code) || /bot_flow_studio_layouts|put_bot_flow_studio_layout/i.test(error?.message || ''); }
function schemaUnavailableError() { const error = new Error('La persistencia de borradores aún no está habilitada. Aplica el artefacto SQL phase8.'); error.statusCode = 503; error.code = 'BOT_FLOW_LAYOUT_SCHEMA_UNAVAILABLE'; return error; }

module.exports = { DRAFT_TYPES, MAX_EDGES, MAX_NODES, MAX_REQUEST_BYTES, normalizeLayout, serializeLayoutRow, validateLayoutRequest, isSchemaMissingError, schemaUnavailableError };

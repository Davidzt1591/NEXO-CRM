const { FALLBACK_MESSAGES } = require('./botFlowMessages');

const RUNTIME_TYPES = Object.freeze(['entry', 'decision', 'capture', 'effect', 'terminal']);
const INPUT_TYPES = Object.freeze(['text', 'categoria', 'nombre', 'empresa', 'correo', 'situacion']);

const nodes = [
  { node_id: 'outside-business-hours', label: 'Fuera de horario', runtime_type: 'terminal', message_key: 'out_of_office', inputs: [], branches: [], next: null },
  { node_id: 'audience-menu', label: 'Tipo de usuario', runtime_type: 'entry', message_key: 'welcome_audience', inputs: ['text'], branches: [{ branch_id: 'analyst', label: 'Analista', target: 'category-menu' }, { branch_id: 'candidate', label: 'Candidato', target: 'candidate-exit' }, { branch_id: 'invalid', label: 'Respuesta inválida', target: 'invalid-audience-answer' }], next: null },
  { node_id: 'invalid-audience-answer', label: 'Reintento de tipo de usuario', runtime_type: 'terminal', message_key: 'audience_invalid', inputs: [], branches: [], next: 'audience-menu' },
  { node_id: 'candidate-exit', label: 'Salida de candidato', runtime_type: 'terminal', message_key: 'candidate_exit', inputs: [], branches: [], next: null },
  { node_id: 'category-menu', label: 'Categoría de solicitud', runtime_type: 'decision', message_key: 'ask_category', inputs: ['text'], branches: [{ branch_id: 'platform', label: 'Plataforma', target: 'capture-name' }, { branch_id: 'tests', label: 'Resultados de pruebas', target: 'capture-name' }, { branch_id: 'requests', label: 'Solicitudes', target: 'capture-name' }, { branch_id: 'integrations', label: 'Integraciones', target: 'capture-name' }, { branch_id: 'other', label: 'Otro / Contacto por correo', target: 'other-email-exit' }, { branch_id: 'invalid', label: 'Respuesta inválida', target: 'invalid-category-answer' }], next: null },
  { node_id: 'other-email-exit', label: 'Otro / Contacto por correo', runtime_type: 'terminal', message_key: 'other_email_exit', inputs: [], branches: [], next: null },
  { node_id: 'invalid-category-answer', label: 'Reintento de categoría', runtime_type: 'terminal', message_key: 'category_invalid', inputs: [], branches: [], next: 'category-menu' },
  { node_id: 'capture-name', label: 'Capturar nombre', runtime_type: 'capture', message_key: 'data_notice_and_ask_name', inputs: ['nombre'], branches: [], next: 'capture-company' },
  { node_id: 'capture-company', label: 'Capturar empresa', runtime_type: 'capture', message_key: 'ask_company', inputs: ['empresa'], branches: [], next: 'capture-email' },
  { node_id: 'capture-email', label: 'Capturar correo', runtime_type: 'capture', message_key: 'ask_email', inputs: ['correo'], branches: [], next: 'capture-issue' },
  { node_id: 'capture-issue', label: 'Capturar incidencia', runtime_type: 'capture', message_key: 'ask_issue', inputs: ['situacion'], branches: [], next: 'confirm-summary' },
  { node_id: 'confirm-summary', label: 'Confirmar resumen', runtime_type: 'decision', message_key: 'confirm_summary', inputs: ['text'], branches: [{ branch_id: 'confirm', label: 'Confirmar', target: 'create-ticket' }, { branch_id: 'correct', label: 'Corregir', target: 'restart-data' }, { branch_id: 'invalid', label: 'Respuesta inválida', target: 'invalid-confirmation' }], next: null },
  { node_id: 'invalid-confirmation', label: 'Reintento de confirmación', runtime_type: 'terminal', message_key: 'confirm_invalid', inputs: [], branches: [], next: 'confirm-summary' },
  { node_id: 'restart-data', label: 'Reiniciar datos', runtime_type: 'terminal', message_key: 'restart_data', inputs: [], branches: [], next: 'capture-name' },
  { node_id: 'create-ticket', label: 'Crear ticket', runtime_type: 'effect', message_key: 'processing', inputs: [], branches: [{ branch_id: 'success', label: 'Registro exitoso', target: 'ticket-confirmation' }, { branch_id: 'failure', label: 'Error de registro', target: 'ticket-error' }], next: null },
  { node_id: 'ticket-confirmation', label: 'Confirmación', runtime_type: 'terminal', message_key: 'confirmation', inputs: [], branches: [], next: null },
  { node_id: 'ticket-error', label: 'Error de ticket', runtime_type: 'terminal', message_key: 'ticket_error', inputs: [], branches: [], next: null },
];

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const BOT_FLOW_DEFINITION = deepFreeze({
  schema_version: 2,
  flow_id: 'nexo-whatsapp-support',
  label: 'Soporte para analistas',
  entry_node_id: 'audience-menu',
  runtime_types: RUNTIME_TYPES,
  nodes,
});

function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw validationError('La definición del flujo debe ser un objeto.');
  assertKeys(definition, ['schema_version', 'flow_id', 'label', 'entry_node_id', 'runtime_types', 'nodes'], 'La definición');
  if (definition.schema_version !== 2) throw validationError('schema_version debe ser 2.');
  for (const key of ['flow_id', 'label', 'entry_node_id']) requireText(definition[key], key);
  if (!Array.isArray(definition.runtime_types) || definition.runtime_types.length !== RUNTIME_TYPES.length || definition.runtime_types.some((value, index) => value !== RUNTIME_TYPES[index])) throw validationError('runtime_types no coincide con el runtime soportado.');
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) throw validationError('La definición debe incluir nodos.');
  const ids = new Set();
  for (const node of definition.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw validationError('Cada nodo debe ser un objeto.');
    assertKeys(node, ['node_id', 'label', 'runtime_type', 'message_key', 'inputs', 'branches', 'next'], `El nodo ${node.node_id || '(sin id)'}`);
    requireText(node.node_id, 'node_id');
    requireText(node.label, `label de ${node.node_id}`);
    requireText(node.message_key, `message_key de ${node.node_id}`);
    if (ids.has(node.node_id)) throw validationError(`El node_id ${node.node_id} está duplicado.`);
    ids.add(node.node_id);
    if (!RUNTIME_TYPES.includes(node.runtime_type)) throw validationError(`El runtime_type ${node.runtime_type || '(vacío)'} no está soportado.`);
    if (!Object.hasOwn(FALLBACK_MESSAGES, node.message_key)) throw validationError(`El message_key ${node.message_key} no existe.`);
    if (!Array.isArray(node.inputs) || node.inputs.some(input => !INPUT_TYPES.includes(input))) throw validationError(`El nodo ${node.node_id} contiene inputs inválidos.`);
    if (!Array.isArray(node.branches)) throw validationError(`branches de ${node.node_id} debe ser un arreglo.`);
    const branchIds = new Set();
    for (const branch of node.branches) {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) throw validationError(`El nodo ${node.node_id} contiene una rama inválida.`);
      assertKeys(branch, ['branch_id', 'label', 'target'], `Una rama de ${node.node_id}`);
      requireText(branch.branch_id, `branch_id de ${node.node_id}`);
      requireText(branch.label, `label de rama de ${node.node_id}`);
      requireText(branch.target, `target de ${node.node_id}`);
      if (branchIds.has(branch.branch_id)) throw validationError(`El nodo ${node.node_id} contiene branch_id duplicado.`);
      branchIds.add(branch.branch_id);
    }
    if (node.next !== null && (typeof node.next !== 'string' || !node.next)) throw validationError(`next de ${node.node_id} debe ser texto o null.`);
    if (node.next && node.branches.length) throw validationError(`El nodo ${node.node_id} no puede combinar next y branches.`);
    if (node.runtime_type === 'capture' && (node.inputs.length !== 1 || !node.next || node.branches.length)) throw validationError(`El nodo de captura ${node.node_id} tiene una forma inválida.`);
    if (['entry', 'decision', 'effect'].includes(node.runtime_type) && node.branches.length === 0) throw validationError(`El nodo ${node.node_id} debe incluir ramas.`);
  }
  if (!ids.has(definition.entry_node_id)) throw validationError('El nodo de entrada no existe.');
  for (const node of definition.nodes) {
    const targets = [node.next, ...node.branches.map(branch => branch.target)].filter(Boolean);
    if (targets.some(target => !ids.has(target))) throw validationError(`El nodo ${node.node_id} contiene una transición inválida.`);
  }
  return definition;
}

function assertKeys(value, allowed, label) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw validationError(`${label} contiene campos no soportados.`);
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw validationError(`${label} debe ser texto no vacío.`);
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'INVALID_FLOW_DEFINITION';
  return error;
}

function getBotFlowDefinition(messages = {}) {
  return {
    ...BOT_FLOW_DEFINITION,
    nodes: BOT_FLOW_DEFINITION.nodes.map(node => ({ ...node, message: messages[node.message_key] })),
  };
}

module.exports = { BOT_FLOW_DEFINITION, RUNTIME_TYPES, deepFreeze, getBotFlowDefinition, validateDefinition };

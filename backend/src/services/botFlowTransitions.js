const LEGACY_PASOS = Object.freeze([0, 1, 2, 3, 4, 5]);
const SEMANTIC_STATES = Object.freeze(['audience_choice', 'issue_category', 'capture_name', 'capture_company', 'capture_email', 'capture_issue', 'confirm_summary', 'ticket_complete']);
const PASOS = Object.freeze([...LEGACY_PASOS, 'filtro_no', ...SEMANTIC_STATES]);

const aliases = Object.freeze({
  analyst: ['1', 'analista', 'soy analista'], candidate: ['2', 'candidato', 'candidata', 'soy candidato', 'soy candidata'],
  platform: ['1', 'plataforma', 'plataforma magneto', 'magneto'], tests: ['2', 'resultados de pruebas', 'pruebas', 'tests', 'potential365', 'potential 365', 'knowledge365', 'knowledge 365', 'pyxoom'],
  requests: ['3', 'solicitud', 'solicitudes'], integrations: ['4', 'integracion', 'integraciones'], other: ['5', 'otro', 'otra', 'otros'],
  confirm: ['1', 'si', 'confirmar', 'confirmo', 'crear ticket'], correct: ['2', 'no', 'corregir', 'editar', 'cambiar'],
});
const CATEGORY_LABELS = Object.freeze({ platform: 'Platform', tests: 'Tests', requests: 'Requests', integrations: 'Integrations', other: 'Other' });

function normalizeChoice(input) {
  return String(input ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function matchAlias(input, keys) {
  const value = normalizeChoice(input);
  return keys.find(key => aliases[key].includes(value)) || null;
}
function cleanCapture(input) {
  return String(input ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}
function validCapture(field, value) {
  const bounds = { nombre: [2, 120], empresa: [2, 160], correo: [3, 254], situacion: [10, 4000] };
  const [min, max] = bounds[field];
  if (value.length < min || value.length > max) return false;
  return field !== 'correo' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function semanticTransition(session, input) {
  const paso = session.paso;
  if (paso === 'audience_choice') {
    const choice = matchAlias(input, ['analyst', 'candidate']);
    if (choice === 'candidate') return Object.freeze({ type: 'end', messageKey: 'candidate_exit', reason: 'candidate_exit' });
    if (choice === 'analyst') return Object.freeze({ type: 'advance', nextPaso: 'issue_category', messageKey: 'ask_category' });
    return Object.freeze({ type: 'retry', nextPaso: paso, messageKey: 'audience_invalid' });
  }
  if (paso === 'issue_category') {
    const category = matchAlias(input, ['platform', 'tests', 'requests', 'integrations', 'other']);
    if (!category) return Object.freeze({ type: 'retry', nextPaso: paso, messageKey: 'category_invalid' });
    if (category === 'other') return Object.freeze({ type: 'end', messageKey: 'other_email_exit', reason: 'other_email_exit' });
    return Object.freeze({ type: 'category', field: 'categoria', categoryKey: category, value: CATEGORY_LABELS[category], nextPaso: 'capture_name', messageKey: 'data_notice_and_ask_name' });
  }
  const captures = {
    capture_name: ['nombre', 'capture_company', 'ask_company'], capture_company: ['empresa', 'capture_email', 'ask_email'],
    capture_email: ['correo', 'capture_issue', 'ask_issue'], capture_issue: ['situacion', 'confirm_summary', 'confirm_summary'],
  };
  if (captures[paso]) {
    const [field, nextPaso, messageKey] = captures[paso];
    const value = cleanCapture(input);
    if (!validCapture(field, value)) return Object.freeze({ type: 'retry', nextPaso: paso, messageKey: paso === 'capture_name' ? 'restart_data' : ({ capture_company: 'ask_company', capture_email: 'ask_email', capture_issue: 'ask_issue' })[paso] });
    return Object.freeze({ type: 'capture', field, value, nextPaso, messageKey });
  }
  if (paso === 'confirm_summary') {
    const choice = matchAlias(input, ['confirm', 'correct']);
    if (choice === 'confirm') return Object.freeze({ type: 'ticket', successPaso: 'ticket_complete', messageKey: 'processing' });
    if (choice === 'correct') return Object.freeze({ type: 'correct', nextPaso: 'capture_name', messageKey: 'restart_data' });
    return Object.freeze({ type: 'retry', nextPaso: paso, messageKey: 'confirm_invalid' });
  }
  if (paso === 'ticket_complete') return Object.freeze({ type: 'complete', nextPaso: paso });
  return null;
}

function legacyTransition(session) {
  switch (session.paso) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
      return Object.freeze({ type: 'migrate', nextPaso: 'audience_choice', messageKey: 'legacy_migration_audience' });
    case 5: return Object.freeze({ type: 'complete', nextPaso: 5 });
    default: return Object.freeze({ type: 'noop', reason: 'unknown_legacy_paso', nextPaso: session.paso });
  }
}

function decideFlowTransition(session, input = '') {
  if (session == null) return Object.freeze({ type: 'start', nextPaso: 'audience_choice', messageKey: 'welcome_audience' });
  if (session.paso === 'filtro_no') return Object.freeze({ type: 'migrate', nextPaso: 'audience_choice', messageKey: 'legacy_migration_audience' });
  if (typeof session.paso === 'number') return legacyTransition(session, input);
  return semanticTransition(session, input) || Object.freeze({ type: 'noop', reason: 'unknown_state', nextPaso: session.paso });
}

module.exports = { CATEGORY_LABELS, PASOS, SEMANTIC_STATES, cleanCapture, decideFlowTransition, normalizeChoice, validCapture };

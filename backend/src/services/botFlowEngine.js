const { BOT_FLOW_DEFINITION, validateDefinition } = require('./botFlowDefinition');
const { FALLBACK_MESSAGES, escapeWhatsApp, interpolate } = require('./botFlowMessages');
const { PASOS, decideFlowTransition } = require('./botFlowTransitions');

const MAX_INPUT_LENGTH = 4000;
const MAX_CAPTURE_LENGTH = 4000;
const MAX_TICKET_ID_LENGTH = 64;
const SESSION_FIELDS = Object.freeze(['paso', 'categoria', 'categoryKey', 'nombre', 'empresa', 'correo', 'situacion', 'ticketId', 'flowVersionId', 'submissionId']);
const CAPTURE_FIELDS = Object.freeze(['categoria', 'nombre', 'empresa', 'correo', 'situacion']);
const STATE_NODE = Object.freeze({
  audience_choice: 'audience-menu', issue_category: 'category-menu', capture_name: 'capture-name', capture_company: 'capture-company',
  capture_email: 'capture-email', capture_issue: 'capture-issue', confirm_summary: 'confirm-summary', ticket_complete: 'ticket-confirmation',
  0: 'legacy-integration-filter', filtro_no: 'audience-menu', 1: 'capture-name', 2: 'capture-company', 3: 'capture-email', 4: 'capture-issue', 5: 'ticket-confirmation',
});
const MESSAGE_NODE = Object.freeze({
  welcome_audience: 'audience-menu', audience_invalid: 'invalid-audience-answer', candidate_exit: 'candidate-exit', ask_category: 'category-menu',
  category_invalid: 'invalid-category-answer', data_notice_and_ask_name: 'capture-name', ask_name: 'capture-name', ask_company: 'capture-company',
  ask_email: 'capture-email', ask_issue: 'capture-issue', confirm_summary: 'confirm-summary', confirm_invalid: 'invalid-confirmation', restart_data: 'restart-data',
  processing: 'create-ticket', confirmation: 'ticket-confirmation', ticket_error: 'ticket-error', filter_no_menu: 'audience-menu',
  legacy_migration_audience: 'audience-menu',
  filter_no_analyst: 'candidate-exit', filter_no_candidate: 'candidate-exit', filter_no_invalid: 'invalid-audience-answer', initial_filter: 'legacy-integration-filter',
});

function simulateTransition(request = {}, resolvedMessages = FALLBACK_MESSAGES) {
  const { session = null, input = '', effects = {} } = validateSimulationRequest(request);
  validateDefinition(BOT_FLOW_DEFINITION);
  const decision = decideFlowTransition(session, input);
  const current = session ? normalizeSession(session) : { paso: decision.nextPaso, submissionId: effects.synthetic_submission_id || 'SIM-SUBMISSION-0001' };
  const trace = [];
  const outputs = [];
  const visit = (nodeId, values = {}, output = true, messageKey = null) => {
    const node = BOT_FLOW_DEFINITION.nodes.find(item => item.node_id === nodeId);
    const key = messageKey || node?.message_key;
    trace.push({ node_id: nodeId, runtime_type: node?.runtime_type || 'entry', message_key: key });
    if (output) outputs.push({ node_id: nodeId, message_key: key, text: interpolate(resolvedMessages[key] || FALLBACK_MESSAGES[key], safeValues(values)) });
  };
  const outputDecision = values => visit(MESSAGE_NODE[decision.messageKey], values, true, decision.messageKey);

  if (decision.type === 'start') outputDecision();
  else if (decision.type === 'advance') { current.paso = decision.nextPaso; outputDecision(); }
  else if (decision.type === 'migrate') {
    for (const field of [...CAPTURE_FIELDS, 'ticketId']) delete current[field];
    current.paso = decision.nextPaso;
    outputDecision();
  }
  else if (decision.type === 'retry') outputDecision(summaryValues(current));
  else if (decision.type === 'end') { outputDecision(); return terminalResult(trace, outputs, [], session, decision.reason || 'audience_exit'); }
  else if (decision.type === 'category') { current.categoria = decision.value; current.categoryKey = decision.categoryKey; current.paso = decision.nextPaso; outputDecision({ categoria: current.categoria }); }
  else if (decision.type === 'capture') {
    current[decision.field] = decision.value;
    current.paso = decision.nextPaso;
    outputDecision(summaryValues(current));
  } else if (decision.type === 'correct') {
    for (const field of ['nombre', 'empresa', 'correo', 'situacion']) delete current[field];
    current.paso = decision.nextPaso;
    outputDecision();
  } else if (decision.type === 'ticket') {
    if (decision.field) current[decision.field] = decision.value;
    outputDecision();
    const effect = { type: 'create_ticket', mode: 'dry-run', submission_id: current.submissionId, fields_present: presence(current) };
    if (effects.ticket_result === 'failure') {
      effect.result = 'failure'; visit('ticket-error');
      return terminalResult(trace, outputs, [effect], current, 'ticket_failure');
    }
    effect.result = effects.ticket_result === 'duplicate' ? 'duplicate' : 'success';
    effect.created = effect.result === 'success';
    effect.side_effects = effect.created ? 'execute' : 'skip';
    effect.synthetic_ticket_id = effects.synthetic_ticket_id || 'SIM-0001';
    current.ticketId = effect.synthetic_ticket_id; current.paso = decision.successPaso;
    visit('ticket-confirmation', { radicado: `Número de caso interno: *${effect.synthetic_ticket_id}*` });
    return terminalResult(trace, outputs, [effect], current, 'terminal_success');
  } else if (decision.type === 'complete') return terminalResult(trace, outputs, [], current, 'terminal_success');
  else if (decision.type === 'noop') return { ...result(current, trace, outputs, []), transition: decision };
  return result(current, trace, outputs, []);
}

function safeValues(session) { return Object.fromEntries(Object.entries(session || {}).map(([key, value]) => [key, key === 'radicado' ? value : escapeWhatsApp(value)])); }
function summaryValues(session) { return Object.fromEntries(CAPTURE_FIELDS.map(key => [key, session[key] || ''])); }
function validateSimulationRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw validationError('El cuerpo de la simulación debe ser un objeto JSON.');
  assertClosed(request, ['session', 'input', 'effects', 'version_id', 'area_id'], 'La simulación');
  const session = request.session === undefined ? null : request.session;
  const input = request.input === undefined ? '' : request.input;
  const effects = request.effects === undefined ? {} : request.effects;
  validateScopeId(request.version_id, 'version_id', false); validateScopeId(request.area_id, 'area_id', true);
  if (session !== null && (typeof session !== 'object' || Array.isArray(session))) throw validationError('session debe ser un objeto o null.');
  if (session) {
    assertClosed(session, SESSION_FIELDS, 'session');
    if (!Object.hasOwn(session, 'paso') || !isSupportedPasoType(session.paso)) throw validationError('session.paso no es válido.');
    for (const field of CAPTURE_FIELDS) validateBoundedText(session[field], `session.${field}`, MAX_CAPTURE_LENGTH);
    validateTicketId(session.ticketId); validateProductionId(session.flowVersionId, 'session.flowVersionId');
  }
  if (typeof input !== 'string') throw validationError('input debe ser texto.');
  if (input.length > MAX_INPUT_LENGTH) throw validationError(`input no puede superar ${MAX_INPUT_LENGTH} caracteres.`);
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) throw validationError('effects debe ser un objeto.');
  assertClosed(effects, ['ticket_result', 'synthetic_ticket_id', 'synthetic_submission_id'], 'effects');
  if (effects.ticket_result !== undefined && !['success', 'failure', 'duplicate'].includes(effects.ticket_result)) throw validationError('effects.ticket_result debe ser success, duplicate o failure.');
  validateBoundedText(effects.synthetic_ticket_id, 'effects.synthetic_ticket_id', MAX_TICKET_ID_LENGTH);
  validateBoundedText(effects.synthetic_submission_id, 'effects.synthetic_submission_id', MAX_TICKET_ID_LENGTH);
  validateBoundedText(session?.submissionId, 'session.submissionId', MAX_TICKET_ID_LENGTH);
  return { session, input, effects };
}
function validateScopeId(value, label, nullable) { if (value === undefined || (nullable && value === null)) return; if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw validationError(`${label} debe ser un entero positivo válido${nullable ? ' o null' : ''}.`); }
function validateBoundedText(value, label, max) { if (value !== undefined && (typeof value !== 'string' || value.length > max)) throw validationError(`${label} debe ser texto de máximo ${max} caracteres.`); if (value !== undefined && label.includes('ticket') && value && !/^[A-Za-z0-9_-]+$/.test(value)) throw validationError(`${label} contiene caracteres no soportados.`); }
function validateTicketId(value) { if (value == null) return; if (typeof value === 'number') return validateProductionId(value, 'session.ticketId'); validateBoundedText(value, 'session.ticketId', MAX_TICKET_ID_LENGTH); }
function validateProductionId(value, label) { if (value == null) return; if (!Number.isSafeInteger(value) || value <= 0) throw validationError(`${label} debe ser un entero positivo seguro o null.`); }
function assertClosed(value, allowed, label) { if (Object.keys(value).some(key => !allowed.includes(key))) throw validationError(`${label} contiene campos no soportados.`); }
function normalizeSession(session) { return Object.fromEntries(SESSION_FIELDS.filter(key => Object.hasOwn(session, key)).map(key => [key, session[key]])); }
function isSupportedPasoType(paso) { return PASOS.includes(paso) || (typeof paso === 'number' && Number.isSafeInteger(paso)); }
function presence(session) { return Object.fromEntries(CAPTURE_FIELDS.map(key => [key, Boolean(session?.[key])])); }
function result(session, trace, outputs, effects) { return { session: session && normalizeSession(session), trace, path: trace.map(item => item.node_id), outputs, effects }; }
function terminalResult(trace, outputs, effects, source, reason) { return { session: null, trace, path: trace.map(item => item.node_id), outputs, effects, terminal: { reason, captured_fields: CAPTURE_FIELDS.filter(key => Boolean(source?.[key])), fields_present: presence(source) } }; }
function validationError(message) { const error = new Error(message); error.statusCode = 400; error.code = 'INVALID_SIMULATION'; return error; }

module.exports = { MAX_INPUT_LENGTH, STATE_NODE, simulateTransition, validateSimulationRequest };

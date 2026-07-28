const test = require('node:test');
const assert = require('node:assert/strict');
const { BOT_FLOW_DEFINITION, validateDefinition } = require('../src/services/botFlowDefinition');
const { FALLBACK_MESSAGES } = require('../src/services/botFlowMessages');
const { simulateTransition } = require('../src/services/botFlowEngine');
const { decideFlowTransition, normalizeChoice } = require('../src/services/botFlowTransitions');

test('v2 manifest is valid, deeply frozen and references existing messages', () => {
  validateDefinition(BOT_FLOW_DEFINITION);
  assert.equal(BOT_FLOW_DEFINITION.schema_version, 2);
  assert.equal(BOT_FLOW_DEFINITION.entry_node_id, 'audience-menu');
  assert.equal(Object.isFrozen(BOT_FLOW_DEFINITION.nodes[1].branches), true);
  for (const node of BOT_FLOW_DEFINITION.nodes) assert.ok(FALLBACK_MESSAGES[node.message_key]);
});

test('normalization is accent-safe and aliases are exact rather than substring matches', () => {
  assert.equal(normalizeChoice('  SÍ!!! '), 'si');
  assert.equal(decideFlowTransition({ paso: 'confirm_summary' }, 'sí').type, 'ticket');
  for (const falsePositive of ['silla', 'similar', 'sistema']) {
    assert.equal(decideFlowTransition({ paso: 'confirm_summary' }, falsePositive).type, 'retry');
  }
  assert.equal(decideFlowTransition({ paso: 'audience_choice' }, 'Soy Analista').nextPaso, 'issue_category');
  assert.equal(decideFlowTransition({ paso: 'issue_category' }, 'integración').value, 'Integrations');
});

test('new simulator flow retries menus, exits candidates and collects category before data notice', () => {
  const start = simulateTransition({});
  assert.equal(start.session.paso, 'audience_choice');
  assert.equal(start.outputs[0].message_key, 'welcome_audience');
  const invalid = simulateTransition({ session: start.session, input: 'persona' });
  assert.equal(invalid.session.paso, 'audience_choice');
  assert.equal(invalid.outputs[0].message_key, 'audience_invalid');
  assert.equal(simulateTransition({ session: start.session, input: 'candidata' }).terminal.reason, 'candidate_exit');
  const candidate = simulateTransition({ session: start.session, input: '2' });
  assert.equal(candidate.outputs[0].node_id, 'candidate-exit');
  assert.equal(candidate.outputs[0].message_key, 'candidate_exit');
  const analyst = simulateTransition({ session: start.session, input: '1' });
  assert.equal(analyst.session.paso, 'issue_category');
  const categoryInvalid = simulateTransition({ session: analyst.session, input: 'ventas' });
  assert.equal(categoryInvalid.session.paso, 'issue_category');
  const category = simulateTransition({ session: analyst.session, input: 'potential 365' });
  assert.equal(category.session.categoria, 'Tests');
  assert.equal(category.session.paso, 'capture_name');
  assert.match(category.outputs[0].text, /Seleccionaste: \*Tests\*/);
});

function completedDataSession() {
  let result = simulateTransition({ session: { paso: 'capture_name', categoria: 'Platform' }, input: 'Ana Pérez' });
  result = simulateTransition({ session: result.session, input: 'Acme' });
  const badEmail = simulateTransition({ session: result.session, input: 'no-es-correo' });
  assert.equal(badEmail.session.paso, 'capture_email');
  result = simulateTransition({ session: result.session, input: 'ana@acme.test' });
  const shortIssue = simulateTransition({ session: result.session, input: 'error' });
  assert.equal(shortIssue.session.paso, 'capture_issue');
  return simulateTransition({ session: result.session, input: 'La API presenta timeout al guardar' });
}

test('summary requires explicit confirmation and safely escapes WhatsApp markup', () => {
  let result = simulateTransition({ session: { paso: 'capture_name', categoria: 'Other' }, input: 'Ana *Admin*' });
  result = simulateTransition({ session: result.session, input: 'Acme_Control' });
  result = simulateTransition({ session: result.session, input: 'ana@acme.test' });
  result = simulateTransition({ session: result.session, input: 'El sistema falla al guardar los datos' });
  assert.equal(result.session.paso, 'confirm_summary');
  assert.deepEqual(result.effects, []);
  assert.ok(result.outputs[0].text.includes('Ana \\*Admin\\*'));
  assert.ok(result.outputs[0].text.includes('Acme\\_Control'));
  const invalid = simulateTransition({ session: result.session, input: 'silla' });
  assert.equal(invalid.session.paso, 'confirm_summary');
  assert.deepEqual(invalid.effects, []);
});

test('correction preserves category, clears collected values and restarts at name', () => {
  const summary = completedDataSession();
  const corrected = simulateTransition({ session: summary.session, input: 'corregir' });
  assert.deepEqual(corrected.session, { paso: 'capture_name', categoria: 'Platform' });
  assert.equal(corrected.outputs[0].message_key, 'restart_data');
});

test('confirmed ticket success and failure are dry-run, terminal and PII-minimized', () => {
  const summary = completedDataSession();
  for (const ticket_result of ['success', 'failure']) {
    const result = simulateTransition({ session: summary.session, input: 'confirmar', effects: { ticket_result, synthetic_ticket_id: ticket_result === 'success' ? 'SIM-77' : undefined } });
    assert.equal(result.session, null);
    assert.equal(result.effects[0].result, ticket_result);
    assert.equal(JSON.stringify(result.effects).includes('Ana Pérez'), false);
    assert.deepEqual(result.outputs.map(item => item.message_key), ticket_result === 'success' ? ['processing', 'confirmation'] : ['processing', 'ticket_error']);
  }
});

test('simulator models duplicate submission metadata without external effects', () => {
  const summary = { ...completedDataSession().session, submissionId: 'SIM-SUBMISSION-77' };
  const result = simulateTransition({ session: summary, input: 'confirmar', effects: { ticket_result: 'duplicate', synthetic_ticket_id: 'SIM-77' } });
  assert.deepEqual(result.effects[0], {
    type: 'create_ticket', mode: 'dry-run', submission_id: 'SIM-SUBMISSION-77',
    fields_present: { categoria: true, nombre: true, empresa: true, correo: true, situacion: true },
    result: 'duplicate', created: false, side_effects: 'skip', synthetic_ticket_id: 'SIM-77',
  });
});

test('active legacy sessions reset to the analyst gate and ignore their current input', () => {
  for (const paso of [0, 1, 2, 3, 4, 'filtro_no']) {
    const result = simulateTransition({
      session: { paso, categoria: 'Other', nombre: 'Ana', empresa: 'Acme', correo: 'ana@acme.test', situacion: 'incidencia heredada' },
      input: paso === 4 ? 'crear ticket' : 'analista',
    });
    assert.deepEqual(result.session, { paso: 'audience_choice' });
    assert.equal(result.outputs[0].message_key, 'legacy_migration_audience');
    assert.deepEqual(result.effects, []);
  }
  assert.equal(simulateTransition({ session: { paso: 5 }, input: 'ignored' }).session, null);
  const unknown = simulateTransition({ session: { paso: 99, nombre: 'Ana' }, input: 'ignored' });
  assert.deepEqual(unknown.session, { paso: 99, nombre: 'Ana' });
  assert.equal(unknown.transition.type, 'noop');
});

test('migrated legacy sessions must pass audience, category, summary and confirmation before ticketing', () => {
  let result = simulateTransition({ session: { paso: 4, situacion: 'legacy issue that must not ticket' }, input: 'confirmar' });
  assert.deepEqual(result.effects, []);
  result = simulateTransition({ session: result.session, input: 'analista' });
  assert.equal(result.session.paso, 'issue_category');
  result = simulateTransition({ session: result.session, input: 'integraciones' });
  for (const input of ['Ana Pérez', 'Acme', 'ana@acme.test', 'La integración falla al sincronizar']) {
    result = simulateTransition({ session: result.session, input });
  }
  assert.equal(result.session.paso, 'confirm_summary');
  assert.deepEqual(result.effects, []);
  result = simulateTransition({ session: result.session, input: 'confirmar' });
  assert.equal(result.effects[0].type, 'create_ticket');
  assert.equal(result.session, null);
});

test('simulator enforces closed bounded input and session contracts', () => {
  assert.throws(() => simulateTransition({ session: { paso: 'capture_name', arbitrary: true } }), /campos no soportados/);
  assert.throws(() => simulateTransition({ session: { paso: 'unknown' } }), /paso no es válido/);
  assert.throws(() => simulateTransition({ input: 'x'.repeat(4001) }), /4000/);
  assert.throws(() => simulateTransition({ effects: { arbitrary: true } }), /campos no soportados/);
});

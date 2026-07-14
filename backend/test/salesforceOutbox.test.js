const test = require('node:test');
const assert = require('node:assert/strict');

const outbox = require('../src/services/salesforceOutbox');

test('Salesforce outbox builds redacted-safe payload without obvious PII or transcripts', () => {
  const payload = outbox.buildSafePayload({
    operation: 'case_close',
    ticket: {
      id: 7,
      telefono: '+57 300 123 4567',
      correo: 'person@example.com',
      nombre_analista: 'Jane Doe',
      nombre_empresa: 'Acme Inc',
      situacion: 'Full user transcript with person@example.com and phone +57 300 123 4567',
      prioridad: 'Alta',
      area_id: 2,
      sf_case_id: '500xx',
      sf_case_number: '00001042',
    },
    metadata: {
      resolucion: 'Called person@example.com at +57 300 123 4567',
      subetapa_resuelto: 'Solucionado',
    },
  });

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /person@example\.com/);
  assert.doesNotMatch(serialized, /300 123 4567/);
  assert.doesNotMatch(serialized, /Jane Doe/);
  assert.doesNotMatch(serialized, /Acme Inc/);
  assert.doesNotMatch(serialized, /Full user transcript/);
  assert.equal(payload.ticket.fields_present.correo, true);
  assert.equal(payload.close.has_resolution, true);
  assert.equal(payload.close.subetapa_resuelto, 'Solucionado');
});

test('Salesforce outbox idempotency key is deterministic for supported ticket operation and case', () => {
  const first = outbox.buildIdempotencyKey({ ticket_id: 7, operation: 'case_close', sf_case_id: '500xx' });
  const second = outbox.buildIdempotencyKey({ ticketId: 7, operation: 'case_close', sfCaseId: '500xx' });
  const different = outbox.buildIdempotencyKey({ ticket_id: 7, operation: 'case_create', sf_case_id: '500xx' });

  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('Salesforce outbox rejects update operations until update fingerprint semantics exist', () => {
  assert.throws(
    () => outbox.buildIdempotencyKey({ ticket_id: 7, operation: 'case_update', sf_case_id: '500xx' }),
    /Unsupported Salesforce outbox operation: case_update/,
  );
});

test('Salesforce outbox normalizes filters and rejects unsupported status', () => {
  assert.deepEqual(outbox.normalizeListFilters({ status: 'pending', ticket_id: '7', limit: '500', offset: '2' }), {
    status: 'pending',
    ticket_id: 7,
    limit: 200,
    offset: 2,
  });

  assert.throws(() => outbox.normalizeListFilters({ status: 'unknown' }), /Unsupported Salesforce outbox status/);
});

test('Salesforce outbox maps missing schema errors to controlled 503 errors', () => {
  const mapped = outbox.toSchemaMissingError({ code: '42P01', message: 'relation "salesforce_outbox" does not exist' });
  assert.equal(mapped.statusCode, 503);
  assert.equal(mapped.code, 'SF_OUTBOX_SCHEMA_MISSING');
});

test('Salesforce outbox ticket serializer removes payload, idempotency key, and raw errors', () => {
  assert.deepEqual(outbox.serializeTicketOutboxJob({
    id: 1,
    ticket_id: 7,
    sf_case_id: '500xx',
    operation: 'case_close',
    status: 'failed',
    attempts: 2,
    next_attempt_at: '2026-07-13T10:00:00.000Z',
    processed_at: null,
    created_at: '2026-07-13T09:00:00.000Z',
    updated_at: '2026-07-13T09:30:00.000Z',
    payload: { transcript: 'secret' },
    idempotency_key: 'secret-key',
    last_error: 'raw Salesforce error',
  }), {
    id: 1,
    ticket_id: 7,
    sf_case_id: '500xx',
    operation: 'case_close',
    status: 'failed',
    attempts: 2,
    next_attempt_at: '2026-07-13T10:00:00.000Z',
    processed_at: null,
    created_at: '2026-07-13T09:00:00.000Z',
    updated_at: '2026-07-13T09:30:00.000Z',
  });
});

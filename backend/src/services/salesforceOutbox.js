const crypto = require('crypto');

const STATUSES = Object.freeze(['pending', 'retrying', 'failed', 'synced']);
const RETRYABLE_STATUSES = Object.freeze(['pending', 'retrying', 'failed']);
// First safe slice only supports operations whose idempotency semantics are
// naturally one-per-ticket/case. Payload-varying updates need a dedicated,
// stable update fingerprint before they are added to this allow-list.
const OPERATIONS = Object.freeze(['case_create', 'case_close']);
const TICKET_OUTBOX_SAFE_FIELDS = Object.freeze([
  'id',
  'ticket_id',
  'sf_case_id',
  'operation',
  'status',
  'attempts',
  'next_attempt_at',
  'processed_at',
  'created_at',
  'updated_at',
]);
const TICKET_OUTBOX_SAFE_SELECT = TICKET_OUTBOX_SAFE_FIELDS.join(',');
const ADMIN_OUTBOX_SAFE_FIELDS = TICKET_OUTBOX_SAFE_FIELDS;
const ADMIN_OUTBOX_SAFE_SELECT = ADMIN_OUTBOX_SAFE_FIELDS.join(',');

function normalizeOperation(operation) {
  if (!OPERATIONS.includes(operation)) {
    const err = new Error(`Unsupported Salesforce outbox operation: ${operation}`);
    err.statusCode = 400;
    err.code = 'SF_OUTBOX_OPERATION_INVALID';
    throw err;
  }
  return operation;
}

function normalizeStatus(status, { optional = false } = {}) {
  if ((status === undefined || status === null || status === '') && optional) return undefined;
  if (!STATUSES.includes(status)) {
    const err = new Error(`Unsupported Salesforce outbox status: ${status}`);
    err.statusCode = 400;
    err.code = 'SF_OUTBOX_STATUS_INVALID';
    throw err;
  }
  return status;
}

function normalizePositiveInteger(value, field, { defaultValue, max } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    const err = new Error(`${field} must be a positive integer.`);
    err.statusCode = 400;
    err.code = 'SF_OUTBOX_FILTER_INVALID';
    throw err;
  }
  return max ? Math.min(normalized, max) : normalized;
}

function normalizeNonNegativeInteger(value, field, { defaultValue } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    const err = new Error(`${field} must be a non-negative integer.`);
    err.statusCode = 400;
    err.code = 'SF_OUTBOX_FILTER_INVALID';
    throw err;
  }
  return normalized;
}

function normalizeListFilters(filters = {}) {
  return {
    status: normalizeStatus(filters.status, { optional: true }),
    ticket_id: filters.ticket_id === undefined || filters.ticket_id === null || filters.ticket_id === ''
      ? undefined
      : normalizePositiveInteger(filters.ticket_id, 'ticket_id'),
    limit: normalizePositiveInteger(filters.limit, 'limit', { defaultValue: 50, max: 200 }),
    offset: normalizeNonNegativeInteger(filters.offset, 'offset', { defaultValue: 0 }),
  };
}

function buildIdempotencyKey({ ticket_id, ticketId, operation, sf_case_id, sfCaseId }) {
  const safeTicketId = String(ticket_id ?? ticketId ?? '').trim();
  const safeOperation = normalizeOperation(operation);
  const safeCaseId = String(sf_case_id ?? sfCaseId ?? 'none').trim() || 'none';
  if (!safeTicketId) {
    const err = new Error('ticket_id is required to build a Salesforce outbox idempotency key.');
    err.statusCode = 400;
    err.code = 'SF_OUTBOX_TICKET_REQUIRED';
    throw err;
  }

  const raw = `sf-outbox:v1:ticket:${safeTicketId}:operation:${safeOperation}:case:${safeCaseId}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function buildSafeTicketSnapshot(ticket = {}) {
  return {
    id: ticket.id,
    status: ticket.status || null,
    priority: ticket.prioridad || ticket.priority || null,
    area_id: ticket.area_id || null,
    sf_case_id: ticket.sf_case_id || null,
    sf_case_number: ticket.sf_case_number || null,
    created_at: ticket.created_at || null,
    closed_at: ticket.closed_at || null,
    fields_present: {
      telefono: Boolean(ticket.telefono),
      correo: Boolean(ticket.correo),
      nombre_analista: Boolean(ticket.nombre_analista),
      nombre_empresa: Boolean(ticket.nombre_empresa),
      situacion: Boolean(ticket.situacion),
    },
  };
}

function buildSafePayload({ operation, ticket, caseId, caseNumber, metadata = {} }) {
  const safeOperation = normalizeOperation(operation);
  const payload = {
    version: 1,
    operation: safeOperation,
    ticket: buildSafeTicketSnapshot(ticket),
    salesforce: {
      case_id: caseId || ticket?.sf_case_id || null,
      case_number: caseNumber || ticket?.sf_case_number || null,
    },
  };

  if (safeOperation === 'case_close') {
    payload.close = {
      has_resolution: Boolean(metadata.resolucion),
      subetapa_resuelto: metadata.subetapa_resuelto || null,
    };
  }

  return payload;
}

function serializeTicketOutboxJob(job = {}) {
  return TICKET_OUTBOX_SAFE_FIELDS.reduce((safe, field) => {
    safe[field] = job[field] ?? null;
    return safe;
  }, {});
}

function serializeAdminOutboxJob(job = {}) {
  return ADMIN_OUTBOX_SAFE_FIELDS.reduce((safe, field) => {
    safe[field] = job[field] ?? null;
    return safe;
  }, {});
}

function buildOutboxJob({ operation, ticket, metadata = {} }) {
  const safeOperation = normalizeOperation(operation);
  const ticketId = ticket?.id ?? metadata.ticket_id;
  const caseId = metadata.sf_case_id || ticket?.sf_case_id || null;

  return {
    ticket_id: ticketId,
    sf_case_id: caseId,
    operation: safeOperation,
    status: 'pending',
    payload: buildSafePayload({
      operation: safeOperation,
      ticket,
      caseId,
      caseNumber: metadata.sf_case_number || ticket?.sf_case_number || null,
      metadata,
    }),
    idempotency_key: buildIdempotencyKey({
      ticket_id: ticketId,
      operation: safeOperation,
      sf_case_id: caseId,
    }),
  };
}

function isSchemaMissingError(error) {
  return error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    error?.code === 'PGRST204' ||
    /relation .*salesforce_outbox.* does not exist|schema cache.*salesforce_outbox|Could not find the table/i.test(error?.message || '');
}

function toSchemaMissingError(error) {
  const err = new Error('Salesforce outbox schema is not available. Apply backend/supabase/phase6_salesforce_outbox.sql manually before using this endpoint.');
  err.statusCode = 503;
  err.code = 'SF_OUTBOX_SCHEMA_MISSING';
  err.cause = error;
  return err;
}

module.exports = {
  STATUSES,
  RETRYABLE_STATUSES,
  OPERATIONS,
  TICKET_OUTBOX_SAFE_SELECT,
  ADMIN_OUTBOX_SAFE_SELECT,
  normalizeOperation,
  normalizeStatus,
  normalizeListFilters,
  buildIdempotencyKey,
  buildSafePayload,
  buildOutboxJob,
  serializeTicketOutboxJob,
  serializeAdminOutboxJob,
  isSchemaMissingError,
  toSchemaMissingError,
};

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
const RETRY_DELAYS_MS = Object.freeze([30_000, 120_000, 600_000, 1_800_000]);
const TERMINAL_HTTP_STATUSES = new Set([400, 403, 404, 422]);
const BATCH_FAILURE_SEVERITY = Object.freeze({
  processor_error: 3,
  failed: 2,
  lease_lost: 1,
  retrying: 1,
});

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

function normalizeProcessLimit(value) {
  if (value === undefined || value === null || value === '') return 1;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    const err = new Error('limit must be a positive integer.');
    err.statusCode = 400;
    err.code = 'SF_OUTBOX_LIMIT_INVALID';
    throw err;
  }
  return Math.min(limit, 10);
}

function validateCaseCloseJob(job) {
  const payload = job?.payload;
  const caseId = typeof payload?.salesforce?.case_id === 'string' ? payload.salesforce.case_id.trim() : '';
  const substage = typeof payload?.close?.subetapa_resuelto === 'string' ? payload.close.subetapa_resuelto.trim() : '';
  if (job?.operation !== 'case_close' || payload?.version !== 1 || payload?.operation !== 'case_close' ||
       !caseId || !substage ||
      payload?.close?.has_resolution !== true) {
    const err = new Error('Invalid case_close outbox payload.');
    err.code = 'SF_OUTBOX_PAYLOAD_INVALID';
    err.terminal = true;
    throw err;
  }
  return { caseId, substage };
}

function classifyProcessorError(error) {
  if (error?.terminal) return { retryable: false, code: error.code || 'SF_OUTBOX_TERMINAL' };
  const status = Number(error?.statusCode || error?.status);
  const rawCode = String(error?.code || '').toUpperCase();
  const code = /^[A-Z0-9_:-]{1,120}$/.test(rawCode) ? rawCode : (status ? `SF_HTTP_${status}` : 'SF_TRANSPORT_ERROR');
  if (TERMINAL_HTTP_STATUSES.has(status)) return { retryable: false, code };
  const retryable = !status || status >= 500 || [408, 409, 425, 429, 401].includes(status) ||
    ['ABORT_ERR', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(rawCode);
  return { retryable, code: retryable ? code : (code || 'SF_OUTBOX_TERMINAL') };
}

function nextRetryAt(attempts, now) {
  const index = Math.min(Math.max(Number(attempts) || 1, 1), RETRY_DELAYS_MS.length) - 1;
  return new Date(now.getTime() + RETRY_DELAYS_MS[index]).toISOString();
}

function safeProcessorJob(job, status, extra = {}) {
  return {
    id: job.id,
    ticket_id: job.ticket_id,
    operation: job.operation,
    attempt: job.attempts,
    status,
    ...extra,
  };
}

function batchDiagnosis(results) {
  const failure = results.reduce((highest, result) => {
    if (!result.error_code) return highest;
    if (!highest) return result;
    return (BATCH_FAILURE_SEVERITY[result.status] || 0) >
      (BATCH_FAILURE_SEVERITY[highest.status] || 0) ? result : highest;
  }, null);
  if (!failure) return null;
  const category = failure.status === 'processor_error'
    ? (failure.id === undefined ? 'claim_failure' : 'processor_failure')
    : ({ failed: 'terminal_failure', lease_lost: 'lease_failure', retrying: 'retryable_failure' }[failure.status]);
  return {
    error_code: failure.error_code,
    category,
  };
}

function withOutboxDbTimeout(operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Salesforce outbox database operation timed out.');
      error.code = 'SF_OUTBOX_DB_TIMEOUT';
      error.statusCode = 503;
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => clearTimeout(timer));
}

async function processClaimedJob(job, { db, salesforce, workerId, now, dbTimeoutMs }) {
  const { SALESFORCE_OUTBOX_DB_TIMEOUT_MS } = require('./salesforceOutboxContract');
  const transitionTimeoutMs = dbTimeoutMs || SALESFORCE_OUTBOX_DB_TIMEOUT_MS;
  try {
    const { caseId, substage } = validateCaseCloseJob(job);
    const state = await salesforce.getCaseCloseState(caseId);
    if (state?.Status !== 'Resuelto' || state?.Subetapa_resuelto__c !== substage) {
      await salesforce.closeCaseFromOutbox(caseId, substage);
    }
  } catch (error) {
    if (error?.code === 'SF_OUTBOX_LEASE_LOST') return safeProcessorJob(job, 'lease_lost');
    const classified = classifyProcessorError(error);
    try {
      if (classified.retryable && Number(job.attempts) < Number(job.max_attempts)) {
        await withOutboxDbTimeout(() => db.markSalesforceOutboxJobRetrying(job.id, workerId, {
          nextAttemptAt: nextRetryAt(job.attempts, now()),
          errorCode: classified.code,
        }), transitionTimeoutMs);
        return safeProcessorJob(job, 'retrying', { error_code: classified.code });
      }
      await withOutboxDbTimeout(
        () => db.markSalesforceOutboxJobFailed(job.id, workerId, classified.code, now().toISOString()),
        transitionTimeoutMs,
      );
      return safeProcessorJob(job, 'failed', { error_code: classified.code });
    } catch (transitionError) {
      if (transitionError?.code === 'SF_OUTBOX_LEASE_LOST') return safeProcessorJob(job, 'lease_lost');
      return safeProcessorJob(job, 'processor_error', {
        error_code: classifyProcessorError(transitionError).code,
      });
    }
  }

  try {
    await withOutboxDbTimeout(
      () => db.markSalesforceOutboxJobSynced(job.id, workerId, now().toISOString()),
      transitionTimeoutMs,
    );
    return safeProcessorJob(job, 'synced');
  } catch (transitionError) {
    if (transitionError?.code === 'SF_OUTBOX_LEASE_LOST') return safeProcessorJob(job, 'lease_lost');
    return safeProcessorJob(job, 'processor_error', {
      error_code: classifyProcessorError(transitionError).code,
    });
  }
}

async function processBatch(options = {}) {
  const db = options.db || require('../database/db');
  const salesforce = options.salesforce || require('./salesforce');
  const now = options.now || (() => new Date());
  const workerId = options.workerId || `admin-${crypto.randomUUID()}`;
  const limit = normalizeProcessLimit(options.limit);
  const { SALESFORCE_OUTBOX_DB_TIMEOUT_MS } = require('./salesforceOutboxContract');
  const dbTimeoutMs = options.dbTimeoutMs || SALESFORCE_OUTBOX_DB_TIMEOUT_MS;
  const startedAt = now();
  const results = [];
  let claimAttempts = 0;
  // Intentionally finite and admin-driven: claim one immediately before processing
  // so later jobs do not spend their lease waiting behind earlier Salesforce calls.
  while (claimAttempts < limit) {
    claimAttempts += 1;
    let claimed;
    try {
      claimed = await withOutboxDbTimeout(() => db.claimSalesforceOutboxJobs(workerId, 1), dbTimeoutMs);
    } catch (error) {
      results.push({ status: 'processor_error', error_code: classifyProcessorError(error).code });
      break;
    }
    if (!claimed.length) break;
    results.push(await processClaimedJob(claimed[0], { db, salesforce, workerId, now, dbTimeoutMs }));
  }
  const counts = { claimed: results.filter(result => result.id !== undefined).length, synced: 0, retrying: 0, failed: 0, lease_lost: 0, processor_error: 0 };
  for (const result of results) if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
  return {
    counts,
    jobs: results,
    diagnosis: batchDiagnosis(results),
    duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
    claim_attempts: claimAttempts,
    recovery: 'manual_admin_invocation_required',
    invocation: 'manual_only',
    external_alerting: 'not_configured_intentional_next_step',
  };
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
    error?.code === 'PGRST202' ||
    /relation .*salesforce_outbox.* does not exist|schema cache.*salesforce_outbox|Could not find the table|claim_salesforce_outbox_jobs/i.test(error?.message || '');
}

function toSchemaMissingError(error) {
  const err = new Error('Salesforce outbox schema is not available. Apply the phase6 and phase7 Salesforce outbox SQL artifacts manually before using this endpoint.');
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
  RETRY_DELAYS_MS,
  normalizeOperation,
  normalizeStatus,
  normalizeListFilters,
  buildIdempotencyKey,
  buildSafePayload,
  buildOutboxJob,
  serializeTicketOutboxJob,
  serializeAdminOutboxJob,
  normalizeProcessLimit,
  validateCaseCloseJob,
  classifyProcessorError,
  nextRetryAt,
  processClaimedJob,
  processBatch,
  isSchemaMissingError,
  toSchemaMissingError,
};

const crypto = require('crypto');
const salesforceOutbox = require('./salesforceOutbox');
const { emitTicketOperation, toMinimalQueueCard } = require('../realtime/operational');

function errorCode(error, fallback) {
  const candidate = String(error?.code || fallback || 'POST_PROCESSING_ERROR').toUpperCase();
  return /^[A-Z0-9_:-]{1,120}$/.test(candidate) ? candidate : fallback;
}

function serialize(row = {}) {
  return {
    ticket_id: row.ticket_id,
    submission_id: row.submission_id,
    salesforce_outbox_status: row.salesforce_outbox_status,
    operational_emit_status: row.operational_emit_status,
    session_cleanup_status: row.session_cleanup_status,
    whatsapp_ack_status: row.whatsapp_ack_status,
    whatsapp_ack_attempts: row.whatsapp_ack_attempts,
    attempts: row.attempts,
    last_error_code: row.last_error_code,
    updated_at: row.updated_at,
  };
}

const DEFAULT_DEADLINES = Object.freeze({ lookup: 5000, sideEffect: 15000, finalize: 5000 });

function operationTimeout(operation, milliseconds) {
  const error = new Error(`${operation} timed out`);
  error.code = `${operation.toUpperCase()}_TIMEOUT`;
  error.isTimeout = true;
  return error;
}

async function withDeadline(operation, milliseconds, work) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => reject(operationTimeout(operation, milliseconds)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function processRow(row, { db, io, workerId, deadlines = DEFAULT_DEADLINES }) {
  const results = [];
  let ticket;
  let lookupError;
  try {
    ticket = await withDeadline('ticket_lookup', deadlines.lookup, () => db.getTicketById(row.ticket_id));
    if (!ticket) lookupError = Object.assign(new Error('Ticket missing'), { code: 'TICKET_NOT_FOUND' });
  } catch (error) {
    lookupError = error;
  }

  const run = async (effect, operation) => {
    if (row[`${effect}_status`] === 'completed') return { continue: true };
    if (effect === 'operational_emit' && row.operational_emit_status === 'uncertain') {
      results.push({ effect, status: 'uncertain', error_code: 'OPERATIONAL_EMIT_UNCERTAIN' });
      return { continue: true };
    }
    const ambiguousSensitive = effect === 'operational_emit';
    let attemptStarted = false;
    try {
      if (effect !== 'session_cleanup' && lookupError) throw lookupError;
      if (ambiguousSensitive) {
        const marked = await withDeadline(`${effect}_attempt_start`, deadlines.finalize,
          () => db.markTicketPostProcessingAttemptStarted(row.ticket_id, workerId, effect));
        if (!marked) {
          results.push({ effect, status: 'attempt_start_failed', error_code: 'ATTEMPT_START_REJECTED' });
          return { continue: false, haltBatch: false };
        }
        attemptStarted = true;
      }
      await withDeadline(`${effect}_side_effect`, deadlines.sideEffect, operation);
      const finalized = await withDeadline(`${effect}_finalize`, deadlines.finalize,
        () => db.finalizeTicketPostProcessingEffect(row.ticket_id, workerId, effect, true));
      if (!finalized) {
        results.push({ effect, status: 'lease_lost', error_code: 'LEASE_LOST' });
        return { continue: false, haltBatch: false };
      }
      results.push({ effect, status: 'completed' });
      return { continue: true };
    } catch (error) {
      const code = errorCode(error, `${effect.toUpperCase()}_FAILED`);
      if (ambiguousSensitive) {
        results.push({ effect, status: attemptStarted ? 'uncertain' : 'attempt_start_failed', error_code: code });
        return { continue: false, haltBatch: attemptStarted };
      }
      if (error?.isTimeout && code.endsWith('_SIDE_EFFECT_TIMEOUT')) {
        results.push({ effect, status: 'uncertain', error_code: code });
        return { continue: false, haltBatch: true };
      }
      try {
        const released = await withDeadline(`${effect}_finalize`, deadlines.finalize,
          () => db.finalizeTicketPostProcessingEffect(row.ticket_id, workerId, effect, false, code));
        if (!released) {
          results.push({ effect, status: 'lease_lost', error_code: 'LEASE_LOST' });
          return { continue: false, haltBatch: false };
        }
        results.push({ effect, status: 'failed', error_code: code });
        return { continue: true };
      } catch (finalizeError) {
        const finalizeCode = errorCode(finalizeError, 'FINALIZE_FAILED');
        results.push({ effect, status: finalizeError?.isTimeout ? 'uncertain' : 'finalize_failed', error_code: finalizeCode });
        return { continue: false, haltBatch: true };
      }
    }
  };
  let outcome = await run('salesforce_outbox', async () => {
    await db.createSalesforceOutboxJob(salesforceOutbox.buildOutboxJob({ operation: 'case_create', ticket }));
  });
  if (!outcome.continue) return { ticket_id: row.ticket_id, effects: results, haltBatch: outcome.haltBatch };
  outcome = await run('operational_emit', async () => {
    emitTicketOperation(io, 'ticket-created', ticket, { areaPayload: toMinimalQueueCard(ticket) });
  });
  if (!outcome.continue) return { ticket_id: row.ticket_id, effects: results, haltBatch: outcome.haltBatch };
  outcome = await run('session_cleanup', () => db.deleteSession(row.chat_id));
  return { ticket_id: row.ticket_id, effects: results, haltBatch: Boolean(outcome.haltBatch) };
}

async function processBatch({ db = require('../database/db'), io, limit = 10, workerId = crypto.randomUUID(), deadlines } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const results = [];
  let claimed = 0;
  while (claimed < safeLimit) {
    let rows;
    try {
      rows = await withDeadline('claim', deadlines?.lookup || DEFAULT_DEADLINES.lookup,
        () => db.claimTicketPostProcessing(workerId, 1));
    } catch (error) {
      results.push({ ticket_id: null, effects: [], status: 'claim_failed', error_code: errorCode(error, 'CLAIM_FAILED') });
      break;
    }
    if (!rows.length) break;
    claimed += 1;
    const result = await processRow(rows[0], { db, io, workerId, deadlines: { ...DEFAULT_DEADLINES, ...deadlines } });
    const haltBatch = result.haltBatch;
    delete result.haltBatch;
    results.push(result);
    if (haltBatch) break;
  }
  return { claimed, results };
}

module.exports = { processBatch, processRow, serialize, errorCode, withDeadline };

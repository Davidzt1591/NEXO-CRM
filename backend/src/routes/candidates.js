const express = require('express');
const crypto = require('node:crypto');
const db = require('../database/db');
const { canAccessTicket, isAdmin } = require('../realtime/operational');
const { candidateQuarantine } = require('../services/candidateQuarantine');

const router = express.Router();

const asyncHandler = fn => (req, res) => fn(req, res).catch(error => {
  console.error('[candidate-api]', error.code || 'UNEXPECTED_ERROR', error.message);
  res.status(error.statusCode || 500).json({ code: error.code || 'CANDIDATE_OPERATION_FAILED', error: error.message });
});

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function requireTicketId(value) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    throw httpError(400, 'TICKET_ID_REQUIRED', 'A valid ticket_id is required.');
  }
  return Number(value);
}

function safeTarget(ticketId) {
  return crypto.createHash('sha256').update(`ticket:${ticketId}`).digest('hex').slice(0, 24);
}

async function authorize(req) {
  const ticketId = requireTicketId(req.query.ticket_id ?? req.body?.ticket_id);
  const ticket = await db.getTicketWithAssignment(ticketId);
  if (!ticket) throw httpError(404, 'TICKET_NOT_FOUND', 'Ticket not found.');
  const chatId = req.params.chatId;
  if (ticket.chat_id !== chatId && ticket.telefono !== chatId) {
    throw httpError(409, 'CHAT_TICKET_MISMATCH', 'The chat does not match the requested ticket.');
  }
  if (isAdmin(req.user)) return { ticket, ticketId };
  const analyst = await db.getAnalystByTokenId(req.user?.id);
  if (!canAccessTicket(req.user, analyst, ticket)) {
    throw httpError(403, 'TICKET_ACCESS_DENIED', 'You are not authorized to access this ticket.');
  }
  return { ticket, ticketId };
}

async function auditBestEffort(req, action, ticketId, metadata) {
  try {
    await db.logAudit?.({
      actor_name: req.user?.name || 'Unknown user', actor_role: req.user?.role || 'agent',
      action, target_id: String(ticketId), metadata,
    });
  } catch (error) {
    console.error('[candidate-audit]', action, error.code || 'AUDIT_FAILED', error.message);
  }
}

router.get('/:chatId/status', asyncHandler(async (req, res) => {
  await authorize(req);
  const [classification, quarantined] = await Promise.all([
    db.getCandidateClassification(req.params.chatId), candidateQuarantine.has(req.params.chatId),
  ]);
  res.json({ candidate: !!classification || quarantined, classification, locally_quarantined: quarantined });
}));

router.put('/:chatId', asyncHandler(async (req, res) => {
  const { ticketId } = await authorize(req);
  const classification = await db.markCandidate(req.params.chatId, {
    source: 'manual', markedBy: req.user?.name || req.user?.role || 'dashboard', note: req.body?.note || null,
  });
  try {
    await candidateQuarantine.add(req.params.chatId);
  } catch (_error) {
    await auditBestEffort(req, 'candidate.mark_partial', ticketId, { ticket_id: ticketId, target_digest: safeTarget(ticketId), db_classified: true, local_quarantine: false });
    return res.status(503).json({ code: 'CANDIDATE_MARK_PARTIAL', error: 'The contact is blocked in the database, but local protection could not be confirmed. Retry safely.', candidate: true, retryable: true });
  }
  await auditBestEffort(req, 'candidate.marked', ticketId, { ticket_id: ticketId, target_digest: safeTarget(ticketId), source: 'manual' });
  res.json({ candidate: true, classification, locally_quarantined: true });
}));

router.delete('/:chatId', asyncHandler(async (req, res) => {
  const { ticketId } = await authorize(req);
  await db.unmarkCandidate(req.params.chatId);
  try {
    await candidateQuarantine.remove(req.params.chatId);
  } catch (_error) {
    await auditBestEffort(req, 'candidate.unmark_partial', ticketId, { ticket_id: ticketId, target_digest: safeTarget(ticketId), db_classified: false, local_quarantine: true });
    return res.status(503).json({ code: 'CANDIDATE_UNMARK_PARTIAL', error: 'Database classification was removed, but local protection remains. Retry safely.', candidate: true, retryable: true });
  }
  await auditBestEffort(req, 'candidate.unmarked', ticketId, { ticket_id: ticketId, target_digest: safeTarget(ticketId) });
  res.json({ candidate: false, classification: null, locally_quarantined: false });
}));

module.exports = router;

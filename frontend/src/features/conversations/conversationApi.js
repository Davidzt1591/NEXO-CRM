import { apiRequest, jsonBody } from '../../lib/apiClient';
import { makeIdempotencyKey } from './conversationContracts';

export function getWorkflow(ticketId, { signal } = {}) {
  return apiRequest(`/api/conversations/${encodeURIComponent(ticketId)}/workflow`, { signal });
}

export function transitionWorkflow(ticket, state, waitingReason = null) {
  return apiRequest(`/api/conversations/${encodeURIComponent(ticket.id)}/transitions`, {
    method: 'POST',
    body: jsonBody({ version: 1, state, waiting_reason: waitingReason, expected_revision: Number(ticket.workflow_revision), idempotency_key: makeIdempotencyKey('transition') }),
  });
}

export function requestDevelopment(ticket, note) {
  return apiRequest(`/api/conversations/${encodeURIComponent(ticket.id)}/development-escalations`, {
    method: 'POST',
    body: jsonBody({ version: 1, note, expected_revision: Number(ticket.workflow_revision), idempotency_key: makeIdempotencyKey('development') }),
  });
}

export function updateDevelopment(ticket, status, note = null) {
  return apiRequest(`/api/conversations/${encodeURIComponent(ticket.id)}/development-escalations/status`, {
    method: 'POST',
    body: jsonBody({ version: 1, status, note, expected_revision: Number(ticket.workflow_revision), idempotency_key: makeIdempotencyKey('development_status') }),
  });
}

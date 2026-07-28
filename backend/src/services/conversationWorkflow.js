const STATES = new Set(['new', 'in_progress', 'waiting', 'closed']);
const WAITING_REASONS = new Set(['customer_response', 'internal_information', 'development_escalation', 'special_situation']);
const DEVELOPMENT_STATES = new Set(['requested', 'in_progress', 'resolved', 'cancelled']);
const PRIORITY_ALIASES = new Map([
  ['critical', 'critical'], ['critica', 'critical'], ['crítica', 'critical'],
  ['high', 'high'], ['alta', 'high'], ['medium', 'medium'], ['media', 'medium'],
  ['low', 'low'], ['baja', 'low'],
]);

function normalizePriority(value) {
  return PRIORITY_ALIASES.get(String(value || '').trim().toLocaleLowerCase('es')) || null;
}

function transitionPayload(body = {}) {
  const state = String(body.state || '').trim().toLowerCase();
  if (!STATES.has(state)) throw Object.assign(new Error('Unsupported conversation state.'), { statusCode: 400 });
  const waitingReason = body.waiting_reason == null ? null : String(body.waiting_reason).trim().toLowerCase();
  if (state === 'waiting' && !WAITING_REASONS.has(waitingReason)) {
    throw Object.assign(new Error('A supported waiting_reason is required for waiting.'), { statusCode: 400 });
  }
  if (state !== 'waiting' && waitingReason) throw Object.assign(new Error('waiting_reason is only valid for waiting.'), { statusCode: 400 });
  return { state, waitingReason, expectedRevision: positiveRevision(body.expected_revision), idempotencyKey: key(body.idempotency_key) };
}

function escalationPayload(body = {}) {
  const status = String(body.status || '').trim().toLowerCase();
  if (!DEVELOPMENT_STATES.has(status)) throw Object.assign(new Error('Unsupported development status.'), { statusCode: 400 });
  return {
    status, expectedRevision: positiveRevision(body.expected_revision), idempotencyKey: key(body.idempotency_key),
    note: body.note == null ? null : String(body.note).trim().slice(0, 4000),
  };
}

function positiveRevision(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw Object.assign(new Error('expected_revision must be a non-negative integer.'), { statusCode: 400 });
  return number;
}

function key(value) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(value || ''))) throw Object.assign(new Error('A valid idempotency_key is required.'), { statusCode: 400 });
  return String(value);
}

function actorContext(user, analyst) {
  const actorRole = user?.role === 'admin' ? 'admin' : analyst?.id ? 'analyst' : user?.role || 'unknown';
  return {
    actorId: actorRole === 'analyst' ? analyst.id : user?.id,
    actorName: user?.name || 'Unknown',
    actorRole,
    actorAreaId: actorRole === 'analyst' ? analyst.area_id : null,
  };
}

function presentSla(workflow, now = new Date()) {
  const snapshots = workflow?.sla_snapshots || [];
  const clocks = {};
  for (const snapshot of snapshots) {
    const current = clocks[snapshot.clock_type];
    if (current && Number(current.snapshot_id) > Number(snapshot.id)) continue;
    const result = require('./slaClock').computeClock({
      target_minutes: snapshot.target_minutes,
      warning_minutes: snapshot.warning_minutes,
      policy_version: snapshot.policy_version,
      clock_mode: snapshot.clock_mode,
      timezone: snapshot.timezone,
      calendar: snapshot.calendar_snapshot,
    }, snapshot.sla_clock_segments || [], now);
    clocks[snapshot.clock_type] = {
      ...result,
      snapshot_id: snapshot.id,
      state: result.status,
      due_at: result.deadline_at,
      minutes_remaining: result.remaining_minutes,
      sla_minutes: result.target_minutes,
    };
  }
  return clocks;
}

function presentWorkflow(workflow, now = new Date()) {
  return workflow ? { ...workflow, sla: presentSla(workflow, now) } : null;
}

module.exports = { DEVELOPMENT_STATES, PRIORITY_ALIASES, STATES, WAITING_REASONS, actorContext, escalationPayload, normalizePriority, presentSla, presentWorkflow, transitionPayload };

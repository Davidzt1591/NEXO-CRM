// ─────────────────────────────────────────────────────────────────────────────
// Admin API Router — NEXO Backend
// All routes under /api/admin/* and protected by adminOnly in server.js
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const crypto = require('crypto');
const router  = express.Router();
const db      = require('../database/db');
const botFlow = require('../services/botFlow');
const { getBotFlowDefinition } = require('../services/botFlowDefinition');
const { simulateTransition, validateSimulationRequest } = require('../services/botFlowEngine');
const { validateLayoutRequest, serializeLayoutRow, isSchemaMissingError, schemaUnavailableError } = require('../services/botFlowLayout');
const routing = require('../services/routing');
const salesforceOutbox = require('../services/salesforceOutbox');
const { disconnectSocketsForToken, emitRoutingUpdate } = require('../socket');
const ticketPostProcessing = require('../services/ticketPostProcessing');

const asyncHandler = fn => (req, res) =>
  fn(req, res).catch(e => {
    console.error('Admin Route Error:', e.message);
    res.status(e.statusCode || 500).json({ error: e.message });
  });

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key value|unique constraint|unique violation/i.test(error?.message || '');
}

async function mapBotFlowWriteConflict(operation) {
  try {
    return await operation();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const conflict = new Error('A bot flow step already exists for this version, area, and step key.');
      conflict.statusCode = 409;
      throw conflict;
    }
    throw err;
  }
}

function requireText(value, field) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    const err = new Error(`${field} is required.`);
    err.statusCode = 400;
    throw err;
  }
  return value.trim();
}

function candidateSettingsPayload(body) {
  const formUrl = typeof body?.formUrl === 'string' ? body.formUrl.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (formUrl) {
    let parsed;
    try { parsed = new URL(formUrl); } catch { throw Object.assign(new Error('formUrl must be a valid HTTPS URL or blank.'), { statusCode: 400 }); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || formUrl.length > 2048) {
      throw Object.assign(new Error('formUrl must be a valid HTTPS URL or blank.'), { statusCode: 400 });
    }
  }
  if (message.length > 1000) throw Object.assign(new Error('message must not exceed 1000 characters.'), { statusCode: 400 });
  return { formUrl, message };
}

function requirePatchBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('PATCH body must be a JSON object.');
    err.statusCode = 400;
    throw err;
  }

  const validKeys = Object.keys(body).filter(key => allowedFields.includes(key));
  if (validKeys.length === 0) {
    const err = new Error(`PATCH body must include at least one valid field: ${allowedFields.join(', ')}.`);
    err.statusCode = 400;
    throw err;
  }
}

function optionalAreaId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(Number(value)) || Number(value) <= 0 || String(value).trim() !== String(Number(value))) {
    const err = new Error(`${field} must be a positive integer.`);
    err.statusCode = 400;
    throw err;
  }
  return Number(value);
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isInteger(Number(value)) || Number(value) <= 0 || String(value).trim() !== String(Number(value))) {
    const err = new Error(`${field} must be a positive integer.`);
    err.statusCode = 400;
    throw err;
  }
  return Number(value);
}

function requiredPositiveInteger(value, field) {
  const normalized = optionalPositiveInteger(value, field);
  if (normalized === undefined) {
    const err = new Error(`${field} is required.`);
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

function optionalInteger(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isInteger(Number(value)) || String(value).trim() !== String(Number(value))) {
    const err = new Error(`${field} must be an integer.`);
    err.statusCode = 400;
    throw err;
  }
  return Number(value);
}

function optionalBoolean(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const err = new Error(`${field} must be true or false.`);
  err.statusCode = 400;
  throw err;
}

function normalizeBotFlowPayload(body, { partial = false } = {}) {
  const payload = {};

  if (!partial || Object.prototype.hasOwnProperty.call(body, 'version_id')) {
    payload.version_id = requiredPositiveInteger(body?.version_id, 'version_id');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'step_key')) {
    payload.step_key = requireText(body?.step_key, 'step_key');
    if (!botFlow.SUPPORTED_STEP_KEYS.includes(payload.step_key)) {
      const err = new Error(`Unsupported step_key. Supported values: ${botFlow.SUPPORTED_STEP_KEYS.join(', ')}.`);
      err.statusCode = 400;
      throw err;
    }
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'message')) {
    payload.message = requireText(body?.message, 'message');
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'area_id')) payload.area_id = optionalAreaId(body.area_id, 'area_id');
  if (Object.prototype.hasOwnProperty.call(body || {}, 'sort_order')) payload.sort_order = optionalInteger(body.sort_order, 'sort_order') ?? 0;
  if (Object.prototype.hasOwnProperty.call(body || {}, 'active')) payload.active = optionalBoolean(body.active, 'active');

  return payload;
}

async function assertUniqueBotFlowStep(payload, currentId = null) {
  const versionId = payload.version_id;
  const stepKey = payload.step_key;
  if (!versionId || !stepKey) return;

  const existing = await db.listBotFlows({
    versionId,
    areaId: payload.area_id || undefined,
    globalOnly: payload.area_id === null,
  });
  const duplicate = existing.find(row => (
    String(row.step_key) === stepKey &&
    String(row.version_id) === String(versionId) &&
    String(row.area_id || '') === String(payload.area_id || '') &&
    String(row.id) !== String(currentId || '')
  ));

  if (duplicate) {
    const err = new Error('A bot flow step already exists for this version, area, and step key.');
    err.statusCode = 409;
    throw err;
  }
}

async function audit(req, action, targetId, metadata) {
  await db.logAudit({
    actor_name: req.user?.name || 'Unknown admin',
    actor_role: req.user?.role || 'admin',
    action,
    target_id: targetId ? String(targetId) : null,
    metadata,
  });
}

async function requireTokenAudit(req, action, targetId, metadata) {
  const result = await db.logAudit({
    actor_name: req.user?.name || 'Unknown admin',
    actor_role: req.user?.role || 'admin',
    action,
    target_id: targetId ? String(targetId) : null,
    metadata,
  });
  if (!result) throw new Error('Token audit was not persisted.');
  return result;
}

function requireExactBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
  const keys = Object.keys(body);
  if (keys.length !== allowedFields.length || keys.some(key => !allowedFields.includes(key))) {
    throw Object.assign(new Error(`Request body must contain exactly: ${allowedFields.join(', ')}.`), { statusCode: 400 });
  }
}

function requireEmptyBody(body) {
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw Object.assign(new Error('Request body must be empty.'), { statusCode: 400 });
  }
}

function emitRoutingFromRequest(req, ticket, options = {}) {
  const io = req.app?.get?.('io');
  if (!io) return;
  emitRoutingUpdate(io, ticket, options);
}

const analystReconciliations = new Map();
const tokenMutations = new Map();

function withTokenMutation(tokenId, operation) {
  const key = String(tokenId);
  const previous = tokenMutations.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation).finally(() => {
    if (tokenMutations.get(key) === current) tokenMutations.delete(key);
  });
  tokenMutations.set(key, current);
  return current;
}

async function requireActiveAgentToken(tokenId) {
  if (await db.getActiveAgentToken(tokenId)) return;
  throw Object.assign(new Error('The selected agent token is not active.'), { code: 'TOKEN_NOT_ACTIVE', statusCode: 409 });
}

function tokenNotActiveResponse(res, error) {
  if (error?.code !== 'TOKEN_NOT_ACTIVE') throw error;
  return res.status(409).json({ code: 'TOKEN_NOT_ACTIVE', error: 'The selected agent token is not active.' });
}

function reconcileAnalystSockets(req, analystId, switchResult = null) {
  const key = String(analystId);
  const previous = analystReconciliations.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const analyst = await db.getAnalystById(analystId);
    const io = req.app?.get?.('io');
    if (!io || !analyst) return analyst;
    for (const socket of io.sockets.sockets.values()) {
      if (String(socket.analyst?.id || '') !== key) continue;
      for (const room of [...socket.rooms]) if (room.startsWith('area:')) socket.leave(room);
      socket.join(`analyst:${analyst.id}`);
      if (analyst.area_id) socket.join(`area:${analyst.area_id}`);
      socket.analyst = analyst;
      socket.emit('workspace-replaced', {
        previousAreaId: switchResult?.previous_area_id ?? null,
        areaId: analyst.area_id || null,
        areaRevision: analyst.area_revision ?? switchResult?.area_revision ?? null,
        removedTicketIds: switchResult?.unassigned_ticket_ids || [],
      });
      socket.emit('principal-info', { user: socket.user, analyst });
    }
    return analyst;
  }).finally(() => {
    if (analystReconciliations.get(key) === current) analystReconciliations.delete(key);
  });
  analystReconciliations.set(key, current);
  return current;
}

// ── Agent tokens ────────────────────────────────────────────────────────────
router.get('/agent-tokens', asyncHandler(async (_req, res) => {
  res.json({ tokens: await db.listAgentTokens() });
}));

router.post('/agent-tokens', asyncHandler(async (req, res) => {
  requireExactBody(req.body, ['name']);
  const name = requireText(req.body.name, 'name');
  if (name.length > 160) throw Object.assign(new Error('name must not exceed 160 characters.'), { statusCode: 400 });

  const pending = await db.createPendingAgentToken(name);
  try {
    await requireTokenAudit(req, 'agent_token.created', pending.token.id, { name, role: 'agent', activation_pending: true });
  } catch (_error) {
    return res.status(503).json({ code: 'TOKEN_AUDIT_FAILED', error: 'Token creation could not be audited.' });
  }

  let metadata;
  try {
    metadata = await db.activatePendingAgentToken(pending.token.id);
  } catch (_error) {
    metadata = null;
  }
  if (!metadata) {
    try { await db.revokePendingAgentToken(pending.token.id); } catch (_error) { /* staged row remains inactive */ }
    return res.status(503).json({ code: 'TOKEN_ACTIVATION_FAILED', error: 'Token creation could not be activated.' });
  }
  res.status(201).json({ token: pending.rawToken, metadata });
}));

router.post('/agent-tokens/:id/revoke', asyncHandler(async (req, res) => {
  requireEmptyBody(req.body);
  const id = requiredPositiveInteger(req.params.id, 'id');
  const headerRequestId = req.headers['x-correlation-id'];
  const requestId = typeof headerRequestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(headerRequestId)
    ? headerRequestId : crypto.randomUUID();
  const result = await withTokenMutation(id, async () => {
    try {
      return await db.revokeAgentTokenAtomically(id, req.user.id, requestId);
    } catch (error) {
      if (error?.code !== 'TOKEN_REVOCATION_UNAVAILABLE') throw error;
      return { unavailable: true };
    }
  });
  if (result.unavailable) return res.status(503).json({ code: 'TOKEN_REVOCATION_UNAVAILABLE', error: 'Token revocation is temporarily unavailable.' });
  if (result.outcome === 'not_found') return res.status(404).json({ code: 'TOKEN_NOT_FOUND', error: 'Agent token not found.' });
  if (result.outcome === 'wrong_role') return res.status(409).json({ code: 'TOKEN_WRONG_ROLE', error: 'The selected token is not an agent token.' });
  let disconnectedSockets;
  if (result.outcome === 'revoked' && req.app?.get?.('io')) {
    try {
      disconnectedSockets = await disconnectSocketsForToken(req.app.get('io'), id);
      console.info('[agent_token_revocation] local_socket_teardown', {
        outcome: 'completed',
        disconnected_sockets: disconnectedSockets,
        reason_code: disconnectedSockets === 0 ? 'NO_LOCAL_MATCH' : 'MATCHES_DISCONNECTED',
      });
    } catch (error) {
      console.warn('[agent_token_revocation] local_socket_teardown', {
        outcome: 'failed',
        disconnected_sockets: Number.isInteger(error?.disconnectedSockets) ? error.disconnectedSockets : 0,
        reason_code: 'SOCKET_TEARDOWN_FAILED',
      });
      /* revocation remains durable */
    }
  }
  res.json({ outcome: result.outcome, metadata: result.token, ...(disconnectedSockets === undefined ? {} : { disconnected_sockets: disconnectedSockets }) });
}));

// ── Areas ───────────────────────────────────────────────────────────────────
router.get('/areas', asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive !== 'false';
  const areas = await db.listAreas({ includeInactive });
  res.json(areas);
}));

router.post('/areas', asyncHandler(async (req, res) => {
  const area = await db.createArea({
    name: requireText(req.body.name, 'name'),
    description: req.body.description,
    welcome_msg: req.body.welcome_msg,
    active: req.body.active,
    sla_minutes: req.body.sla_minutes,
  });

  await audit(req, 'area.created', area.id, { name: area.name });
  res.status(201).json(area);
}));

router.patch('/areas/:id', asyncHandler(async (req, res) => {
  requirePatchBody(req.body, ['name', 'description', 'welcome_msg', 'active', 'sla_minutes']);
  const area = await db.updateArea(req.params.id, req.body);
  await audit(req, 'area.updated', area.id, req.body);
  res.json(area);
}));

// ── Analysts ────────────────────────────────────────────────────────────────
router.get('/analysts', asyncHandler(async (req, res) => {
  const analysts = await db.listAnalysts();
  res.json(analysts);
}));

router.post('/analysts', asyncHandler(async (req, res) => {
  const payload = {
    token_id: req.body.token_id,
    area_id: req.body.area_id,
    display_name: requireText(req.body.display_name, 'display_name'),
    available: req.body.available,
  };
  let analyst;
  try {
    analyst = payload.token_id === undefined
      ? await db.createAnalyst(payload)
      : await withTokenMutation(payload.token_id, async () => {
        await requireActiveAgentToken(payload.token_id);
        return db.createAnalyst(payload);
      });
  } catch (error) {
    return tokenNotActiveResponse(res, error);
  }

  await audit(req, 'analyst.created', analyst.id, {
    token_id: analyst.token_id,
    area_id: analyst.area_id,
  });
  res.status(201).json(analyst);
}));

router.patch('/analysts/:id', asyncHandler(async (req, res) => {
  requirePatchBody(req.body, ['token_id', 'area_id', 'display_name', 'available', 'last_seen']);
  const operation = async () => {
    if (Object.hasOwn(req.body, 'token_id')) await requireActiveAgentToken(req.body.token_id);
    const analystId = Number(req.params.id);
    const areaRequested = Object.hasOwn(req.body, 'area_id');
    const remainingChanges = { ...req.body }; delete remainingChanges.area_id;
    const updated = Object.keys(remainingChanges).length ? await db.updateAnalyst(req.params.id, remainingChanges) : null;
    if (!areaRequested) {
      const analyst = updated || await db.getAnalystById(req.params.id);
      await audit(req, 'analyst.updated', analyst.id, req.body);
      return analyst;
    }
    let switched = null;
    try {
      switched = await db.switchAnalystArea({ analystId, areaId: Number(req.body.area_id), actorName: req.user?.name || 'admin', metadata: { explicit_override: true } });
    } finally {
      await reconcileAnalystSockets(req, analystId, switched);
    }
    return db.getAnalystById(analystId);
  };
  let analyst;
  try {
    analyst = Object.hasOwn(req.body, 'token_id') ? await withTokenMutation(req.body.token_id, operation) : await operation();
  } catch (error) {
    return tokenNotActiveResponse(res, error);
  }
  res.json(analyst);
}));

router.get('/category-area-mappings', asyncHandler(async (_req, res) => {
  res.json(await db.listCategoryAreaMappings());
}));

router.put('/category-area-mappings/:key', asyncHandler(async (req, res) => {
  const key = String(req.params.key || '').trim().toLowerCase();
  if (!['platform', 'tests', 'requests', 'integrations'].includes(key)) throw Object.assign(new Error('Unsupported category key.'), { statusCode: 400 });
  requirePatchBody(req.body, ['area_id', 'active']);
  const mapping = await db.updateCategoryAreaMapping(key, req.body);
  await audit(req, 'category_area_mapping.updated', key, { area_id: mapping.area_id, active: mapping.active });
  res.json(mapping);
}));

async function runSlaService(operation) {
  try { return await operation(); } catch (error) { if (error.statusCode && error.statusCode < 500) throw error; throw Object.assign(new Error('SLA configuration service is temporarily unavailable.'), { statusCode: 503 }); }
}
router.get('/sla/policies', asyncHandler(async (_req, res) => res.json({ policies: await runSlaService(() => db.listSlaPolicies()) })));
router.get('/sla/calendars', asyncHandler(async (_req, res) => res.json({ calendars: await runSlaService(() => db.listBusinessCalendars()) })));

router.post('/sla/policies', asyncHandler(async (req, res) => {
  const priority = requireText(req.body.priority, 'priority').toLowerCase();
  const clockType = requireText(req.body.clock_type, 'clock_type').toLowerCase();
  const clockMode = requireText(req.body.clock_mode || 'business_hours', 'clock_mode').toLowerCase();
  if (!['critical','high','medium','low'].includes(priority) || !['support','development'].includes(clockType) || !['business_hours','24x7'].includes(clockMode)) throw Object.assign(new Error('Invalid SLA policy enum.'), { statusCode: 400 });
  const targetMinutes = requiredPositiveInteger(req.body.target_minutes, 'target_minutes');
  const warningMinutes = optionalInteger(req.body.warning_minutes, 'warning_minutes');
  if (warningMinutes === undefined || warningMinutes < 0 || warningMinutes >= targetMinutes) throw Object.assign(new Error('warning_minutes must be non-negative and below target_minutes.'), { statusCode: 400 });
  const calendarId = optionalAreaId(req.body.calendar_id, 'calendar_id');
  if (clockMode === 'business_hours' && !calendarId) throw Object.assign(new Error('calendar_id is required for business_hours.'), { statusCode: 400 });
  res.status(201).json(await runSlaService(() => db.configureSlaPolicy({ areaId: requiredPositiveInteger(req.body.area_id, 'area_id'), priority, clockType, clockMode, calendarId, targetMinutes, warningMinutes, actorName: req.user.name || 'admin' })));
}));

router.post('/sla/calendars', asyncHandler(async (req, res) => {
  const timezone = requireText(req.body.timezone || 'America/Bogota', 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw Object.assign(new Error('timezone must be a valid IANA timezone.'), { statusCode: 400 }); }
  if (!Array.isArray(req.body.windows) || !Array.isArray(req.body.exceptions || [])) throw Object.assign(new Error('windows and exceptions must be arrays.'), { statusCode: 400 });
  res.status(201).json(await runSlaService(() => db.configureBusinessCalendar({ areaId: requiredPositiveInteger(req.body.area_id, 'area_id'), name: requireText(req.body.name, 'name'), timezone, windows: req.body.windows, exceptions: req.body.exceptions || [], actorName: req.user.name || 'admin' })));
}));

// ── Audit ───────────────────────────────────────────────────────────────────
router.get('/audit', asyncHandler(async (req, res) => {
  const logs = await db.listAuditLogs({
    limit: req.query.limit,
    offset: req.query.offset,
    action: req.query.action,
    actor_role: req.query.actor_role,
    target_id: req.query.target_id,
    from: req.query.from,
    to: req.query.to,
  });
  res.json(logs);
}));

// ── Reports ─────────────────────────────────────────────────────────────────
router.get('/reports/summary', asyncHandler(async (req, res) => {
  const summary = await db.getAdminReportSummary();
  res.json(summary);
}));

router.get('/candidate-settings', asyncHandler(async (_req, res) => {
  res.json(await db.getCandidateSupportSettings());
}));

router.put('/candidate-settings', asyncHandler(async (req, res) => {
  const settings = candidateSettingsPayload(req.body);
  const saved = await db.updateCandidateSupportSettings(settings);
  await audit(req, 'candidate.settings_updated', 'candidate-support', {
    form_url_configured: !!saved.formUrl, message_length: saved.message.length,
  });
  res.json(saved);
}));

router.get('/candidates', asyncHandler(async (_req, res) => {
  const candidates = await db.listCandidateClassifications();
  res.json({ candidates });
}));

// ── Salesforce Outbox ───────────────────────────────────────────────────────
router.get('/salesforce-outbox', asyncHandler(async (req, res) => {
  const filters = salesforceOutbox.normalizeListFilters(req.query);
  const jobs = await db.listSalesforceOutboxJobs(filters);
  res.json({ jobs: jobs.map(salesforceOutbox.serializeAdminOutboxJob), filters });
}));

router.post('/salesforce-outbox/:id/retry', asyncHandler(async (req, res) => {
  const id = requiredPositiveInteger(req.params.id, 'id');
  const job = await db.markSalesforceOutboxJobRetryable(id);
  await audit(req, 'salesforce_outbox.retry', job.id, {
    ticket_id: job.ticket_id,
    operation: job.operation,
  });
  res.json({ job: salesforceOutbox.serializeAdminOutboxJob(job) });
}));

router.post('/salesforce-outbox/process', asyncHandler(async (req, res) => {
  const limit = salesforceOutbox.normalizeProcessLimit(req.body?.limit);
  try {
    const summary = await salesforceOutbox.processBatch({ db, limit });
    const auditAction = summary.diagnosis && ['processor_failure', 'claim_failure', 'terminal_failure'].includes(summary.diagnosis.category)
      ? 'salesforce_outbox.process_failed'
      : 'salesforce_outbox.processed';
    let auditPersisted = true;
    try {
      await audit(req, auditAction, null, {
        limit,
        failed: summary.counts.failed,
        retrying: summary.counts.retrying,
        lease_lost: summary.counts.lease_lost,
        processor_error: summary.counts.processor_error,
        synced: summary.counts.synced,
        claimed: summary.counts.claimed,
        duration_ms: summary.duration_ms,
        recovery: summary.recovery,
        invocation: summary.invocation,
        external_alerting: summary.external_alerting,
        error_code: summary.diagnosis?.error_code || null,
        error_category: summary.diagnosis?.category || null,
      });
    } catch (_auditError) {
      auditPersisted = false;
      console.error('[salesforce_outbox] processor_audit_persist_failed');
    }
    res.json({
      ...summary,
      audit_persisted: auditPersisted,
      warnings: auditPersisted ? [] : ['PROCESSOR_AUDIT_PERSIST_FAILED'],
    });
  } catch (error) {
    const classified = salesforceOutbox.classifyProcessorError(error);
    await audit(req, 'salesforce_outbox.process_failed', null, {
      limit, error_code: classified.code, recovery: 'manual_admin_invocation_required',
    });
    throw error;
  }
}));

// ── Routing / Queue ────────────────────────────────────────────────────────
router.get('/queue', asyncHandler(async (req, res) => {
  const tickets = routing.enrichTickets(await db.getTicketsWithRouting());
  res.json({ tickets });
}));

router.post('/tickets/:id/assign', asyncHandler(async (req, res) => {
  const ticket = await routing.assignTicket(db, {
    ticketId: req.params.id,
    analystId: req.body?.analyst_id,
    assignedBy: 'manual',
    actor: req.user,
  });

  emitRoutingFromRequest(req, ticket);
  res.json(ticket);
}));

router.post('/tickets/:id/unassign', asyncHandler(async (req, res) => {
  const ticket = await routing.unassignTicket(db, req.params.id, { assignedBy: 'manual' });
  emitRoutingFromRequest(req, ticket);
  res.json(ticket);
}));

router.post('/tickets/:id/transfer', asyncHandler(async (req, res) => {
  const ticket = await routing.transferTicket(db, {
    ticketId: req.params.id,
    areaId: req.body?.area_id,
    analystId: req.body?.analyst_id,
    actor: req.user,
  });

  emitRoutingFromRequest(req, ticket, { previousAreaId: ticket.previous_area_id || null });
  res.json(ticket);
}));

// ── Bot flows ───────────────────────────────────────────────────────────────
router.get('/bot-flow-studio/definition', asyncHandler(async (req, res) => {
  const areaId = optionalAreaId(req.query.area_id, 'area_id');
  const versionId = optionalPositiveInteger(req.query.version_id, 'version_id');
  let flow;
  if (versionId) {
    const [globalRows, areaRows] = await Promise.all([
      db.listBotFlows({ versionId, globalOnly: true, active: true }),
      areaId ? db.listBotFlows({ versionId, areaId, active: true }) : Promise.resolve([]),
    ]);
    flow = botFlow.buildFlow([...globalRows, ...areaRows], areaId, versionId);
  } else {
    flow = await botFlow.loadFlow(areaId);
  }
  res.json({
    definition: getBotFlowDefinition(Object.fromEntries(flow.messages)),
    message_source: flow.source,
    version_id: flow.versionId,
  });
}));

router.post('/bot-flow-studio/simulate', asyncHandler(async (req, res) => {
  validateSimulationRequest(req.body);
  const versionId = req.body.version_id;
  const areaId = req.body.area_id ?? null;
  let flow;
  if (versionId) {
    const [globalRows, areaRows] = await Promise.all([
      db.listBotFlows({ versionId, globalOnly: true, active: true }),
      areaId ? db.listBotFlows({ versionId, areaId, active: true }) : Promise.resolve([]),
    ]);
    flow = botFlow.buildFlow([...globalRows, ...areaRows], areaId, versionId);
  } else {
    flow = await botFlow.loadFlow(areaId);
  }
  const simulation = simulateTransition(req.body, Object.fromEntries(flow.messages));
  const editContext = { version_id: flow.versionId, area_id: areaId };
  const provenance = Object.fromEntries((simulation.outputs || []).map(output => [output.node_id, {
    node_id: output.node_id,
    message_key: output.message_key,
    source: flow.messageSources?.get(output.message_key) || 'fallback',
    edit_context: editContext,
  }]));
  res.json({ mode: 'dry-run', ...simulation, provenance });
}));

router.get('/bot-flow-studio/layout', asyncHandler(async (req, res) => {
  const versionId = requiredPositiveInteger(req.query.version_id, 'version_id');
  const areaId = optionalAreaId(req.query.area_id, 'area_id');
  try {
    const row = await db.getBotFlowStudioLayout({ versionId, areaId });
    res.json(serializeLayoutRow(row, versionId, areaId));
  } catch (error) {
    if (isSchemaMissingError(error)) throw schemaUnavailableError();
    throw error;
  }
}));

router.put('/bot-flow-studio/layout', asyncHandler(async (req, res) => {
  const versionId = requiredPositiveInteger(req.query.version_id, 'version_id');
  const areaId = optionalAreaId(req.query.area_id, 'area_id');
  const request = validateLayoutRequest(req.body, req.get('content-length'));
  let row;
  try {
    row = await db.putBotFlowStudioLayout({
      versionId, areaId, layout: request.layout, expectedRevision: request.revision,
      updatedBy: String(req.user?.name || 'Admin').slice(0, 160),
    });
  } catch (error) {
    if (isSchemaMissingError(error)) throw schemaUnavailableError();
    throw error;
  }
  if (!row) {
    const error = new Error('El borrador cambió en otra sesión. Recarga la versión más reciente antes de continuar.');
    error.statusCode = 409;
    error.code = 'BOT_FLOW_LAYOUT_CONFLICT';
    throw error;
  }
  const result = serializeLayoutRow(row, versionId, areaId);
  await audit(req, 'bot_flow_studio.layout_saved', `${versionId}:${areaId ?? 'global'}`, {
    version_id: versionId, area_id: areaId, revision: result.revision,
    node_count: result.layout.nodes.length, edge_count: result.layout.edges.length,
  });
  res.json(result);
}));

router.get('/bot-flows', asyncHandler(async (req, res) => {
  const versionId = optionalPositiveInteger(req.query.version_id, 'version_id');
  const areaId = optionalAreaId(req.query.area_id, 'area_id');
  const globalOnly = req.query.scope === 'global' || req.query.global === 'true';
  const active = req.query.active === 'all' ? undefined : optionalBoolean(req.query.active ?? true, 'active');
  const flows = req.query.version_id || req.query.active || globalOnly
    ? await db.listBotFlows({ versionId, areaId, globalOnly, active })
    : await db.listActiveBotFlows({ areaId });
  res.json({ flows, cache: botFlow.getBotFlowCacheStatus() });
}));

router.post('/bot-flows', asyncHandler(async (req, res) => {
  const payload = normalizeBotFlowPayload(req.body);
  await assertUniqueBotFlowStep(payload);

  const flow = await mapBotFlowWriteConflict(() => db.createBotFlowStep(payload));
  botFlow.invalidateBotFlowCache();
  await audit(req, 'flow.created', flow.id, {
    version_id: flow.version_id,
    area_id: flow.area_id || null,
    step_key: flow.step_key,
  });
  res.status(201).json(flow);
}));

router.patch('/bot-flows/:id', asyncHandler(async (req, res) => {
  requirePatchBody(req.body, ['version_id', 'area_id', 'step_key', 'message', 'sort_order', 'active']);
  const current = await db.listBotFlows({ active: undefined });
  const existing = current.find(row => String(row.id) === String(req.params.id));
  if (!existing) {
    const err = new Error('Bot flow step not found.');
    err.statusCode = 404;
    throw err;
  }

  const changes = normalizeBotFlowPayload(req.body, { partial: true });
  const next = { ...existing, ...changes };
  await assertUniqueBotFlowStep(next, req.params.id);

  const flow = await mapBotFlowWriteConflict(() => db.updateBotFlowStep(req.params.id, changes));
  botFlow.invalidateBotFlowCache();
  await audit(req, 'flow.updated', flow.id, changes);
  res.json(flow);
}));

router.post('/bot-flows/:id/toggle', asyncHandler(async (req, res) => {
  const active = optionalBoolean(req.body?.active, 'active');
  if (active === undefined) {
    const err = new Error('active is required.');
    err.statusCode = 400;
    throw err;
  }

  const flow = await db.updateBotFlowStep(req.params.id, { active });
  botFlow.invalidateBotFlowCache();
  await audit(req, 'flow.toggled', flow.id, { active: flow.active });
  res.json(flow);
}));

router.post('/bot-flows/cache/invalidate', asyncHandler(async (req, res) => {
  const areaId = optionalAreaId(req.body?.area_id, 'area_id');
  botFlow.invalidateBotFlowCache(areaId);

  await audit(req, 'flow.cache_invalidated', areaId || 'global', { area_id: areaId });
  res.json({ ok: true, cache: botFlow.getBotFlowCacheStatus() });
}));

router.get('/ticket-post-processing', asyncHandler(async (req, res) => {
  const limit = optionalPositiveInteger(req.query.limit, 'limit') || 50;
  if (limit > 200) throw Object.assign(new Error('limit must not exceed 200.'), { statusCode: 400 });
  const items = await db.listTicketPostProcessing({ limit, status: req.query.status });
  res.json({ items: items.map(ticketPostProcessing.serialize) });
}));

router.post('/ticket-post-processing/process', asyncHandler(async (req, res) => {
  const limit = optionalPositiveInteger(req.body?.limit, 'limit') || 10;
  if (limit > 25) throw Object.assign(new Error('limit must not exceed 25.'), { statusCode: 400 });
  try {
    await audit(req, 'ticket_post_processing.invoked', 'batch', { requested_limit: limit });
  } catch (error) {
    console.error('Ticket post-processing pre-audit failed:', error.message);
    return res.status(503).json({ code: 'AUDIT_UNAVAILABLE', error: 'Processing could not be authorized for execution.' });
  }
  const result = await ticketPostProcessing.processBatch({ db, io: req.app.get('io'), limit });
  await audit(req, 'ticket_post_processing.completed', 'batch', {
    requested_limit: limit, claimed: result.claimed,
    completed_effects: result.results.reduce((count, item) => count + item.effects.filter(effect => effect.status === 'completed').length, 0),
    failed_effects: result.results.reduce((count, item) => count + item.effects.filter(effect => effect.status === 'failed').length, 0),
    uncertain_effects: result.results.reduce((count, item) => count + item.effects.filter(effect => effect.status === 'uncertain').length, 0),
    lease_lost_effects: result.results.reduce((count, item) => count + item.effects.filter(effect => effect.status === 'lease_lost').length, 0),
  });
  res.json(result);
}));

module.exports = router;

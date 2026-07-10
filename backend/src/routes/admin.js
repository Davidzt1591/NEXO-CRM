// ─────────────────────────────────────────────────────────────────────────────
// Admin API Router — NEXO Backend
// All routes under /api/admin/* and protected by adminOnly in server.js
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const botFlow = require('../services/botFlow');
const routing = require('../services/routing');
const { emitRoutingUpdate } = require('../socket');

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

function emitRoutingFromRequest(req, ticket, options = {}) {
  const io = req.app?.get?.('io');
  if (!io) return;
  emitRoutingUpdate(io, ticket, options);
}

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
  const analyst = await db.createAnalyst({
    token_id: req.body.token_id,
    area_id: req.body.area_id,
    display_name: requireText(req.body.display_name, 'display_name'),
    available: req.body.available,
  });

  await audit(req, 'analyst.created', analyst.id, {
    token_id: analyst.token_id,
    area_id: analyst.area_id,
  });
  res.status(201).json(analyst);
}));

router.patch('/analysts/:id', asyncHandler(async (req, res) => {
  requirePatchBody(req.body, ['token_id', 'area_id', 'display_name', 'available', 'last_seen']);
  const analyst = await db.updateAnalyst(req.params.id, req.body);
  await audit(req, 'analyst.updated', analyst.id, req.body);
  res.json(analyst);
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

  await audit(req, 'ticket.assigned', ticket.id, {
    analyst_id: ticket.assignment?.analyst_id || null,
    area_id: ticket.area_id || null,
  });
  emitRoutingFromRequest(req, ticket);
  res.json(ticket);
}));

router.post('/tickets/:id/unassign', asyncHandler(async (req, res) => {
  const ticket = await routing.unassignTicket(db, req.params.id, { assignedBy: 'manual' });
  await audit(req, 'ticket.unassigned', ticket.id, { area_id: ticket.area_id || null });
  emitRoutingFromRequest(req, ticket);
  res.json(ticket);
}));

router.post('/tickets/:id/transfer', asyncHandler(async (req, res) => {
  const previousTicket = await db.getTicketById(req.params.id);
  const ticket = await routing.transferTicket(db, {
    ticketId: req.params.id,
    areaId: req.body?.area_id,
    analystId: req.body?.analyst_id,
    actor: req.user,
  });

  await audit(req, 'ticket.transferred', ticket.id, {
    area_id: ticket.area_id || null,
    analyst_id: ticket.assignment?.analyst_id || null,
  });
  emitRoutingFromRequest(req, ticket, { previousAreaId: previousTicket?.area_id || null });
  res.json(ticket);
}));

// ── Bot flows ───────────────────────────────────────────────────────────────
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

module.exports = router;

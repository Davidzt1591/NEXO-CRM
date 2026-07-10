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
  const logs = await db.listAuditLogs(req.query.limit);
  res.json(logs);
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
  const areaId = optionalAreaId(req.query.area_id, 'area_id');
  const flows = await db.listActiveBotFlows({ areaId });
  res.json({ flows, cache: botFlow.getBotFlowCacheStatus() });
}));

router.post('/bot-flows/cache/invalidate', asyncHandler(async (req, res) => {
  const areaId = optionalAreaId(req.body?.area_id, 'area_id');
  botFlow.invalidateBotFlowCache(areaId);

  await audit(req, 'flow.cache_invalidated', areaId || 'global', { area_id: areaId });
  res.json({ ok: true, cache: botFlow.getBotFlowCacheStatus() });
}));

module.exports = router;

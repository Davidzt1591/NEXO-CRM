// ─────────────────────────────────────────────────────────────────────────────
// Admin API Router — NEXO Backend
// All routes under /api/admin/* and protected by adminOnly in server.js
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const db      = require('../database/db');

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

async function audit(req, action, targetId, metadata) {
  await db.logAudit({
    actor_name: req.user?.name || 'Unknown admin',
    actor_role: req.user?.role || 'admin',
    action,
    target_id: targetId ? String(targetId) : null,
    metadata,
  });
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

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// Salesforce API Router — NEXO Backend Proxy
// All routes under /api/sf/*
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const sf      = require('../services/salesforce');

// Helper to wrap async route handlers
const asyncHandler = fn => (req, res) =>
  fn(req, res).catch(e => {
    console.error('SF Route Error:', e.message);
    res.status(500).json({ error: e.message });
  });

// ── GET /api/sf/me — Analista autenticado ───────────────────────────────────
router.get('/me', asyncHandler(async (req, res) => {
  const info = await sf.getOwnerInfo();
  res.json(info || { error: 'No configurado' });
}));

// ── GET /api/sf/describe — Picklists en vivo ────────────────────────────────
router.get('/describe', asyncHandler(async (req, res) => {
  const picklists = await sf.getDescribe();
  res.json(picklists);
}));

// ── GET /api/sf/cases/:id — Obtener Case existente ──────────────────────────
router.get('/cases/:id', asyncHandler(async (req, res) => {
  const result = await sf.obtenerCase(req.params.id);
  res.json(result);
}));

// ── POST /api/sf/cases — Crear Case ─────────────────────────────────────────
router.post('/cases', asyncHandler(async (req, res) => {
  const result = await sf.crearCase(req.body);
  res.json(result);
}));

// ── PATCH /api/sf/cases/:id — Actualizar Case ───────────────────────────────
router.patch('/cases/:id', asyncHandler(async (req, res) => {
  const result = await sf.actualizarCase(req.params.id, req.body);
  res.json(result);
}));

// ── POST /api/sf/cases/:id/close — Cerrar Case ─────────────────────────────
router.post('/cases/:id/close', asyncHandler(async (req, res) => {
  const { resolucion, subetapa_resuelto } = req.body;
  if (!resolucion?.trim()) {
    return res.status(400).json({ error: 'El campo "resolucion" es obligatorio para cerrar el caso.' });
  }
  const result = await sf.cerrarCase(req.params.id, resolucion, subetapa_resuelto);
  res.json(result);
}));

// ── PATCH /api/sf/cases/:id/assign-me — Asignar al analista actual ──────────
router.patch('/cases/:id/assign-me', asyncHandler(async (req, res) => {
  const result = await sf.asignarmeCase(req.params.id);
  res.json(result);
}));

// ── GET /api/sf/accounts?q=texto — Búsqueda de Cuentas ─────────────────────
router.get('/accounts', asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 3) {
    return res.json([]);
  }
  const results = await sf.buscarCuentas(q.trim());
  res.json(results);
}));

module.exports = router;

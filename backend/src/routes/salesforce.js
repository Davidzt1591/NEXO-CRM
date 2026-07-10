// ─────────────────────────────────────────────────────────────────────────────
// Salesforce API Router — NEXO Backend Proxy
// All routes under /api/sf/*
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const sf      = require('../services/salesforce');
const ticketClose = require('../services/ticketClose');
const db = require('../database/db');
const { canAccessTicket } = require('../realtime/operational');

// Helper to wrap async route handlers
const asyncHandler = fn => (req, res) =>
  fn(req, res).catch(e => {
    console.error('SF Route Error:', e.message);
    res.status(e.statusCode || 500).json({ error: e.message, code: e.code });
  });

async function requireTicketAccess(req, ticketId) {
  const ticket = await db.getTicketWithAssignment(ticketId);
  if (!ticket) {
    const err = new Error('Ticket not found.');
    err.statusCode = 404;
    throw err;
  }

  const analyst = req.user?.role === 'admin' ? null : await db.getAnalystByTokenId(req.user?.id);
  if (!canAccessTicket(req.user, analyst, ticket)) {
    const err = new Error('You are not authorized to access this ticket.');
    err.statusCode = 403;
    err.code = 'TICKET_FORBIDDEN';
    throw err;
  }

  return ticket;
}

async function requireMatchingCaseTicketAccess(req) {
  const ticketId = req.body?.ticket_id || req.query?.ticket_id;
  if (!ticketId) {
    const err = new Error('El campo "ticket_id" es obligatorio para acceder al caso de Salesforce.');
    err.statusCode = 400;
    err.code = 'TICKET_ID_REQUIRED';
    throw err;
  }

  const ticket = await requireTicketAccess(req, ticketId);
  if (!ticket.sf_case_id) {
    const err = new Error('El ticket no tiene un Case de Salesforce asociado.');
    err.statusCode = 400;
    err.code = 'SF_CASE_MISSING';
    throw err;
  }
  if (String(ticket.sf_case_id) !== String(req.params.id)) {
    const err = new Error('El Case de Salesforce no coincide con el ticket indicado.');
    err.statusCode = 400;
    err.code = 'SF_CASE_MISMATCH';
    throw err;
  }

  return ticket;
}

async function bindCreatedCaseToTicket(ticketId, result) {
  if (!result?.id || typeof db.updateTicketSalesforce !== 'function') return;

  try {
    await db.updateTicketSalesforce(ticketId, {
      sf_case_id: result.id,
      sf_case_number: result.CaseNumber || null,
    });
  } catch (cause) {
    console.error('SF Case local binding failed:', cause.message);
    const err = new Error('Salesforce Case was created, but local ticket binding failed. Please retry or contact support.');
    err.statusCode = 502;
    err.code = 'SF_CASE_BIND_FAILED';
    throw err;
  }
}

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
  await requireMatchingCaseTicketAccess(req);
  const result = await sf.obtenerCase(req.params.id);
  res.json(result);
}));

// ── POST /api/sf/cases — Crear Case ─────────────────────────────────────────
router.post('/cases', asyncHandler(async (req, res) => {
  const { ticket_id, ticketId: _ticketIdAlias, user: _user, actor: _actor, auth: _auth, authorization: _authorization, ...casePayload } = req.body || {};
  if (!ticket_id) {
    const err = new Error('El campo "ticket_id" es obligatorio para crear el caso de Salesforce.');
    err.statusCode = 400;
    err.code = 'TICKET_ID_REQUIRED';
    throw err;
  }

  await requireTicketAccess(req, ticket_id);
  const result = await sf.crearCase(casePayload);

  await bindCreatedCaseToTicket(ticket_id, result);

  res.json(result);
}));

// ── PATCH /api/sf/cases/:id — Actualizar Case ───────────────────────────────
router.patch('/cases/:id', asyncHandler(async (req, res) => {
  await requireMatchingCaseTicketAccess(req);
  const { ticket_id: _ticketId, ...caseUpdates } = req.body || {};
  const result = await sf.actualizarCase(req.params.id, caseUpdates);
  res.json(result);
}));

// ── POST /api/sf/cases/:id/close — Cerrar Case ─────────────────────────────
router.post('/cases/:id/close', asyncHandler(async (req, res) => {
  const { resolucion, subetapa_resuelto, ticket_id } = req.body;
  if (!resolucion?.trim()) {
    return res.status(400).json({ error: 'El campo "resolucion" es obligatorio para cerrar el caso.' });
  }

  if (!ticket_id) {
    return res.status(400).json({ error: 'El campo "ticket_id" es obligatorio para cerrar el caso desde Salesforce.' });
  }

  ticketClose.validateSalesforceCloseFields({ resolucion, subetapa_resuelto });
  const ticket = await requireTicketAccess(req, ticket_id);
  if (!ticket.sf_case_id) {
    return res.status(400).json({ error: 'El ticket no tiene un Case de Salesforce asociado.' });
  }
  if (String(ticket.sf_case_id) !== String(req.params.id)) {
    return res.status(400).json({ error: 'El Case de Salesforce no coincide con el ticket indicado.' });
  }

  const result = await ticketClose.closeTicket({
    ticketId: ticket_id,
    actor: req.user,
    resolucion,
    subetapa_resuelto,
    closeSalesforce: true,
  });
  res.json(result);
}));

// ── PATCH /api/sf/cases/:id/assign-me — Asignar al analista actual ──────────
router.patch('/cases/:id/assign-me', asyncHandler(async (req, res) => {
  await requireMatchingCaseTicketAccess(req);
  const result = await sf.asignarmeCase(req.params.id);
  res.json(result);
}));

// ── GET /api/sf/accounts?q=texto — Búsqueda de Cuentas ─────────────────────
router.get('/accounts', asyncHandler(async (req, res) => {
  const { q, ticket_id } = req.query;
  if (!ticket_id) {
    const err = new Error('El campo "ticket_id" es obligatorio para buscar cuentas de Salesforce.');
    err.statusCode = 400;
    err.code = 'TICKET_ID_REQUIRED';
    throw err;
  }

  await requireTicketAccess(req, ticket_id);

  if (!q || q.trim().length < 3) {
    return res.json([]);
  }
  const results = await sf.buscarCuentas(q.trim());
  res.json(results);
}));

module.exports = router;

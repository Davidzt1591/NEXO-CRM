const express = require('express');
const db = require('../database/db');
const { actorContext, escalationPayload, presentWorkflow, transitionPayload } = require('../services/conversationWorkflow');
const { emitTicketOperation, toMinimalQueueCard } = require('../realtime/operational');

const router = express.Router();
const asyncHandler = fn => (req, res) => fn(req, res).catch(error => res.status(error.statusCode || 500).json({ code: error.message, error: error.message }));

async function principal(req) {
  const analyst = await db.getAnalystByTokenId(req.user.id);
  return { analyst, actor: actorContext(req.user, analyst) };
}

function emit(req, workflow, event, mutation) {
  if (mutation?.replayed) return;
  const io = req.app.get('io');
  if (!io) return;
  const presented = presentWorkflow(workflow);
  emitTicketOperation(io, event, presented, { areaPayload: { ticket: toMinimalQueueCard(presented) } });
}

router.get('/:id/workflow', asyncHandler(async (req, res) => {
  const { analyst } = await principal(req);
  const workflow = await db.getTicketWorkflow(req.params.id);
  const assigned = workflow?.assignment?.analyst_id;
  if (!workflow) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.user.role !== 'admin' && (!analyst || String(assigned) !== String(analyst.id) || String(workflow.area_id) !== String(analyst.area_id))) return res.status(403).json({ error: 'Ticket access denied.' });
  res.json(presentWorkflow(workflow));
}));

router.post('/:id/transitions', asyncHandler(async (req, res) => {
  const input = transitionPayload(req.body); const { actor } = await principal(req);
  const { workflow, mutation } = await db.transitionConversation({ ticketId: req.params.id, ...input, actor });
  emit(req, workflow, 'conversation-state-changed', mutation); res.json(presentWorkflow(workflow));
}));

router.post('/:id/development-escalations', asyncHandler(async (req, res) => {
  const input = escalationPayload({ ...req.body, status: 'requested' }); const { actor } = await principal(req);
  const { workflow, mutation } = await db.updateDevelopmentEscalation({ ticketId: req.params.id, ...input, actor });
  emit(req, workflow, 'development-escalation-changed', mutation); res.status(mutation.replayed ? 200 : 201).json(presentWorkflow(workflow));
}));

router.post('/:id/development-escalations/status', asyncHandler(async (req, res) => {
  const input = escalationPayload(req.body); const { actor } = await principal(req);
  const { workflow, mutation } = await db.updateDevelopmentEscalation({ ticketId: req.params.id, ...input, actor });
  emit(req, workflow, 'development-escalation-changed', mutation); res.json(presentWorkflow(workflow));
}));

module.exports = router;

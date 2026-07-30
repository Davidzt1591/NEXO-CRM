/**
 * NEXO — Supabase Database Integration Module
 * Secure Production Implementation with strict TLS/HTTPS.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const salesforceOutbox = require('../services/salesforceOutbox');
const { createAuthValidator } = require('../services/authValidation');

const supabaseUrl = process.env.SUPABASE_URL;
// Server-side backend operations use admin/RLS-protected tables; prefer service_role.
// SUPABASE_ANON_KEY remains a local-development fallback only.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: SUPABASE_URL and a Supabase backend key are required. Prefer SUPABASE_SERVICE_ROLE_KEY server-side.');
}

// Strictly configured Supabase Client (No TLS reject bypass)
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

console.log('🌐 Conexión segura inicializada con Supabase.');

// ── Helpers ────────────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const CHAT_ID_PATTERN = /^[1-9][0-9]{5,31}@(c\.us|lid)$/;

function requireExactChatId(chatId) {
  if (typeof chatId !== 'string' || chatId.length > 64 || !CHAT_ID_PATTERN.test(chatId)) {
    const error = new Error('A valid exact WhatsApp chat ID is required.');
    error.code = 'INVALID_CHAT_ID';
    throw error;
  }
  return chatId;
}

async function getCandidateClassification(chatId) {
  const exactChatId = requireExactChatId(chatId);
  const { data, error } = await supabase.from('contact_classifications').select('*').eq('chat_id', exactChatId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function markCandidate(chatId, { source = 'auto', markedBy = 'whatsapp-bot', note = null } = {}) {
  const exactChatId = requireExactChatId(chatId);
  const payload = {
    chat_id: exactChatId, classification: 'candidate', support_blocked: true,
    source: source === 'manual' ? 'manual' : 'auto', marked_at: new Date().toISOString(),
    marked_by: String(markedBy || 'whatsapp-bot').slice(0, 120),
    note: note === null ? null : String(note).slice(0, 500),
  };
  const { data, error } = await supabase.from('contact_classifications').upsert(payload, { onConflict: 'chat_id' }).select().single();
  if (error) throw error;
  return data;
}

async function unmarkCandidate(chatId) {
  const exactChatId = requireExactChatId(chatId);
  const { error } = await supabase.from('contact_classifications').delete().eq('chat_id', exactChatId);
  if (error) throw error;
  return true;
}

async function claimCandidateGuidance(chatId) {
  const exactChatId = requireExactChatId(chatId);
  const token = crypto.randomUUID();
  const { data, error } = await supabase.rpc('claim_candidate_guidance', { p_chat_id: exactChatId, p_token: token });
  if (error) throw error;
  return data === true || (Array.isArray(data) && data[0] === true) ? token : null;
}

async function finalizeCandidateGuidance(chatId, token) {
  const exactChatId = requireExactChatId(chatId);
  const { data, error } = await supabase.rpc('finalize_candidate_guidance', { p_chat_id: exactChatId, p_token: token });
  if (error) throw error;
  return data === true || (Array.isArray(data) && data[0] === true);
}

async function releaseCandidateGuidance(chatId, token) {
  const exactChatId = requireExactChatId(chatId);
  const { data, error } = await supabase.rpc('release_candidate_guidance', { p_chat_id: exactChatId, p_token: token });
  if (error) throw error;
  return data === true || (Array.isArray(data) && data[0] === true);
}

async function getCandidateSupportSettings() {
  const { data, error } = await supabase.from('app_settings').select('key,value').in('key', ['candidate_form_url', 'candidate_guidance_message']);
  if (error) throw error;
  const settings = Object.fromEntries((data || []).map(row => [row.key, row.value]));
  return { formUrl: settings.candidate_form_url || '', message: settings.candidate_guidance_message || '' };
}

async function updateCandidateSupportSettings({ formUrl, message }) {
  const rows = [
    { key: 'candidate_form_url', value: formUrl },
    { key: 'candidate_guidance_message', value: message },
  ];
  const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' });
  if (error) throw error;
  return { formUrl, message };
}

async function listCandidateClassifications() {
  const { data, error } = await supabase
    .from('contact_classifications')
    .select('classification,support_blocked,source,marked_at,marked_by,note,chat_id')
    .eq('classification', 'candidate')
    .order('marked_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ── Ticket Operations ──────────────────────────────────────────────────────

async function getTicketBySubmissionId(submissionId) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('bot_submission_id', submissionId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createTicket({ chat_id, telefono, nombre_analista, nombre_empresa, correo, situacion, categoria, prioridad, area_id, submission_id }) {
  const payload = {
    chat_id,
    telefono: telefono || null,
    nombre_analista: nombre_analista || null,
    nombre_empresa: nombre_empresa || null,
    correo: correo || null,
    situacion: situacion || null,
    categoria: categoria || null,
    prioridad: prioridad || null,
    status: 'open',
    bot_submission_id: submission_id || null
  };

  if (area_id) payload.area_id = area_id;

  const { data, error } = await supabase
    .from('tickets')
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (submission_id && isUniqueViolation(error)) {
      const existing = await getTicketBySubmissionId(submission_id);
      if (existing) return { ...existing, created: false };
    }
    console.error('❌ Error Supabase al crear ticket:', error.message);
    throw error;
  }
  return { ...data, created: true };
}

async function createRoutedTicket({ chat_id, telefono, nombre_analista, nombre_empresa, correo, situacion, categoria, category_key, prioridad, submission_id }) {
  const { data, error } = await supabase.rpc('create_routed_ticket', {
    p_chat_id: chat_id,
    p_telefono: telefono || null,
    p_nombre_analista: nombre_analista || null,
    p_nombre_empresa: nombre_empresa || null,
    p_correo: correo || null,
    p_situacion: situacion || null,
    p_categoria: categoria,
    p_category_key: category_key,
    p_prioridad: prioridad || null,
    p_submission_id: submission_id || null,
  });
  if (error) throw error;
  const ticket = Array.isArray(data) ? data[0] : data;
  if (!ticket?.id) throw Object.assign(new Error('Category routing is unavailable.'), { code: 'CATEGORY_ROUTING_UNAVAILABLE' });
  return ticket;
}

async function updateTicketPriority(id, prioridad) {
  const { data, error } = await supabase.from('tickets').update({ prioridad }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

async function updateTicketSalesforce(id, { sf_case_id, sf_case_number }) {
  const { data, error } = await supabase
    .from('tickets')
    .update({ sf_case_id, sf_case_number })
    .eq('id', id)
    .select('id,sf_case_id,sf_case_number')
    .single();

  if (error) {
    console.error('❌ Error Supabase al actualizar Salesforce Case:', error.message);
    throw error;
  }

  if (
    !data ||
    String(data.sf_case_id) !== String(sf_case_id) ||
    String(data.sf_case_number) !== String(sf_case_number)
  ) {
    const err = new Error(`Ticket #${id} Salesforce Case binding was not confirmed by Supabase.`);
    console.error('❌ Error Supabase al confirmar Salesforce Case:', err.message);
    throw err;
  }

  return data;
}

async function closeTicket(id) {
  const closedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('tickets')
    .update({ status: 'closed', closed_at: closedAt })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al cerrar ticket:', error.message);
    throw error;
  }

  if (!data || data.status !== 'closed') {
    const err = new Error(`Ticket #${id} close was not confirmed by Supabase.`);
    console.error('❌ Error Supabase al confirmar cierre de ticket:', err.message);
    throw err;
  }

  return data;
}

async function getTickets() {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('❌ Error Supabase al listar tickets:', error.message);
    return [];
  }
  return data || [];
}

async function getTicketById(id) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error(`❌ Error Supabase al buscar ticket #${id}:`, error.message);
    return null;
  }
  return data;
}

async function getTicketAssignment(ticketId) {
  const { data, error } = await supabase
    .from('ticket_assignments')
    .select('*')
    .eq('ticket_id', ticketId)
    .maybeSingle();

  if (error) {
    console.error(`❌ Error Supabase al buscar asignación de ticket #${ticketId}:`, error.message);
    return null;
  }
  return data;
}

async function getTicketWithAssignment(id) {
  const ticket = await getTicketById(id);
  if (!ticket) return null;
  ticket.assignment = await getTicketAssignment(id);
  return ticket;
}

async function getTicketWithRouting(id) {
  const { data, error } = await supabase
    .from('tickets')
    .select('*, area:areas(*), ticket_assignments(*, analyst:analysts(*)), sla_snapshots(*, sla_clock_segments(*))')
    .eq('id', id)
    .single();

  if (error) {
    console.error(`❌ Error Supabase al buscar ticket enriquecido #${id}:`, error.message);
    return null;
  }

  return {
    ...data,
    assignment: Array.isArray(data.ticket_assignments) ? data.ticket_assignments[0] || null : data.ticket_assignments || null,
  };
}

async function getTicketsWithRouting() {
  const { data, error } = await supabase
    .from('tickets')
    .select('*, area:areas(*), ticket_assignments(*, analyst:analysts(*)), sla_snapshots(*, sla_clock_segments(*))')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('❌ Error Supabase al listar tickets enriquecidos:', error.message);
    return [];
  }

  return (data || []).map(ticket => ({
    ...ticket,
    assignment: Array.isArray(ticket.ticket_assignments) ? ticket.ticket_assignments[0] || null : ticket.ticket_assignments || null,
  }));
}

async function assignTicket(ticketId, analystId, { assigned_by = 'manual' } = {}) {
  const { data, error } = await supabase
    .from('ticket_assignments')
    .upsert({
      ticket_id: ticketId,
      analyst_id: analystId,
      assigned_at: new Date().toISOString(),
      assigned_by,
    }, { onConflict: 'ticket_id' })
    .select()
    .single();

  if (error) {
    console.error(`❌ Error Supabase al asignar ticket #${ticketId}:`, error.message);
    throw error;
  }
  return data;
}

async function unassignTicket(ticketId, { assigned_by = 'manual' } = {}) {
  const { data, error } = await supabase
    .from('ticket_assignments')
    .upsert({
      ticket_id: ticketId,
      analyst_id: null,
      assigned_at: new Date().toISOString(),
      assigned_by,
    }, { onConflict: 'ticket_id' })
    .select()
    .single();

  if (error) {
    console.error(`❌ Error Supabase al desasignar ticket #${ticketId}:`, error.message);
    throw error;
  }
  return data;
}

async function updateTicketArea(ticketId, areaId) {
  const { data, error } = await supabase
    .from('tickets')
    .update({ area_id: areaId || null })
    .eq('id', ticketId)
    .select()
    .single();

  if (error) {
    console.error(`❌ Error Supabase al actualizar área de ticket #${ticketId}:`, error.message);
    throw error;
  }
  return data;
}

async function listTicketAssignments() {
  const { data, error } = await supabase
    .from('ticket_assignments')
    .select('*');

  if (error) {
    console.error('❌ Error Supabase al listar asignaciones de tickets:', error.message);
    throw error;
  }
  return data || [];
}

async function deleteTicket(id) {
  // Cascades must be configured on Supabase tables
  const { error } = await supabase
    .from('tickets')
    .delete()
    .eq('id', id);

  if (error) console.error(`❌ Error Supabase al eliminar ticket #${id}:`, error.message);
}

// ── Message Operations ─────────────────────────────────────────────────────

async function saveMessage({ ticket_id, chat_id, body, from_user, is_bot, wa_message_id }) {
  const payload = {
    ticket_id: ticket_id || null,
    chat_id,
    body: body || '',
    from_user: !!from_user,
    is_bot: !!is_bot,
    wa_message_id: wa_message_id || null
  };

  const { data, error } = await supabase
    .from('messages')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al guardar mensaje:', error.message);
    return null;
  }
  return data;
}

async function getMessages(ticketId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('timestamp', { ascending: true });

  if (error) {
    console.error('❌ Error Supabase al obtener mensajes:', error.message);
    return [];
  }
  return data || [];
}

async function getTranscriptMessages(ticketId) {
  return getMessages(ticketId);
}

async function createSalesforceAttachment({ ticket_id, sf_content_document_id, filename, mimetype, size_bytes }) {
  const { data, error } = await supabase
    .from('sf_attachments')
    .insert({
      ticket_id,
      sf_content_document_id,
      filename: filename || null,
      mimetype: mimetype || null,
      size_bytes: Number.isFinite(Number(size_bytes)) ? Number(size_bytes) : null,
    })
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al registrar adjunto SF:', error.message);
    throw error;
  }
  return data;
}

async function listSalesforceAttachments(ticketId) {
  let query = supabase
    .from('sf_attachments')
    .select('*')
    .order('created_at', { ascending: false });
  if (ticketId) query = query.eq('ticket_id', ticketId);

  const { data, error } = await query;
  if (error) {
    console.error('❌ Error Supabase al listar adjuntos SF:', error.message);
    throw error;
  }
  return data || [];
}

// ── Session Operations ─────────────────────────────────────────────────────

async function getSession(chatId) {
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('chat_id', chatId)
    .single();

  if (error || !data) return null;
  return {
    paso: data.paso,
    categoria: data.categoria,
    nombre: data.nombre,
    empresa: data.empresa,
    correo: data.correo,
    situacion: data.situacion,
    ticketId: data.ticket_id,
    submissionId: data.submission_id || undefined,
    flowVersionId: data.flow_version_id || undefined
  };
}

async function saveSession(chatId, session) {
  const payload = {
    chat_id: chatId,
    paso: session.paso ?? null,
    categoria: session.categoria ?? null,
    nombre: session.nombre ?? null,
    empresa: session.empresa ?? null,
    correo: session.correo ?? null,
    situacion: session.situacion ?? null,
    ticket_id: session.ticketId ?? null,
    submission_id: session.submissionId ?? null,
    flow_version_id: session.flowVersionId ?? null,
    updated_at: new Date().toISOString()
  };

  let { error } = await supabase
    .from('bot_sessions')
    .upsert(payload, { onConflict: 'chat_id' });

  if (error && /flow_version_id/i.test(error.message || '')) {
    delete payload.flow_version_id;
    ({ error } = await supabase
      .from('bot_sessions')
      .upsert(payload, { onConflict: 'chat_id' }));
  }

  if (error) console.error('❌ Error Supabase al guardar sesión:', error.message);
}

async function deleteSession(chatId) {
  const { error } = await supabase
    .from('bot_sessions')
    .delete()
    .eq('chat_id', chatId);

  if (error) {
    console.error('❌ Error Supabase al eliminar sesión:', error.message);
    throw error;
  }
}

async function ensureTicketPostProcessing(ticketId) {
  const { data, error } = await supabase.rpc('ensure_ticket_post_processing', { p_ticket_id: ticketId });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

async function claimTicketPostProcessing(workerId) {
  const { data, error } = await supabase.rpc('claim_ticket_post_processing', {
    p_worker_id: workerId,
  });
  if (error) throw error;
  return data || [];
}

async function finalizeTicketPostProcessingEffect(ticketId, workerId, effect, completed, errorCode = null) {
  const { data, error } = await supabase.rpc('finalize_ticket_post_processing_effect', {
    p_ticket_id: ticketId, p_worker_id: workerId, p_effect: effect,
    p_completed: completed, p_error_code: errorCode,
  });
  if (error) throw error;
  return data === true || (Array.isArray(data) && data[0] === true);
}

async function markTicketPostProcessingAttemptStarted(ticketId, workerId, effect) {
  const { data, error } = await supabase.rpc('mark_ticket_post_processing_attempt_started', {
    p_ticket_id: ticketId, p_worker_id: workerId, p_effect: effect,
  });
  if (error) throw error;
  return data === true || (Array.isArray(data) && data[0] === true);
}

async function claimTicketWhatsAppAck(ticketId, claimToken) {
  const { data, error } = await supabase.rpc('claim_ticket_whatsapp_ack', {
    p_ticket_id: ticketId, p_claim_token: claimToken,
  });
  if (error) throw error;
  return data === true || (Array.isArray(data) && data[0] === true);
}

async function finalizeTicketWhatsAppAck(ticketId, claimToken) {
  const { data, error } = await supabase.rpc('finalize_ticket_whatsapp_ack', {
    p_ticket_id: ticketId, p_claim_token: claimToken,
  });
  if (error) throw error;
  return data === true || (Array.isArray(data) && data[0] === true);
}

async function listTicketPostProcessing({ limit = 50, status } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  let query = supabase.from('ticket_post_processing')
    .select('ticket_id,submission_id,salesforce_outbox_status,operational_emit_status,session_cleanup_status,whatsapp_ack_status,whatsapp_ack_attempts,attempts,last_error_code,updated_at')
    .order('updated_at', { ascending: false }).limit(safeLimit);
  if (status === 'incomplete') query = query.or('salesforce_outbox_status.neq.completed,operational_emit_status.neq.completed,session_cleanup_status.neq.completed,whatsapp_ack_status.neq.completed');
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function loadAllSessions() {
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('*');

  if (error) {
    const hydrationError = new Error('Unable to load persisted bot sessions.', { cause: error });
    hydrationError.code = 'SESSION_HYDRATION_FAILED';
    throw hydrationError;
  }
  return data || [];
}

// ── Stats ──────────────────────────────────────────────────────────────────

async function getStats() {
  // Safe estimation queries
  const { count: total } = await supabase.from('tickets').select('*', { count: 'exact', head: true });
  const { count: open }  = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('status', 'open');
  const { count: closed } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('status', 'closed');
  
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { count: today } = await supabase.from('tickets').select('*', { count: 'exact', head: true }).gte('created_at', todayStart.toISOString());

  return { total: total || 0, open: open || 0, closed: closed || 0, today: today || 0 };
}

// ── Cleanup (TTL) ──────────────────────────────────────────────────────────

async function cleanupOldMessages(ttlDays = 90) {
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() - ttlDays);

  const { data, error } = await supabase
    .from('messages')
    .delete()
    .lt('timestamp', limitDate.toISOString());

  if (error) console.error('❌ Error Supabase al limpiar mensajes viejos:', error.message);
  else console.log(`🧹 Supabase: mensajes viejos eliminados (TTL: ${ttlDays}d)`);
}

async function cleanupOldSessions(ttlDays = 7) {
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() - ttlDays);

  const { data, error } = await supabase
    .from('bot_sessions')
    .delete()
    .lt('updated_at', limitDate.toISOString());

  if (error) console.error('❌ Error Supabase al limpiar sesiones viejas:', error.message);
  else console.log(`🧹 Supabase: sesiones viejas eliminadas (TTL: ${ttlDays}d)`);
}

// ── Dashboard Token Operations ─────────────────────────────────────────────

async function createToken({ name, role = 'agent' }) {
  const rawToken = 'nexo_tkn_' + crypto.randomBytes(16).toString('hex');
  const tokenHash = hashToken(rawToken);

  const { error } = await supabase
    .from('dashboard_tokens')
    .insert({ token_hash: tokenHash, name, role, active: true });

  if (error) {
    console.error('❌ Error Supabase al guardar token:', error.message);
    throw error;
  }

  return { rawToken, name, role };
}

const AGENT_TOKEN_METADATA = 'id, name, role, active, created_at';

async function createPendingAgentToken(name) {
  const rawToken = 'nexo_tkn_' + crypto.randomBytes(16).toString('hex');
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .insert({ token_hash: hashToken(rawToken), name, role: 'agent', active: false })
    .select(AGENT_TOKEN_METADATA)
    .single();
  if (error) throw error;
  return { rawToken, token: data };
}

async function activatePendingAgentToken(id) {
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .update({ active: true })
    .eq('id', id)
    .eq('role', 'agent')
    .eq('active', false)
    .select(AGENT_TOKEN_METADATA)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listAgentTokens() {
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .select(AGENT_TOKEN_METADATA)
    .eq('role', 'agent')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getAgentToken(id) {
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .select(AGENT_TOKEN_METADATA)
    .eq('id', id)
    .eq('role', 'agent')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getActiveAgentToken(id) {
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .select(AGENT_TOKEN_METADATA)
    .eq('id', id)
    .eq('role', 'agent')
    .eq('active', true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function revokePendingAgentToken(id) {
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .update({ active: false })
    .eq('id', id)
    .eq('role', 'agent')
    .eq('active', true)
    .select(AGENT_TOKEN_METADATA)
    .maybeSingle();
  if (error) throw error;
  if (data) return { outcome: 'revoked', token: data };
  const token = await getAgentToken(id);
  return token ? { outcome: 'already_revoked', token } : null;
}

function tokenRevocationUnavailable() {
  return Object.assign(new Error('Token revocation is temporarily unavailable.'), {
    code: 'TOKEN_REVOCATION_UNAVAILABLE', statusCode: 503,
  });
}

async function revokeAgentTokenAtomically(tokenId, actorTokenId, requestId) {
  let response;
  try {
    response = await supabase.rpc('revoke_agent_token_with_audit', {
      p_token_id: tokenId,
      p_actor_token_id: actorTokenId,
      p_request_id: requestId,
    });
  } catch (_error) {
    throw tokenRevocationUnavailable();
  }
  if (response?.error) throw tokenRevocationUnavailable();
  const result = response?.data;
  if (!result || typeof result !== 'object' || !['revoked', 'already_revoked', 'not_found', 'wrong_role'].includes(result.outcome)) {
    throw tokenRevocationUnavailable();
  }
  if (result.outcome === 'revoked' || result.outcome === 'already_revoked') {
    const token = result.token;
    if (!token || token.id !== tokenId || token.role !== 'agent' || token.active !== false || typeof token.name !== 'string') {
      throw tokenRevocationUnavailable();
    }
    return { outcome: result.outcome, token };
  }
  if (Object.hasOwn(result, 'token')) throw tokenRevocationUnavailable();
  return { outcome: result.outcome };
}

async function validateTokenOnce(token, { signal } = {}) {
  const tokenHash = hashToken(token);
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .select('id, name, role, active')
    .eq('token_hash', tokenHash)
    .abortSignal(signal)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { status: 'invalid', code: 'AUTH_INVALID' };
  if (!data.active) return { status: 'invalid', code: 'AUTH_REVOKED' };
  return { status: 'valid', user: { id: data.id, name: data.name, role: data.role } };
}

const authValidator = createAuthValidator(validateTokenOnce);
const validateToken = authValidator.validate;

async function getTokens() {
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .select('id, name, role, active, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('❌ Error Supabase al obtener tokens:', error.message);
    return [];
  }
  return data || [];
}

async function revokeToken(id) {
  const { error } = await supabase
    .from('dashboard_tokens')
    .update({ active: false })
    .eq('id', id);

  if (error) console.error('❌ Error Supabase al revocar token:', error.message);
}

// ── Admin Operations ───────────────────────────────────────────────────────

async function listAreas({ includeInactive = true } = {}) {
  let query = supabase
    .from('areas')
    .select('*')
    .order('name', { ascending: true });

  if (!includeInactive) query = query.eq('active', true);

  const { data, error } = await query;
  if (error) {
    console.error('❌ Error Supabase al listar áreas:', error.message);
    throw error;
  }
  return data || [];
}

async function listCategoryAreaMappings() {
  const { data, error } = await supabase.from('category_area_mappings').select('category_key,area_id,active,created_at,updated_at,area:areas(id,name,active)').order('category_key');
  if (error) throw error;
  return data || [];
}

async function updateCategoryAreaMapping(categoryKey, { area_id, active }) {
  const payload = { category_key: categoryKey };
  if (area_id !== undefined) payload.area_id = area_id;
  if (active !== undefined) payload.active = !!active;
  const { data, error } = await supabase.from('category_area_mappings').upsert(payload, { onConflict: 'category_key' }).select('category_key,area_id,active,created_at,updated_at,area:areas(id,name,active)').single();
  if (error) throw error;
  return data;
}

async function claimTicket(ticketId, analystId) {
  const { data, error } = await supabase.rpc('claim_area_ticket', { p_ticket_id: ticketId, p_analyst_id: analystId });
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Ticket is no longer available to claim.'), { statusCode: 409 });
  return getTicketWithRouting(ticketId);
}

async function claimConversation({ ticketId, analystId, analystAreaId, expectedRevision, idempotencyKey, actorName }) {
  const { data, error } = await supabase.rpc('claim_conversation', {
    p_command: { version: 1, ticket_id: Number(ticketId), expected_revision: expectedRevision, idempotency_key: idempotencyKey },
    p_actor_id: String(analystId), p_actor_name: actorName, p_actor_role: 'analyst', p_actor_area_id: analystAreaId,
  });
  if (error) throw mapWorkflowError(error);
  return verifiedWorkflowResult(data, ticketId);
}

async function adminRouteTicket({ action, ticketId, areaId = null, analystId = null, actorName = 'admin', metadata = {} }) {
  const { data, error } = await supabase.rpc('admin_route_ticket', {
    p_action: action, p_ticket_id: ticketId, p_area_id: areaId, p_analyst_id: analystId,
    p_actor_name: actorName, p_metadata: metadata,
  });
  if (error) throw error;
  const rpcResult = Array.isArray(data) ? data[0] : data;
  const ticket = await getTicketWithRouting(ticketId);
  return ticket ? { ...ticket, previous_area_id: rpcResult?.previous_area_id ?? null } : ticket;
}

async function switchAnalystArea({ analystId, areaId, actorName = 'admin', metadata = {} }) {
  const { data, error } = await supabase.rpc('switch_analyst_area', {
    p_analyst_id: analystId, p_area_id: areaId, p_actor_name: actorName, p_metadata: metadata,
  });
  if (error) throw error;
  return data;
}

async function transitionConversation({ ticketId, state, waitingReason, expectedRevision, idempotencyKey, actor }) {
  const { data, error } = await supabase.rpc('transition_conversation', {
    p_command: { version: 1, ticket_id: Number(ticketId), state, waiting_reason: waitingReason, expected_revision: expectedRevision, idempotency_key: idempotencyKey },
    p_actor_id: String(actor.actorId), p_actor_name: actor.actorName,
    p_actor_role: actor.actorRole, p_actor_area_id: actor.actorAreaId,
  });
  if (error) throw mapWorkflowError(error);
  return verifiedWorkflowResult(data, ticketId);
}

async function updateDevelopmentEscalation({ ticketId, status, note, expectedRevision, idempotencyKey, actor }) {
  const { data, error } = await supabase.rpc('update_development_escalation', {
    p_command: { version: 1, ticket_id: Number(ticketId), status, note, expected_revision: expectedRevision, idempotency_key: idempotencyKey },
    p_actor_id: String(actor.actorId), p_actor_name: actor.actorName,
    p_actor_role: actor.actorRole, p_actor_area_id: actor.actorAreaId,
  });
  if (error) throw mapWorkflowError(error);
  return verifiedWorkflowResult(data, ticketId);
}

async function verifiedWorkflowResult(data, requestedTicketId) {
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.ticket_id || String(result.ticket_id) !== String(requestedTicketId) || !result?.event_id) {
    throw Object.assign(new Error('WORKFLOW_RESULT_MISMATCH'), { statusCode: 409 });
  }
  const workflow = await getTicketWorkflow(result.ticket_id);
  return { workflow, mutation: { replayed: result.replayed === true, eventId: result.event_id, eventType: result.event_type } };
}

function mapWorkflowError(error) {
  const conflict = /REVISION_CONFLICT|ILLEGAL_|ACTIVE_ESCALATION|IDEMPOTENCY_KEY_REUSED|WORKFLOW_RESULT_MISMATCH/.test(error?.message || '');
  const forbidden = /FORBIDDEN/.test(error?.message || '') || error?.code === '42501';
  const unavailable = /^08/.test(error?.code || '') || /database unavailable/i.test(error?.message || '');
  error.statusCode = unavailable ? 503 : forbidden ? 403 : conflict ? 409 : error?.code === 'P0002' ? 404 : 400;
  return error;
}

async function getTicketWorkflow(ticketId) {
  const ticket = await getTicketWithRouting(ticketId);
  if (!ticket) return null;
  const [{ data: escalations, error: escalationError }, { data: snapshots, error: snapshotError }] = await Promise.all([
    supabase.from('development_escalations').select('*').eq('ticket_id', ticketId).order('id', { ascending: false }),
    supabase.from('sla_snapshots').select('*,sla_clock_segments(*)').eq('ticket_id', ticketId).order('id'),
  ]);
  if (escalationError) throw escalationError;
  if (snapshotError) throw snapshotError;
  return { ...ticket, development_escalations: escalations || [], sla_snapshots: snapshots || [] };
}

async function configureSlaPolicy(payload) {
  const { data, error } = await supabase.rpc('configure_sla_policy', {
    p_area_id: payload.areaId, p_priority: payload.priority, p_clock_type: payload.clockType,
    p_clock_mode: payload.clockMode, p_calendar_id: payload.calendarId,
    p_target_minutes: payload.targetMinutes, p_warning_minutes: payload.warningMinutes,
    p_actor_name: payload.actorName,
  });
  if (error) throw error;
  return data;
}

async function listSlaPolicies() {
  const { data, error } = await supabase.from('sla_policies').select('*').order('area_id').order('priority').order('clock_type').order('version', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function listBusinessCalendars() {
  const { data, error } = await supabase.from('business_calendars').select('*,business_calendar_windows(*),business_calendar_exceptions(*)').order('id');
  if (error) throw error;
  return data || [];
}

async function configureBusinessCalendar(payload) {
  const { data, error } = await supabase.rpc('configure_business_calendar', {
    p_area_id: payload.areaId, p_name: payload.name, p_timezone: payload.timezone,
    p_windows: payload.windows, p_exceptions: payload.exceptions, p_actor_name: payload.actorName,
  });
  if (error) throw error;
  return data;
}

async function getAreaById(id) {
  const { data, error } = await supabase
    .from('areas')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error(`❌ Error Supabase al buscar área #${id}:`, error.message);
    return null;
  }
  return data;
}

async function createArea({ name, description, welcome_msg, active = true, sla_minutes = 30 }) {
  const payload = {
    name,
    description: description || null,
    welcome_msg: welcome_msg || null,
    active: active !== false,
    sla_minutes: Number.isFinite(Number(sla_minutes)) ? Number(sla_minutes) : 30,
  };

  const { data, error } = await supabase
    .from('areas')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al crear área:', error.message);
    throw error;
  }
  return data;
}

async function updateArea(id, changes) {
  const allowed = ['name', 'description', 'welcome_msg', 'active', 'sla_minutes'];
  const payload = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) payload[key] = changes[key];
  }

  const { data, error } = await supabase
    .from('areas')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error(`❌ Error Supabase al actualizar área #${id}:`, error.message);
    throw error;
  }
  return data;
}

async function listAnalysts() {
  const { data, error } = await supabase
    .from('analysts')
    .select('*, area:areas(*), token:dashboard_tokens(id, name, role, active)')
    .order('display_name', { ascending: true });

  if (error) {
    console.error('❌ Error Supabase al listar analistas:', error.message);
    throw error;
  }
  return data || [];
}

async function getAnalystById(id) {
  const { data, error } = await supabase
    .from('analysts')
    .select('*, area:areas(*), token:dashboard_tokens(id, name, role, active)')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error(`❌ Error Supabase al buscar analista #${id}:`, error.message);
    return null;
  }
  return data;
}

async function listAvailableAnalystsByArea(areaId) {
  const { data, error } = await supabase
    .from('analysts')
    .select('*, area:areas(*)')
    .eq('area_id', areaId)
    .eq('available', true)
    .order('id', { ascending: true });

  if (error) {
    console.error(`❌ Error Supabase al listar analistas disponibles para área #${areaId}:`, error.message);
    throw error;
  }
  return data || [];
}

async function createAnalyst({ token_id, area_id, display_name, available = false }) {
  const payload = {
    token_id: token_id || null,
    area_id: area_id || null,
    display_name,
    available: !!available,
    last_seen: null,
  };

  const { data, error } = await supabase
    .from('analysts')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al crear analista:', error.message);
    throw error;
  }
  return data;
}

async function updateAnalyst(id, changes) {
  const allowed = ['token_id', 'area_id', 'display_name', 'available', 'last_seen'];
  const payload = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) payload[key] = changes[key];
  }

  const { data, error } = await supabase
    .from('analysts')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error(`❌ Error Supabase al actualizar analista #${id}:`, error.message);
    throw error;
  }
  return data;
}

async function getAnalystByTokenId(tokenId) {
  if (!tokenId) return null;

  const { data, error } = await supabase
    .from('analysts')
    .select('*, area:areas(*)')
    .eq('token_id', tokenId)
    .maybeSingle();

  if (error) {
    console.error(`❌ Error Supabase al buscar analista por token #${tokenId}:`, error.message);
    return null;
  }
  return data;
}

async function logAudit({ actor_name, actor_role, action, target_id, metadata }) {
  const { data, error } = await supabase
    .from('audit_log')
    .insert({
      actor_name,
      actor_role,
      action,
      target_id: target_id || null,
      metadata: metadata || null,
    })
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al escribir auditoría:', error.message);
    return null;
  }
  return data;
}

async function listAuditLogs(options = 100) {
  const filters = typeof options === 'object' && options !== null ? options : { limit: options };
  const safeLimit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(filters.offset) || 0, 0);
  let query = supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false });

  if (filters.action) query = query.eq('action', filters.action);
  if (filters.actor_role) query = query.eq('actor_role', filters.actor_role);
  if (filters.target_id) query = query.eq('target_id', String(filters.target_id));
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  query = query.range(safeOffset, safeOffset + safeLimit - 1);

  const { data, error } = await query;

  if (error) {
    console.error('❌ Error Supabase al listar auditoría:', error.message);
    throw error;
  }
  return data || [];
}

async function getAdminReportSummary() {
  const [tickets, attachments] = await Promise.all([
    getTicketsWithRouting(),
    listSalesforceAttachments().catch(() => []),
  ]);

  const byArea = new Map();
  let closedWithDuration = 0;
  let totalCloseMinutes = 0;

  for (const ticket of tickets) {
    const areaName = ticket.area?.name || 'Sin área';
    const item = byArea.get(areaName) || { area: areaName, total: 0, open: 0, closed: 0 };
    item.total += 1;
    if (ticket.status === 'closed') item.closed += 1;
    else item.open += 1;
    byArea.set(areaName, item);

    if (ticket.created_at && ticket.closed_at) {
      const minutes = (new Date(ticket.closed_at).getTime() - new Date(ticket.created_at).getTime()) / 60000;
      if (Number.isFinite(minutes) && minutes >= 0) {
        closedWithDuration += 1;
        totalCloseMinutes += minutes;
      }
    }
  }

  return {
    total_tickets: tickets.length,
    open_tickets: tickets.filter(ticket => ticket.status !== 'closed').length,
    closed_tickets: tickets.filter(ticket => ticket.status === 'closed').length,
    sf_attachments: attachments.length,
    avg_close_minutes: closedWithDuration ? Math.round(totalCloseMinutes / closedWithDuration) : null,
    by_area: Array.from(byArea.values()),
  };
}

async function listActiveBotFlows({ areaId = null } = {}) {
  const safeAreaId = areaId === null || areaId === undefined || areaId === '' ? null : Number(areaId);
  if (safeAreaId !== null && !Number.isInteger(safeAreaId)) {
    const err = new Error('areaId must be a numeric identifier.');
    err.statusCode = 400;
    throw err;
  }

  let query = supabase
    .from('bot_flows')
    .select('*, area:areas(id, name)')
    .eq('active', true)
    .order('area_id', { ascending: true, nullsFirst: true })
    .order('sort_order', { ascending: true })
    .order('step_key', { ascending: true })
    .order('version_id', { ascending: false })
    .order('id', { ascending: true });

  if (safeAreaId) {
    query = query.or(`area_id.is.null,area_id.eq.${safeAreaId}`);
  } else {
    query = query.is('area_id', null);
  }

  const { data, error } = await query;
  if (error) {
    console.error('❌ Error Supabase al listar flujos activos del bot:', error.message);
    throw error;
  }
  return data || [];
}

async function listBotFlows({ versionId, areaId, globalOnly = false, active } = {}) {
  let query = supabase
    .from('bot_flows')
    .select('*, area:areas(id, name)')
    .order('version_id', { ascending: false })
    .order('area_id', { ascending: true, nullsFirst: true })
    .order('sort_order', { ascending: true })
    .order('step_key', { ascending: true })
    .order('id', { ascending: true });

  if (versionId !== undefined && versionId !== null && versionId !== '') query = query.eq('version_id', Number(versionId));
  if (globalOnly) query = query.is('area_id', null);
  if (areaId !== undefined && areaId !== null && areaId !== '') query = query.eq('area_id', Number(areaId));
  if (active !== undefined && active !== null && active !== '') query = query.eq('active', !!active);

  const { data, error } = await query;
  if (error) {
    console.error('❌ Error Supabase al listar flujos del bot:', error.message);
    throw error;
  }
  return data || [];
}

async function createBotFlowStep({ version_id, area_id, step_key, message, sort_order = 0, active = true }) {
  const payload = {
    version_id: Number(version_id),
    area_id: area_id || null,
    step_key,
    message,
    sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
    active: active !== false,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('bot_flows')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al crear paso de flujo del bot:', error.message);
    throw error;
  }
  return data;
}

async function updateBotFlowStep(id, changes) {
  const allowed = ['version_id', 'area_id', 'step_key', 'message', 'sort_order', 'active'];
  const payload = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) payload[key] = changes[key];
  }

  const { data, error } = await supabase
    .from('bot_flows')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error(`❌ Error Supabase al actualizar paso de flujo del bot #${id}:`, error.message);
    throw error;
  }
  return data;
}

async function getBotFlowStudioLayout({ versionId, areaId = null }) {
  let query = supabase.from('bot_flow_studio_layouts').select('*').eq('version_id', Number(versionId));
  query = areaId === null ? query.is('area_id', null) : query.eq('area_id', Number(areaId));
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function putBotFlowStudioLayout({ versionId, areaId = null, layout, expectedRevision, updatedBy }) {
  const { data, error } = await supabase.rpc('put_bot_flow_studio_layout', {
    p_version_id: Number(versionId), p_area_id: areaId, p_layout: layout,
    p_expected_revision: expectedRevision, p_updated_by: updatedBy,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

function handleSalesforceOutboxError(error, context) {
  if (salesforceOutbox.isSchemaMissingError(error)) {
    throw salesforceOutbox.toSchemaMissingError(error);
  }
  console.error(`❌ Error Supabase en Salesforce outbox (${context}):`, error.message);
  throw error;
}

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key value|unique constraint|unique violation/i.test(error?.message || '');
}

async function getSalesforceOutboxJobByIdempotencyKey(idempotencyKey) {
  const { data, error } = await supabase
    .from('salesforce_outbox')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) handleSalesforceOutboxError(error, 'buscar por idempotency_key');
  return data || null;
}

async function createSalesforceOutboxJob(job) {
  const payload = {
    ticket_id: job.ticket_id,
    sf_case_id: job.sf_case_id || null,
    operation: salesforceOutbox.normalizeOperation(job.operation),
    status: salesforceOutbox.normalizeStatus(job.status || 'pending'),
    payload: job.payload || {},
    idempotency_key: job.idempotency_key,
    next_attempt_at: job.next_attempt_at || new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('salesforce_outbox')
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const existing = await getSalesforceOutboxJobByIdempotencyKey(payload.idempotency_key);
      if (existing) return { ...existing, duplicate: true };
    }
    handleSalesforceOutboxError(error, 'crear job');
  }

  return data;
}

async function listTicketSalesforceOutboxJobs(ticketId, options = {}) {
  const filters = salesforceOutbox.normalizeListFilters({ ...options, ticket_id: ticketId });
  let query = supabase
    .from('salesforce_outbox')
    .select(salesforceOutbox.TICKET_OUTBOX_SAFE_SELECT)
    .eq('ticket_id', filters.ticket_id)
    .order('created_at', { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);

  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) handleSalesforceOutboxError(error, 'listar por ticket');
  return data || [];
}

async function listSalesforceOutboxJobs(filters = {}) {
  const normalized = salesforceOutbox.normalizeListFilters(filters);
  let query = supabase
    .from('salesforce_outbox')
    .select(salesforceOutbox.ADMIN_OUTBOX_SAFE_SELECT)
    .order('created_at', { ascending: false })
    .range(normalized.offset, normalized.offset + normalized.limit - 1);

  if (normalized.status) query = query.eq('status', normalized.status);
  if (normalized.ticket_id) query = query.eq('ticket_id', normalized.ticket_id);

  const { data, error } = await query;
  if (error) handleSalesforceOutboxError(error, 'listar admin');
  return data || [];
}

async function markSalesforceOutboxJobRetryable(id) {
  const { data, error } = await supabase.rpc('retry_salesforce_outbox_job', { p_job_id: id });

  if (error) handleSalesforceOutboxError(error, 'marcar retry');
  const job = Array.isArray(data) ? data[0] : data;
  if (!job) {
    const err = new Error('Salesforce outbox job was not found or is not failed.');
    err.statusCode = 409;
    err.code = 'SF_OUTBOX_JOB_NOT_RETRYABLE';
    throw err;
  }
  return salesforceOutbox.serializeAdminOutboxJob(job);
}

async function claimSalesforceOutboxJobs(workerId, limit = 1) {
  const { SALESFORCE_OUTBOX_LEASE_SECONDS } = require('../services/salesforceOutboxContract');
  if (!workerId || !String(workerId).trim()) {
    const err = new Error('Salesforce outbox worker id is required.');
    err.code = 'SF_OUTBOX_WORKER_REQUIRED';
    throw err;
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 10);
  const { data, error } = await supabase.rpc('claim_salesforce_outbox_jobs', {
    p_worker_id: String(workerId),
    p_limit: safeLimit,
    p_lock_timeout_seconds: SALESFORCE_OUTBOX_LEASE_SECONDS,
  });
  if (error) handleSalesforceOutboxError(error, 'claim jobs');
  return data || [];
}

async function transitionClaimedSalesforceOutboxJob(id, workerId, changes, context) {
  const { SALESFORCE_OUTBOX_LEASE_SECONDS } = require('../services/salesforceOutboxContract');
  const { data, error } = await supabase.rpc('transition_salesforce_outbox_job', {
    p_job_id: id,
    p_worker_id: workerId,
    p_status: changes.status,
    p_last_error: changes.last_error ?? null,
    p_next_attempt_at: changes.next_attempt_at ?? null,
    p_processed_at: changes.processed_at ?? null,
    p_lock_timeout_seconds: SALESFORCE_OUTBOX_LEASE_SECONDS,
  });
  if (error) handleSalesforceOutboxError(error, context);
  const job = Array.isArray(data) ? data[0] : data;
  if (!job) {
    const err = new Error('Salesforce outbox lease was lost.');
    err.code = 'SF_OUTBOX_LEASE_LOST';
    err.statusCode = 409;
    throw err;
  }
  return job;
}

function markSalesforceOutboxJobSynced(id, workerId, processedAt = new Date().toISOString()) {
  return transitionClaimedSalesforceOutboxJob(id, workerId, {
    status: 'synced', last_error: null, processed_at: processedAt, next_attempt_at: processedAt,
  }, 'mark synced');
}

function markSalesforceOutboxJobRetrying(id, workerId, { nextAttemptAt, errorCode }) {
  return transitionClaimedSalesforceOutboxJob(id, workerId, {
    status: 'retrying', last_error: String(errorCode || 'SF_RETRYABLE').slice(0, 120),
    next_attempt_at: nextAttemptAt, processed_at: null,
  }, 'mark retrying');
}

function markSalesforceOutboxJobFailed(id, workerId, errorCode, processedAt = new Date().toISOString()) {
  return transitionClaimedSalesforceOutboxJob(id, workerId, {
    status: 'failed', last_error: String(errorCode || 'SF_TERMINAL').slice(0, 120),
    processed_at: processedAt,
  }, 'mark failed');
}

/**
 * Verify the Supabase connection is working by running a lightweight health check.
 * Uses `head: true` with `count: 'exact'` on the `tickets` table — a metadata-only
 * query that confirms the client is configured, authenticated, and can reach the
 * database without fetching any rows.
 *
 * A 10-second timeout prevents boot from hanging on network issues.
 * @returns {Promise<true>} Resolves with `true` when the connection is verified.
 * @throws {Error} If the check fails or times out — boot sequence will stop.
 */
async function initDb() {
  const TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { error } = await supabase
      .from('tickets')
      .select('*', { count: 'exact', head: true })
      .abortSignal(controller.signal);

    if (error) {
      console.error('❌ Supabase connection check failed:', error.message);
      throw new Error(`Supabase connection check failed: ${error.message}`);
    }

    console.log('✅ Supabase connection verified successfully.');
    return true;
  } catch (err) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Supabase connection check timed out after ${TIMEOUT_MS / 1000}s`);
      timeoutError.code = 'DB_TIMEOUT';
      console.error('❌', timeoutError.message);
      throw timeoutError;
    }
    // If it's already wrapped, re-throw as-is
    if (err instanceof Error && err.message.startsWith('Supabase connection check failed')) {
      throw err;
    }
    console.error('❌ Supabase connection check threw unexpectedly:', err.message || err);
    throw new Error(`Supabase connection check failed: ${err.message || 'unknown error'}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Supabase persists data automatically — no manual persist step is needed.
 * Kept as a no-op for interface compatibility (called in boot sequences).
 */
function persistDb() { return Promise.resolve(true); }

/**
 * Supabase manages its own HTTP connection pool — no explicit close is required
 * in normal operation. Idle connections are cleaned up by Node's garbage collector
 * or on process exit.
 * Kept as a no-op for interface compatibility.
 */
function closeDb() { return Promise.resolve(true); }

module.exports = {
  initDb,
  supabase,
  persistDb,
  closeDb,
  // Tickets
  createTicket,
  createRoutedTicket,
  getTicketBySubmissionId,
  updateTicketPriority,
  updateTicketSalesforce,
  closeTicket,
  getTickets,
  getTicketById,
  getTicketAssignment,
  getTicketWithAssignment,
  getTicketWithRouting,
  getTicketsWithRouting,
  assignTicket,
  unassignTicket,
  updateTicketArea,
  listTicketAssignments,
  deleteTicket,
  // Messages
  saveMessage,
  getMessages,
  getTranscriptMessages,
  createSalesforceAttachment,
  listSalesforceAttachments,
  // Sessions
  getSession,
  saveSession,
  deleteSession,
  loadAllSessions,
  ensureTicketPostProcessing,
  claimTicketPostProcessing,
  finalizeTicketPostProcessingEffect,
  markTicketPostProcessingAttemptStarted,
  claimTicketWhatsAppAck,
  finalizeTicketWhatsAppAck,
  listTicketPostProcessing,
  // Candidate support blocking
  getCandidateClassification,
  markCandidate,
  unmarkCandidate,
  claimCandidateGuidance,
  finalizeCandidateGuidance,
  releaseCandidateGuidance,
  getCandidateSupportSettings,
  updateCandidateSupportSettings,
  listCandidateClassifications,
  // Stats
  getStats,
  // Cleanup
  cleanupOldMessages,
  cleanupOldSessions,
  // Dashboard Tokens
  createToken,
  createPendingAgentToken,
  activatePendingAgentToken,
  listAgentTokens,
  getAgentToken,
  getActiveAgentToken,
  revokePendingAgentToken,
  revokeAgentTokenAtomically,
  validateToken,
  getTokens,
  revokeToken,
  // Admin
  listAreas,
  listCategoryAreaMappings,
  updateCategoryAreaMapping,
  claimTicket,
  claimConversation,
  adminRouteTicket,
  switchAnalystArea,
  transitionConversation,
  updateDevelopmentEscalation,
  getTicketWorkflow,
  configureSlaPolicy,
  listSlaPolicies,
  listBusinessCalendars,
  configureBusinessCalendar,
  getAreaById,
  createArea,
  updateArea,
  listAnalysts,
  getAnalystById,
  listAvailableAnalystsByArea,
  createAnalyst,
  updateAnalyst,
  getAnalystByTokenId,
  logAudit,
  listAuditLogs,
  getAdminReportSummary,
  listActiveBotFlows,
  listBotFlows,
  createBotFlowStep,
  updateBotFlowStep,
  getBotFlowStudioLayout,
  putBotFlowStudioLayout,
  // Salesforce Outbox
  createSalesforceOutboxJob,
  getSalesforceOutboxJobByIdempotencyKey,
  listTicketSalesforceOutboxJobs,
  listSalesforceOutboxJobs,
  markSalesforceOutboxJobRetryable,
  claimSalesforceOutboxJobs,
  markSalesforceOutboxJobSynced,
  markSalesforceOutboxJobRetrying,
  markSalesforceOutboxJobFailed
};

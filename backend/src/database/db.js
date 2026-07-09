/**
 * NEXO — Supabase Database Integration Module
 * Secure Production Implementation with strict TLS/HTTPS.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

console.log('🌐 Conexión segura inicializada con Supabase URL:', supabaseUrl);

// ── Helpers ────────────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Ticket Operations ──────────────────────────────────────────────────────

async function createTicket({ chat_id, telefono, nombre_analista, nombre_empresa, correo, situacion, prioridad, area_id }) {
  const payload = {
    chat_id,
    telefono: telefono || null,
    nombre_analista: nombre_analista || null,
    nombre_empresa: nombre_empresa || null,
    correo: correo || null,
    situacion: situacion || null,
    prioridad: prioridad || null,
    status: 'open'
  };

  if (area_id) payload.area_id = area_id;

  const { data, error } = await supabase
    .from('tickets')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('❌ Error Supabase al crear ticket:', error.message);
    throw error;
  }
  return data;
}

async function updateTicketSalesforce(id, { sf_case_id, sf_case_number }) {
  const { error } = await supabase
    .from('tickets')
    .update({ sf_case_id, sf_case_number })
    .eq('id', id);

  if (error) console.error('❌ Error Supabase al actualizar Salesforce Case:', error.message);
}

async function closeTicket(id) {
  const { error } = await supabase
    .from('tickets')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', id);

  if (error) console.error('❌ Error Supabase al cerrar ticket:', error.message);
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
    nombre: data.nombre,
    empresa: data.empresa,
    correo: data.correo,
    situacion: data.situacion,
    ticketId: data.ticket_id,
    flowVersionId: data.flow_version_id || undefined
  };
}

async function saveSession(chatId, session) {
  const payload = {
    chat_id: chatId,
    paso: session.paso ?? null,
    nombre: session.nombre ?? null,
    empresa: session.empresa ?? null,
    correo: session.correo ?? null,
    situacion: session.situacion ?? null,
    ticket_id: session.ticketId ?? null,
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

  if (error) console.error('❌ Error Supabase al eliminar sesión:', error.message);
}

async function loadAllSessions() {
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('*');

  if (error) {
    console.error('❌ Error Supabase al cargar sesiones:', error.message);
    return [];
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

async function validateToken(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const { data, error } = await supabase
    .from('dashboard_tokens')
    .select('id, name, role, active')
    .eq('token_hash', tokenHash)
    .single();

  if (error || !data || !data.active) return null;
  return { id: data.id, name: data.name, role: data.role };
}

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

async function listAuditLogs(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    console.error('❌ Error Supabase al listar auditoría:', error.message);
    throw error;
  }
  return data || [];
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
    .select('*')
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

// Mock closing for Supabase (no active connections/intervals to clear like SQLite)
function initDb() { return Promise.resolve(true); }
function persistDb() { return Promise.resolve(true); }
function closeDb() { return Promise.resolve(true); }

module.exports = {
  initDb,
  persistDb,
  closeDb,
  // Tickets
  createTicket,
  updateTicketSalesforce,
  closeTicket,
  getTickets,
  getTicketById,
  getTicketAssignment,
  getTicketWithAssignment,
  listTicketAssignments,
  deleteTicket,
  // Messages
  saveMessage,
  getMessages,
  // Sessions
  getSession,
  saveSession,
  deleteSession,
  loadAllSessions,
  // Stats
  getStats,
  // Cleanup
  cleanupOldMessages,
  cleanupOldSessions,
  // Dashboard Tokens
  createToken,
  validateToken,
  getTokens,
  revokeToken,
  // Admin
  listAreas,
  createArea,
  updateArea,
  listAnalysts,
  createAnalyst,
  updateAnalyst,
  getAnalystByTokenId,
  logAudit,
  listAuditLogs,
  listActiveBotFlows
};

const db = require('../database/db');

const CACHE_TTL_MS = 60 * 1000;

const FALLBACK_VERSION_ID = 1;

const FALLBACK_MESSAGES = Object.freeze({
  out_of_office:
    'Estimado usuario, gracias por contactar al área de Integraciones de *Magneto365*. 🌐\n\n' +
    'Le informamos que actualmente no nos encontramos en horario de atención. ' +
    'Una vez retomemos actividades, estaremos dando respuesta a su requerimiento. Gracias por su comprensión.',
  initial_filter:
    'Bienvenido al canal de soporte de Integraciones de *Magneto365*.\n\n' +
    'ℹ️ Este canal es exclusivo para atención a dudas y novedades técnicas sobre integraciones.\n\n' +
    '¿Su requerimiento está relacionado con alguna integración? (Responda *SI* o *NO*)',
  ask_name: 'Entendido. Procederemos con el registro. Por favor, indíqueme su *Nombre Completo*:',
  filter_no_menu:
    'Para orientarlo correctamente, por favor indíquenos:\n\n' +
    'Escriba *1* si es *Analista*.\n' +
    'Escriba *2* si es *Candidato* o *Candidata*.',
  filter_no_analyst:
    '👨‍💻 *ZONA DE ANALISTAS - MAGNETO365*\n\n' +
    'Para brindarte un soporte técnico seguro y garantizado, todas tus consultas y reportes deben registrarse mediante nuestro buzón oficial.\n\n' +
    '📧 *Envíanos un correo directamente a:*\n' +
    'soporte.mgt@magnetoglobal.com\n\n' +
    'Uno de nuestros asesores de soporte tomará tu caso y te contactará. ¡Feliz día! ✨',
  filter_no_candidate:
    '👋 *Atención a Candidatos:*\n\n' +
    'Si requiere soporte o ayuda con su proceso, debe escalar su solicitud a través de nuestro canal oficial:\n\n' +
    '🔗 https://static.magneto365.com/widgets/help/index.html\n\n' +
    '¡Muchos éxitos en su búsqueda laboral! ✨',
  filter_no_invalid: 'Por favor, responda *1* para Analista o *2* para Candidato.',
  ask_company: 'Gracias, {{nombre}}. Indíqueme el nombre de la *Empresa o Cliente* afectado:',
  ask_email: 'Proporcione su *Correo Electrónico Corporativo*:',
  ask_issue: 'Describa detalladamente su *Requerimiento Técnico o Incidencia*:',
  processing: '📋 *Procesando solicitud técnica en Magneto365...*',
  confirmation:
    '✅ *SOLICITUD RECIBIDA*\n\n' +
    'El equipo técnico de Integraciones ha sido notificado sobre tu novedad.\n' +
    '{{radicado}}\n\n' +
    'Un asesor revisará tu caso y te contactará pronto por este medio. ¡Gracias!',
  ticket_error: '⚠️ Ocurrió un error al registrar su solicitud. Por favor intente nuevamente o contacte a soporte.mgt@magnetoglobal.com',
});

const SUPPORTED_STEP_KEYS = Object.freeze(Object.keys(FALLBACK_MESSAGES));

const cache = new Map();
let now = () => Date.now();

function cacheKey(areaId) {
  return areaId ? `area:${areaId}` : 'global';
}

function interpolate(template, values = {}) {
  return String(template).replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function buildFlow(rows, areaId) {
  const messages = new Map(Object.entries(FALLBACK_MESSAGES));
  let versionId = FALLBACK_VERSION_ID;
  let source = 'fallback';
  const selected = new Map();

  for (const row of rows || []) {
    if (!row?.step_key || !row.message) continue;
    const priority = areaId && String(row.area_id || '') === String(areaId) ? 2 : 1;
    const current = selected.get(row.step_key);
    if (!current || priority > current.priority || (priority === current.priority && (row.version_id || 0) > (current.row.version_id || 0))) {
      selected.set(row.step_key, { row, priority });
    }
    source = 'database';
  }

  for (const { row } of selected.values()) {
    messages.set(row.step_key, row.message);
    versionId = Math.max(versionId, row.version_id || versionId);
  }

  return { messages, versionId, source, loadedAt: now(), areaId: areaId || null };
}

async function loadFlow(areaId = null) {
  const key = cacheKey(areaId);
  const cached = cache.get(key);
  if (cached && now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  try {
    const rows = await db.listActiveBotFlows({ areaId });
    const flow = buildFlow(rows, areaId);
    cache.set(key, flow);
    return flow;
  } catch (err) {
    console.warn('⚠️ No se pudieron cargar flujos del bot desde Supabase. Usando mensajes estáticos:', err.message);
    const flow = buildFlow([], areaId);
    cache.set(key, flow);
    return flow;
  }
}

async function getBotMessage(stepKey, values = {}, options = {}) {
  const flow = await loadFlow(options.areaId || null);
  const template = flow.messages.get(stepKey) || FALLBACK_MESSAGES[stepKey] || '';
  return {
    text: interpolate(template, values),
    versionId: flow.versionId,
    source: flow.source,
  };
}

function invalidateBotFlowCache(areaId = null) {
  if (areaId) {
    cache.delete(cacheKey(areaId));
  } else {
    cache.clear();
  }
}

function getBotFlowCacheStatus() {
  return Array.from(cache.entries()).map(([key, entry]) => ({
    key,
    area_id: entry.areaId,
    source: entry.source,
    version_id: entry.versionId,
    age_ms: Math.max(0, now() - entry.loadedAt),
    expires_in_ms: Math.max(0, CACHE_TTL_MS - (now() - entry.loadedAt)),
  }));
}

function _resetCache() {
  cache.clear();
  now = () => Date.now();
}

function _setNow(fn) {
  now = fn;
}

module.exports = {
  CACHE_TTL_MS,
  FALLBACK_MESSAGES,
  SUPPORTED_STEP_KEYS,
  getBotMessage,
  getBotFlowCacheStatus,
  invalidateBotFlowCache,
  interpolate,
  loadFlow,
  _resetCache,
  _setNow,
};

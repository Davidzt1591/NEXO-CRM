const db = require('../database/db');

const CACHE_TTL_MS = 60 * 1000;

const FALLBACK_VERSION_ID = 2;

const { BOT_FLOW_DEFINITION } = require('./botFlowDefinition');
const { FALLBACK_MESSAGES, interpolate } = require('./botFlowMessages');
const SUPPORTED_STEP_KEYS = Object.freeze(Object.keys(FALLBACK_MESSAGES));

const cache = new Map();
let now = () => Date.now();

function cacheKey(areaId) {
  return areaId ? `area:${areaId}` : 'global';
}

function buildFlow(rows, areaId, requestedVersionId = null) {
  const messages = new Map(Object.entries(FALLBACK_MESSAGES));
  let versionId = requestedVersionId || FALLBACK_VERSION_ID;
  let source = 'fallback';
  const selected = new Map();
  const messageSources = new Map(Object.keys(FALLBACK_MESSAGES).map(key => [key, 'fallback']));

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
    messageSources.set(row.step_key, 'bot_flows');
    versionId = Math.max(versionId, row.version_id || versionId);
  }

  return { messages, messageSources, versionId, source, loadedAt: now(), areaId: areaId || null };
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
  buildFlow,
  invalidateBotFlowCache,
  interpolate,
  loadFlow,
  _resetCache,
  _setNow,
};

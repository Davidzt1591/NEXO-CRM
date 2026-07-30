/**
 * NEXO — Chat Preferences Persistence Service
 *
 * Persists chatModes and silenciados to Supabase so they survive restarts.
 * Gracefully handles missing tables — the app NEVER crashes if the migration
 * hasn't been applied.
 *
 * @module chatPreferences
 */

const { supabase } = require('../database/db');

const TABLE = 'chat_preferences';

/**
 * Detect whether a Supabase error indicates the target table does not exist.
 * @param {Error} error
 * @returns {boolean}
 */
function isTableMissingError(error) {
  if (!error) return false;
  // PGRST116 = relation "X" does not exist (PostgREST standard)
  // Also catch raw PostgreSQL "relation does not exist" for defense in depth.
  return (
    error?.code === 'PGRST116' ||
    /relation .* does not exist/i.test(error?.message || '') ||
    /doesn't exist/i.test(error?.message || '')
  );
}

/**
 * Upsert a single chat preference row.
 *
 * Only the provided preference keys are written; missing ones keep their
 * existing value in the database.
 *
 * @param {string} chatId - WhatsApp chat ID
 * @param {object} opts
 * @param {'auto'|'manual'} [opts.mode]
 * @param {boolean} [opts.silenced]
 * @returns {Promise<null>} Always returns null (fire-and-forget friendly).
 */
async function saveChatPreference(chatId, { mode, silenced } = {}) {
  try {
    const payload = { chat_id: chatId, updated_at: new Date().toISOString() };

    if (mode !== undefined) payload.mode = mode;
    if (silenced !== undefined) payload.silenced = silenced;

    const { error } = await supabase
      .from(TABLE)
      .upsert(payload, { onConflict: 'chat_id' });

    if (error) {
      if (isTableMissingError(error)) {
        console.warn(
          `⚠️  Table '${TABLE}' does not exist — preference not persisted. ` +
          `Run migration 001_chat_preferences.sql to enable persistence.`
        );
        return null;
      }
      console.warn(`⚠️  Error persisting chat preference:`, error.message);
    }
  } catch (err) {
    console.warn(`⚠️  Failed to save chat preference:`, err.message);
  }
  return null;
}

/**
 * Load all chat preferences from Supabase.
 *
 * @returns {Promise<{chatModes: Map<string,string>, silenciados: Set<string>}>}
 */
async function loadChatPreferences() {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('chat_id, mode, silenced');

    if (error) {
      if (isTableMissingError(error)) {
        console.warn(
          `⚠️  Table '${TABLE}' does not exist — cannot load preferences. ` +
          `Run migration 001_chat_preferences.sql to enable persistence.`
        );
      } else {
        console.warn(`⚠️  Error loading chat preferences:`, error.message);
      }
      return { chatModes: new Map(), silenciados: new Set() };
    }

    const chatModes = new Map();
    const silenciados = new Set();

    for (const row of data || []) {
      if (row.mode) chatModes.set(row.chat_id, row.mode);
      if (row.silenced) silenciados.add(row.chat_id);
    }

    console.log(
      `✅ Restored ${chatModes.size} mode(s) and ${silenciados.size} silenced chat(s) from '${TABLE}'.`
    );
    return { chatModes, silenciados };
  } catch (err) {
    console.warn(`⚠️  Failed to load chat preferences:`, err.message);
    return { chatModes: new Map(), silenciados: new Set() };
  }
}

/**
 * Delete a chat preference row.
 *
 * @param {string} chatId - WhatsApp chat ID
 * @returns {Promise<null>}
 */
async function deleteChatPreference(chatId) {
  try {
    const { error } = await supabase
      .from(TABLE)
      .delete()
      .eq('chat_id', chatId);

    if (error) {
      if (isTableMissingError(error)) {
        console.warn(
          `⚠️  Table '${TABLE}' does not exist — preference not deleted.`
        );
        return null;
      }
      console.warn(`⚠️  Error deleting chat preference:`, error.message);
    }
  } catch (err) {
    console.warn(`⚠️  Failed to delete chat preference:`, err.message);
  }
  return null;
}

module.exports = {
  saveChatPreference,
  loadChatPreferences,
  deleteChatPreference,
};

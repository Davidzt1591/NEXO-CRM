const chatPreferences = require('./services/chatPreferences');

const store = {
  sesiones: {},
  chatModes: new Map(),
  silenciados: new Set(),
  lastQR: null,
  lastQRTime: 0,
  QR_THROTTLE: 20000,
  botActivo: false,
  pendingPairingPhone: null,
  horaDeInicio: Math.floor(Date.now() / 1000),

  /**
   * Persist a chat preference to Supabase (fire-and-forget).
   * Does NOT block; errors are logged, never thrown.
   * @param {string} chatId
   * @param {{ mode?: 'auto'|'manual', silenced?: boolean }} opts
   */
  async persistPreference(chatId, opts) {
    try {
      await chatPreferences.saveChatPreference(chatId, opts);
    } catch (err) {
      console.warn(`⚠️  persistPreference failed for ${chatId}:`, err.message);
    }
  },

  /**
   * Delete a chat preference row from Supabase (fire-and-forget).
   * @param {string} chatId
   */
  async deletePreference(chatId) {
    try {
      await chatPreferences.deleteChatPreference(chatId);
    } catch (err) {
      console.warn(`⚠️  deletePreference failed for ${chatId}:`, err.message);
    }
  },

  /**
   * Load all persisted preferences from Supabase and populate the in-memory
   * Maps/Sets. Called once during boot AFTER initDb() succeeds.
   * If the table doesn't exist, the in-memory store stays empty and the app
   * continues working normally.
   */
  async restorePreferences() {
    const { chatModes, silenciados } = await chatPreferences.loadChatPreferences();
    store.chatModes = chatModes;
    store.silenciados = silenciados;
  }
};

console.log('🔄 Init Store...');
module.exports = store;

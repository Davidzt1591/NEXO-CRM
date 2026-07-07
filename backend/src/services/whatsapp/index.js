/**
 * NEXO — WhatsApp Service Adapter
 * 
 * This module abstracts the underlying WhatsApp engine.
 * Currently wraps whatsapp-web.js, but designed to easily swap in the
 * official Meta WhatsApp Cloud API or Baileys without changing client code.
 */

const { setupWhatsApp: setupWWebJS } = require('./wwebjs');
const store = require('../../store');

let _clientInstance = null;
let _borrarSesionFn = null;
let _io = null;

/**
 * Initializes the active WhatsApp engine.
 */
function initWhatsApp(io) {
  _io = io;
  const { client, borrarSesion } = setupWWebJS(io);
  _clientInstance = client;
  _borrarSesionFn = borrarSesion;
  return { client, borrarSesion };
}

/**
 * Agnostic message sender.
 */
async function sendMessage(chatId, text, options = {}) {
  if (!_clientInstance) {
    throw new Error('WhatsApp client is not initialized');
  }

  // Under the hood: Uses the active engine (wwebjs for now)
  // Options can include media metadata
  if (options.media) {
    const { MessageMedia } = require('whatsapp-web.js');
    const media = new MessageMedia(options.media.mimetype, options.media.data, options.media.filename);
    return await _clientInstance.sendMessage(chatId, media, { caption: text });
  }

  return await _clientInstance.sendMessage(chatId, text);
}

/**
 * Clears the session logic for the active engine.
 */
async function clearSession() {
  if (_borrarSesionFn) {
    await _borrarSesionFn(_clientInstance);
  }
}

/**
 * Checks if the engine client is authenticated and ready.
 */
function isReady() {
  return !!(_clientInstance && _clientInstance.info);
}

/**
 * Agnostic metadata format.
 */
function getSystemInfo() {
  if (isReady()) {
    return {
      user: _clientInstance.info.wid?.user || 'Desconocido',
      pushname: _clientInstance.info.pushname || 'Cuenta Empresa',
      platform: _clientInstance.info.platform || 'N/A',
      connectedAt: store.horaDeInicio ? store.horaDeInicio * 1000 : null
    };
  }
  return null;
}

module.exports = {
  initWhatsApp,
  sendMessage,
  clearSession,
  isReady,
  getSystemInfo
};

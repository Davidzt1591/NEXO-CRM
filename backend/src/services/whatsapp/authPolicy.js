const SUPPORTED_AUTH_STRATEGY = 'local';

function assertLocalAuthOnly(env = process.env) {
  const requested = String(env.WHATSAPP_AUTH_STRATEGY || SUPPORTED_AUTH_STRATEGY).trim().toLowerCase();
  if (requested !== SUPPORTED_AUTH_STRATEGY) {
    throw new Error(`Unsupported WhatsApp auth strategy: ${requested || '(empty)'}. NEXO supports LocalAuth only.`);
  }
  return SUPPORTED_AUTH_STRATEGY;
}

module.exports = { assertLocalAuthOnly, SUPPORTED_AUTH_STRATEGY };

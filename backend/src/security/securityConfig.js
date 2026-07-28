const { configuredOrigins } = require('./origins');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
function isLoopbackOrigin(origin) {
  try { return LOOPBACK_HOSTS.has(new URL(origin).hostname); } catch (_) { return false; }
}

function validateSecurityConfig(env = process.env, logger = console) {
  const allowedOrigins = configuredOrigins(env, logger);
  const production = env.NODE_ENV === 'production';
  const insecureException = env.ALLOW_INSECURE_LOCAL_COOKIE === 'true';
  const host = String(env.HOST || (production ? '' : '127.0.0.1')).trim();
  if (production && !host) throw new Error('Production requires an explicit HOST.');
  if (insecureException) {
    if (!production || !LOOPBACK_HOSTS.has(host) || allowedOrigins.size === 0 || ![...allowedOrigins].every(isLoopbackOrigin)) {
      throw new Error('Insecure local cookie exception requires production loopback HOST and loopback-only allowed origins.');
    }
    logger?.warn?.('insecure_loopback_cookie_enabled');
  } else if (production && env.SESSION_COOKIE_SECURE === 'false') {
    throw new Error('Insecure production cookies are forbidden.');
  }
  return { allowedOrigins, host, cookieSecure: production ? !insecureException : env.SESSION_COOKIE_SECURE === 'true' };
}

module.exports = { LOOPBACK_HOSTS, isLoopbackOrigin, validateSecurityConfig };

const COOKIE_NAME = 'nexo_session';
const DEFAULT_MAX_AGE_SECONDS = 8 * 60 * 60;

function parseCookies(header) {
  if (typeof header !== 'string' || header.length > 16_384) return {};
  const cookies = Object.create(null);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    const value = part.slice(separator + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch (_) { /* malformed cookie ignored */ }
  }
  return cookies;
}

function sessionToken(req) {
  const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  return typeof token === 'string' && token.length > 0 && token.length <= 4096 ? token : null;
}

function maxAgeSeconds(env = process.env, logger = console) {
  if (env.SESSION_MAX_AGE_SECONDS === undefined) return DEFAULT_MAX_AGE_SECONDS;
  const value = Number(env.SESSION_MAX_AGE_SECONDS);
  if (Number.isSafeInteger(value) && value >= 300 && value <= 86_400) return value;
  logger?.warn?.('session_cookie_config_fallback', { setting: 'SESSION_MAX_AGE_SECONDS' });
  return DEFAULT_MAX_AGE_SECONDS;
}

function cookieIsSecure(req, env = process.env, logger = console) {
  if (env.SESSION_COOKIE_SECURE === 'true') return true;
  if (env.NODE_ENV === 'production') {
    if (env.ALLOW_INSECURE_LOCAL_COOKIE === 'true') {
      const { validateSecurityConfig } = require('./securityConfig');
      return validateSecurityConfig(env, logger).cookieSecure;
    }
    if (env.SESSION_COOKIE_SECURE === 'false') throw new Error('Insecure production cookies are forbidden.');
    return true;
  }
  if (req.secure) return true;
  return false;
}

function serializeSessionCookie(value, req, { env = process.env, logger = console, clear = false } = {}) {
  const attributes = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(value)}`,
    'HttpOnly', 'SameSite=Strict', 'Path=/',
    `Max-Age=${clear ? 0 : maxAgeSeconds(env, logger)}`,
  ];
  if (cookieIsSecure(req, env, logger)) attributes.push('Secure');
  return attributes.join('; ');
}

module.exports = { COOKIE_NAME, parseCookies, sessionToken, serializeSessionCookie, maxAgeSeconds, cookieIsSecure };

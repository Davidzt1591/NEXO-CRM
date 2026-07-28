function extractBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header !== 'string') return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  return token || null;
}
const { sessionToken } = require('../security/sessionCookie');

const SAFE_CORRELATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
function safeCorrelationId(value, randomUUID) {
  return typeof value === 'string' && SAFE_CORRELATION_ID.test(value) ? value : randomUUID();
}

async function defaultTokenValidator(token) {
  const { validateToken } = require('../database/db');
  return validateToken(token);
}

function createApiAuth(tokenValidator = defaultTokenValidator, { randomUUID = require('crypto').randomUUID } = {}) {
  return async (req, res, next) => {
    const cookieToken = sessionToken(req);
    const bearerToken = extractBearerToken(req);
    const token = cookieToken || bearerToken;

    if (!token) {
      return res.status(401).json({ code: 'AUTH_INVALID', error: 'Acceso no autorizado. Token ausente.' });
    }

    try {
      const correlationId = safeCorrelationId(req.headers['x-correlation-id'], randomUUID);
      res.setHeader?.('x-correlation-id', correlationId);
      const result = await tokenValidator(token, {
        eventType: 'rest_auth', correlationId,
        route: `${req.baseUrl || ''}${req.route?.path || 'unmatched'}`,
      });
      if (!result || result.status !== 'valid') {
        const code = result?.code === 'AUTH_REVOKED' ? 'AUTH_REVOKED' : 'AUTH_INVALID';
        return res.status(401).json({ code, error: code === 'AUTH_REVOKED'
          ? 'Acceso no autorizado. Token revocado.'
          : 'Acceso no autorizado. Token inválido.' });
      }

      req.user = result.user;
      req.authMethod = cookieToken ? 'cookie' : 'bearer';
      if (!cookieToken && bearerToken) {
        res.setHeader?.('Deprecation', 'true');
        res.setHeader?.('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
        console.warn('bearer_auth_deprecated', { route: req.path || req.baseUrl || 'unknown' });
      }
      next();
    } catch (err) {
      return res.status(503).json({ code: 'AUTH_UNAVAILABLE', error: 'Servicio de autenticación temporalmente no disponible.' });
    }
  };
}

module.exports = createApiAuth();
module.exports.createApiAuth = createApiAuth;
module.exports.defaultTokenValidator = defaultTokenValidator;
module.exports.extractBearerToken = extractBearerToken;
module.exports.safeCorrelationId = safeCorrelationId;

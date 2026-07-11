function extractBearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header !== 'string') return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  return token || null;
}

async function defaultTokenValidator(token) {
  const { validateToken } = require('../database/db');
  return validateToken(token);
}

function createApiAuth(tokenValidator = defaultTokenValidator) {
  return async (req, res, next) => {
    const token = extractBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: 'Acceso no autorizado. Token ausente.' });
    }

    try {
      const user = await tokenValidator(token);
      if (!user) {
        return res.status(401).json({ error: 'Acceso no autorizado. Token inválido o revocado.' });
      }

      req.user = user;
      next();
    } catch (err) {
      return res.status(500).json({ error: 'Error de comunicación con la base de datos de seguridad.' });
    }
  };
}

module.exports = createApiAuth();
module.exports.createApiAuth = createApiAuth;
module.exports.defaultTokenValidator = defaultTokenValidator;
module.exports.extractBearerToken = extractBearerToken;

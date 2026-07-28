const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestOrigin(req) {
  const origin = req.headers?.origin;
  if (typeof origin === 'string' && origin) return origin.replace(/\/$/, '');
  const referer = req.headers?.referer;
  if (typeof referer !== 'string' || !referer) return null;
  try { return new URL(referer).origin; } catch (_) { return null; }
}

function createCsrfProtection(allowedOrigins) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(String(req.method || '').toUpperCase()) || req.authMethod !== 'cookie') return next();
    const origin = requestOrigin(req);
    if (!origin || !allowedOrigins.has(origin)) {
      return res.status(403).json({ code: 'CSRF_REJECTED', error: 'Origen de solicitud no autorizado.' });
    }
    return next();
  };
}

module.exports = { createCsrfProtection, requestOrigin };

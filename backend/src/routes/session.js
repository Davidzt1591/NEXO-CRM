const express = require('express');
const { defaultTokenValidator } = require('../middleware/apiAuth');
const { sessionToken, serializeSessionCookie } = require('../security/sessionCookie');
const { requestOrigin } = require('../middleware/csrf');

function safePrincipal(user) {
  if (!user || typeof user !== 'object') return null;
  const { id, name, role } = user;
  return { user: { id, name, role } };
}

function createSessionRouter(tokenValidator = defaultTokenValidator, options = {}) {
  const router = express.Router();
  const requireTrustedOrigin = (req, res, next) => {
    const origin = requestOrigin(req);
    if (!origin || !options.allowedOrigins?.has(origin)) {
      return res.status(403).json({ code: 'CSRF_REJECTED', error: 'Origen de solicitud no autorizado.' });
    }
    return next();
  };
  router.post('/', requireTrustedOrigin, async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 4096) return res.status(401).json({ code: 'AUTH_INVALID', error: 'Credencial inválida.' });
    try {
      const result = await tokenValidator(token, { eventType: 'session_create', route: '/api/session' });
      if (!result || result.status !== 'valid') {
        const code = result?.code === 'AUTH_REVOKED' ? 'AUTH_REVOKED' : 'AUTH_INVALID';
        return res.status(401).json({ code, error: 'Credencial inválida.' });
      }
      res.setHeader('Set-Cookie', serializeSessionCookie(token, req, options));
      return res.status(201).json({ authenticated: true, principal: safePrincipal(result.user) });
    } catch (_) {
      return res.status(503).json({ code: 'AUTH_UNAVAILABLE', error: 'Servicio de autenticación temporalmente no disponible.' });
    }
  });
  router.get('/', async (req, res) => {
    const token = sessionToken(req);
    if (!token) return res.status(401).json({ authenticated: false, code: 'AUTH_INVALID' });
    try {
      const result = await tokenValidator(token, { eventType: 'session_status', route: '/api/session' });
      if (!result || result.status !== 'valid') {
        res.setHeader('Set-Cookie', serializeSessionCookie('', req, { ...options, clear: true }));
        return res.status(401).json({ authenticated: false, code: result?.code === 'AUTH_REVOKED' ? 'AUTH_REVOKED' : 'AUTH_INVALID' });
      }
      return res.json({ authenticated: true, principal: safePrincipal(result.user) });
    } catch (_) {
      return res.status(503).json({ code: 'AUTH_UNAVAILABLE', error: 'Servicio de autenticación temporalmente no disponible.' });
    }
  });
  router.delete('/', requireTrustedOrigin, (req, res) => {
    res.setHeader('Set-Cookie', serializeSessionCookie('', req, { ...options, clear: true }));
    return res.status(204).end();
  });
  return router;
}

module.exports = { createSessionRouter, safePrincipal };

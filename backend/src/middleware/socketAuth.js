const { safeCorrelationId } = require('./apiAuth');
const { sessionToken } = require('../security/sessionCookie');

function createSocketAuthMiddleware(tokenValidator, { randomUUID = require('crypto').randomUUID } = {}) {
  return async (socket, next) => {
    const token = sessionToken({ headers: socket.handshake.headers || {} });
    const correlationId = safeCorrelationId(socket.handshake.headers?.['x-correlation-id'], randomUUID);
    if (!token) {
      const error = new Error('Acceso no autorizado.');
      error.data = { code: 'AUTH_INVALID' };
      return next(error);
    }

    try {
      const result = await tokenValidator(token, { eventType: 'socket_auth', route: 'socket_handshake', correlationId });
      if (!result || result.status !== 'valid') {
        const error = new Error('Acceso no autorizado.');
        error.data = { code: result?.code === 'AUTH_REVOKED' ? 'AUTH_REVOKED' : 'AUTH_INVALID' };
        return next(error);
      }
      socket.user = result.user;
      socket.sessionToken = token;
      return next();
    } catch (err) {
      const error = new Error('Servicio de autenticación temporalmente no disponible.');
      error.data = { code: 'AUTH_UNAVAILABLE' };
      return next(error);
    }
  };
}

function clearProtectedSocketState(socket) {
  if (socket.user?.role === 'admin') socket.leave('admin');
  if (socket.analyst?.id) socket.leave(`analyst:${socket.analyst.id}`);
  if (socket.analyst?.area_id) socket.leave(`area:${socket.analyst.area_id}`);
  socket.user = null; socket.analyst = null; socket.sessionToken = null;
}

async function validateAndRefreshSocket(socket, tokenValidator, resolveAnalyst, eventType) {
  const result = await tokenValidator(socket.sessionToken, { eventType, route: eventType });
  if (!result || result.status !== 'valid') return { code: result?.code === 'AUTH_REVOKED' ? 'AUTH_REVOKED' : 'AUTH_INVALID' };
  const previousAnalyst = socket.analyst; const previousUser = socket.user;
  const analyst = await resolveAnalyst(result.user.id);
  if (previousUser?.role === 'admin' && result.user.role !== 'admin') socket.leave('admin');
  if (previousAnalyst?.id && String(previousAnalyst.id) !== String(analyst?.id || '')) socket.leave(`analyst:${previousAnalyst.id}`);
  if (previousAnalyst?.area_id && String(previousAnalyst.area_id) !== String(analyst?.area_id || '')) socket.leave(`area:${previousAnalyst.area_id}`);
  socket.user = result.user; socket.analyst = analyst || null;
  if (result.user.role === 'admin') socket.join('admin');
  if (analyst?.id) socket.join(`analyst:${analyst.id}`);
  if (analyst?.area_id) socket.join(`area:${analyst.area_id}`);
  return { code: 'AUTH_VALID' };
}

function rejectSocket(socket, code) {
  clearProtectedSocketState(socket);
  socket.emit('auth-error', { code, message: code === 'AUTH_UNAVAILABLE' ? 'Servicio de autenticación temporalmente no disponible.' : 'Acceso no autorizado.' });
  socket.disconnect(true);
}

function createSocketEventAuthMiddleware(tokenValidator, resolveAnalyst) {
  return async (socket, _packet, next) => {
    try {
      const result = await validateAndRefreshSocket(socket, tokenValidator, resolveAnalyst, 'socket_event_auth');
      if (result.code !== 'AUTH_VALID') { rejectSocket(socket, result.code); return next(new Error(result.code)); }
      return next();
    } catch (_) {
      socket.emit('auth-error', { code: 'AUTH_UNAVAILABLE', message: 'Servicio de autenticación temporalmente no disponible.' });
      return next(new Error('AUTH_UNAVAILABLE'));
    }
  };
}

function passiveRevalidationInterval(env = process.env) {
  const value = Number(env.SOCKET_AUTH_REVALIDATE_MS);
  return Number.isSafeInteger(value) && value >= 15_000 && value <= 30_000 ? value : 20_000;
}

function createPassiveSocketRevalidator(socket, tokenValidator, resolveAnalyst, { intervalMs = passiveRevalidationInterval(), setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let inflight = false; let stopped = false;
  const tick = async () => {
    if (stopped || inflight || !socket.connected) return;
    inflight = true;
    try {
      const result = await validateAndRefreshSocket(socket, tokenValidator, resolveAnalyst, 'socket_passive_auth');
      if (result.code !== 'AUTH_VALID') { stopped = true; clearIntervalFn(timer); rejectSocket(socket, result.code); }
    } catch (_) { stopped = true; clearIntervalFn(timer); rejectSocket(socket, 'AUTH_UNAVAILABLE'); }
    finally { inflight = false; }
  };
  const timer = setIntervalFn(tick, intervalMs);
  timer?.unref?.();
  return () => { stopped = true; clearIntervalFn(timer); };
}

module.exports = { clearProtectedSocketState, createPassiveSocketRevalidator, createSocketAuthMiddleware, createSocketEventAuthMiddleware, passiveRevalidationInterval, validateAndRefreshSocket };

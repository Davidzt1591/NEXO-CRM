const LOCAL_ORIGINS = Object.freeze(['http://localhost:5173', 'http://localhost:5174']);

function configuredOrigins(env = process.env, logger = console) {
  const explicit = [env.FRONTEND_URL, ...(env.ALLOWED_ORIGINS || '').split(',')]
    .map(value => String(value || '').trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (env.NODE_ENV === 'production' && explicit.length === 0) throw new Error('Production requires ALLOWED_ORIGINS or FRONTEND_URL.');
  const origins = new Set([...(env.NODE_ENV === 'production' ? [] : LOCAL_ORIGINS), ...explicit]);
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('Allowed origins must be exact HTTP(S) origins.');
  }
  return origins;
}

function corsOriginHandler(origins) {
  return (origin, callback) => {
    if (!origin || origins.has(origin.replace(/\/$/, ''))) return callback(null, true);
    const error = new Error('Origin not allowed.');
    error.code = 'ORIGIN_NOT_ALLOWED';
    error.status = 403;
    return callback(error);
  };
}

module.exports = { LOCAL_ORIGINS, configuredOrigins, corsOriginHandler };

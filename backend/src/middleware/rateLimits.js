const crypto = require('crypto');
const proxyaddr = require('proxy-addr');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const DEFAULTS = Object.freeze({
  apiWindowMs: 5 * 60 * 1000,
  apiMax: 600,
  mutationWindowMs: 15 * 60 * 1000,
  mutationMax: 60,
  processorWindowMs: 15 * 60 * 1000,
  processorMax: 5,
});

const CONFIG_BOUNDS = Object.freeze({
  apiWindowMs: Object.freeze({ min: 1_000, max: 24 * 60 * 60 * 1000 }),
  apiMax: Object.freeze({ min: 1, max: 10_000 }),
  mutationWindowMs: Object.freeze({ min: 1_000, max: 24 * 60 * 60 * 1000 }),
  mutationMax: Object.freeze({ min: 1, max: 1_000 }),
  processorWindowMs: Object.freeze({ min: 1_000, max: 24 * 60 * 60 * 1000 }),
  processorMax: Object.freeze({ min: 1, max: 100 }),
});

function boundedPositiveInteger(value, fallback, bounds, name, logger) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= bounds.min && parsed <= bounds.max) return parsed;
  logger?.warn?.('rate_limit_config_fallback', { setting: name, fallback });
  return fallback;
}

function rateLimitConfig(env = process.env, logger = console) {
  return {
    apiWindowMs: boundedPositiveInteger(env.API_RATE_LIMIT_WINDOW_MS, DEFAULTS.apiWindowMs, CONFIG_BOUNDS.apiWindowMs, 'API_RATE_LIMIT_WINDOW_MS', logger),
    apiMax: boundedPositiveInteger(env.API_RATE_LIMIT_MAX, DEFAULTS.apiMax, CONFIG_BOUNDS.apiMax, 'API_RATE_LIMIT_MAX', logger),
    mutationWindowMs: boundedPositiveInteger(env.MUTATION_RATE_LIMIT_WINDOW_MS, DEFAULTS.mutationWindowMs, CONFIG_BOUNDS.mutationWindowMs, 'MUTATION_RATE_LIMIT_WINDOW_MS', logger),
    mutationMax: boundedPositiveInteger(env.MUTATION_RATE_LIMIT_MAX, DEFAULTS.mutationMax, CONFIG_BOUNDS.mutationMax, 'MUTATION_RATE_LIMIT_MAX', logger),
    processorWindowMs: boundedPositiveInteger(env.PROCESSOR_RATE_LIMIT_WINDOW_MS, DEFAULTS.processorWindowMs, CONFIG_BOUNDS.processorWindowMs, 'PROCESSOR_RATE_LIMIT_WINDOW_MS', logger),
    processorMax: boundedPositiveInteger(env.PROCESSOR_RATE_LIMIT_MAX, DEFAULTS.processorMax, CONFIG_BOUNDS.processorMax, 'PROCESSOR_RATE_LIMIT_MAX', logger),
  };
}

function retryAfterSeconds(req, windowMs) {
  const resetTime = req.rateLimit?.resetTime;
  if (resetTime instanceof Date) return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
  return Math.max(1, Math.ceil(windowMs / 1000));
}

function safeHandler(windowMs) {
  return (req, res) => {
    const seconds = retryAfterSeconds(req, windowMs);
    res.setHeader('Retry-After', String(seconds));
    res.status(429).json({
      code: 'RATE_LIMITED',
      error: `Se alcanzó temporalmente el límite de solicitudes. Intenta nuevamente en ${seconds} segundos.`,
      retryAfterSeconds: seconds,
    });
  };
}

function limiter({ windowMs, max, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: safeHandler(windowMs),
    ...(keyGenerator ? { keyGenerator } : {}),
  });
}

function createPreAuthApiLimiter(config = rateLimitConfig()) {
  return limiter({ windowMs: config.apiWindowMs, max: config.apiMax, keyGenerator: req => ipKeyGenerator(req.ip) });
}

function createSessionLimiter(config = rateLimitConfig()) {
  return limiter({ windowMs: config.mutationWindowMs, max: Math.min(config.mutationMax, 10), keyGenerator: req => ipKeyGenerator(req.ip) });
}

function agentKey(req, secret) {
  const agentId = req.user?.id ?? req.user?.agent_id ?? req.user?.token_id;
  if (agentId === undefined || agentId === null || String(agentId).length > 160) return ipKeyGenerator(req.ip);
  if (!secret) return `agent:${String(agentId)}`;
  const digest = crypto.createHmac('sha256', secret).update(String(req.ip || '')).digest('base64url').slice(0, 22);
  return `agent:${String(agentId)}:ip:${digest}`;
}

const PROCESSOR_ROUTES = Object.freeze([
  ['POST', /^\/admin\/salesforce-outbox\/process$/],
  ['POST', /^\/admin\/ticket-post-processing\/process$/],
]);

const MUTATION_ROUTES = Object.freeze([
  ['POST', /^\/sf\/cases$/],
  ['PATCH', /^\/sf\/cases\/[^/]+$/],
  ['POST', /^\/sf\/cases\/[^/]+\/close$/],
  ['PATCH', /^\/sf\/cases\/[^/]+\/assign-me$/],
  ['PUT', /^\/candidates\/[^/]+$/],
  ['DELETE', /^\/candidates\/[^/]+$/],
  ['POST', /^\/admin\/areas$/],
  ['PATCH', /^\/admin\/areas\/[^/]+$/],
  ['POST', /^\/admin\/analysts$/],
  ['PATCH', /^\/admin\/analysts\/[^/]+$/],
  ['PUT', /^\/admin\/candidate-settings$/],
  ['POST', /^\/admin\/agent-tokens$/],
  ['POST', /^\/admin\/agent-tokens\/[^/]+\/revoke$/],
  ['POST', /^\/admin\/salesforce-outbox\/[^/]+\/retry$/],
  ['POST', /^\/admin\/tickets\/[^/]+\/(?:assign|unassign|transfer)$/],
  ['PUT', /^\/admin\/bot-flow-studio\/layout$/],
  ['POST', /^\/admin\/bot-flows$/],
  ['PATCH', /^\/admin\/bot-flows\/[^/]+$/],
  ['POST', /^\/admin\/bot-flows\/[^/]+\/toggle$/],
  ['POST', /^\/admin\/bot-flows\/cache\/invalidate$/],
]);

function normalizedRoutePath(req) {
  const raw = `${req.baseUrl || ''}${req.path || '/'}`;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function matchesRoute(routes, req) {
  const method = String(req.method || '').toUpperCase();
  const path = normalizedRoutePath(req).replace(/^\/api(?=\/)/, '');
  return routes.some(([routeMethod, pattern]) => routeMethod === method && pattern.test(path));
}

function isHighRiskMutation(req) {
  return matchesRoute(MUTATION_ROUTES, req);
}

function createPostAuthLimiters(config = rateLimitConfig(), env = process.env) {
  const keyGenerator = req => agentKey(req, env.RATE_LIMIT_KEY_SECRET);
  const mutations = limiter({ windowMs: config.mutationWindowMs, max: config.mutationMax, keyGenerator });
  const processors = limiter({ windowMs: config.processorWindowMs, max: config.processorMax, keyGenerator });
  return (req, res, next) => {
    if (matchesRoute(PROCESSOR_ROUTES, req)) return processors(req, res, next);
    if (isHighRiskMutation(req)) return mutations(req, res, next);
    return next();
  };
}

function trustProxySetting(env = process.env, logger = console) {
  if (env.TRUST_PROXY_HOPS !== undefined) {
    logger?.warn?.('trust_proxy_config_rejected', { setting: 'TRUST_PROXY_HOPS' });
    return false;
  }
  if (env.TRUST_PROXY_CIDRS === undefined) return false;
  const trusted = String(env.TRUST_PROXY_CIDRS).split(',').map(value => value.trim()).filter(Boolean);
  if (trusted.length === 0) return false;
  try {
    return proxyaddr.compile(trusted);
  } catch (_error) {
    logger?.warn?.('trust_proxy_config_rejected', { setting: 'TRUST_PROXY_CIDRS' });
    return false;
  }
}

module.exports = {
  DEFAULTS,
  CONFIG_BOUNDS,
  agentKey,
  createPostAuthLimiters,
  createPreAuthApiLimiter,
  createSessionLimiter,
  isHighRiskMutation,
  rateLimitConfig,
  trustProxySetting,
};

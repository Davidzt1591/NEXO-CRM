const crypto = require('crypto');
const { isRetryableTransportError, normalizeCauseCode } = require('../startup');

function timeoutError() {
  const error = new Error('Authentication validation deadline exceeded.');
  error.code = 'ETIMEDOUT';
  return error;
}

async function runAttempt(validateOnce, token, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError());
  }, timeoutMs);
  try {
    const result = await validateOnce(token, { signal: controller.signal });
    if (timedOut) throw timeoutError();
    return result;
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createAuthValidator(validateOnce, options = {}) {
  const config = {
    maxAttempts: options.maxAttempts ?? 3,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 1_500,
    baseDelayMs: options.baseDelayMs ?? 50,
    maxDelayMs: options.maxDelayMs ?? 250,
    maxInflight: options.maxInflight ?? 100,
  };
  const inflight = new Map();
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const logger = options.logger ?? console;

  const digest = token => crypto.createHash('sha256').update(token).digest('hex');
  async function validate(token, context = {}) {
    if (!token) return { status: 'invalid', code: 'AUTH_INVALID' };
    const key = digest(token);
    if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= config.maxInflight) {
      const error = new Error('Authentication validation capacity exceeded.');
      error.code = 'AUTH_OVERLOADED';
      throw error;
    }

    const operation = (async () => {
      const startedAt = now();
      let lastError;
      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        try {
          const result = await runAttempt(validateOnce, token, config.attemptTimeoutMs);
          logger.info?.('auth_validation', { eventType: context.eventType || 'auth', route: context.route || 'socket', code: result?.code || 'AUTH_VALID', attempts: attempt, latencyMs: now() - startedAt, outcome: attempt > 1 ? 'recovered' : 'terminal', correlationId: context.correlationId });
          return result;
        } catch (error) {
          lastError = error;
          const code = normalizeCauseCode(error);
          const retryable = isRetryableTransportError(error);
          if (!retryable || attempt === config.maxAttempts) {
            logger.warn?.('auth_validation', { eventType: context.eventType || 'auth', route: context.route || 'socket', code, attempts: attempt, latencyMs: now() - startedAt, outcome: 'terminal', correlationId: context.correlationId });
            throw error;
          }
          const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** (attempt - 1)));
          await sleep(Math.floor(random() * ceiling));
        }
      }
      throw lastError;
    })();
    inflight.set(key, operation);
    try { return await operation; } finally { inflight.delete(key); }
  }

  return { validate, config };
}

module.exports = { createAuthValidator };

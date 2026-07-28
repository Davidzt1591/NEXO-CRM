const RETRYABLE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
]);

const SAFE_NON_RETRYABLE_CODES = new Set([
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  '42703',
]);

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    chain.push(current);
  }
  return chain;
}

function normalizeCauseCode(error) {
  for (const item of errorChain(error)) {
    const code = String(item?.code || '').toUpperCase();
    if (RETRYABLE_CODES.has(code)) return code;
    if (SAFE_NON_RETRYABLE_CODES.has(code)) return code;
  }
  return 'UNKNOWN_ERROR';
}

function isRetryableTransportError(error) {
  return RETRYABLE_CODES.has(normalizeCauseCode(error));
}

function captureSafeFailure(captureException, phase, code, attempts) {
  const error = new Error(`Startup ${phase} failed (${code})`);
  error.name = 'StartupFailure';
  error.code = code;
  captureException(error, { tags: { component: 'startup', phase, code, attempts: String(attempts) } });
}

function positiveInt(value, fallback, min = 1, max = 60_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), min), max) : fallback;
}

function retryConfig(env = process.env) {
  return {
    maxAttempts: positiveInt(env.STARTUP_HYDRATION_MAX_ATTEMPTS, 5, 1, 20),
    baseDelayMs: positiveInt(env.STARTUP_HYDRATION_BASE_DELAY_MS, 250, 1, 10_000),
    maxDelayMs: positiveInt(env.STARTUP_HYDRATION_MAX_DELAY_MS, 4_000, 1, 60_000),
  };
}

function createStartupState(now = Date.now) {
  const startedAt = now();
  return {
    status: 'hydrating', ready: false, attempts: 0, latencyMs: 0, causeCode: null,
    startedAt,
    publicView() {
      return {
        status: this.ready ? 'ready' : 'degraded',
        ready: this.ready,
      };
    },
  };
}

function createHealthHandler(state) {
  return (_req, res) => res.status(state.ready ? 200 : 503).json({
    ...state.publicView(),
  });
}

async function hydrateThenStart({
  hydrate, startWhatsApp, state, config = retryConfig(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random, now = Date.now, logger = console, captureException = () => {},
}) {
  let lastError;
  let sessionCount;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    state.attempts = attempt;
    const attemptStartedAt = now();
    try {
      sessionCount = await hydrate();
      state.latencyMs = now() - state.startedAt;
      state.status = 'hydrated';
      state.causeCode = null;
      logger.log('startup_hydration_recovered', { attempt, latencyMs: now() - attemptStartedAt, sessionCount });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const causeCode = normalizeCauseCode(error);
      const retryable = isRetryableTransportError(error);
      state.latencyMs = now() - state.startedAt;
      state.causeCode = causeCode;
      logger.warn('startup_hydration_attempt_failed', { attempt, latencyMs: now() - attemptStartedAt, causeCode, retryable });
      if (!retryable || attempt === config.maxAttempts) break;
      const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** (attempt - 1)));
      await sleep(Math.floor(random() * ceiling));
    }
  }
  if (lastError) {
    state.status = 'failed';
    state.ready = false;
    logger.error('startup_hydration_exhausted', { attempt: state.attempts, latencyMs: state.latencyMs, causeCode: state.causeCode });
    captureSafeFailure(captureException, 'session_hydration', state.causeCode, state.attempts);
    return { ready: false, attempts: state.attempts, causeCode: state.causeCode };
  }

  state.status = 'whatsapp_initializing';
  try {
    await startWhatsApp();
    state.status = 'ready';
    state.ready = true;
    state.causeCode = null;
    return { ready: true, attempts: state.attempts, sessionCount };
  } catch (_) {
    state.status = 'failed';
    state.ready = false;
    state.causeCode = 'WHATSAPP_INIT_FAILED';
    state.latencyMs = now() - state.startedAt;
    logger.error('startup_whatsapp_init_failed', { attempt: state.attempts, latencyMs: state.latencyMs, causeCode: state.causeCode });
    captureSafeFailure(captureException, 'whatsapp_init', state.causeCode, state.attempts);
    return { ready: false, attempts: state.attempts, causeCode: state.causeCode };
  }
}

module.exports = { createHealthHandler, createStartupState, hydrateThenStart, isRetryableTransportError, normalizeCauseCode, retryConfig };

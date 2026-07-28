const { isRetryableTransportError, normalizeCauseCode } = require('../startup');

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), min), max) : fallback;
}

function createClassificationState() {
  return {
    transientFailures: 0,
    recoveredAfterRetry: 0,
    terminalDrops: 0,
    lastFailureTimestamp: null,
    lastFailureCode: null,
    publicView() {
      return {
        status: this.terminalDrops > 0 ? 'degraded' : 'ok',
        transientFailures: this.transientFailures,
        recoveredAfterRetry: this.recoveredAfterRetry,
        terminalDrops: this.terminalDrops,
        lastFailureTimestamp: this.lastFailureTimestamp,
        lastFailureCode: this.lastFailureCode,
      };
    },
  };
}

function classificationRetryConfig(env = process.env) {
  return {
    maxAttempts: positiveInt(env.CLASSIFICATION_MAX_ATTEMPTS, 3, 1, 10),
    baseDelayMs: positiveInt(env.CLASSIFICATION_BASE_DELAY_MS, 100, 1, 5_000),
    maxDelayMs: positiveInt(env.CLASSIFICATION_MAX_DELAY_MS, 1_000, 1, 10_000),
  };
}

function captureSafeClassificationFailure(captureException, code, attempts, outcome) {
  const error = new Error(`Candidate classification lookup ${outcome} (${code})`);
  error.name = 'CandidateClassificationFailure';
  error.code = code;
  captureException(error, {
    tags: { component: 'candidate_classification', code, attempts: String(attempts), outcome },
  });
}

async function lookupCandidateClassification({
  lookup,
  state,
  config = classificationRetryConfig(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
  now = Date.now,
  logger = console,
  captureException = () => {},
}) {
  const startedAt = now();
  let hadTransientFailure = false;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      const classification = await lookup();
      if (hadTransientFailure) {
        state.recoveredAfterRetry += 1;
        logger.log('candidate_classification_lookup', {
          causeCode: state.lastFailureCode, attempt, latencyMs: now() - startedAt, outcome: 'recovered',
        });
      }
      return { ok: true, classification, attempts: attempt };
    } catch (error) {
      const causeCode = normalizeCauseCode(error);
      const retryable = isRetryableTransportError(error);
      const latencyMs = now() - startedAt;

      state.lastFailureTimestamp = new Date(now()).toISOString();
      state.lastFailureCode = causeCode;
      if (retryable) state.transientFailures += 1;

      const terminal = !retryable || attempt === config.maxAttempts;
      logger[terminal ? 'error' : 'warn']('candidate_classification_lookup', {
        causeCode, attempt, latencyMs, outcome: terminal ? 'terminal_drop' : 'retry',
      });

      if (terminal) {
        state.terminalDrops += 1;
        captureSafeClassificationFailure(captureException, causeCode, attempt, 'terminal_drop');
        return { ok: false, attempts: attempt, causeCode };
      }

      hadTransientFailure = true;
      const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * (2 ** (attempt - 1)));
      await sleep(Math.floor(random() * ceiling));
    }
  }

  return { ok: false, attempts: config.maxAttempts, causeCode: 'UNKNOWN_ERROR' };
}

const classificationState = createClassificationState();

module.exports = {
  captureSafeClassificationFailure,
  classificationRetryConfig,
  classificationState,
  createClassificationState,
  lookupCandidateClassification,
};

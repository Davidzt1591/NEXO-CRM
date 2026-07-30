const path = require('node:path');
const { enforceStartupDependencyTopology } = require('../scripts/dependency-topology');
enforceStartupDependencyTopology({
  repositoryRoot: path.resolve(__dirname, '..'),
  runtimeDirectories: [path.resolve(__dirname, '..'), __dirname],
});
require('dotenv').config();
// For corporate/self-signed certificate chains, configure NODE_EXTRA_CA_CERTS
// with a local CA bundle instead of disabling TLS verification globally.
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const globalLogs = [];
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const { redactLogArgs, safeStringifyForLog, redactTextForLog } = require('./src/utils/redact');
function addLog(type, args) {
  const msg = Array.from(args)
    .map(a => typeof a === 'object' ? safeStringifyForLog(a) : redactTextForLog(a))
    .join(' ')
    .replace(/(pairing-code|pairing code|c[oó]digo de emparejamiento|qr)([^\n]{0,40})([A-Za-z0-9+/=_-]{6,})/gi, '$1$2[REDACTED]');
  globalLogs.push({ ts: new Date().toISOString(), type, msg });
  if (globalLogs.length > 200) globalLogs.shift(); // Max 200 logs
}
console.log = (...args) => { const safeArgs = redactLogArgs(args); addLog('INFO', safeArgs); origLog(...safeArgs); };
console.error = (...args) => { const safeArgs = redactLogArgs(args); addLog('ERROR', safeArgs); origError(...safeArgs); };
console.warn = (...args) => { const safeArgs = redactLogArgs(args); addLog('WARN', safeArgs); origWarn(...safeArgs); };
const { initWhatsApp: setupWhatsApp } = require('./src/services/whatsapp');
const { setupSockets } = require('./src/socket');
const { loadSessionsFromDb } = require('./src/services/whatsapp/wwebjs');
const { createHealthHandler, createStartupState, hydrateThenStart, retryConfig } = require('./src/startup');

function captureConfiguredStartupError(error, context) {
  if (!process.env.SENTRY_DSN) return;
  try {
    // Sentry is optional in this deployment; use it when the configured SDK is present.
    require('@sentry/node').captureException(error, context);
  } catch (_) {
    console.warn('startup_observability_unavailable', { causeCode: 'SENTRY_SDK_UNAVAILABLE' });
  }
}

const helmet = require('helmet');
const cors = require('cors');
const { createPostAuthLimiters, createPreAuthApiLimiter, createSessionLimiter, rateLimitConfig, trustProxySetting } = require('./src/middleware/rateLimits');
const { corsOriginHandler } = require('./src/security/origins');
const { validateSecurityConfig } = require('./src/security/securityConfig');
const { createCsrfProtection } = require('./src/middleware/csrf');

const app = express();
// Direct/local traffic is the safe default. TRUST_PROXY_CIDRS accepts only an
// explicit proxy-addr CIDR/loopback list; numeric hop trust is rejected.
app.set('trust proxy', trustProxySetting());

app.use(helmet());
const securityConfig = validateSecurityConfig();
const allowedOrigins = securityConfig.allowedOrigins;
app.use(cors({ origin: corsOriginHandler(allowedOrigins), credentials: true }));
app.use((error, _req, res, next) => {
  if (error?.code === 'ORIGIN_NOT_ALLOWED') return res.status(403).json({ error: 'Origin not allowed.' });
  return next(error);
});

app.use(express.json());

const startupState = createStartupState();
// Liveness is exposed while booting; readiness remains 503 until hydration succeeds.
app.get('/health', createHealthHandler(startupState));

const apiAuth = require('./src/middleware/apiAuth');
const adminOnly = require('./src/middleware/adminOnly');

// Enforce auth on all API sub-routes
const rateLimits = rateLimitConfig();
const strictRouteLimiter = createSessionLimiter(rateLimits);
app.use('/api/session', strictRouteLimiter, require('./src/routes/session').createSessionRouter(undefined, { allowedOrigins }));
app.use('/api', createPreAuthApiLimiter(rateLimits), apiAuth, createCsrfProtection(allowedOrigins), createPostAuthLimiters(rateLimits));

// Protected API Routes
app.use('/api/sf', require('./src/routes/salesforce'));
app.use('/api/candidates', require('./src/routes/candidates'));
app.use('/api/conversations', require('./src/routes/conversations'));
app.use('/api/admin', adminOnly, require('./src/routes/admin'));

app.get('/api/logs', adminOnly, (req, res) => {
  res.json(globalLogs);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [...allowedOrigins],
    credentials: true,
    methods: ['GET', 'POST'],
  },
});
app.set('io', io);

const PORT = process.env.PORT || 3001;

const store               = require('./src/store');
const { initDb }           = require('./src/database/db');
const { startCleanupCron } = require('./src/database/cleanup');

// ── Boot sequence ─────────────────────────────────────────────────────────
(async () => {
  // 1. Verify Supabase connection
  await initDb();

  // 2. Start nightly cleanup cron
  startCleanupCron();

  // 3. Restore persisted chat preferences before WhatsApp starts processing messages
  await store.restorePreferences();

  // 4. Expose degraded health while persisted sessions are hydrated.
  server.listen(PORT, securityConfig.host, () => {
    console.log(`\n🚀 NEXO Backend corriendo en puerto ${PORT}`);
  });

  // 5. WhatsApp processing starts only after durable session hydration succeeds.
  await hydrateThenStart({
    hydrate: loadSessionsFromDb,
    state: startupState,
    config: retryConfig(),
    captureException: captureConfiguredStartupError,
    startWhatsApp: async () => {
      const { client, borrarSesion } = setupWhatsApp(io, { captureException: captureConfiguredStartupError });
      setupSockets(io, client, borrarSesion);
      await client.initialize();
    },
  });
})();

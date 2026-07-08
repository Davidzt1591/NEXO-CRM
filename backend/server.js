require('dotenv').config();
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const globalLogs = [];
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
function addLog(type, args) {
  const msg = Array.from(args)
    .map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))
    .join(' ')
    .replace(/(pairing-code|pairing code|c[oó]digo de emparejamiento|qr)([^\n]{0,40})([A-Za-z0-9+/=_-]{6,})/gi, '$1$2[REDACTED]');
  globalLogs.push({ ts: new Date().toISOString(), type, msg });
  if (globalLogs.length > 200) globalLogs.shift(); // Max 200 logs
}
console.log = (...args) => { addLog('INFO', args); origLog(...args); };
console.error = (...args) => { addLog('ERROR', args); origError(...args); };
console.warn = (...args) => { addLog('WARN', args); origWarn(...args); };
const { initWhatsApp: setupWhatsApp } = require('./src/services/whatsapp');
const { setupSockets } = require('./src/socket');

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Nginx) for client IP detection

app.use(helmet());
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas peticiones desde esta IP, por favor intenta más tarde.' }
});

app.use(express.json());
app.use('/', limiter);

// Public Endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const { validateToken } = require('./src/database/db');
const adminOnly = require('./src/middleware/adminOnly');

// Auth middleware for API routes
const apiAuth = async (req, res, next) => {
  let token = req.headers['authorization'];
  if (token && token.startsWith('Bearer ')) {
    token = token.slice(7);
  } else {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Acceso no autorizado. Token ausente.' });
  }

  try {
    const user = await validateToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Acceso no autorizado. Token inválido o revocado.' });
    }

    req.user = user; // Attach user metadata to request object
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Error de comunicación con la base de datos de seguridad.' });
  }
};

// Enforce auth on all API sub-routes
app.use('/api', apiAuth);

// Protected API Routes
app.use('/api/sf', require('./src/routes/salesforce'));
app.use('/api/admin', adminOnly, require('./src/routes/admin'));

app.get('/api/logs', adminOnly, (req, res) => {
  res.json(globalLogs);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL
      ? [process.env.FRONTEND_URL]
      : ['http://localhost:5173', 'http://localhost:5174'],
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3001;

const { initDb }           = require('./src/database/db');
const { startCleanupCron } = require('./src/database/cleanup');

// ── Boot sequence ─────────────────────────────────────────────────────────
(async () => {
  // 1. Initialize SQLite DB (creates tables if not exist)
  await initDb();

  // 2. Start nightly cleanup cron
  startCleanupCron();

  // 3. Inicializamos WhatsApp pasándole los Sockets
  const { client, borrarSesion } = setupWhatsApp(io);

  // 4. Inicializamos Sockets pasándole el cliente WhatsApp
  setupSockets(io, client, borrarSesion);

  // 5. Start server
  server.listen(PORT, () => {
    console.log(`\n🚀 NEXO Backend corriendo en puerto ${PORT}`);
    client.initialize();
  });
})();

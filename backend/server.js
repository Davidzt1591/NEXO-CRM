require('dotenv').config();
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const globalLogs = [];
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
function addLog(type, args) {
  const msg = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
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

app.use(helmet());
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas peticiones desde esta IP, por favor intenta más tarde.' }
});
app.use('/', limiter);

const { validateToken } = require('./src/database/db');

// Auth middleware for API routes
const apiAuth = async (req, res, next) => {
  // Exclude healthcheck from authorization
  if (req.path === '/health') return next();

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

app.use('/api', apiAuth);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL
      ? [process.env.FRONTEND_URL]
      : ['http://localhost:5173', 'http://localhost:5174'],
    methods: ['GET', 'POST'],
  },
});

app.use(express.json());

const PORT = process.env.PORT || 3001;

// Salesforce proxy routes
app.use('/api/sf', require('./src/routes/salesforce'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/logs', (req, res) => {
  res.json(globalLogs);
});

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

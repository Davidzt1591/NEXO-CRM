/**
 * NEXO — SQLite Database Module
 * Replaces Supabase. All data stays on-premise.
 * Uses sql.js (pure JavaScript, no native compilation needed).
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(__dirname, '..', '..', 'data', 'nexo.db');
const DB_DIR  = path.dirname(DB_PATH);

let _db = null;

// ── Persist DB to disk ─────────────────────────────────────────────────────
function persistDb() {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 30 seconds to prevent data loss
let _persistInterval = null;

// ── Schema ─────────────────────────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tickets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id         TEXT    NOT NULL,
    telefono        TEXT,
    nombre_analista TEXT,
    nombre_empresa  TEXT,
    correo          TEXT,
    situacion       TEXT,
    prioridad       TEXT,
    status          TEXT    DEFAULT 'open',
    sf_case_id      TEXT,
    sf_case_number  TEXT,
    created_at      TEXT    DEFAULT (datetime('now')),
    closed_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id     INTEGER,
    chat_id       TEXT    NOT NULL,
    body          TEXT,
    from_user     INTEGER DEFAULT 0,
    is_bot        INTEGER DEFAULT 0,
    wa_message_id TEXT,
    timestamp     TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS bot_sessions (
    chat_id    TEXT PRIMARY KEY,
    paso       TEXT,
    nombre     TEXT,
    empresa    TEXT,
    correo     TEXT,
    situacion  TEXT,
    ticket_id  INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ticket    ON messages (ticket_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);
  CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets  (status);
  CREATE INDEX IF NOT EXISTS idx_tickets_chat_id    ON tickets  (chat_id);
`;

// ── Init ───────────────────────────────────────────────────────────────────
async function initDb() {
  if (_db) return _db;

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
    console.log('💾 SQLite DB cargada desde disco:', DB_PATH);
  } else {
    _db = new SQL.Database();
    console.log('💾 SQLite DB nueva creada en:', DB_PATH);
  }

  _db.run(SCHEMA);
  persistDb();

  // Auto-save each 30 seconds
  _persistInterval = setInterval(persistDb, 30_000);

  return _db;
}

// ── Query helpers ──────────────────────────────────────────────────────────

/**
 * Run a SELECT and return all rows as an array of objects.
 */
function query(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Run a single-row SELECT.
 */
function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

/**
 * Run INSERT/UPDATE/DELETE. Returns lastInsertRowid for INSERTs.
 */
function run(sql, params = []) {
  _db.run(sql, params);
  const meta = _db.exec('SELECT last_insert_rowid() as id');
  const id = meta?.[0]?.values?.[0]?.[0] ?? null;
  // Persist asynchronously to avoid blocking
  setImmediate(persistDb);
  return { id };
}

// ── Ticket Operations ──────────────────────────────────────────────────────

function createTicket({ chat_id, telefono, nombre_analista, nombre_empresa, correo, situacion, prioridad }) {
  const { id } = run(
    `INSERT INTO tickets (chat_id, telefono, nombre_analista, nombre_empresa, correo, situacion, prioridad)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [chat_id, telefono || null, nombre_analista || null, nombre_empresa || null,
     correo || null, situacion || null, prioridad || null]
  );
  return queryOne('SELECT * FROM tickets WHERE id = ?', [id]);
}

function updateTicketSalesforce(id, { sf_case_id, sf_case_number }) {
  run('UPDATE tickets SET sf_case_id = ?, sf_case_number = ? WHERE id = ?',
    [sf_case_id, sf_case_number, id]);
}

function closeTicket(id) {
  run(`UPDATE tickets SET status = 'closed', closed_at = datetime('now') WHERE id = ?`, [id]);
}

function getTickets() {
  return query('SELECT * FROM tickets ORDER BY created_at DESC');
}

function getTicketById(id) {
  return queryOne('SELECT * FROM tickets WHERE id = ?', [id]);
}

function deleteTicket(id) {
  run('DELETE FROM tickets WHERE id = ?', [id]);
}

// ── Message Operations ─────────────────────────────────────────────────────

function saveMessage({ ticket_id, chat_id, body, from_user, is_bot, wa_message_id }) {
  const { id } = run(
    `INSERT INTO messages (ticket_id, chat_id, body, from_user, is_bot, wa_message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [ticket_id || null, chat_id, body || '', from_user ? 1 : 0, is_bot ? 1 : 0, wa_message_id || null]
  );
  return queryOne('SELECT * FROM messages WHERE id = ?', [id]);
}

function getMessages(ticketId) {
  return query(
    'SELECT * FROM messages WHERE ticket_id = ? ORDER BY timestamp ASC',
    [ticketId]
  );
}

// ── Session Operations ─────────────────────────────────────────────────────

function getSession(chatId) {
  const row = queryOne('SELECT * FROM bot_sessions WHERE chat_id = ?', [chatId]);
  if (!row) return null;
  return {
    paso:      row.paso,
    nombre:    row.nombre,
    empresa:   row.empresa,
    correo:    row.correo,
    situacion: row.situacion,
    ticketId:  row.ticket_id,
  };
}

function saveSession(chatId, session) {
  run(
    `INSERT INTO bot_sessions (chat_id, paso, nombre, empresa, correo, situacion, ticket_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(chat_id) DO UPDATE SET
       paso       = excluded.paso,
       nombre     = excluded.nombre,
       empresa    = excluded.empresa,
       correo     = excluded.correo,
       situacion  = excluded.situacion,
       ticket_id  = excluded.ticket_id,
       updated_at = datetime('now')`,
    [
      chatId,
      session.paso ?? null,
      session.nombre ?? null,
      session.empresa ?? null,
      session.correo ?? null,
      session.situacion ?? null,
      session.ticketId ?? null,
    ]
  );
}

function deleteSession(chatId) {
  run('DELETE FROM bot_sessions WHERE chat_id = ?', [chatId]);
}

function loadAllSessions() {
  return query('SELECT * FROM bot_sessions');
}

// ── Stats ──────────────────────────────────────────────────────────────────

function getStats() {
  const total    = queryOne('SELECT COUNT(*) as n FROM tickets')?.n ?? 0;
  const open     = queryOne("SELECT COUNT(*) as n FROM tickets WHERE status = 'open'")?.n ?? 0;
  const closed   = queryOne("SELECT COUNT(*) as n FROM tickets WHERE status = 'closed'")?.n ?? 0;
  const today    = queryOne("SELECT COUNT(*) as n FROM tickets WHERE date(created_at) = date('now')")?.n ?? 0;
  return { total, open, closed, today };
}

// ── Cleanup (TTL) ──────────────────────────────────────────────────────────

function cleanupOldMessages(ttlDays = 90) {
  const result = run(
    `DELETE FROM messages WHERE timestamp < datetime('now', ?)`,
    [`-${ttlDays} days`]
  );
  console.log(`🧹 Cleanup: mensajes eliminados con más de ${ttlDays} días`);
  return result;
}

function cleanupOldSessions(ttlDays = 7) {
  run(
    `DELETE FROM bot_sessions WHERE updated_at < datetime('now', ?)`,
    [`-${ttlDays} days`]
  );
  console.log(`🧹 Cleanup: sesiones inactivas eliminadas con más de ${ttlDays} días`);
}

module.exports = {
  initDb,
  persistDb,
  // Tickets
  createTicket,
  updateTicketSalesforce,
  closeTicket,
  getTickets,
  getTicketById,
  deleteTicket,
  // Messages
  saveMessage,
  getMessages,
  // Sessions
  getSession,
  saveSession,
  deleteSession,
  loadAllSessions,
  // Stats
  getStats,
  // Cleanup
  cleanupOldMessages,
  cleanupOldSessions,
};

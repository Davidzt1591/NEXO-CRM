/**
 * NEXO — Cleanup Cron Job
 * Runs nightly at 2:00 AM to enforce data TTL policy.
 * TTL values are configurable via .env
 */

const cron = require('node-cron');
const db   = require('./db');

const MESSAGE_TTL_DAYS = parseInt(process.env.MESSAGE_TTL_DAYS || '90', 10);
const SESSION_TTL_DAYS = parseInt(process.env.SESSION_TTL_DAYS || '7',  10);

function runCleanup() {
  console.log('🌙 Iniciando limpieza nocturna de datos...');
  try {
    db.cleanupOldMessages(MESSAGE_TTL_DAYS);
    db.cleanupOldSessions(SESSION_TTL_DAYS);
    db.persistDb();
    console.log(`✅ Limpieza completada. Retención: mensajes ${MESSAGE_TTL_DAYS}d, sesiones ${SESSION_TTL_DAYS}d`);
  } catch (err) {
    console.error('❌ Error en limpieza nocturna:', err.message);
  }
}

function startCleanupCron() {
  // Every night at 2:00 AM
  cron.schedule('0 2 * * *', runCleanup, {
    timezone: 'America/Bogota'
  });
  console.log(`🕑 Cron de limpieza activado (2:00 AM hora Bogotá) — TTL: ${MESSAGE_TTL_DAYS}d mensajes, ${SESSION_TTL_DAYS}d sesiones`);
}

module.exports = { startCleanupCron, runCleanup };

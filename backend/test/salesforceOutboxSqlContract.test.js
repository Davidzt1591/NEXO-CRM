const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../src/services/salesforceOutboxContract');

const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/phase7_salesforce_outbox_processor.sql'), 'utf8');

test('phase7 SQL preserves atomic claim and lease contract', () => {
  for (const clause of [
    /FOR UPDATE SKIP LOCKED/i,
    /operation\s*=\s*'case_close'/i,
    /next_attempt_at\s*<=\s*now\(\)/i,
    /attempts\s*<\s*max_attempts/i,
    /locked_at IS NULL OR locked_at\s*</i,
    /ORDER BY next_attempt_at ASC, created_at ASC/i,
    /attempts\s*=\s*job\.attempts\s*\+\s*1/i,
  ]) assert.match(sql, clause);
});

test('SQL lease default matches the exported cross-layer contract', () => {
  const sqlLease = Number(sql.match(/p_lock_timeout_seconds INT DEFAULT (\d+)/i)?.[1]);
  assert.equal(sqlLease, contract.SALESFORCE_OUTBOX_LEASE_SECONDS);
});

test('application transitions enforce the same centralized lease freshness cutoff', () => {
  const dbSource = fs.readFileSync(path.resolve(__dirname, '../src/database/db.js'), 'utf8');
  assert.match(dbSource, /SALESFORCE_OUTBOX_LEASE_SECONDS/);
  assert.match(dbSource, /transition_salesforce_outbox_job/);
  const transitionFunction = sql.match(/CREATE OR REPLACE FUNCTION transition_salesforce_outbox_job[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(transitionFunction, /job\.id = p_job_id/);
  assert.match(transitionFunction, /job\.locked_by = p_worker_id/);
  assert.match(transitionFunction, /job\.locked_at >= CURRENT_TIMESTAMP - pg_catalog\.make_interval/);
});

test('phase7 SQL hardens definer functions and grants only service role execution', () => {
  assert.equal((sql.match(/SECURITY DEFINER/gi) || []).length, 3);
  assert.equal((sql.match(/SET search_path = ''/gi) || []).length, 3);
  assert.equal((sql.match(/REVOKE ALL ON FUNCTION public\./gi) || []).length, 3);
  assert.equal((sql.match(/GRANT EXECUTE ON FUNCTION public\.[\s\S]*? TO service_role/gi) || []).length, 3);
  assert.doesNotMatch(sql, /SET search_path = public/i);
});

test('phase7 SQL is repeatable and manual retry replenishes exhausted budget', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS max_attempts/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/i);
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/gi) || []).length, 3);
  assert.match(sql, /max_attempts\s*=\s*attempts\s*\+\s*5/i);
  assert.match(sql, /status\s*=\s*'pending'/i);
  assert.match(sql, /next_attempt_at\s*=\s*CURRENT_TIMESTAMP/i);
  assert.match(sql, /locked_at\s*=\s*NULL[\s\S]*locked_by\s*=\s*NULL/i);
  assert.match(sql, /attempts\s*<\s*max_attempts/i);
});

test('manual retry is failed-only and cannot clear an active retrying lease', () => {
  const retryFunction = sql.match(/CREATE OR REPLACE FUNCTION retry_salesforce_outbox_job[\s\S]*?\$\$;/i)?.[0] || '';
  assert.match(retryFunction, /WHERE id = p_job_id\s+AND status = 'failed'/i);
  assert.doesNotMatch(retryFunction, /status\s+IN\s*\([^)]*'retrying'/i);
  assert.match(retryFunction, /never clear a retrying[\s\S]*active lease/i);
});

test('SQL artifact explicitly remains manual application evidence, not execution proof', () => {
  assert.match(sql, /Artifact only: apply manually/i);
  assert.match(sql, /Post-application manual validation \(not integration proof\)/i);
  assert.match(sql, /failed-only[\s\S]*active retrying lease[\s\S]*concurrent claim/i);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.resolve(__dirname, `../supabase/${name}`), 'utf8');
const migration = read('admin_token_revocation_audit.sql');
const preflight = read('admin_token_revocation_audit_preflight.sql');
const postflight = read('admin_token_revocation_audit_postflight.sql');
const runbook = read('ADMIN_TOKEN_REVOCATION_AUDIT_RUNBOOK.md');
const signature = /public\.revoke_agent_token_with_audit\s*\(\s*(?:p_token_id\s+)?bigint\s*,\s*(?:p_actor_token_id\s+)?bigint\s*,\s*(?:p_request_id\s+)?text\s*\)/i;

test('token revocation preflight validates deployed tables, columns, owner, and exact overload set read-only', () => {
  assert.match(preflight, /Read-only preflight/i);
  assert.match(preflight, /public\.dashboard_tokens/);
  assert.match(preflight, /public\.audit_log/);
  for (const column of ['id', 'name', 'role', 'active', 'token_hash', 'actor_name', 'actor_role', 'action', 'target_id', 'metadata', 'created_at']) {
    assert.match(preflight, new RegExp(`'${column}'`));
  }
  assert.match(preflight, /postgres.*supabase_admin|supabase_admin.*postgres/s);
  assert.match(preflight, /revoke_agent_token_with_audit/);
  assert.match(preflight, /unexpected_overloads/);
  assert.doesNotMatch(preflight, /\b(insert|update|delete|alter|create|drop|grant|revoke)\b/i);
});

test('nullable deployed role and active remain type-checked and classify null deterministically without table mutation', () => {
  assert.match(preflight, /\('dashboard_tokens','role','text',true\)/);
  assert.match(preflight, /\('dashboard_tokens','active','boolean',true\)/);
  for (const required of [
    "('dashboard_tokens','id','bigint',false)",
    "('dashboard_tokens','token_hash','text',false)",
    "('dashboard_tokens','name','text',false)",
  ]) assert.ok(preflight.includes(required));
  assert.match(migration, /v_role\s+is\s+distinct\s+from\s+'agent'/i);
  assert.match(migration, /v_active\s+is\s+not\s+true/i);
  assert.match(migration, /t\.role\s*=\s*'admin'\s+and\s+t\.active\s+is\s+true/i);
  assert.doesNotMatch(preflight, /\balter\s+table\b/i);
  assert.doesNotMatch(migration, /\balter\s+table\b/i);
});

test('migration installs one exact transactional definer RPC with deterministic locked classification', () => {
  assert.match(migration, /^begin;/im);
  assert.match(migration, /commit;\s*$/i);
  assert.match(migration, signature);
  assert.match(migration, /returns jsonb/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = pg_catalog, public/i);
  assert.match(migration, /from public\.dashboard_tokens[\s\S]*for update/i);
  for (const outcome of ['revoked', 'already_revoked', 'not_found', 'wrong_role']) assert.match(migration, new RegExp(`'outcome',\s*'${outcome}'`));
  assert.match(migration, /update public\.dashboard_tokens[\s\S]*set active\s*=\s*false/i);
  assert.equal((migration.match(/insert into public\.audit_log/gi) || []).length, 1);
  assert.match(migration, /'agent_token\.revoked'/);
  assert.match(migration, /jsonb_build_object\(\s*'name'.*'role'.*'actor_token_id'.*'request_id'/s);
  assert.doesNotMatch(migration, /token_hash|raw_token|nexo_tkn_/i);
});

test('migration validates trusted actor and request inputs and grants only service_role execution', () => {
  assert.match(migration, /p_token_id\s*<=\s*0/);
  assert.match(migration, /p_actor_token_id\s*<=\s*0/);
  assert.match(migration, /p_request_id\s*!~\s*'\^\[A-Za-z0-9_-/);
  assert.match(migration, /role\s*=\s*'admin'[\s\S]*active/i);
  assert.match(migration, /errcode\s*=\s*'22023'/i);
  assert.match(migration, /errcode\s*=\s*'42501'/i);
  assert.match(migration, /alter function[\s\S]*owner to/i);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/i);
});

test('postflight proves exact signature, return, owner, path, definer bit, and effective ACL', () => {
  assert.match(postflight, /Read-only postflight/i);
  assert.match(postflight, /revoke_agent_token_with_audit\(bigint,bigint,text\)/);
  for (const check of ['exact_signature', 'returns_jsonb', 'security_definer', 'approved_owner', 'fixed_search_path', 'service_role_execute', 'browser_public_denial', 'unexpected_effective_grantees']) {
    assert.match(postflight, new RegExp(`'${check}'`));
  }
  assert.doesNotMatch(postflight, /\b(insert|update|delete|alter|create|drop|grant|revoke)\b/i);
});

test('operator runbook keeps remote proofs manual and documents safe enablement and exact rollback', () => {
  for (const step of ['preflight', 'service-role', 'apply twice', 'concurrency', 'induced audit failure', 'postflight', 'enablement', 'rollback']) {
    assert.match(runbook, new RegExp(step, 'i'));
  }
  assert.match(runbook, /operator evidence.*pending/i);
  assert.match(runbook, /drop function if exists public\.revoke_agent_token_with_audit\(bigint, bigint, text\)/i);
  assert.doesNotMatch(runbook, /proof.*passed remotely/i);
});

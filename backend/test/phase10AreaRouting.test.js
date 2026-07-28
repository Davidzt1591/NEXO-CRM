const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decideFlowTransition } = require('../src/services/botFlowTransitions');
const { analystCanAccessTicket, analystCanSeeQueueCard, toMinimalQueueCard } = require('../src/realtime/operational');

test('operational category choices preserve stable keys and Other exits without capture', () => {
  const session = { paso: 'issue_category' };
  const expected = [['1','platform'],['2','tests'],['3','requests'],['4','integrations']];
  for (const [input, key] of expected) {
    const transition = decideFlowTransition(session, input);
    assert.equal(transition.type, 'category');
    assert.equal(transition.categoryKey, key);
  }
  const other = decideFlowTransition(session, '5');
  assert.deepEqual({ type: other.type, key: other.messageKey, reason: other.reason }, { type: 'end', key: 'other_email_exit', reason: 'other_email_exit' });
});

test('unassigned same-area queue cards contain no PII and history remains assignee/admin-only', () => {
  const analyst = { id: 7, area_id: 2 };
  const ticket = { id: 9, area_id: 2, telefono: 'secret', correo: 'secret@example.com', nombre_analista: 'Secret', situacion: 'Secret issue', assignment: null };
  assert.equal(analystCanAccessTicket(analyst, ticket), false);
  assert.equal(analystCanSeeQueueCard(analyst, ticket), true);
  const card = toMinimalQueueCard(ticket);
  for (const key of ['telefono','phone','correo','email','nombre','nombre_analista','nombre_empresa','company','situacion','issue','message','messages','media','chat_id']) assert.equal(Object.hasOwn(card, key), false);
  assert.equal(analystCanSeeQueueCard({ id: 8, area_id: 3 }, ticket), false);
  assert.equal(analystCanAccessTicket(analyst, { ...ticket, assignment: { analyst_id: 7 } }), true);
  assert.equal(analystCanAccessTicket({ id: 7, area_id: 3 }, { ...ticket, assignment: { analyst_id: 7 } }), false);
});

test('phase 10 SQL contract is atomic, fair, token-aware and concurrency-safe', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.category_area_mappings/i);
  assert.match(sql, /join public\.dashboard_tokens dt on dt\.id=a\.token_id and dt\.active/i);
  assert.match(sql, /order by \(select count\(\*\)/i);
  assert.match(sql, /for update of a skip locked limit 1/i);
  assert.match(sql, /on conflict\(ticket_id\) do nothing/i);
  assert.match(sql, /exception when unique_violation/i);
  assert.match(sql, /where bot_submission_id::text=p_submission_id::text/i);
  assert.match(sql, /v_area_id,p_submission_id::text\)/i);
  assert.match(sql, /'bot_submission_id',v_ticket\.bot_submission_id::text/i);
  assert.match(sql, /create or replace function public\.admin_route_ticket/i);
  assert.match(sql, /create or replace function public\.switch_analyst_area/i);
  assert.match(sql, /insert into public\.audit_log/i);
  assert.match(sql, /v_previous_area_id := v_ticket\.area_id;[\s\S]*return to_jsonb\(v_ticket\) \|\| jsonb_build_object\('previous_area_id',v_previous_area_id\)/i);
  assert.match(sql, /area_revision=area_revision\+1/i);
  assert.match(sql, /update public\.ticket_assignments ta set analyst_id=null[\s\S]*assigned_by='area_switch'/i);
  assert.match(sql, /revoke all on function public\.admin_route_ticket[\s\S]*grant execute on function public\.admin_route_ticket[\s\S]*to service_role/i);
  assert.match(sql, /revoke all on table public\.areas, public\.analysts, public\.ticket_assignments,[\s\S]*public\.category_area_mappings, public\.tickets from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant select, insert, update on table public\.areas, public\.analysts,[\s\S]*public\.category_area_mappings to service_role/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.tickets to service_role/i);
  assert.match(sql, /grant usage, select on sequence/i);
  assert.match(sql, /alter function %s set search_path = pg_catalog, public/i);
  assert.doesNotMatch(sql, /grant .* to (anon|authenticated)/i);
});

test('phase 10 area bootstrap matches the current one-row production baseline', () => {
  const preflight = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing_preflight.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing_postflight.sql'), 'utf8');

  for (const artifact of [preflight, migration]) {
    assert.match(artifact, /regexp_replace\(trim\(name\), '\\s\+', ' ', 'g'\)/i);
    assert.match(artifact, /'integraciones','soporte integraciones'/i);
    assert.doesNotMatch(artifact, /magneto support|\blike\b/i);
  }
  assert.match(preflight, /reuse active Soporte Integraciones; create active Soporte Magneto using schema defaults/i);
  assert.match(preflight, /a\.attnotnull[\s\S]*a\.attidentity = ''[\s\S]*a\.attgenerated = ''[\s\S]*d\.adbin is null/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /insert into public\.areas\(name, active\) values \('Soporte Magneto', true\)[\s\S]*on conflict \(name\) do nothing/i);
  assert.match(migration, /v_support_all <> 1 or v_support_active <> 1/i);
  assert.match(migration, /on conflict\(category_key\) do update set area_id=excluded\.area_id, active=true/i);
  assert.match(migration, /alter table public\.areas enable row level security/i);
  assert.match(migration, /revoke all on table public\.areas/i);
  assert.match(postflight, /canonical_areas/i);
  assert.match(postflight, /canonical_category_mappings/i);
});

test('phase 10 ACL fix and postflight enforce exact backend-only routing access', () => {
  const fix = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing_acl_fix.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing_postflight.sql'), 'utf8');
  assert.match(fix, /^--[\s\S]*begin;[\s\S]*commit;\s*$/i);
  assert.match(fix, /revoke all on table public\.areas, public\.analysts, public\.ticket_assignments,[\s\S]*public\.tickets from public, anon, authenticated, service_role/i);
  assert.match(fix, /r\.rolname not in \('service_role','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user'\)/i);
  assert.match(fix, /grant usage, select on sequence/i);
  assert.doesNotMatch(fix, /force row level security/i);
  assert.doesNotMatch(postflight, /begin\s+(?:transaction\s+)?read\s+only/i);
  assert.equal((postflight.match(/select check_name,case when ok then 'PASS' else 'FAIL' end status/gi) || []).length, 1);
  for (const check of ['browser_public_table_denial','browser_public_sequence_denial','service_role_exact_table_acl','service_role_exact_sequence_acl','rpc_signature_security_path_owner','service_role_exact_rpc_execute','unexpected_effective_relation_grantees','tickets_browser_denial_intact']) assert.match(postflight, new RegExp(check, 'i'));
  assert.doesNotMatch(postflight, /select\s+c\.relrowsecurity\s*,[\s\S]*c\.relacl/i);
});

test('phase 10 postflight is one pure read-only statement with one terminal select', () => {
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing_postflight.sql'), 'utf8');
  const executable = postflight.replace(/--.*$/gm, '').trim();
  const executableTokens = executable.replace(/E?'(?:\\.|''|[^'])*'/gis, "''");
  assert.match(executable, /^with\b/i);
  assert.match(executable, /,\s*checks\s+as\s*\([\s\S]*\)\s*select\s+check_name\s*,\s*status\s*,\s*detail\s+from\s+checks\s+order\s+by\s+check_name\s*;$/i);
  assert.equal((executable.match(/;/g) || []).length, 1);
  assert.doesNotMatch(executableTokens, /\b(?:create|insert|update|delete|do|begin|commit|rollback|temp(?:orary)?)\b/i);
  assert.doesNotMatch(executableTokens, /\bset\s+(?:local|session)\b|\bpg_temp\b/i);
});

test('phase 10 postflight resolves absent objects without aborting and emits every check once', () => {
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing_postflight.sql'), 'utf8');
  const expectedChecks = [
    'canonical_areas','canonical_category_mappings','relation_object_types','routing_tables_rls_enabled',
    'browser_public_table_denial','browser_public_sequence_denial','service_role_exact_table_acl',
    'service_role_exact_sequence_acl','unexpected_effective_relation_grantees','rpc_signature_security_path_owner',
    'rpc_signature_set_exact','service_role_exact_rpc_execute','browser_public_rpc_denial',
    'unexpected_effective_rpc_grantees','mapping_index_valid','mapping_trigger_definition_and_state',
    'mapping_constraints','tickets_browser_denial_intact'
  ];

  assert.doesNotMatch(postflight, /::\s*reg(?:class|procedure)\b/i);
  assert.doesNotMatch(postflight, /has_function_privilege\s*\([^,]+,\s*['"]public\./i);
  assert.match(postflight, /to_regclass\s*\(/i);
  assert.match(postflight, /to_regprocedure\s*\(/i);
  assert.match(postflight, /from public\.areas/i);
  assert.match(postflight, /from public\.category_area_mappings/i);
  assert.match(postflight, /resolved_tables e left join pg_class c on c\.oid=e\.oid/i);
  assert.match(postflight, /resolved_functions e left join pg_proc p on p\.oid=e\.oid/i);
  assert.match(postflight, /where c\.oid is null or/i);
  assert.match(postflight, /where p\.oid is null or/i);
  for (const check of expectedChecks) {
    assert.match(postflight, new RegExp(`['"]${check}['"]`, 'i'));
  }
  assert.match(postflight, /from checks order by check_name;\s*$/i);
});

test('frontend has no direct Supabase client or dependency', () => {
  const frontendRoot = path.join(__dirname, '../../frontend');
  assert.doesNotMatch(fs.readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'), /@supabase\/supabase-js/i);
  const files = fs.readdirSync(path.join(frontendRoot, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[jt]sx?$/.test(entry.name));
  for (const entry of files) {
    const source = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
    assert.doesNotMatch(source, /@supabase\/supabase-js|createClient\s*\([^)]*supabase/i, entry.name);
  }
});

test('phase 10 area bootstrap rejects duplicate and inactive aliases and documents rerun convergence', () => {
  const preflight = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing_preflight.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/phase10_area_routing.sql'), 'utf8');
  assert.match(preflight, /v_integrations_all <> 1 or v_integrations_active <> 1/i);
  assert.match(preflight, /v_magneto_all > 1 or \(v_magneto_all = 1 and v_magneto_active <> 1\)/i);
  assert.match(migration, /missing, inactive, or duplicated; rerun preflight/i);
  assert.match(migration, /inactive or duplicated; rerun preflight/i);
  assert.match(migration, /select count\(\*\), count\(\*\) filter \(where active\), min\(id\) filter \(where active\)[\s\S]*did not converge to exactly one active area/i);
});

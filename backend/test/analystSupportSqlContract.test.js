const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FALLBACK_MESSAGES } = require('../src/services/botFlowMessages');

const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/phase9_analyst_support_conversation.sql'), 'utf8');
const preflight = fs.readFileSync(path.resolve(__dirname, '../supabase/phase9_preflight.sql'), 'utf8');
const postflight = fs.readFileSync(path.resolve(__dirname, '../supabase/phase9_postflight.sql'), 'utf8');
const runbook = fs.readFileSync(path.resolve(__dirname, '../supabase/PHASE9_MANUAL_RUNBOOK.md'), 'utf8');
const semanticKeys = [
  'out_of_office', 'welcome_audience', 'legacy_migration_audience', 'audience_invalid', 'candidate_exit', 'ask_category', 'category_invalid',
  'data_notice_and_ask_name', 'ask_company', 'ask_email', 'ask_issue', 'confirm_summary', 'confirm_invalid',
  'restart_data', 'processing', 'confirmation', 'ticket_error',
];

test('phase9 is manual, idempotent and adds category to sessions and tickets', () => {
  assert.match(sql, /Execute manually/);
  assert.match(sql, /ALTER TABLE public\.bot_sessions ADD COLUMN IF NOT EXISTS categoria TEXT/);
  assert.match(sql, /ALTER TABLE public\.tickets ADD COLUMN IF NOT EXISTS categoria TEXT/);
  assert.match(sql, /ALTER TABLE public\.bot_sessions ADD COLUMN IF NOT EXISTS submission_id TEXT/);
  assert.match(sql, /ALTER TABLE public\.tickets ADD COLUMN IF NOT EXISTS bot_submission_id TEXT/);
  assert.match(sql, /ALTER TABLE public\.tickets ADD COLUMN IF NOT EXISTS chat_id TEXT/);
  assert.doesNotMatch(sql, /phase9_ticket_chat_id_backfill/);
  assert.doesNotMatch(sql, /CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE/i);
  const legacyBackfill = sql.match(/DO \$tickets_chat_id_legacy_backfill\$([\s\S]*?)\$tickets_chat_id_legacy_backfill\$;/)?.[1] || '';
  assert.match(legacyBackfill, /IF EXISTS \(SELECT 1 FROM public\.tickets WHERE chat_id IS NULL\) THEN/);
  assert.match(legacyBackfill, /EXECUTE \$legacy_validation\$[\s\S]*telefono IS NULL[\s\S]*telefono::text !~ '\^\[1-9\]\[0-9\]\{5,31\}@\(c\[\.\]us\|lid\)\$'[\s\S]*char_length\(telefono::text\) NOT BETWEEN 12 AND 64[\s\S]*\$legacy_validation\$ INTO unsafe_legacy_values/);
  assert.match(legacyBackfill, /IF unsafe_legacy_values THEN[\s\S]*RAISE EXCEPTION[\s\S]*END IF;[\s\S]*EXECUTE \$legacy_update\$/);
  assert.match(legacyBackfill, /EXECUTE \$legacy_update\$[\s\S]*UPDATE public\.tickets[\s\S]*SET chat_id = telefono::text[\s\S]*WHERE chat_id IS NULL[\s\S]*\$legacy_update\$/);
  const withoutDynamicLegacySql = sql
    .replace(/\$legacy_validation\$[\s\S]*?\$legacy_validation\$/g, '')
    .replace(/\$legacy_update\$[\s\S]*?\$legacy_update\$/g, '');
  assert.doesNotMatch(withoutDynamicLegacySql, /\btelefono(?:::text)?\b(?=\s*(?:IS|!~|=))/);
  assert.match(sql, /DO \$tickets_chat_id_validation\$[\s\S]*WHERE chat_id IS NULL[\s\S]*char_length\(chat_id\) NOT BETWEEN 12 AND 64[\s\S]*chat_id !~ '\^\[1-9\]\[0-9\]\{5,31\}@\(c\[\.\]us\|lid\)\$'/);
  assert.doesNotMatch(sql, /chat_id IS DISTINCT FROM telefono::text/);
  assert.match(sql, /ADD CONSTRAINT tickets_chat_id_whatsapp_check/);
  assert.match(sql, /ALTER COLUMN chat_id SET NOT NULL/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS bot_sessions_submission_id_check[\s\S]*VALIDATE CONSTRAINT bot_sessions_submission_id_check/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS tickets_bot_submission_id_check[\s\S]*VALIDATE CONSTRAINT tickets_bot_submission_id_check/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS tickets_bot_submission_id_uidx\s+ON public\.tickets \(bot_submission_id\) WHERE bot_submission_id IS NOT NULL/);
  assert.match(sql, /ON CONFLICT[\s\S]*DO UPDATE SET message = EXCLUDED\.message/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.bot_sessions TO service_role/);
  assert.match(sql, /categoria IN \('Platform', 'Tests', 'Integrations', 'Other'\)/);
});

test('phase9 upserts the complete v2 fallback catalog with exact non-stale copy', () => {
  for (const key of semanticKeys) {
    assert.match(sql, new RegExp(`'${key}'`));
    const encoded = FALLBACK_MESSAGES[key].replaceAll("'", "''").replaceAll('\n', '\\n');
    assert.ok(sql.includes(encoded), `SQL copy differs for ${key}`);
  }
  assert.equal((sql.match(/\(2, NULL, '/g) || []).length, semanticKeys.length + 1); // Other is an explicit terminal outside the legacy semantic path list.
});

test('phase9 persists candidate blocking and service-only bounded settings idempotently', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.contact_classifications/);
  assert.match(sql, /chat_id TEXT PRIMARY KEY/);
  assert.match(sql, /classification = 'candidate'/);
  assert.match(sql, /source IN \('auto', 'manual'\)/);
  assert.match(sql, /char_length\(note\) <= 500/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.contact_classifications FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.contact_classifications TO service_role/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.app_settings/);
  assert.match(sql, /key IN \('candidate_form_url', 'candidate_guidance_message'\)/);
  assert.match(sql, /ON CONFLICT \(key\) DO NOTHING/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS guidance_claimed_at TIMESTAMPTZ/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS guidance_claim_token UUID/);
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.claim_candidate_guidance\(TEXT\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_candidate_guidance\(p_chat_id TEXT, p_token UUID\)/);
  assert.match(sql, /last_guidance_at <= now\(\) - interval '24 hours'/);
  assert.match(sql, /guidance_claimed_at <= now\(\) - interval '24 hours'/);
  assert.match(sql, /at-most-once bias/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.finalize_candidate_guidance/);
  assert.match(sql, /SET last_guidance_at = now\(\), guidance_claimed_at = NULL, guidance_claim_token = NULL/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.release_candidate_guidance/);
  assert.match(sql, /WHERE chat_id = p_chat_id AND guidance_claim_token = p_token/g);
  for (const fn of ['claim_candidate_guidance', 'finalize_candidate_guidance', 'release_candidate_guidance']) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(TEXT, UUID\\) FROM PUBLIC, anon, authenticated, service_role`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(TEXT, UUID\\) TO service_role`));
  }
});

test('phase9 documents manual reapply and concurrent guidance claim validation', () => {
  assert.match(sql, /Manual validation checklist/);
  assert.match(sql, /reapply this entire file/i);
  assert.match(sql, /concurrent transactions/i);
  assert.match(sql, /exactly one claim/i);
});

test('phase9 atomically initializes and leases privacy-minimized ticket post-processing', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.ticket_post_processing/);
  assert.match(sql, /ticket_id BIGINT PRIMARY KEY REFERENCES public\.tickets\(id\)/);
  assert.match(sql, /submission_id UUID NOT NULL UNIQUE/);
  assert.doesNotMatch(sql, /ticket_post_processing[\s\S]{0,800}(nombre|correo|situacion|telefono)/i);
  assert.match(sql, /CREATE TRIGGER tickets_initialize_post_processing AFTER INSERT ON public\.tickets/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  for (const effect of ['salesforce_outbox', 'operational_emit', 'session_cleanup']) {
    assert.match(sql, new RegExp(`${effect}_claimed_by UUID`));
    assert.match(sql, new RegExp(`${effect}_claimed_at TIMESTAMPTZ`));
    assert.match(sql, new RegExp(`${effect}_status IN \\('pending','failed','processing'\\)[\\s\\S]{0,160}${effect}_claimed_at`));
  }
  assert.match(sql, /whatsapp_ack_attempts BETWEEN 0 AND 1/);
  assert.match(sql, /operational_emit_status IN \('pending', 'processing', 'completed', 'failed', 'uncertain'\)/);
  assert.match(sql, /SET operational_emit_status = 'uncertain'[\s\S]{0,240}operational_emit_claimed_by = p_worker_id/);
  assert.match(sql, /WHEN 'salesforce_outbox' THEN salesforce_outbox_claimed_by = p_worker_id[\s\S]*WHEN 'operational_emit' THEN operational_emit_claimed_by = p_worker_id[\s\S]*WHEN 'session_cleanup' THEN session_cleanup_claimed_by = p_worker_id/);
  assert.match(sql, /operational_emit_status IN \('pending','failed','processing'\)/);
  assert.doesNotMatch(sql, /operational_emit_status IN \([^)]*uncertain[^)]*\)[\s\S]{0,180}operational_emit_claimed_by = CASE/);
  assert.match(sql, /WHERE ticket_id = p_ticket_id AND whatsapp_ack_attempts = 0 AND p_claim_token IS NOT NULL/);
  assert.match(sql, /SET whatsapp_ack_attempts = 1,[\s\S]{0,180}whatsapp_ack_status = 'uncertain'[\s\S]{0,180}whatsapp_ack_claim_token = p_claim_token/);
  assert.match(sql, /SET whatsapp_ack_status = 'completed'[\s\S]{0,240}whatsapp_ack_claim_token = p_claim_token/);
  for (const signature of [
    'ensure_ticket_post_processing\\(BIGINT\\)',
    'claim_ticket_post_processing\\(UUID\\)',
    'finalize_ticket_post_processing_effect\\(BIGINT, UUID, TEXT, BOOLEAN, TEXT\\)',
    'mark_ticket_post_processing_attempt_started\\(BIGINT, UUID, TEXT\\)',
    'claim_ticket_whatsapp_ack\\(BIGINT, UUID\\)',
    'finalize_ticket_whatsapp_ack\\(BIGINT, UUID\\)',
  ]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM PUBLIC, anon, authenticated, service_role`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO service_role`));
  }
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.claim_ticket_post_processing\(UUID, INTEGER\)/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED LIMIT 1/);
  assert.doesNotMatch(sql, /GRANT (?:ALL|SELECT|INSERT|UPDATE|DELETE|EXECUTE)[^;]+ TO (?:PUBLIC|anon|authenticated)/i);
  assert.equal((sql.match(/SECURITY DEFINER SET search_path = pg_catalog, public/g) || []).length >= 8, true);
  assert.match(sql, /contract tests cannot prove transaction locking, lease expiry, or concurrency/i);
});

test('phase9 applies atomically with bounded waits and hardens Phase8 browser exposure', () => {
  assert.match(sql, /BEGIN;[\s\S]*SET LOCAL lock_timeout = '5s'/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s'/);
  assert.match(sql, /SET LOCAL idle_in_transaction_session_timeout = '60s'/);
  assert.match(sql, /SET LOCAL search_path = public, pg_catalog/);
  assert.doesNotMatch(sql, /SET LOCAL search_path = pg_catalog, public/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.bot_flow_studio_layouts FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.put_bot_flow_studio_layout\(INTEGER, BIGINT, JSONB, INTEGER, TEXT\) FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, /ALTER FUNCTION public\.put_bot_flow_studio_layout[\s\S]*SET search_path = pg_catalog, public/);
});

test('phase9 separates the safe DDL session path from hardened function paths', () => {
  assert.equal((sql.match(/^SET LOCAL search_path = public, pg_catalog;$/gm) || []).length, 1);
  assert.doesNotMatch(sql, /^SET LOCAL search_path = pg_catalog, public;$/m);

  const definerCount = (sql.match(/SECURITY DEFINER SET search_path = pg_catalog, public/g) || []).length;
  assert.ok(definerCount >= 8);
  assert.doesNotMatch(sql, /SECURITY DEFINER SET search_path = public, pg_catalog/);
});

test('phase9 rejects unqualified public DDL and creates no temporary helper relation', () => {
  const publicDdlPatterns = [
    /^CREATE TABLE IF NOT EXISTS public\./,
    /^ALTER TABLE public\./,
    /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [a-z_][a-z0-9_]*$/,
    /^CREATE OR REPLACE FUNCTION public\./,
    /^DROP FUNCTION IF EXISTS public\./,
    /^DROP TRIGGER IF EXISTS \w+ ON public\./,
    /^CREATE TRIGGER \w+ .* ON public\./,
    /^(?:REVOKE|GRANT) .* ON (?:TABLE|SEQUENCE|FUNCTION) public\./,
  ];
  const ddlPrefixes = [
    'CREATE TABLE IF NOT EXISTS ', 'ALTER TABLE ', 'CREATE INDEX IF NOT EXISTS ',
    'CREATE UNIQUE INDEX IF NOT EXISTS ', 'CREATE OR REPLACE FUNCTION ',
    'DROP FUNCTION IF EXISTS ', 'DROP TRIGGER IF EXISTS ', 'CREATE TRIGGER ',
  ];

  for (const line of sql.split('\n').map((value) => value.trim())) {
    if (!line || line.startsWith('--')) continue;
    if (ddlPrefixes.some((prefix) => line.startsWith(prefix)) || /^(?:REVOKE|GRANT) .* ON (?:TABLE|SEQUENCE|FUNCTION) /.test(line)) {
      assert.ok(publicDdlPatterns.some((pattern) => pattern.test(line)), `unqualified public DDL: ${line}`);
    }
  }

  const indexDeclarations = [...sql.matchAll(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([^\s]+)\s+ON ([^\s(]+)/gm)];
  assert.equal(indexDeclarations.length, 3);
  assert.deepEqual(indexDeclarations.map((match) => match[1]), [
    'contact_classifications_blocked_idx',
    'tickets_bot_submission_id_uidx',
    'bot_flows_effective_identity_uidx',
  ]);
  assert.ok(indexDeclarations.every((match) => !match[1].includes('.')), 'PostgreSQL index names must not be schema-qualified');
  assert.deepEqual(indexDeclarations.map((match) => match[2]), [
    'public.contact_classifications',
    'public.tickets',
    'public.bot_flows',
  ]);
  assert.doesNotMatch(sql, /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS public\./m);
  assert.doesNotMatch(sql, /phase9_ticket_chat_id_backfill/);
  assert.doesNotMatch(sql, /\bpg_temp\b|CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE/i);
  assert.match(sql, /ON public\.contact_classifications/);
  assert.match(sql, /ON public\.tickets \(bot_submission_id\)/);
  assert.match(sql, /ON public\.bot_flows/);
  assert.match(sql, /EXECUTE FUNCTION public\.initialize_ticket_post_processing\(\)/);
});

test('phase9 preflight is read-only, privacy-safe, and covers production blockers', () => {
  assert.match(preflight, /BEGIN READ ONLY/);
  assert.match(preflight, /ROLLBACK;\s*$/);
  assert.doesNotMatch(preflight, /phase9_ticket_chat_id_backfill|\bpg_temp\b/i);
  assert.doesNotMatch(preflight, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL)\b/im);
  for (const check of [
    'base_tables_and_columns', 'tickets_chat_id_migration', 'invalid_existing_submission_ids',
    'duplicate_ticket_submission_ids', 'unsupported_ticket_categories',
    'duplicate_effective_bot_flow_identities', 'incompatible_phase9_columns',
    'partial_phase9_tables', 'incompatible_phase9_table_columns',
    'incompatible_phase9_constraints', 'incompatible_phase9_indexes',
    'incompatible_phase9_function_overloads', 'incompatible_canonical_function_contracts',
    'repairable_canonical_function_search_paths',
    'public_schema_create_denied', 'relation_lock_holders',
  ]) assert.ok(preflight.includes(`'${check}'`), `missing preflight check ${check}`);
  assert.match(preflight, /no values exposed/);
  assert.match(preflight, /pg_locks l JOIN pg_class c/);
  assert.doesNotMatch(preflight, /COALESCE\(a\.query|pg_stat_activity/);
  assert.match(preflight, /is_nullable=expected\.is_nullable/);
  assert.match(preflight, /column_default ILIKE/);
  assert.match(preflight, /pg_get_constraintdef/);
  assert.match(preflight, /c\.convalidated/);
  assert.match(preflight, /i\.indisvalid AND i\.indisready/);
  assert.match(preflight, /pg_get_function_result/);
  assert.match(preflight, /p\.prosecdef<>e\.must_be_definer/);
  assert.match(preflight, /existing canonical function search paths will be normalized by migration/);
  assert.doesNotMatch(preflight, /WHERE pg_get_function_result[\s\S]{0,300}proconfig/);
  assert.match(preflight, /p\.proowner IS DISTINCT FROM \(SELECT oid FROM approved_owner\)/);
  assert.match(preflight, /CASE WHEN[\s\S]*'PASS'[\s\S]*'FAIL'/);
  assert.match(preflight, /WHERE to_jsonb\(t\)->>'chat_id' IS NULL[\s\S]{0,300}to_jsonb\(t\)->>'telefono'/);
  assert.doesNotMatch(preflight, /chat_id[^\n]*IS DISTINCT FROM[^\n]*telefono/i);
});

test('phase9 postflight is read-only and verifies structural and effective ACL contracts', () => {
  assert.match(postflight, /BEGIN READ ONLY/);
  assert.match(postflight, /ROLLBACK;\s*$/);
  assert.doesNotMatch(postflight, /phase9_ticket_chat_id_backfill|\bpg_temp\b/i);
  assert.doesNotMatch(postflight, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL)\b/im);
  for (const check of [
    'relation_object_types', 'complete_column_contract', 'tickets_chat_id_data', 'constraint_contract', 'valid_index_contract',
     'trigger_definition_and_state', 'function_identity_return_security_path_owner', 'rls_enabled',
     'public_schema_create_denied', 'service_role_exact_table_sequence_acl',
     'public_anon_authenticated_relation_denial', 'public_anon_authenticated_sequence_denial',
     'unexpected_effective_relation_grantees', 'service_role_function_execute',
    'public_anon_authenticated_function_denial', 'unexpected_effective_function_grantees',
  ]) assert.ok(postflight.includes(`'${check}'`), `missing postflight check ${check}`);
  assert.match(postflight, /has_table_privilege/);
  assert.match(postflight, /has_function_privilege/);
  assert.match(postflight, /has_sequence_privilege/);
  assert.match(postflight, /r\.rolname NOT IN \('service_role','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user'\)/);
  assert.match(postflight, /has_table_privilege\('anon',c\.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'\)/);
  assert.match(postflight, /has_table_privilege\('authenticated',c\.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'\)/);
  assert.match(postflight, /has_sequence_privilege\('anon',c\.oid,'USAGE,SELECT,UPDATE'\)/);
  assert.match(postflight, /has_sequence_privilege\('authenticated',c\.oid,'USAGE,SELECT,UPDATE'\)/);
  assert.match(postflight, /a\.grantee=0 AND a\.privilege_type IN \('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'\)/);
  assert.match(postflight, /a\.grantee=0 AND a\.privilege_type IN \('USAGE','SELECT','UPDATE'\)/);
  assert.match(postflight, /aclexplode/);
  assert.match(postflight, /pg_get_function_result/);
  assert.match(postflight, /p\.prosecdef=e\.must_be_definer/);
  assert.match(postflight, /p\.proowner=/);
  assert.match(postflight, /p\.proconfig=ARRAY\['search_path=pg_catalog, public'\]/);
  assert.match(postflight, /'tickets','chat_id','text','NO',NULL/);
  assert.match(postflight, /tickets_chat_id_whatsapp_check/);
  assert.match(postflight, /char_length\(chat_id\) NOT BETWEEN 12 AND 64/);
  assert.doesNotMatch(postflight, /chat_id[^\n]*IS DISTINCT FROM[^\n]*telefono/i);
  assert.match(postflight, /pg_get_triggerdef/);
  assert.match(postflight, /t\.tgenabled='O'/);
  assert.doesNotMatch(postflight, /SELECT\s+public\.[a-z_]+\s*\(/i);
});

test('phase9 normalizes every canonical function contract to an existing platform owner', () => {
  const canonicalSignatures = [
    'put_bot_flow_studio_layout(integer,bigint,jsonb,integer,text)',
    'claim_candidate_guidance(text,uuid)', 'finalize_candidate_guidance(text,uuid)',
    'release_candidate_guidance(text,uuid)', 'initialize_ticket_post_processing()',
    'ensure_ticket_post_processing(bigint)', 'claim_ticket_post_processing(uuid)',
    'finalize_ticket_post_processing_effect(bigint,uuid,text,boolean,text)',
    'mark_ticket_post_processing_attempt_started(bigint,uuid,text)',
    'claim_ticket_whatsapp_ack(bigint,uuid)', 'finalize_ticket_whatsapp_ack(bigint,uuid)',
  ];
  for (const signature of canonicalSignatures) assert.ok(sql.includes(`public.${signature}`));
  for (const catalogSql of [preflight, postflight]) {
    assert.match(catalogSql, /rolname IN \('postgres','supabase_admin'\)/);
    assert.match(catalogSql, /WHEN 'postgres' THEN 1 ELSE 2/);
  }
  assert.match(sql, /ALTER FUNCTION %s OWNER TO %I/);
  assert.match(sql, /ALTER FUNCTION %s SET search_path = pg_catalog, public/);
  assert.match(sql, /CASE WHEN item\.must_be_definer THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END/);
  assert.match(sql, /put_bot_flow_studio_layout\(INTEGER, BIGINT, JSONB, INTEGER, TEXT\)[\s\S]*SECURITY INVOKER/);
});

test('phase9 runbook gives exact order and honest fix-forward boundaries', () => {
  const preflightAt = runbook.indexOf('phase9_preflight.sql');
  const migrationAt = runbook.indexOf('phase9_analyst_support_conversation.sql');
  const postflightAt = runbook.indexOf('phase9_postflight.sql');
  assert.ok(preflightAt > 0 && preflightAt < migrationAt && migrationAt < postflightAt);
  assert.match(runbook, /no general safe rollback/i);
  assert.match(runbook, /fix-forward/i);
  assert.match(runbook, /frontend must use NEXO backend routes/i);
  assert.match(runbook, /must never use a Supabase URL\/key/i);
  assert.match(runbook, /behavioral concurrency proof remains pending/i);
  assert.match(runbook, /updates only null values from `telefono::text`/i);
  assert.match(runbook, /No temporary helper relation/i);
  assert.match(runbook, /does not compare `chat_id` with `telefono`/i);
  assert.match(runbook, /Prior failed attempts occurred inside this transaction/i);
  assert.match(runbook, /rerun `phase9_preflight\.sql`/i);
  assert.match(runbook, /partial_phase9_tables/);
  assert.match(runbook, /No remote probe is performed/i);
  assert.match(runbook, /pg_read_all_data/);
  assert.match(runbook, /pg_write_all_data/);
  assert.match(runbook, /supabase_etl_admin/);
  assert.match(runbook, /supabase_read_only_user/);
  assert.match(runbook, /not browser JWT roles/i);
  assert.match(runbook, /include inherited access/i);
});

test('phase9 removes arbitrary ACL grantees and hardens the public schema', () => {
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /aclexplode\(COALESCE\(c\.relacl/);
  assert.match(sql, /grantee\.rolname <> 'service_role' AND grantee\.oid <> c\.relowner/);
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM %I/);
  assert.match(sql, /UPDATE public\.contact_classifications/);
  assert.match(sql, /UPDATE public\.ticket_post_processing/);
  assert.match(postflight, /a\.grantee=0 AND a\.privilege_type='CREATE'/);
  assert.match(postflight, /a\.grantee=0 AND a\.privilege_type='EXECUTE'/);
});

test('phase9 handles PUBLIC, inherited schema CREATE, and every protected overload', () => {
  assert.match(sql, /aclexplode\(COALESCE\([\s\S]*schema_public\.nspacl/);
  assert.match(sql, /acl\.grantee = 0/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM %I/);
  for (const catalogSql of [preflight, postflight]) {
    assert.match(catalogSql, /CROSS JOIN pg_namespace n/);
    assert.match(catalogSql, /has_schema_privilege\(r\.oid,n\.oid,'CREATE'\)/);
    assert.match(catalogSql, /r\.oid<>n\.nspowner AND NOT r\.rolsuper/);
    assert.match(catalogSql, /r\.rolname NOT IN \('postgres','supabase_admin'\)/);
    assert.match(catalogSql, /oidvectortypes\(p\.proargtypes\)/);
    assert.match(catalogSql, /p\.proname IN \('put_bot_flow_studio_layout'/);
    assert.match(catalogSql, /'finalize_ticket_whatsapp_ack','bigint, uuid'/);
  }
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM anon, authenticated, service_role/);
  assert.match(sql, /acldefault\('f', item\.proowner\)/);
  assert.match(postflight, /'protected_function_signature_set_exact'/);
  assert.match(postflight, /'all_protected_overloads_exact_acl'/);
});

test('phase9 compares normalized full constraint semantics', () => {
  for (const catalogSql of [preflight, postflight]) {
    assert.match(catalogSql, /regexp_replace\(pg_get_constraintdef\(c\.oid,\s*true\),? '[^']+'/);
    assert.doesNotMatch(catalogSql, /pg_get_constraintdef\(c\.oid,\s*true\) ILIKE/);
    assert.match(catalogSql, /whatsapp_ack_attempts\s*>=\s*0\s*AND\s*whatsapp_ack_attempts\s*<=\s*1/);
    assert.match(catalogSql, /\^\[1-9\]\[0-9\]\{5,31\}@\(c\[\.\]us\|lid\)\$/);
    assert.match(catalogSql, /candidate_form_url[\\',\s]+candidate_guidance_message/);
    assert.match(catalogSql, /pending[\\',\s]+completed[\\',\s]+uncertain/);
  }
});

test('phase9 keeps uncertain effect ownership across cross-effect claims and rejects wrong tokens', () => {
  assert.match(sql, /operational_emit_claimed_by = CASE WHEN operational_emit_status IN \('pending','failed','processing'\)[\s\S]{0,260}THEN p_worker_id ELSE operational_emit_claimed_by END/);
  assert.match(sql, /session_cleanup_claimed_by = CASE WHEN session_cleanup_status IN \('pending','failed','processing'\)[\s\S]{0,260}THEN p_worker_id ELSE session_cleanup_claimed_by END/);
  assert.match(sql, /WHEN 'operational_emit' THEN operational_emit_claimed_by = p_worker_id/);
  assert.match(sql, /p_effect <> 'operational_emit' OR \(p_completed AND operational_emit_status = 'uncertain'\)/);
  assert.match(sql, /operational_emit_status = 'processing'/);

  // The acknowledgement is the representative attempt-once effect: only its
  // independently persisted token can confirm an uncertain delivery.
  assert.match(sql, /whatsapp_ack_status = 'uncertain' AND whatsapp_ack_claim_token = p_claim_token/);
  assert.doesNotMatch(sql, /whatsapp_ack_claim_token\s*=\s*p_worker_id/);
});

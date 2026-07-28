-- NEXO Phase 9 read-only preflight.
-- Run in Supabase SQL Editor before phase9_analyst_support_conversation.sql.
-- PASS means the migration may proceed; any FAIL means stop and investigate.
-- This script returns counts and catalog metadata only; it never returns row data.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = pg_catalog, public;

WITH required(table_name, column_name) AS (VALUES
  ('bot_sessions','chat_id'), ('tickets','id'),
  ('bot_flows','version_id'), ('bot_flows','area_id'), ('bot_flows','step_key'),
  ('bot_flows','message'), ('bot_flows','sort_order'), ('bot_flows','active'),
  ('bot_flows','updated_at'), ('bot_flow_studio_layouts','id')
), missing AS (
  SELECT count(*) AS n FROM required r
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = r.table_name AND c.column_name = r.column_name
  )
)
SELECT 'base_tables_and_columns' AS check_name,
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
       format('%s required columns missing', n) AS detail FROM missing
UNION ALL
SELECT 'tickets_chat_id_migration',
       CASE
         WHEN chat_id_exists AND chat_id_is_text AND invalid_chat_ids = 0
           AND (null_chat_ids = 0 OR telefono_compatible AND unsafe_legacy_values = 0) THEN 'PASS'
         WHEN NOT chat_id_exists AND telefono_compatible AND unsafe_legacy_values = 0 THEN 'PASS'
         ELSE 'FAIL'
       END,
       format('%s rows safe for legacy backfill (count only)', CASE WHEN chat_id_exists THEN null_chat_ids ELSE total_rows END)
FROM (
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tickets' AND column_name='chat_id') chat_id_exists,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tickets' AND column_name='chat_id' AND data_type='text') chat_id_is_text,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tickets' AND column_name='telefono'
      AND data_type IN ('text','character varying','character')) telefono_compatible,
    count(*) total_rows,
    count(*) FILTER (WHERE to_jsonb(t)->>'chat_id' IS NULL) null_chat_ids,
    count(*) FILTER (WHERE to_jsonb(t) ? 'chat_id' AND to_jsonb(t)->>'chat_id' IS NOT NULL
      AND (char_length(to_jsonb(t)->>'chat_id') NOT BETWEEN 12 AND 64
        OR (to_jsonb(t)->>'chat_id') !~ '^[1-9][0-9]{5,31}@(c[.]us|lid)$')) invalid_chat_ids,
    count(*) FILTER (WHERE to_jsonb(t)->>'chat_id' IS NULL AND (NOT to_jsonb(t) ? 'telefono' OR to_jsonb(t)->>'telefono' IS NULL
      OR char_length(to_jsonb(t)->>'telefono') NOT BETWEEN 12 AND 64
      OR (to_jsonb(t)->>'telefono') !~ '^[1-9][0-9]{5,31}@(c[.]us|lid)$')) unsafe_legacy_values
  FROM public.tickets t
) ticket_identity
UNION ALL
SELECT 'invalid_existing_submission_ids',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s invalid values (no values exposed)', count(*))
FROM (
  SELECT 1 FROM public.bot_sessions s
  WHERE to_jsonb(s) ->> 'submission_id' IS NOT NULL
    AND (to_jsonb(s) ->> 'submission_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  UNION ALL
  SELECT 1 FROM public.tickets t
  WHERE to_jsonb(t) ->> 'bot_submission_id' IS NOT NULL
    AND (to_jsonb(t) ->> 'bot_submission_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
) invalid
UNION ALL
SELECT 'duplicate_ticket_submission_ids',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s duplicate identity groups (no values exposed)', count(*))
FROM (
  SELECT to_jsonb(t) ->> 'bot_submission_id'
  FROM public.tickets t
  WHERE to_jsonb(t) ->> 'bot_submission_id' IS NOT NULL
  GROUP BY to_jsonb(t) ->> 'bot_submission_id' HAVING count(*) > 1
) duplicates
UNION ALL
SELECT 'unsupported_ticket_categories',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s unsupported values (no values exposed)', count(*))
FROM public.tickets t
WHERE to_jsonb(t) ->> 'categoria' IS NOT NULL
  AND to_jsonb(t) ->> 'categoria' NOT IN ('Platform','Tests','Integrations','Other')
UNION ALL
SELECT 'duplicate_effective_bot_flow_identities',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s duplicate identity groups (no identities exposed)', count(*))
FROM (
  SELECT 1 FROM public.bot_flows
  GROUP BY version_id, COALESCE(area_id, 0), step_key HAVING count(*) > 1
) duplicate_flows
UNION ALL
SELECT 'incompatible_phase9_columns',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s existing Phase 9 columns have incompatible types', count(*))
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name, data_type) IN (
    ('bot_sessions','categoria','text'), ('bot_sessions','submission_id','text'),
    ('tickets','categoria','text'), ('tickets','bot_submission_id','text')
  ) IS FALSE
  AND (table_name, column_name) IN (
    ('bot_sessions','categoria'), ('bot_sessions','submission_id'),
    ('tickets','categoria'), ('tickets','bot_submission_id')
  )
UNION ALL
SELECT 'partial_phase9_tables',
       CASE WHEN count(*) IN (0, 3) THEN 'PASS' ELSE 'FAIL' END,
       format('%s of 3 Phase 9 tables already exist', count(*))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  AND c.relname IN ('contact_classifications','app_settings','ticket_post_processing')
UNION ALL
SELECT 'incompatible_phase9_table_columns',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s required columns missing or incompatible on existing Phase 9 tables', count(*))
FROM (VALUES
  ('contact_classifications','chat_id','text','NO',NULL),
  ('contact_classifications','classification','text','NO','candidate'),
  ('contact_classifications','support_blocked','boolean','NO','true'),
  ('contact_classifications','source','text','NO',NULL),
  ('contact_classifications','marked_at','timestamp with time zone','NO','now()'),
  ('contact_classifications','marked_by','text','NO',NULL),
  ('contact_classifications','last_guidance_at','timestamp with time zone','YES',NULL),
  ('contact_classifications','guidance_claimed_at','timestamp with time zone','YES',NULL),
  ('contact_classifications','guidance_claim_token','uuid','YES',NULL),
  ('contact_classifications','note','text','YES',NULL),
  ('app_settings','key','text','NO',NULL), ('app_settings','value','text','NO',NULL),
  ('app_settings','updated_at','timestamp with time zone','NO','now()'),
  ('ticket_post_processing','ticket_id','bigint','NO',NULL),
  ('ticket_post_processing','submission_id','uuid','NO',NULL),
  ('ticket_post_processing','chat_id','text','NO',NULL),
  ('ticket_post_processing','salesforce_outbox_status','text','NO','pending'),
  ('ticket_post_processing','operational_emit_status','text','NO','pending'),
  ('ticket_post_processing','session_cleanup_status','text','NO','pending'),
  ('ticket_post_processing','whatsapp_ack_status','text','NO','pending'),
  ('ticket_post_processing','whatsapp_ack_attempts','integer','NO','0'),
  ('ticket_post_processing','whatsapp_ack_claim_token','uuid','YES',NULL),
  ('ticket_post_processing','attempts','integer','NO','0'), ('ticket_post_processing','last_error_code','text','YES',NULL),
  ('ticket_post_processing','salesforce_outbox_claimed_by','uuid','YES',NULL),
  ('ticket_post_processing','salesforce_outbox_claimed_at','timestamp with time zone','YES',NULL),
  ('ticket_post_processing','operational_emit_claimed_by','uuid','YES',NULL),
  ('ticket_post_processing','operational_emit_claimed_at','timestamp with time zone','YES',NULL),
  ('ticket_post_processing','session_cleanup_claimed_by','uuid','YES',NULL),
  ('ticket_post_processing','session_cleanup_claimed_at','timestamp with time zone','YES',NULL),
  ('ticket_post_processing','created_at','timestamp with time zone','NO','now()'),
  ('ticket_post_processing','updated_at','timestamp with time zone','NO','now()')
) expected(table_name,column_name,data_type,is_nullable,default_fragment)
WHERE to_regclass('public.' || expected.table_name) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=expected.table_name
      AND c.column_name=expected.column_name AND c.data_type=expected.data_type
      AND c.is_nullable=expected.is_nullable
      AND (expected.default_fragment IS NULL AND c.column_default IS NULL
        OR expected.default_fragment IS NOT NULL AND c.column_default ILIKE '%' || expected.default_fragment || '%')
  )
UNION ALL
SELECT 'incompatible_phase9_constraints', CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s required PK/FK/unique/check constraints absent, invalid, detached, or incompatible', count(*))
FROM (VALUES
  ('contact_classifications','contact_classifications_pkey','PRIMARYKEY(chat_id)'),
  ('contact_classifications','contact_classifications_chat_id_check',E'CHECK(char_length(chat_id)>=12ANDchar_length(chat_id)<=64ANDchat_id~\'^[1-9][0-9]{5,31}@(c[.]us|lid)$\')'),
  ('contact_classifications','contact_classifications_classification_check',E'CHECK(classification=\'candidate\')'),
  ('contact_classifications','contact_classifications_source_check',E'CHECK(source=ANY(ARRAY[\'auto\',\'manual\']))'),
  ('contact_classifications','contact_classifications_marked_by_check','CHECK(char_length(marked_by)>=1ANDchar_length(marked_by)<=120)'),
  ('contact_classifications','contact_classifications_note_check','CHECK(noteISNULLORchar_length(note)<=500)'),
  ('app_settings','app_settings_pkey','PRIMARYKEY(key)'),
  ('app_settings','app_settings_key_check',E'CHECK(key=ANY(ARRAY[\'candidate_form_url\',\'candidate_guidance_message\']))'),
  ('app_settings','app_settings_value_check','CHECK(char_length(value)<=2000)'),
  ('ticket_post_processing','ticket_post_processing_pkey','PRIMARYKEY(ticket_id)'),
  ('ticket_post_processing','ticket_post_processing_ticket_id_fkey','FOREIGNKEY(ticket_id)REFERENCEStickets(id)ONDELETECASCADE'),
  ('ticket_post_processing','ticket_post_processing_submission_id_key','UNIQUE(submission_id)'),
  ('ticket_post_processing','ticket_post_processing_chat_id_check','CHECK(char_length(chat_id)>=12ANDchar_length(chat_id)<=64)'),
  ('ticket_post_processing','ticket_post_processing_salesforce_outbox_status_check',E'CHECK(salesforce_outbox_status=ANY(ARRAY[\'pending\',\'processing\',\'completed\',\'failed\']))'),
  ('ticket_post_processing','ticket_post_processing_operational_emit_status_check',E'CHECK(operational_emit_status=ANY(ARRAY[\'pending\',\'processing\',\'completed\',\'failed\',\'uncertain\']))'),
  ('ticket_post_processing','ticket_post_processing_session_cleanup_status_check',E'CHECK(session_cleanup_status=ANY(ARRAY[\'pending\',\'processing\',\'completed\',\'failed\']))'),
  ('ticket_post_processing','ticket_post_processing_whatsapp_ack_status_check',E'CHECK(whatsapp_ack_status=ANY(ARRAY[\'pending\',\'completed\',\'uncertain\']))'),
  ('ticket_post_processing','ticket_post_processing_whatsapp_ack_attempts_check','CHECK(whatsapp_ack_attempts>=0ANDwhatsapp_ack_attempts<=1)'),
  ('ticket_post_processing','ticket_post_processing_last_error_code_check','CHECK(last_error_codeISNULLORchar_length(last_error_code)<=120)')
 ) expected(table_name, constraint_name, normalized_definition)
WHERE to_regclass('public.' || expected.table_name) IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM pg_constraint c
 WHERE c.conrelid=to_regclass('public.' || expected.table_name) AND c.conname=expected.constraint_name
   AND c.convalidated
   AND regexp_replace(pg_get_constraintdef(c.oid, true), '[[:space:]()]|::text', '', 'g') =
       regexp_replace(expected.normalized_definition, '[[:space:]()]|::text', '', 'g'))
UNION ALL
SELECT 'incompatible_phase9_indexes', CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s required indexes absent, invalid, non-unique, or incompatible', count(*))
FROM (VALUES
 ('contact_classifications','contact_classifications_blocked_idx',false,'support_blocked, marked_at DESC'),
 ('ticket_post_processing','ticket_post_processing_submission_id_key',true,'submission_id')
) expected(table_name,index_name,must_be_unique,definition_fragment)
WHERE to_regclass('public.' || expected.table_name) IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid
 WHERE i.indrelid=to_regclass('public.' || expected.table_name) AND x.relname=expected.index_name
   AND i.indisvalid AND i.indisready AND (NOT expected.must_be_unique OR i.indisunique)
   AND pg_get_indexdef(i.indexrelid) ILIKE '%' || expected.definition_fragment || '%')
UNION ALL
SELECT 'incompatible_phase9_function_overloads',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s obsolete/incompatible function overloads present', count(*))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('put_bot_flow_studio_layout','claim_candidate_guidance','finalize_candidate_guidance','release_candidate_guidance','initialize_ticket_post_processing','ensure_ticket_post_processing','claim_ticket_post_processing','finalize_ticket_post_processing_effect','mark_ticket_post_processing_attempt_started','claim_ticket_whatsapp_ack','finalize_ticket_whatsapp_ack')
  AND (p.proname, oidvectortypes(p.proargtypes)) NOT IN (VALUES
    ('put_bot_flow_studio_layout','integer, bigint, jsonb, integer, text'),
    ('claim_candidate_guidance','text, uuid'), ('finalize_candidate_guidance','text, uuid'),
    ('release_candidate_guidance','text, uuid'), ('initialize_ticket_post_processing',''),
    ('ensure_ticket_post_processing','bigint'), ('claim_ticket_post_processing','uuid'),
    ('finalize_ticket_post_processing_effect','bigint, uuid, text, boolean, text'),
    ('mark_ticket_post_processing_attempt_started','bigint, uuid, text'),
    ('claim_ticket_whatsapp_ack','bigint, uuid'), ('finalize_ticket_whatsapp_ack','bigint, uuid')
  )
UNION ALL
SELECT 'incompatible_canonical_function_contracts',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s existing canonical functions have incompatible return, security, or owner contracts', count(*))
FROM (
  WITH expected(signature,result_type,must_be_definer) AS (VALUES
    ('put_bot_flow_studio_layout(integer,bigint,jsonb,integer,text)','SETOF bot_flow_studio_layouts',false),
    ('claim_candidate_guidance(text,uuid)','boolean',true),
    ('finalize_candidate_guidance(text,uuid)','boolean',true),
    ('release_candidate_guidance(text,uuid)','boolean',true),
    ('initialize_ticket_post_processing()','trigger',true),
    ('ensure_ticket_post_processing(bigint)','ticket_post_processing',true),
    ('claim_ticket_post_processing(uuid)','SETOF ticket_post_processing',true),
    ('finalize_ticket_post_processing_effect(bigint,uuid,text,boolean,text)','boolean',true),
    ('mark_ticket_post_processing_attempt_started(bigint,uuid,text)','boolean',true),
    ('claim_ticket_whatsapp_ack(bigint,uuid)','boolean',true),
    ('finalize_ticket_whatsapp_ack(bigint,uuid)','boolean',true)
  ), approved_owner AS (
    SELECT oid FROM pg_roles WHERE rolname IN ('postgres','supabase_admin')
    ORDER BY CASE rolname WHEN 'postgres' THEN 1 ELSE 2 END LIMIT 1
  )
  SELECT 1
  FROM expected e
  JOIN pg_proc p ON p.oid=to_regprocedure('public.'||e.signature)
  WHERE pg_get_function_result(p.oid)<>e.result_type
     OR p.prosecdef<>e.must_be_definer
     OR p.proowner IS DISTINCT FROM (SELECT oid FROM approved_owner)
  UNION ALL
  SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM approved_owner)
) incompatible
UNION ALL
SELECT 'repairable_canonical_function_search_paths', 'PASS',
       format('%s existing canonical function search paths will be normalized by migration', count(*))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.oid IN (
    to_regprocedure('public.put_bot_flow_studio_layout(integer,bigint,jsonb,integer,text)'),
    to_regprocedure('public.claim_candidate_guidance(text,uuid)'),
    to_regprocedure('public.finalize_candidate_guidance(text,uuid)'),
    to_regprocedure('public.release_candidate_guidance(text,uuid)'),
    to_regprocedure('public.initialize_ticket_post_processing()'),
    to_regprocedure('public.ensure_ticket_post_processing(bigint)'),
    to_regprocedure('public.claim_ticket_post_processing(uuid)'),
    to_regprocedure('public.finalize_ticket_post_processing_effect(bigint,uuid,text,boolean,text)'),
    to_regprocedure('public.mark_ticket_post_processing_attempt_started(bigint,uuid,text)'),
    to_regprocedure('public.claim_ticket_whatsapp_ack(bigint,uuid)'),
    to_regprocedure('public.finalize_ticket_whatsapp_ack(bigint,uuid)')
  ) AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
UNION ALL
SELECT 'public_schema_create_denied',
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM pg_roles r CROSS JOIN pg_namespace n
           WHERE n.nspname='public' AND r.oid<>n.nspowner AND NOT r.rolsuper
             AND r.rolname NOT IN ('postgres','supabase_admin')
            AND has_schema_privilege(r.oid,n.oid,'CREATE')
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
          WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE'
        ) THEN 'PASS' ELSE 'FAIL' END,
        'ordinary roles (including inherited membership) and PUBLIC must have no effective CREATE (no role names exposed)'
UNION ALL
SELECT 'relation_lock_holders',
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('%s other sessions hold or await relation locks on migration relations (no session data exposed)', count(DISTINCT l.pid))
FROM pg_locks l JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE l.pid <> pg_backend_pid() AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND n.nspname='public' AND c.relname IN ('bot_sessions','tickets','bot_flows','bot_flow_studio_layouts',
    'contact_classifications','app_settings','ticket_post_processing');

ROLLBACK;

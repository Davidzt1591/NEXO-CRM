-- NEXO Phase 9 read-only postflight. Run only after the migration commits.
-- Catalog-derived counts only: no application rows, role lists, queries, or PII.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = pg_catalog, public;

WITH required_relations(name,kind) AS (VALUES
  ('contact_classifications','r'), ('app_settings','r'), ('ticket_post_processing','r'),
  ('bot_sessions','r'), ('tickets','r'), ('bot_flows','r'), ('bot_flow_studio_layouts','r'),
  ('bot_flow_studio_layouts_id_seq','S')
), expected_columns(table_name,column_name,data_type,is_nullable,default_fragment) AS (VALUES
  ('contact_classifications','chat_id','text','NO',NULL), ('contact_classifications','classification','text','NO','candidate'),
  ('contact_classifications','support_blocked','boolean','NO','true'), ('contact_classifications','source','text','NO',NULL),
  ('contact_classifications','marked_at','timestamp with time zone','NO','now()'), ('contact_classifications','marked_by','text','NO',NULL),
  ('contact_classifications','last_guidance_at','timestamp with time zone','YES',NULL),
  ('contact_classifications','guidance_claimed_at','timestamp with time zone','YES',NULL),
  ('contact_classifications','guidance_claim_token','uuid','YES',NULL), ('contact_classifications','note','text','YES',NULL),
  ('app_settings','key','text','NO',NULL), ('app_settings','value','text','NO',NULL),
  ('app_settings','updated_at','timestamp with time zone','NO','now()'),
  ('ticket_post_processing','ticket_id','bigint','NO',NULL), ('ticket_post_processing','submission_id','uuid','NO',NULL),
  ('ticket_post_processing','chat_id','text','NO',NULL), ('ticket_post_processing','salesforce_outbox_status','text','NO','pending'),
  ('ticket_post_processing','operational_emit_status','text','NO','pending'), ('ticket_post_processing','session_cleanup_status','text','NO','pending'),
  ('ticket_post_processing','whatsapp_ack_status','text','NO','pending'), ('ticket_post_processing','whatsapp_ack_attempts','integer','NO','0'),
  ('ticket_post_processing','whatsapp_ack_claim_token','uuid','YES',NULL), ('ticket_post_processing','attempts','integer','NO','0'),
  ('ticket_post_processing','last_error_code','text','YES',NULL), ('ticket_post_processing','salesforce_outbox_claimed_by','uuid','YES',NULL),
  ('ticket_post_processing','salesforce_outbox_claimed_at','timestamp with time zone','YES',NULL),
  ('ticket_post_processing','operational_emit_claimed_by','uuid','YES',NULL),
  ('ticket_post_processing','operational_emit_claimed_at','timestamp with time zone','YES',NULL),
  ('ticket_post_processing','session_cleanup_claimed_by','uuid','YES',NULL),
  ('ticket_post_processing','session_cleanup_claimed_at','timestamp with time zone','YES',NULL),
  ('ticket_post_processing','created_at','timestamp with time zone','NO','now()'),
  ('ticket_post_processing','updated_at','timestamp with time zone','NO','now()'),
  ('bot_sessions','categoria','text','YES',NULL), ('bot_sessions','submission_id','text','YES',NULL),
  ('tickets','chat_id','text','NO',NULL), ('tickets','categoria','text','YES',NULL), ('tickets','bot_submission_id','text','YES',NULL)
), expected_constraints(table_name,constraint_name,normalized_definition) AS (VALUES
  ('contact_classifications','contact_classifications_pkey','PRIMARY KEY (chat_id)'),
  ('contact_classifications','contact_classifications_chat_id_check',E'CHECK (char_length(chat_id) >= 12 AND char_length(chat_id) <= 64 AND chat_id ~ \'^[1-9][0-9]{5,31}@(c[.]us|lid)$\')'),
  ('contact_classifications','contact_classifications_classification_check',E'CHECK (classification = \'candidate\')'),
  ('contact_classifications','contact_classifications_source_check',E'CHECK (source = ANY (ARRAY[\'auto\',\'manual\']))'),
  ('contact_classifications','contact_classifications_marked_by_check','CHECK (char_length(marked_by) >= 1 AND char_length(marked_by) <= 120)'),
  ('contact_classifications','contact_classifications_note_check','CHECK (note IS NULL OR char_length(note) <= 500)'),
  ('app_settings','app_settings_pkey','PRIMARY KEY (key)'),
  ('app_settings','app_settings_key_check',E'CHECK (key = ANY (ARRAY[\'candidate_form_url\',\'candidate_guidance_message\']))'),
  ('app_settings','app_settings_value_check','CHECK (char_length(value) <= 2000)'),
  ('ticket_post_processing','ticket_post_processing_pkey','PRIMARY KEY (ticket_id)'),
  ('ticket_post_processing','ticket_post_processing_ticket_id_fkey','FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE'),
  ('ticket_post_processing','ticket_post_processing_submission_id_key','UNIQUE (submission_id)'),
  ('ticket_post_processing','ticket_post_processing_chat_id_check','CHECK (char_length(chat_id) >= 12 AND char_length(chat_id) <= 64)'),
  ('ticket_post_processing','ticket_post_processing_salesforce_outbox_status_check',E'CHECK (salesforce_outbox_status = ANY (ARRAY[\'pending\',\'processing\',\'completed\',\'failed\']))'),
  ('ticket_post_processing','ticket_post_processing_operational_emit_status_check',E'CHECK (operational_emit_status = ANY (ARRAY[\'pending\',\'processing\',\'completed\',\'failed\',\'uncertain\']))'),
  ('ticket_post_processing','ticket_post_processing_session_cleanup_status_check',E'CHECK (session_cleanup_status = ANY (ARRAY[\'pending\',\'processing\',\'completed\',\'failed\']))'),
  ('ticket_post_processing','ticket_post_processing_whatsapp_ack_status_check',E'CHECK (whatsapp_ack_status = ANY (ARRAY[\'pending\',\'completed\',\'uncertain\']))'),
  ('ticket_post_processing','ticket_post_processing_whatsapp_ack_attempts_check','CHECK (whatsapp_ack_attempts >= 0 AND whatsapp_ack_attempts <= 1)'),
  ('ticket_post_processing','ticket_post_processing_last_error_code_check','CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 120)'),
  ('bot_sessions','bot_sessions_submission_id_check',E'CHECK (submission_id IS NULL OR submission_id ~ \'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$\')'),
  ('tickets','tickets_bot_submission_id_check',E'CHECK (bot_submission_id IS NULL OR bot_submission_id ~ \'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$\')'),
  ('tickets','tickets_chat_id_whatsapp_check',E'CHECK (char_length(chat_id) >= 12 AND char_length(chat_id) <= 64 AND chat_id ~ \'^[1-9][0-9]{5,31}@(c[.]us|lid)$\')'),
  ('bot_sessions','bot_sessions_categoria_length_check','CHECK (categoria IS NULL OR char_length(categoria) >= 1 AND char_length(categoria) <= 32)'),
  ('tickets','tickets_categoria_length_check',E'CHECK (categoria IS NULL OR categoria = ANY (ARRAY[\'Platform\',\'Tests\',\'Integrations\',\'Other\']))')
), expected_indexes(table_name,index_name,must_be_unique,definition_fragment) AS (VALUES
  ('contact_classifications','contact_classifications_blocked_idx',false,'support_blocked, marked_at DESC'),
  ('tickets','tickets_bot_submission_id_uidx',true,'bot_submission_id) WHERE (bot_submission_id IS NOT NULL)'),
  ('bot_flows','bot_flows_effective_identity_uidx',true,'version_id%COALESCE(area_id'),
  ('bot_flow_studio_layouts','bot_flow_studio_layouts_effective_identity_uidx',true,'version_id%COALESCE(area_id')
), expected_functions(signature,result_type,must_be_definer,service_execute) AS (VALUES
  ('claim_candidate_guidance(text,uuid)','boolean',true,true), ('finalize_candidate_guidance(text,uuid)','boolean',true,true),
  ('release_candidate_guidance(text,uuid)','boolean',true,true),
  ('ensure_ticket_post_processing(bigint)','ticket_post_processing',true,true),
  ('initialize_ticket_post_processing()','trigger',true,false),
  ('claim_ticket_post_processing(uuid)','SETOF ticket_post_processing',true,true),
  ('finalize_ticket_post_processing_effect(bigint,uuid,text,boolean,text)','boolean',true,true),
  ('mark_ticket_post_processing_attempt_started(bigint,uuid,text)','boolean',true,true),
  ('claim_ticket_whatsapp_ack(bigint,uuid)','boolean',true,true),
  ('finalize_ticket_whatsapp_ack(bigint,uuid)','boolean',true,true),
  ('put_bot_flow_studio_layout(integer,bigint,jsonb,integer,text)','SETOF bot_flow_studio_layouts',false,true)
), approved_owner AS (
  SELECT oid FROM pg_roles WHERE rolname IN ('postgres','supabase_admin')
  ORDER BY CASE rolname WHEN 'postgres' THEN 1 ELSE 2 END LIMIT 1
), checks AS (
  SELECT 'relation_object_types' check_name, count(*)=0 ok, count(*) n
  FROM required_relations e LEFT JOIN pg_class c ON c.oid=to_regclass('public.' || e.name)
  WHERE c.oid IS NULL OR c.relkind<>e.kind::"char"
  UNION ALL
  SELECT 'complete_column_contract', count(*)=0, count(*) FROM expected_columns e
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=e.table_name
    AND c.column_name=e.column_name AND c.data_type=e.data_type AND c.is_nullable=e.is_nullable
    AND (e.default_fragment IS NULL AND c.column_default IS NULL OR e.default_fragment IS NOT NULL AND c.column_default ILIKE '%'||e.default_fragment||'%'))
  UNION ALL
  SELECT 'tickets_chat_id_data', count(*)=0, count(*)
  FROM public.tickets
  WHERE chat_id IS NULL
     OR char_length(chat_id) NOT BETWEEN 12 AND 64
     OR chat_id !~ '^[1-9][0-9]{5,31}@(c[.]us|lid)$'
  UNION ALL
  SELECT 'constraint_contract', count(*)=0, count(*) FROM expected_constraints e WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||e.table_name) AND c.conname=e.constraint_name
      AND c.convalidated
      AND regexp_replace(pg_get_constraintdef(c.oid,true), '[[:space:]()]|::text', '', 'g') =
          regexp_replace(e.normalized_definition, '[[:space:]()]|::text', '', 'g'))
  UNION ALL
  SELECT 'valid_index_contract', count(*)=0, count(*) FROM expected_indexes e WHERE NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=to_regclass('public.'||e.table_name)
      AND x.relname=e.index_name AND i.indisvalid AND i.indisready AND (NOT e.must_be_unique OR i.indisunique)
      AND pg_get_indexdef(i.indexrelid) ILIKE '%'||e.definition_fragment||'%')
  UNION ALL
  SELECT 'trigger_definition_and_state', count(*)=1, 1-count(*) FROM pg_trigger t
    WHERE t.tgrelid='public.tickets'::regclass AND t.tgname='tickets_initialize_post_processing'
      AND NOT t.tgisinternal AND t.tgenabled='O'
      AND pg_get_triggerdef(t.oid,true) ILIKE 'CREATE TRIGGER tickets_initialize_post_processing AFTER INSERT ON %tickets FOR EACH ROW EXECUTE FUNCTION %initialize_ticket_post_processing()'
  UNION ALL
  SELECT 'function_identity_return_security_path_owner', count(*)=0, count(*) FROM expected_functions e
  WHERE to_regprocedure('public.'||e.signature) IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||e.signature)
      AND pg_get_function_result(p.oid)=e.result_type AND p.prosecdef=e.must_be_definer
      AND p.proconfig=ARRAY['search_path=pg_catalog, public']
      AND p.proowner=(SELECT oid FROM approved_owner))
    OR NOT EXISTS (SELECT 1 FROM approved_owner)
  UNION ALL
  SELECT 'rls_enabled', bool_and(c.relrowsecurity), count(*) FILTER (WHERE NOT c.relrowsecurity)
    FROM pg_class c WHERE c.oid IN ('public.contact_classifications'::regclass,'public.app_settings'::regclass,
      'public.ticket_post_processing'::regclass,'public.bot_flow_studio_layouts'::regclass)
  UNION ALL
  SELECT 'public_schema_create_denied', NOT EXISTS (
      SELECT 1 FROM pg_roles r CROSS JOIN pg_namespace n
       WHERE n.nspname='public' AND r.oid<>n.nspowner AND NOT r.rolsuper
         AND r.rolname NOT IN ('postgres','supabase_admin')
        AND has_schema_privilege(r.oid,n.oid,'CREATE')
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE'
    ), 0
  UNION ALL
  SELECT 'service_role_exact_table_sequence_acl', count(*)=0, count(*) FROM required_relations e
  WHERE (e.name IN ('contact_classifications','bot_sessions','tickets','bot_flows')
          AND (NOT has_table_privilege('service_role','public.'||e.name,'SELECT')
               OR NOT has_table_privilege('service_role','public.'||e.name,'INSERT')
               OR NOT has_table_privilege('service_role','public.'||e.name,'UPDATE')
               OR NOT has_table_privilege('service_role','public.'||e.name,'DELETE')
               OR has_table_privilege('service_role','public.'||e.name,'TRUNCATE,REFERENCES,TRIGGER')))
     OR (e.name IN ('app_settings','ticket_post_processing','bot_flow_studio_layouts')
          AND (NOT has_table_privilege('service_role','public.'||e.name,'SELECT')
               OR NOT has_table_privilege('service_role','public.'||e.name,'INSERT')
               OR NOT has_table_privilege('service_role','public.'||e.name,'UPDATE')
               OR has_table_privilege('service_role','public.'||e.name,'DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      OR (e.kind='S' AND (NOT has_sequence_privilege('service_role','public.'||e.name,'USAGE')
                          OR NOT has_sequence_privilege('service_role','public.'||e.name,'SELECT')
                          OR has_sequence_privilege('service_role','public.'||e.name,'UPDATE')))
  UNION ALL
  SELECT 'public_anon_authenticated_relation_denial', count(*)=0, count(*)
  FROM required_relations e JOIN pg_class c ON c.oid=to_regclass('public.'||e.name)
  WHERE e.kind<>'S' AND (
    has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
               WHERE a.grantee=0 AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'))
  )
  UNION ALL
  SELECT 'public_anon_authenticated_sequence_denial', count(*)=0, count(*)
  FROM required_relations e JOIN pg_class c ON c.oid=to_regclass('public.'||e.name)
  WHERE e.kind='S' AND (
    has_sequence_privilege('anon',c.oid,'USAGE,SELECT,UPDATE')
    OR has_sequence_privilege('authenticated',c.oid,'USAGE,SELECT,UPDATE')
    OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a
               WHERE a.grantee=0 AND a.privilege_type IN ('USAGE','SELECT','UPDATE'))
  )
  UNION ALL
  SELECT 'unexpected_effective_relation_grantees', count(*)=0, count(*) FROM required_relations e
    JOIN pg_class c ON c.oid=to_regclass('public.'||e.name) CROSS JOIN pg_roles r
    WHERE r.rolname NOT IN ('service_role','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user')
      AND r.oid<>c.relowner AND NOT r.rolsuper
      AND CASE WHEN e.kind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
               ELSE has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END
  UNION ALL
  SELECT 'service_role_function_execute', bool_and(has_function_privilege('service_role','public.'||e.signature,'EXECUTE')=e.service_execute),
    count(*) FILTER (WHERE has_function_privilege('service_role','public.'||e.signature,'EXECUTE')<>e.service_execute) FROM expected_functions e
  UNION ALL
  SELECT 'public_anon_authenticated_function_denial', count(*)=0, count(*) FROM expected_functions e
    JOIN pg_proc p ON p.oid=to_regprocedure('public.'||e.signature)
    WHERE has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
  UNION ALL
  SELECT 'unexpected_effective_function_grantees', count(*)=0, count(*) FROM expected_functions e
    JOIN pg_proc p ON p.oid=to_regprocedure('public.'||e.signature) CROSS JOIN pg_roles r
    WHERE r.rolname<>'service_role' AND r.oid<>p.proowner AND NOT r.rolsuper AND has_function_privilege(r.oid,p.oid,'EXECUTE')
  UNION ALL
  SELECT 'protected_function_signature_set_exact', count(*)=0, count(*)
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
  SELECT 'all_protected_overloads_exact_acl', count(*)=0, count(*)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('put_bot_flow_studio_layout','claim_candidate_guidance','finalize_candidate_guidance','release_candidate_guidance','initialize_ticket_post_processing','ensure_ticket_post_processing','claim_ticket_post_processing','finalize_ticket_post_processing_effect','mark_ticket_post_processing_attempt_started','claim_ticket_whatsapp_ack','finalize_ticket_whatsapp_ack')
    AND (EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
      OR has_function_privilege('anon',p.oid,'EXECUTE')
      OR has_function_privilege('authenticated',p.oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid<>p.proowner AND NOT r.rolsuper
                 AND r.rolname<>'service_role' AND has_function_privilege(r.oid,p.oid,'EXECUTE')))
)
SELECT check_name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END status,
       format('%s contract violations (counts only)', GREATEST(n,0)) detail
FROM checks ORDER BY check_name;

ROLLBACK;

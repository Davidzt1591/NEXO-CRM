-- Phase 10 pure read-only postflight for Supabase SQL Editor.
-- Run only after the Phase 10 migration succeeds: the two application relations
-- queried by canonical data checks must exist when PostgreSQL parses this statement.
-- Catalog-resolvable objects remain optional and produce FAIL rows when absent.
with table_relations(name,kind) as (values
  ('areas','r'),('analysts','r'),('ticket_assignments','r'),
  ('category_area_mappings','r'),('tickets','r')
), resolved_tables as (
  select e.*,to_regclass('public.'||e.name) oid from table_relations e
), routing_sequences(name,kind,oid) as (
  select distinct seq.relname,'S'::text,seq.oid
  from resolved_tables rt
  join pg_class t on t.oid=rt.oid
  join pg_namespace tn on tn.oid=t.relnamespace
  join pg_depend d on d.refobjid=t.oid and d.refobjsubid>0 and d.deptype in ('a','i')
  join pg_class seq on seq.oid=d.objid and seq.relkind='S'
  where tn.nspname='public'
  union all
  select name||'_missing_table_sequence','S'::text,null::oid from resolved_tables where oid is null
), required_relations as (
  select name,kind,oid from resolved_tables union all select name,kind,oid from routing_sequences
), expected_functions(signature,result_type,must_be_definer,service_execute) as (values
  ('phase10_touch_category_mapping()','trigger',false,false),
  ('resolve_category_area(text)','bigint',true,true),
  ('create_routed_ticket(text,text,text,text,text,text,text,text,text,uuid)','jsonb',true,true),
  ('claim_area_ticket(bigint,bigint)','boolean',true,true),
  ('admin_route_ticket(text,bigint,bigint,bigint,text,jsonb)','jsonb',true,true),
  ('switch_analyst_area(bigint,bigint,text,jsonb)','jsonb',true,true)
), resolved_functions as (
  select e.*,to_regprocedure('public.'||e.signature) oid from expected_functions e
), approved_owner as (
  select oid from pg_roles where rolname in ('postgres','supabase_admin')
  order by case rolname when 'postgres' then 1 else 2 end limit 1
), normalized_areas as (
  select id,active,lower(regexp_replace(trim(name),'\s+',' ','g')) normalized from public.areas
), canonical_area_counts as (
  select
    count(*) filter (where active and normalized in ('integraciones','soporte integraciones')) integrations_active,
    count(*) filter (where active and normalized='soporte magneto') magneto_active,
    count(*) filter (where not active and normalized in ('integraciones','soporte integraciones','soporte magneto')) inactive_canonical
  from normalized_areas
), canonical_mapping_counts as (
  select count(*) mapping_count,count(*) filter (where not (
    m.active and a.active and
    (m.category_key='integrations' and a.normalized in ('integraciones','soporte integraciones')
      or m.category_key in ('platform','tests','requests') and a.normalized='soporte magneto')
  )) invalid_count
  from public.category_area_mappings m left join normalized_areas a on a.id=m.area_id
), check_results as (
  select 'canonical_areas' check_name,
    integrations_active=1 and magneto_active=1 and inactive_canonical=0 ok,
    abs(integrations_active-1)+abs(magneto_active-1)+inactive_canonical n
    from canonical_area_counts
  union all
  select 'canonical_category_mappings',mapping_count=4 and invalid_count=0,
    abs(mapping_count-4)+invalid_count from canonical_mapping_counts
  union all
  select 'relation_object_types',count(*)=0,count(*) from required_relations e
    left join pg_class c on c.oid=e.oid where c.oid is null or c.relkind<>e.kind::"char"
  union all
  select 'routing_tables_rls_enabled',count(*) filter (where c.oid is null or not c.relrowsecurity)=0,
    count(*) filter (where c.oid is null or not c.relrowsecurity)
    from resolved_tables e left join pg_class c on c.oid=e.oid
  union all
  select 'browser_public_table_denial',count(*) filter (where c.oid is null or
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0))=0,
    count(*) filter (where c.oid is null or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0))
    from resolved_tables e left join pg_class c on c.oid=e.oid
  union all
  select 'browser_public_sequence_denial',count(*) filter (where c.oid is null or has_sequence_privilege('anon',c.oid,'USAGE,SELECT,UPDATE')
      or has_sequence_privilege('authenticated',c.oid,'USAGE,SELECT,UPDATE')
      or exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a where a.grantee=0))=0,
    count(*) filter (where c.oid is null or has_sequence_privilege('anon',c.oid,'USAGE,SELECT,UPDATE')
      or has_sequence_privilege('authenticated',c.oid,'USAGE,SELECT,UPDATE')
      or exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a where a.grantee=0))
    from routing_sequences e left join pg_class c on c.oid=e.oid
  union all
  select 'service_role_exact_table_acl',count(*) filter (where c.oid is null or not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE')
      or (e.name='tickets' and not has_table_privilege('service_role',c.oid,'DELETE'))
      or (e.name<>'tickets' and has_table_privilege('service_role',c.oid,'DELETE'))
      or has_table_privilege('service_role',c.oid,'TRUNCATE,REFERENCES,TRIGGER'))=0,
    count(*) filter (where c.oid is null or not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE')
      or (e.name='tickets' and not has_table_privilege('service_role',c.oid,'DELETE'))
      or (e.name<>'tickets' and has_table_privilege('service_role',c.oid,'DELETE'))
      or has_table_privilege('service_role',c.oid,'TRUNCATE,REFERENCES,TRIGGER'))
    from resolved_tables e left join pg_class c on c.oid=e.oid
  union all
  select 'service_role_exact_sequence_acl',count(*) filter (where c.oid is null or not has_sequence_privilege('service_role',c.oid,'USAGE,SELECT')
      or has_sequence_privilege('service_role',c.oid,'UPDATE'))=0,
    count(*) filter (where c.oid is null or not has_sequence_privilege('service_role',c.oid,'USAGE,SELECT')
      or has_sequence_privilege('service_role',c.oid,'UPDATE'))
    from routing_sequences e left join pg_class c on c.oid=e.oid
  union all
  select 'unexpected_effective_relation_grantees',count(*) filter (where c.oid is null or bad.role_oid is not null)=0,
    count(*) filter (where c.oid is null or bad.role_oid is not null)
    from required_relations e left join pg_class c on c.oid=e.oid
    left join lateral (select r.oid role_oid from pg_roles r where c.oid is not null
      and r.rolname not in ('service_role','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user')
      and r.oid<>c.relowner and not r.rolsuper and case when e.kind='S' then has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
        else has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end) bad on true
  union all
  select 'rpc_signature_security_path_owner',count(*) filter (where p.oid is null or pg_get_function_result(p.oid)<>e.result_type
      or p.prosecdef<>e.must_be_definer or p.proconfig is distinct from array['search_path=pg_catalog, public']
      or p.proowner is distinct from (select oid from approved_owner))=0,
    count(*) filter (where p.oid is null or pg_get_function_result(p.oid)<>e.result_type
      or p.prosecdef<>e.must_be_definer or p.proconfig is distinct from array['search_path=pg_catalog, public']
      or p.proowner is distinct from (select oid from approved_owner))
    from resolved_functions e left join pg_proc p on p.oid=e.oid
  union all
  select 'rpc_signature_set_exact',count(*)=0,count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('phase10_touch_category_mapping','resolve_category_area','create_routed_ticket','claim_area_ticket','admin_route_ticket','switch_analyst_area')
      and not exists(select 1 from resolved_functions e where e.oid=p.oid)
  union all
  select 'service_role_exact_rpc_execute',count(*) filter (where p.oid is null or has_function_privilege('service_role',p.oid,'EXECUTE')<>e.service_execute)=0,
    count(*) filter (where p.oid is null or has_function_privilege('service_role',p.oid,'EXECUTE')<>e.service_execute)
    from resolved_functions e left join pg_proc p on p.oid=e.oid
  union all
  select 'browser_public_rpc_denial',count(*) filter (where p.oid is null or has_function_privilege('anon',p.oid,'EXECUTE')
      or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))=0,
    count(*) filter (where p.oid is null or has_function_privilege('anon',p.oid,'EXECUTE')
      or has_function_privilege('authenticated',p.oid,'EXECUTE')
      or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'))
    from resolved_functions e left join pg_proc p on p.oid=e.oid
  union all
  select 'unexpected_effective_rpc_grantees',count(*) filter (where p.oid is null or bad.role_oid is not null)=0,
    count(*) filter (where p.oid is null or bad.role_oid is not null)
    from resolved_functions e left join pg_proc p on p.oid=e.oid
    left join lateral (select r.oid role_oid from pg_roles r where p.oid is not null and r.rolname<>'service_role'
      and r.oid<>p.proowner and not r.rolsuper and has_function_privilege(r.oid,p.oid,'EXECUTE')) bad on true
  union all
  select 'mapping_index_valid',count(i.indexrelid)=1,case when count(i.indexrelid)=1 then 0 else 1 end
    from (select to_regclass('public.category_area_mappings') table_oid,to_regclass('public.category_area_mappings_active_area_idx') index_oid) o
    left join pg_index i on i.indrelid=o.table_oid and i.indexrelid=o.index_oid and i.indisvalid and i.indisready
  union all
  select 'mapping_trigger_definition_and_state',count(t.oid)=1,case when count(t.oid)=1 then 0 else 1 end
    from (select to_regclass('public.category_area_mappings') table_oid) o left join pg_trigger t on t.tgrelid=o.table_oid
      and t.tgname='category_area_mappings_touch' and not t.tgisinternal and t.tgenabled='O'
      and pg_get_triggerdef(t.oid,true) ilike 'CREATE TRIGGER category_area_mappings_touch BEFORE UPDATE ON %category_area_mappings FOR EACH ROW EXECUTE FUNCTION %phase10_touch_category_mapping()'
  union all
  select 'mapping_constraints',count(*) filter (where c.oid is null)=0,count(*) filter (where c.oid is null) from (values
    ('category_area_mappings_pkey','PRIMARY KEY (category_key)'),
    ('category_area_mappings_area_id_fkey','FOREIGN KEY (area_id) REFERENCES areas(id) ON UPDATE RESTRICT ON DELETE RESTRICT'),
    ('category_area_mappings_key_check',E'CHECK (category_key = ANY (ARRAY[\'platform\', \'tests\', \'requests\', \'integrations\']))')
  ) e(name,definition) left join pg_constraint c on c.conrelid=to_regclass('public.category_area_mappings')
    and c.conname=e.name and c.convalidated
    and regexp_replace(pg_get_constraintdef(c.oid,true),'[[:space:]()]|::text','','g')=regexp_replace(e.definition,'[[:space:]()]|::text','','g')
  union all
  select 'tickets_browser_denial_intact',count(*) filter (where c.oid is null or
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0))=0,
    count(*) filter (where c.oid is null or has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0))
    from (values(to_regclass('public.tickets'))) expected(oid) left join pg_class c on c.oid=expected.oid
), checks as (
  select check_name,case when ok then 'PASS' else 'FAIL' end status,
    format('%s contract violations (counts only)',greatest(n,0)) detail
  from check_results
)
select check_name,status,detail from checks order by check_name;

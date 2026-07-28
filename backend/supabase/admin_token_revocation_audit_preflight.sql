-- Read-only preflight. Run as postgres or supabase_admin before the migration.
with required_relations(name, oid) as (values
  ('dashboard_tokens', to_regclass('public.dashboard_tokens')),
  ('audit_log', to_regclass('public.audit_log'))
), required_columns(relation_name, column_name, expected_type, nullable) as (values
  ('dashboard_tokens','id','bigint',false),
  ('dashboard_tokens','token_hash','text',false),
  ('dashboard_tokens','name','text',false),
  ('dashboard_tokens','role','text',true),
  ('dashboard_tokens','active','boolean',true),
  ('dashboard_tokens','created_at','timestamp with time zone',true),
  ('audit_log','actor_name','text',false),
  ('audit_log','actor_role','text',false),
  ('audit_log','action','text',false),
  ('audit_log','target_id','text',true),
  ('audit_log','metadata','jsonb',true),
  ('audit_log','created_at','timestamp with time zone',true)
), column_drift as (
  select e.relation_name, e.column_name
  from required_columns e
  left join information_schema.columns c on c.table_schema='public'
    and c.table_name=e.relation_name and c.column_name=e.column_name
    and c.data_type=e.expected_type
    and (e.nullable or c.is_nullable='NO')
  where c.column_name is null
), function_set as (
  select p.oid, pg_get_function_identity_arguments(p.oid) args,
    pg_get_function_result(p.oid) result
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='revoke_agent_token_with_audit'
), approved_owner as (
  select oid, rolname from pg_roles where rolname in ('postgres','supabase_admin')
  order by case rolname when 'postgres' then 1 else 2 end limit 1
), checks as (
  select 'required_relations' check_name, bool_and(oid is not null) ok,
    string_agg(name||'='||coalesce(oid::text,'missing'),', ') detail from required_relations
  union all
  select 'required_columns', count(*)=0, 'drift='||count(*) from column_drift
  union all
  select 'approved_owner', count(*)=1, 'available='||count(*) from approved_owner
  union all
  select 'exact_signature_compatible', count(*) filter (where args='p_token_id bigint, p_actor_token_id bigint, p_request_id text' and result='jsonb') in (0,1),
    'compatible='||count(*) filter (where args='p_token_id bigint, p_actor_token_id bigint, p_request_id text' and result='jsonb') from function_set
  union all
  select 'unexpected_overloads', count(*)=0, 'unexpected='||count(*) from function_set
    where args<>'p_token_id bigint, p_actor_token_id bigint, p_request_id text'
       or result<>'jsonb'
)
select check_name, case when ok then 'PASS' else 'FAIL' end status, detail
from checks order by check_name;

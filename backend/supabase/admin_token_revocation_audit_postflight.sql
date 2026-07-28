-- Read-only postflight. Every row must be PASS before backend enablement.
with target as (
  select to_regprocedure('public.revoke_agent_token_with_audit(bigint,bigint,text)') oid
), function_set as (
  select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='revoke_agent_token_with_audit'
), approved_owner as (
  select oid from pg_roles where rolname in ('postgres','supabase_admin')
), checks as (
  select 'exact_signature' check_name, (select oid from target) is not null ok
  union all select 'returns_jsonb', coalesce(pg_get_function_result(t.oid)='jsonb',false) from target t
  union all select 'security_definer', coalesce(p.prosecdef,false) from target t left join pg_proc p on p.oid=t.oid
  union all select 'approved_owner', coalesce(p.proowner in (select oid from approved_owner),false) from target t left join pg_proc p on p.oid=t.oid
  union all select 'fixed_search_path', coalesce(p.proconfig=array['search_path=pg_catalog, public'],false) from target t left join pg_proc p on p.oid=t.oid
  union all select 'exact_overload_set', (select count(*) from function_set)=1
  union all select 'service_role_execute', coalesce(has_function_privilege('service_role',t.oid,'EXECUTE'),false) from target t
  union all select 'browser_public_denial', coalesce(not has_function_privilege('anon',t.oid,'EXECUTE')
    and not has_function_privilege('authenticated',t.oid,'EXECUTE')
    and not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=t.oid and a.grantee=0 and a.privilege_type='EXECUTE'),false) from target t
  union all select 'unexpected_effective_grantees', coalesce(not exists(
    select 1 from pg_roles r, target x, pg_proc p where p.oid=x.oid
      and r.rolname<>'service_role' and r.oid<>p.proowner and not r.rolsuper
      and has_function_privilege(r.oid,p.oid,'EXECUTE')),false)
)
select check_name,case when ok then 'PASS' else 'FAIL' end status,
  case when ok then '0 contract violations' else '1 contract violation' end detail
from checks order by check_name;

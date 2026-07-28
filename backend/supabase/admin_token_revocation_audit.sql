-- Execute manually only after every preflight row is PASS.
begin;
set local search_path = pg_catalog, public;

do $contract$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='revoke_agent_token_with_audit'
      and pg_get_function_identity_arguments(p.oid)<>'p_token_id bigint, p_actor_token_id bigint, p_request_id text'
  ) then raise exception 'TOKEN_REVOCATION_MIGRATION: unexpected overload'; end if;
  if not exists (select 1 from pg_roles where rolname in ('postgres','supabase_admin')) then
    raise exception 'TOKEN_REVOCATION_MIGRATION: approved owner unavailable';
  end if;
end $contract$;

create or replace function public.revoke_agent_token_with_audit(
  p_token_id bigint,
  p_actor_token_id bigint,
  p_request_id text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_name text;
  v_name text;
  v_role text;
  v_active boolean;
  v_created_at timestamptz;
begin
  if p_token_id is null or p_token_id <= 0 or p_actor_token_id is null or p_actor_token_id <= 0
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'TOKEN_REVOCATION_INVALID_INPUT' using errcode = '22023';
  end if;

  select t.name into v_actor_name
  from public.dashboard_tokens t
  where t.id=p_actor_token_id and t.role='admin' and t.active is true
  for key share;
  if v_actor_name is null then
    raise exception 'TOKEN_REVOCATION_ACTOR_DENIED' using errcode = '42501';
  end if;

  select t.name,t.role,t.active,t.created_at into v_name,v_role,v_active,v_created_at
  from public.dashboard_tokens t where t.id=p_token_id for update;
  if not found then return jsonb_build_object('outcome','not_found'); end if;
  if v_role is distinct from 'agent' then return jsonb_build_object('outcome','wrong_role'); end if;
  if v_active is not true then
    return jsonb_build_object('outcome','already_revoked','token',jsonb_build_object(
      'id',p_token_id,'name',v_name,'role','agent','active',false,'created_at',v_created_at));
  end if;

  update public.dashboard_tokens set active=false where id=p_token_id and active is true;
  if not found then raise exception 'TOKEN_REVOCATION_CONFLICT'; end if;
  insert into public.audit_log(actor_name,actor_role,action,target_id,metadata)
  values(v_actor_name,'admin','agent_token.revoked',p_token_id::text,jsonb_build_object(
    'name',v_name,'role','agent','actor_token_id',p_actor_token_id,'request_id',p_request_id));

  return jsonb_build_object('outcome','revoked','token',jsonb_build_object(
    'id',p_token_id,'name',v_name,'role','agent','active',false,'created_at',v_created_at));
end
$function$;

do $owner$
declare v_owner text;
begin
  select rolname into v_owner from pg_roles where rolname in ('postgres','supabase_admin')
  order by case rolname when 'postgres' then 1 else 2 end limit 1;
  execute format('alter function public.revoke_agent_token_with_audit(bigint,bigint,text) owner to %I',v_owner);
end $owner$;

revoke all on function public.revoke_agent_token_with_audit(bigint,bigint,text) from public, anon, authenticated, service_role;
grant execute on function public.revoke_agent_token_with_audit(bigint,bigint,text) to service_role;
commit;

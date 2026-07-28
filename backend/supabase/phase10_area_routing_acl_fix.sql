-- Fix-forward for Phase 10 installations applied before routing ACL hardening.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public;

alter table public.areas enable row level security;
alter table public.analysts enable row level security;
alter table public.ticket_assignments enable row level security;
alter table public.category_area_mappings enable row level security;
alter table public.tickets enable row level security;

revoke all on table public.areas, public.analysts, public.ticket_assignments,
  public.category_area_mappings, public.tickets from public, anon, authenticated, service_role;
grant select, insert, update on table public.areas, public.analysts,
  public.ticket_assignments, public.category_area_mappings to service_role;
grant select, insert, update, delete on table public.tickets to service_role;

do $acl_fix$
declare item record; grant_source record;
begin
  for item in
    select c.oid,c.relkind,c.relowner,n.nspname,c.relname
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and (
      c.relname in ('areas','analysts','ticket_assignments','category_area_mappings','tickets')
      or (c.relkind='S' and exists (
        select 1 from pg_depend d join pg_class t on t.oid=d.refobjid join pg_namespace tn on tn.oid=t.relnamespace
        where d.objid=c.oid and d.refobjsubid>0 and d.deptype in ('a','i') and tn.nspname='public'
          and t.relname in ('areas','analysts','ticket_assignments','category_area_mappings','tickets'))))
  loop
    execute format('revoke all on %s %I.%I from public, anon, authenticated, service_role',
      case when item.relkind='S' then 'sequence' else 'table' end,item.nspname,item.relname);
    for grant_source in
      select distinct r.rolname
      from aclexplode(coalesce((select c2.relacl from pg_class c2 where c2.oid=item.oid),
        acldefault(case when item.relkind='S' then 'S'::"char" else 'r'::"char" end,item.relowner))) acl
      join pg_roles r on r.oid=acl.grantee
      where r.oid<>item.relowner and not r.rolsuper
        and r.rolname not in ('service_role','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user')
    loop
      execute format('revoke all on %s %I.%I from %I',case when item.relkind='S' then 'sequence' else 'table' end,item.nspname,item.relname,grant_source.rolname);
    end loop;
    if item.relkind='S' then execute format('grant usage, select on sequence %I.%I to service_role',item.nspname,item.relname); end if;
  end loop;
end $acl_fix$;

grant select, insert, update on table public.areas, public.analysts,
  public.ticket_assignments, public.category_area_mappings to service_role;
grant select, insert, update, delete on table public.tickets to service_role;

do $function_fix$
declare approved_owner name; item record; grant_source record;
begin
  select rolname into approved_owner from pg_roles where rolname in ('postgres','supabase_admin')
  order by case rolname when 'postgres' then 1 else 2 end limit 1;
  if approved_owner is null then raise exception 'PHASE10_ACL_FIX: no approved platform function owner exists'; end if;
  for item in select p.oid,p.oid::regprocedure::text identity,p.proowner,p.proname
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('phase10_touch_category_mapping','resolve_category_area','create_routed_ticket','claim_area_ticket','admin_route_ticket','switch_analyst_area')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',item.identity);
    for grant_source in select distinct r.rolname
      from aclexplode(coalesce((select p2.proacl from pg_proc p2 where p2.oid=item.oid),acldefault('f',item.proowner))) acl
      join pg_roles r on r.oid=acl.grantee
      where r.oid<>item.proowner and not r.rolsuper and r.rolname<>'service_role'
    loop execute format('revoke all on function %s from %I',item.identity,grant_source.rolname); end loop;
    execute format('alter function %s %s',item.identity,case when item.proname='phase10_touch_category_mapping' then 'security invoker' else 'security definer' end);
    execute format('alter function %s set search_path = pg_catalog, public',item.identity);
    execute format('alter function %s owner to %I',item.identity,approved_owner);
  end loop;
end $function_fix$;

grant execute on function public.resolve_category_area(text) to service_role;
grant execute on function public.create_routed_ticket(text,text,text,text,text,text,text,text,text,uuid) to service_role;
grant execute on function public.claim_area_ticket(bigint,bigint) to service_role;
grant execute on function public.admin_route_ticket(text,bigint,bigint,bigint,text,jsonb) to service_role;
grant execute on function public.switch_analyst_area(bigint,bigint,text,jsonb) to service_role;
commit;

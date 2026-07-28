begin;
set local search_path = public, pg_catalog;

create table if not exists public.category_area_mappings (
  category_key text primary key,
  area_id bigint not null references public.areas(id) on update restrict on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint category_area_mappings_key_check check (category_key in ('platform','tests','requests','integrations'))
);
create index if not exists category_area_mappings_active_area_idx on public.category_area_mappings(area_id) where active;
alter table public.analysts add column if not exists area_revision bigint not null default 0;
alter table public.areas enable row level security;
alter table public.analysts enable row level security;
alter table public.ticket_assignments enable row level security;
alter table public.category_area_mappings enable row level security;
alter table public.tickets enable row level security;

-- Routing relations are backend-only. Reset service_role too so historical
-- GRANT ALL entries cannot retain TRUNCATE, REFERENCES, or TRIGGER.
revoke all on table public.areas, public.analysts, public.ticket_assignments,
  public.category_area_mappings, public.tickets from public, anon, authenticated, service_role;
grant select, insert, update on table public.areas, public.analysts,
  public.ticket_assignments, public.category_area_mappings to service_role;
grant select, insert, update, delete on table public.tickets to service_role;

do $routing_sequence_acl$
declare item record; grant_source record;
begin
  for item in
    select distinct seq.oid, ns.nspname, seq.relname, seq.relowner
    from pg_class table_rel
    join pg_namespace table_ns on table_ns.oid=table_rel.relnamespace
    join pg_depend dep on dep.refobjid=table_rel.oid and dep.refobjsubid>0 and dep.deptype in ('a','i')
    join pg_class seq on seq.oid=dep.objid and seq.relkind='S'
    join pg_namespace ns on ns.oid=seq.relnamespace
    where table_ns.nspname='public'
      and table_rel.relname in ('areas','analysts','ticket_assignments','category_area_mappings','tickets')
  loop
    execute format('revoke all on sequence %I.%I from public, anon, authenticated, service_role',item.nspname,item.relname);
    for grant_source in
      select distinct r.rolname from aclexplode(coalesce((select c.relacl from pg_class c where c.oid=item.oid),acldefault('S',item.relowner))) acl
      join pg_roles r on r.oid=acl.grantee
      where r.oid<>item.relowner and not r.rolsuper
        and r.rolname not in ('service_role','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user')
    loop execute format('revoke all on sequence %I.%I from %I',item.nspname,item.relname,grant_source.rolname); end loop;
    execute format('grant usage, select on sequence %I.%I to service_role',item.nspname,item.relname);
  end loop;
end $routing_sequence_acl$;

do $routing_table_acl$
declare item record; grant_source record;
begin
  for item in select c.oid,c.relowner,n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
      and c.relname in ('areas','analysts','ticket_assignments','category_area_mappings','tickets')
  loop
    for grant_source in
      select distinct r.rolname from aclexplode(coalesce((select c.relacl from pg_class c where c.oid=item.oid),acldefault('r',item.relowner))) acl
      join pg_roles r on r.oid=acl.grantee
      where r.oid<>item.relowner and not r.rolsuper
        and r.rolname not in ('service_role','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user')
    loop execute format('revoke all on table %I.%I from %I',item.nspname,item.relname,grant_source.rolname); end loop;
  end loop;
end $routing_table_acl$;

create or replace function public.phase10_touch_category_mapping() returns trigger language plpgsql security invoker set search_path = public, pg_catalog as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists category_area_mappings_touch on public.category_area_mappings;
create trigger category_area_mappings_touch before update on public.category_area_mappings for each row execute function public.phase10_touch_category_mapping();

do $$
declare
  v_integrations bigint;
  v_support bigint;
  v_integrations_all integer;
  v_integrations_active integer;
  v_support_all integer;
  v_support_active integer;
  v_required_columns text;
begin
  -- Serialize Phase 10 canonical-area creation without changing the areas schema.
  perform pg_advisory_xact_lock(hashtextextended('nexo:phase10:canonical-areas', 0));
  select count(*), count(*) filter (where active), min(id) filter (where active)
    into v_integrations_all, v_integrations_active, v_integrations
  from public.areas
  where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) in ('integraciones','soporte integraciones');
  if v_integrations_all <> 1 or v_integrations_active <> 1 then
    raise exception 'PHASE10_MIGRATION: Integrations aliases are missing, inactive, or duplicated; rerun preflight';
  end if;

  select count(*), count(*) filter (where active), min(id) filter (where active)
    into v_support_all, v_support_active, v_support
  from public.areas
  where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'soporte magneto';
  if v_support_all > 1 or (v_support_all = 1 and v_support_active <> 1) then
    raise exception 'PHASE10_MIGRATION: Soporte Magneto alias is inactive or duplicated; rerun preflight';
  end if;

  if v_support_all = 0 then
    select string_agg(a.attname, ', ' order by a.attnum)
      into v_required_columns
    from pg_attribute a
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.areas'::regclass
      and a.attnum > 0 and not a.attisdropped and a.attnotnull
      and a.attname not in ('name','active')
      and a.attidentity = '' and a.attgenerated = '' and d.adbin is null;
    if v_required_columns is not null then
      raise exception 'PHASE10_MIGRATION: cannot safely create Soporte Magneto; public.areas requires values without defaults for columns: %', v_required_columns;
    end if;
    insert into public.areas(name, active) values ('Soporte Magneto', true)
      on conflict (name) do nothing;
    select count(*), count(*) filter (where active), min(id) filter (where active)
      into v_support_all, v_support_active, v_support
    from public.areas
    where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'soporte magneto';
  end if;
  if v_support_all <> 1 or v_support_active <> 1 or v_support is null then
    raise exception 'PHASE10_MIGRATION: Soporte Magneto did not converge to exactly one active area';
  end if;

  insert into public.category_area_mappings(category_key, area_id, active) values
    ('platform',v_support,true),('tests',v_support,true),('requests',v_support,true),('integrations',v_integrations,true)
  on conflict(category_key) do update set area_id=excluded.area_id, active=true;

end $$;

create or replace function public.resolve_category_area(p_category_key text) returns bigint
language sql stable security definer set search_path = public, pg_catalog as $$
  select m.area_id from public.category_area_mappings m join public.areas a on a.id=m.area_id
  where m.category_key=lower(trim(p_category_key)) and m.active and a.active;
$$;

create or replace function public.create_routed_ticket(
 p_chat_id text, p_telefono text, p_nombre_analista text, p_nombre_empresa text, p_correo text,
 p_situacion text, p_categoria text, p_category_key text, p_prioridad text default null, p_submission_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_area_id bigint; v_ticket public.tickets; v_analyst_id bigint; v_created boolean := true;
begin
  v_area_id := public.resolve_category_area(p_category_key);
  if v_area_id is null then raise exception 'CATEGORY_ROUTING_UNAVAILABLE' using errcode='P0001'; end if;
  if lower(trim(p_category_key)) not in ('platform','tests','requests','integrations') then raise exception 'CATEGORY_ROUTING_UNAVAILABLE' using errcode='P0001'; end if;
  if p_submission_id is not null then select * into v_ticket from public.tickets where bot_submission_id::text=p_submission_id::text; end if;
  if v_ticket.id is null then
    begin
      insert into public.tickets(chat_id,telefono,nombre_analista,nombre_empresa,correo,situacion,categoria,prioridad,status,area_id,bot_submission_id)
      values(p_chat_id,p_telefono,p_nombre_analista,p_nombre_empresa,p_correo,p_situacion,p_categoria,p_prioridad,'open',v_area_id,p_submission_id::text)
      returning * into v_ticket;
    exception when unique_violation then
      if p_submission_id is null then raise; end if;
       select * into v_ticket from public.tickets where bot_submission_id::text=p_submission_id::text;
      if v_ticket.id is null then raise; end if;
      v_created := false;
    end;
  else v_created := false;
  end if;
  if v_created then
    select a.id into v_analyst_id
    from public.analysts a
    join public.dashboard_tokens dt on dt.id=a.token_id and dt.active
    where a.area_id=v_area_id and a.available
    order by (select count(*) from public.ticket_assignments ta join public.tickets assigned on assigned.id=ta.ticket_id where ta.analyst_id=a.id and assigned.status<>'closed'), a.last_seen nulls first, a.id
    for update of a skip locked limit 1;
    if v_analyst_id is not null then
      insert into public.ticket_assignments(ticket_id,analyst_id,assigned_at,assigned_by)
      values(v_ticket.id,v_analyst_id,now(),'auto') on conflict(ticket_id) do nothing;
    end if;
  end if;
   return to_jsonb(v_ticket) || jsonb_build_object('bot_submission_id',v_ticket.bot_submission_id::text,'created',v_created);
end $$;

create or replace function public.admin_route_ticket(
  p_action text, p_ticket_id bigint, p_area_id bigint default null, p_analyst_id bigint default null,
  p_actor_name text default 'admin', p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_ticket public.tickets; v_analyst public.analysts; v_action text := lower(trim(p_action)); v_previous_area_id bigint;
begin
  if v_action not in ('assign','unassign','transfer') then raise exception 'INVALID_ROUTING_ACTION' using errcode='22023'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'TICKET_NOT_FOUND' using errcode='P0002'; end if;
  v_previous_area_id := v_ticket.area_id;
  if v_action='transfer' then
    perform 1 from public.areas where id=p_area_id and active;
    if not found then raise exception 'TARGET_AREA_UNAVAILABLE' using errcode='23514'; end if;
    update public.tickets set area_id=p_area_id where id=p_ticket_id returning * into v_ticket;
  end if;
  if v_action='unassign' then
    insert into public.ticket_assignments(ticket_id,analyst_id,assigned_at,assigned_by) values(p_ticket_id,null,now(),'manual')
    on conflict(ticket_id) do update set analyst_id=null,assigned_at=now(),assigned_by='manual';
  elsif p_analyst_id is not null then
    select * into v_analyst from public.analysts where id=p_analyst_id and available for update;
    if not found or v_analyst.area_id is distinct from v_ticket.area_id then raise exception 'ANALYST_NOT_ELIGIBLE' using errcode='23514'; end if;
    insert into public.ticket_assignments(ticket_id,analyst_id,assigned_at,assigned_by) values(p_ticket_id,p_analyst_id,now(),case when v_action='transfer' then 'transfer' else 'manual' end)
    on conflict(ticket_id) do update set analyst_id=excluded.analyst_id,assigned_at=excluded.assigned_at,assigned_by=excluded.assigned_by;
  else
    insert into public.ticket_assignments(ticket_id,analyst_id,assigned_at,assigned_by) values(p_ticket_id,null,now(),v_action)
    on conflict(ticket_id) do update set analyst_id=null,assigned_at=now(),assigned_by=excluded.assigned_by;
  end if;
  insert into public.audit_log(actor_name,actor_role,action,target_id,metadata)
  values(p_actor_name,'admin','ticket.'||v_action,p_ticket_id::text,p_metadata || jsonb_build_object('area_id',v_ticket.area_id,'analyst_id',p_analyst_id,'admin_override',true));
  return to_jsonb(v_ticket) || jsonb_build_object('previous_area_id',v_previous_area_id);
end $$;

create or replace function public.switch_analyst_area(
  p_analyst_id bigint,p_area_id bigint,p_actor_name text default 'admin',p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_analyst public.analysts; v_previous bigint; v_unassigned bigint[];
begin
  perform 1 from public.areas where id=p_area_id and active;
  if not found then raise exception 'TARGET_AREA_UNAVAILABLE' using errcode='23514'; end if;
  select * into v_analyst from public.analysts where id=p_analyst_id for update;
  if not found then raise exception 'ANALYST_NOT_FOUND' using errcode='P0002'; end if;
  v_previous:=v_analyst.area_id;
  with changed as (
    update public.ticket_assignments ta set analyst_id=null,assigned_at=now(),assigned_by='area_switch'
    from public.tickets t where ta.ticket_id=t.id and ta.analyst_id=p_analyst_id and t.status<>'closed' and t.area_id is distinct from p_area_id
    returning ta.ticket_id
  ) select coalesce(array_agg(ticket_id),'{}') into v_unassigned from changed;
  update public.analysts set area_id=p_area_id,area_revision=area_revision+1 where id=p_analyst_id returning * into v_analyst;
  insert into public.audit_log(actor_name,actor_role,action,target_id,metadata)
  values(p_actor_name,'admin','analyst.area_switched',p_analyst_id::text,p_metadata || jsonb_build_object('previous_area_id',v_previous,'area_id',p_area_id,'unassigned_ticket_ids',v_unassigned));
  return to_jsonb(v_analyst) || jsonb_build_object('previous_area_id',v_previous,'area_revision',v_analyst.area_revision,'unassigned_ticket_ids',v_unassigned);
end $$;

create or replace function public.claim_area_ticket(p_ticket_id bigint,p_analyst_id bigint) returns boolean
language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_rows integer;
begin
  perform 1 from public.tickets t join public.areas ar on ar.id=t.area_id and ar.active
    join public.analysts a on a.id=p_analyst_id and a.area_id=t.area_id and a.available
    join public.dashboard_tokens dt on dt.id=a.token_id and dt.active
    where t.id=p_ticket_id and t.status<>'closed' for update of t;
  if not found then return false; end if;
  insert into public.ticket_assignments(ticket_id,analyst_id,assigned_at,assigned_by)
  values(p_ticket_id,p_analyst_id,now(),'self') on conflict(ticket_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $$;

revoke all on function public.resolve_category_area(text) from public, anon, authenticated;
revoke all on function public.create_routed_ticket(text,text,text,text,text,text,text,text,text,uuid) from public, anon, authenticated;
revoke all on function public.claim_area_ticket(bigint,bigint) from public, anon, authenticated;
revoke all on function public.admin_route_ticket(text,bigint,bigint,bigint,text,jsonb) from public, anon, authenticated;
revoke all on function public.switch_analyst_area(bigint,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.resolve_category_area(text) to service_role;
grant execute on function public.create_routed_ticket(text,text,text,text,text,text,text,text,text,uuid) to service_role;
grant execute on function public.claim_area_ticket(bigint,bigint) to service_role;
grant execute on function public.admin_route_ticket(text,bigint,bigint,bigint,text,jsonb) to service_role;
grant execute on function public.switch_analyst_area(bigint,bigint,text,jsonb) to service_role;

do $routing_function_contract$
declare approved_owner name; item record; grant_source record;
begin
  select rolname into approved_owner from pg_roles where rolname in ('postgres','supabase_admin')
  order by case rolname when 'postgres' then 1 else 2 end limit 1;
  if approved_owner is null then raise exception 'PHASE10_MIGRATION: no approved platform function owner exists'; end if;
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
end $routing_function_contract$;

grant execute on function public.resolve_category_area(text) to service_role;
grant execute on function public.create_routed_ticket(text,text,text,text,text,text,text,text,text,uuid) to service_role;
grant execute on function public.claim_area_ticket(bigint,bigint) to service_role;
grant execute on function public.admin_route_ticket(text,bigint,bigint,bigint,text,jsonb) to service_role;
grant execute on function public.switch_analyst_area(bigint,bigint,text,jsonb) to service_role;
commit;

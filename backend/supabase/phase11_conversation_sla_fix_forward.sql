begin;
set local search_path = pg_catalog, public;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
select pg_advisory_xact_lock(hashtextextended('nexo:phase11:conversation-sla',0));

-- This repair is intentionally for an already-applied Phase 11 baseline. Refuse
-- to manufacture a mixed baseline or guess idempotency data for existing events.
do $preflight$
declare
 v_missing text;
 v_events bigint;
 v_bad bigint;
begin
 select string_agg(name, ', ' order by name) into v_missing
 from (values ('tickets'),('ticket_assignments'),('areas'),('analysts'),('dashboard_tokens'),('audit_log'),('business_calendars'),('business_calendar_windows'),
  ('business_calendar_exceptions'),('sla_policies'),('development_escalations'),
  ('workflow_events'),('sla_snapshots'),('sla_clock_segments')) expected(name)
 where not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=expected.name and c.relkind='r');
 if v_missing is not null then
  raise exception 'PHASE11_FIX_FORWARD_BASELINE_MISSING: %', v_missing using errcode='55000';
 end if;
 select count(*) into v_bad from (values
  ('conversation_state','text','NO','''new''::text'),('waiting_reason','text','YES',null),
  ('workflow_revision','bigint','NO','0'),('priority_normalized','text','YES',null)
 ) e(column_name,data_type,is_nullable,column_default)
 left join information_schema.columns c on c.table_schema='public' and c.table_name='tickets' and c.column_name=e.column_name
  and c.data_type=e.data_type and c.is_nullable=e.is_nullable and c.is_identity='NO' and c.column_default is not distinct from e.column_default
 where c.column_name is null;
 if v_bad<>0 then
  raise exception 'PHASE11_FIX_FORWARD_INCOMPATIBLE_TICKET_WORKFLOW_BASELINE: % contract violation(s)',v_bad using errcode='55000';
 end if;
 select count(*) into v_events from public.workflow_events;
 if v_events > 0 and (not exists(select 1 from information_schema.columns where table_schema='public' and table_name='workflow_events' and column_name='request_fingerprint' and data_type='text' and is_nullable='NO' and column_default is null and is_identity='NO')
  or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='workflow_events' and column_name='request_payload' and data_type='jsonb' and is_nullable='NO' and column_default is null and is_identity='NO')) then
  raise exception 'PHASE11_FIX_FORWARD_AMBIGUOUS_EVENT_BACKFILL: existing workflow events cannot be bound to an invented payload' using errcode='55000';
 end if;
 if exists(select 1 from public.development_escalations where status not in ('requested','in_progress','resolved','cancelled')) then
  raise exception 'PHASE11_FIX_FORWARD_INCOMPATIBLE_ESCALATION_STATUS' using errcode='23514';
 end if;
 if exists(select 1 from information_schema.columns where table_schema='public' and table_name='workflow_events' and column_name='request_fingerprint' and (data_type<>'text' or column_default is not null or is_identity<>'NO'))
  or exists(select 1 from information_schema.columns where table_schema='public' and table_name='workflow_events' and column_name='request_payload' and (data_type<>'jsonb' or column_default is not null or is_identity<>'NO')) then
  raise exception 'PHASE11_FIX_FORWARD_INCOMPATIBLE_EVENT_BINDING_COLUMNS' using errcode='42804';
 end if;
end $preflight$;

alter table public.workflow_events add column if not exists request_fingerprint text;
alter table public.workflow_events add column if not exists request_payload jsonb;
do $event_columns$
begin
 if exists(select 1 from public.workflow_events where request_fingerprint is null or request_payload is null) then
  raise exception 'PHASE11_FIX_FORWARD_AMBIGUOUS_EVENT_BINDING' using errcode='55000';
 end if;
 alter table public.workflow_events alter column request_fingerprint set not null;
 alter table public.workflow_events alter column request_payload set not null;
end $event_columns$;
alter table public.tickets alter column conversation_state set default 'new';
alter table public.tickets alter column conversation_state set not null;
alter table public.tickets drop constraint if exists tickets_conversation_state_check;
alter table public.tickets add constraint tickets_conversation_state_check check(conversation_state in ('new','in_progress','waiting','closed'));
comment on constraint tickets_conversation_state_check on public.tickets is 'nexo:phase11:contract:tickets_conversation_state_check:v2:3e839e26a3363307feff4c79852cd715edc1619a11322d87b769d2e06b2b4534';
alter table public.tickets drop constraint if exists tickets_waiting_reason_check;
alter table public.tickets add constraint tickets_waiting_reason_check check(
  (conversation_state='waiting' and waiting_reason in ('customer_response','internal_information','development_escalation','special_situation')) or
  (conversation_state<>'waiting' and waiting_reason is null));
comment on constraint tickets_waiting_reason_check on public.tickets is 'nexo:phase11:contract:tickets_waiting_reason_check:v2:c46be18ae0af91fd9a20b99cbf1cf77788a4785750b47b933bc7a5521fd0953c';
alter table public.tickets drop constraint if exists tickets_priority_normalized_check;
alter table public.tickets add constraint tickets_priority_normalized_check check(priority_normalized is null or priority_normalized in ('critical','high','medium','low'));
comment on constraint tickets_priority_normalized_check on public.tickets is 'nexo:phase11:contract:tickets_priority_normalized_check:v2:86dc1f91c271d4438e41e83d0411c51ef9205b46e82610bc2c8b173986cf41a8';

create table if not exists public.business_calendars(
 id bigint generated by default as identity primary key, area_id bigint references public.areas(id) on delete restrict,
 name text not null, timezone text not null default 'America/Bogota', version bigint not null default 1,
 active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(area_id,name,version), check(length(timezone) between 1 and 100)
);
create table if not exists public.business_calendar_windows(
 id bigint generated by default as identity primary key, calendar_id bigint not null references public.business_calendars(id) on delete cascade,
 weekday smallint not null check(weekday between 0 and 6), starts_at time not null, ends_at time not null,
 constraint business_calendar_windows_calendar_id_weekday_starts_at_ends_at unique(calendar_id,weekday,starts_at,ends_at), check(starts_at<>ends_at)
);
create table if not exists public.business_calendar_exceptions(
 id bigint generated by default as identity primary key, calendar_id bigint not null references public.business_calendars(id) on delete cascade,
 exception_date date not null, closed boolean not null default true, windows jsonb,
 unique(calendar_id,exception_date), check((closed and windows is null) or (not closed and jsonb_typeof(windows)='array'))
);
create table if not exists public.sla_policies(
 id bigint generated by default as identity primary key, area_id bigint not null references public.areas(id) on delete restrict,
 priority text not null check(priority in ('critical','high','medium','low')),
 clock_type text not null check(clock_type in ('support','development')),
 clock_mode text not null default 'business_hours' check(clock_mode in ('business_hours','24x7')),
 calendar_id bigint references public.business_calendars(id) on delete restrict,
 target_minutes integer not null check(target_minutes>0), warning_minutes integer not null check(warning_minutes>=0 and warning_minutes<target_minutes),
 version bigint not null default 1, active boolean not null default true, created_at timestamptz not null default now(), created_by text not null,
 unique(area_id,priority,clock_type,version), check(clock_mode='24x7' or calendar_id is not null)
);
drop index if exists public.sla_policies_one_active_idx;
create unique index sla_policies_one_active_idx on public.sla_policies(area_id,priority,clock_type) where active;
comment on index public.sla_policies_one_active_idx is 'nexo:phase11:contract:sla_policies_one_active_idx:v2:4871a14123de8e6c2af8aa69857d5a51482b54c57e735c2aca88866572fea6d3';
create table if not exists public.development_escalations(
 id bigint generated by default as identity primary key, ticket_id bigint not null references public.tickets(id) on delete restrict,
 status text not null check(status in ('requested','in_progress','resolved','cancelled')), revision bigint not null default 0,
 requested_by text not null, requested_at timestamptz not null default now(), updated_at timestamptz not null default now(), resolved_at timestamptz,
 unique(ticket_id,id)
);
alter table public.development_escalations drop constraint if exists development_escalations_status_check;
alter table public.development_escalations add constraint development_escalations_status_check check(status in ('requested','in_progress','resolved','cancelled'));
comment on constraint development_escalations_status_check on public.development_escalations is 'nexo:phase11:contract:development_escalations_status_check:v2:cdd48389db888f5dbfb103be24a2a46d67a63c794744c61aa376563405cc87a4';
drop index if exists public.development_escalations_active_ticket_idx;
create unique index development_escalations_active_ticket_idx on public.development_escalations(ticket_id) where status in ('requested','in_progress');
comment on index public.development_escalations_active_ticket_idx is 'nexo:phase11:contract:development_escalations_active_ticket_idx:v2:c628888b2dfab86d5025997a588d7f333a3714976e721196b353dbcbb10501e5';
create table if not exists public.workflow_events(
 id bigint generated by default as identity primary key, ticket_id bigint not null references public.tickets(id) on delete restrict,
 escalation_id bigint references public.development_escalations(id) on delete restrict, event_type text not null,
 from_value text, to_value text, actor_id text not null, actor_name text not null, actor_role text not null,
 idempotency_key text not null, request_fingerprint text not null, request_payload jsonb not null,
 metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
 unique(actor_id,idempotency_key)
);
create table if not exists public.sla_snapshots(
 id bigint generated by default as identity primary key, ticket_id bigint not null references public.tickets(id) on delete restrict,
 escalation_id bigint references public.development_escalations(id) on delete restrict, clock_type text not null check(clock_type in ('support','development')),
 policy_id bigint not null references public.sla_policies(id) on delete restrict, policy_version bigint not null,
 calendar_id bigint references public.business_calendars(id) on delete restrict, calendar_version bigint,
 clock_mode text not null check(clock_mode in ('business_hours','24x7')), timezone text not null,
 target_minutes integer not null, warning_minutes integer not null, calendar_snapshot jsonb not null,
 created_at timestamptz not null default now(), unique(ticket_id,escalation_id,clock_type)
);
drop index if exists public.sla_snapshots_support_once_idx;
create unique index sla_snapshots_support_once_idx on public.sla_snapshots(ticket_id,clock_type) where escalation_id is null;
comment on index public.sla_snapshots_support_once_idx is 'nexo:phase11:contract:sla_snapshots_support_once_idx:v2:df9edd6e9e515a9323270227cd7fdab574bbc9c9e514d0a658e50726df203262';
drop index if exists public.sla_snapshots_escalation_once_idx;
create unique index sla_snapshots_escalation_once_idx on public.sla_snapshots(escalation_id,clock_type) where escalation_id is not null;
comment on index public.sla_snapshots_escalation_once_idx is 'nexo:phase11:contract:sla_snapshots_escalation_once_idx:v2:569e5b7cd77a773519ab82587bc8164d5502dde4215d6595d47ddbdb523bc509';
create table if not exists public.sla_clock_segments(
 id bigint generated by default as identity primary key, snapshot_id bigint not null references public.sla_snapshots(id) on delete restrict,
 started_at timestamptz not null, stopped_at timestamptz, start_event_id bigint not null references public.workflow_events(id) on delete restrict,
 stop_event_id bigint references public.workflow_events(id) on delete restrict, stop_reason text,
 check(stopped_at is null or stopped_at>=started_at)
);
drop index if exists public.sla_clock_segments_open_idx;
create unique index sla_clock_segments_open_idx on public.sla_clock_segments(snapshot_id) where stopped_at is null;
comment on index public.sla_clock_segments_open_idx is 'nexo:phase11:contract:sla_clock_segments_open_idx:v2:c005e9450a581e2732a7ee439e50a90db27d2e47e830f59f525951356d262833';

-- Contract marker hashes are immutable SHA-256 identifiers for the canonical
-- DDL immediately preceding each COMMENT. Changing canonical DDL requires a
-- new contract version and marker; replacing an object removes its marker.
alter table public.business_calendars drop constraint if exists business_calendars_timezone_check;
alter table public.business_calendars add constraint business_calendars_timezone_check check(length(timezone) between 1 and 100);
comment on constraint business_calendars_timezone_check on public.business_calendars is 'nexo:phase11:contract:business_calendars_timezone_check:v2:6d641b7af706ffc80b8bd6ef962d989232c763a175cee241fa20ec5dd6ba99fa';
alter table public.business_calendar_windows drop constraint if exists business_calendar_windows_weekday_check;
alter table public.business_calendar_windows add constraint business_calendar_windows_weekday_check check(weekday between 0 and 6);
comment on constraint business_calendar_windows_weekday_check on public.business_calendar_windows is 'nexo:phase11:contract:business_calendar_windows_weekday_check:v2:620aa4e1552bef6a252f827d6746b758b676e494a088d2a12111bc47e9d9c546';
alter table public.business_calendar_windows drop constraint if exists business_calendar_windows_check;
alter table public.business_calendar_windows add constraint business_calendar_windows_check check(starts_at<>ends_at);
comment on constraint business_calendar_windows_check on public.business_calendar_windows is 'nexo:phase11:contract:business_calendar_windows_check:v2:661021bf4b91e04e8c56ad9c0d5ce20cc7235e2d9d7356bd0e47fc9390200fa4';
alter table public.business_calendar_exceptions drop constraint if exists business_calendar_exceptions_check;
alter table public.business_calendar_exceptions add constraint business_calendar_exceptions_check check((closed and windows is null) or (not closed and jsonb_typeof(windows)='array'));
comment on constraint business_calendar_exceptions_check on public.business_calendar_exceptions is 'nexo:phase11:contract:business_calendar_exceptions_check:v2:b0061b47e4efad2b348c97a0eea6bf3e7eabb490e5ece48d3162edfb8852c9a5';
alter table public.sla_policies drop constraint if exists sla_policies_priority_check;
alter table public.sla_policies add constraint sla_policies_priority_check check(priority in ('critical','high','medium','low'));
comment on constraint sla_policies_priority_check on public.sla_policies is 'nexo:phase11:contract:sla_policies_priority_check:v2:d2bdb5a68104c9136a5742d629c593395cc373cf756e29e3223e100bd8bd2723';
alter table public.sla_policies drop constraint if exists sla_policies_clock_type_check;
alter table public.sla_policies add constraint sla_policies_clock_type_check check(clock_type in ('support','development'));
comment on constraint sla_policies_clock_type_check on public.sla_policies is 'nexo:phase11:contract:sla_policies_clock_type_check:v2:6ff5cf1bb7abe6b2ca20cba9f6e919dddfbca4c9be1de8a339e8ce3e37c47619';
alter table public.sla_policies drop constraint if exists sla_policies_clock_mode_check;
alter table public.sla_policies add constraint sla_policies_clock_mode_check check(clock_mode in ('business_hours','24x7'));
comment on constraint sla_policies_clock_mode_check on public.sla_policies is 'nexo:phase11:contract:sla_policies_clock_mode_check:v2:a22244dc831f41dc3821a35616e03a35824565577a1f6ef9dea4e2f1b2d542a9';
alter table public.sla_policies drop constraint if exists sla_policies_target_minutes_check;
alter table public.sla_policies add constraint sla_policies_target_minutes_check check(target_minutes>0);
comment on constraint sla_policies_target_minutes_check on public.sla_policies is 'nexo:phase11:contract:sla_policies_target_minutes_check:v2:62acd5b3df939f47805f0dbc847fb8056d73f2c4702f5e713a032b754a0ceb4f';
alter table public.sla_policies drop constraint if exists sla_policies_warning_minutes_check;
alter table public.sla_policies add constraint sla_policies_warning_minutes_check check(warning_minutes>=0 and warning_minutes<target_minutes);
comment on constraint sla_policies_warning_minutes_check on public.sla_policies is 'nexo:phase11:contract:sla_policies_warning_minutes_check:v2:ceb51cb63dba4ac5583e5c0df12d16c5349b4ca25e4ab5e6e71156e5b6b5b607';
alter table public.sla_policies drop constraint if exists sla_policies_check;
alter table public.sla_policies add constraint sla_policies_check check(clock_mode='24x7' or calendar_id is not null);
comment on constraint sla_policies_check on public.sla_policies is 'nexo:phase11:contract:sla_policies_check:v2:8c2efbdda296dab6effcb6fd1d4bb10e07f818f766f2b95f6062ac76a33ccb4f';
alter table public.sla_snapshots drop constraint if exists sla_snapshots_clock_type_check;
alter table public.sla_snapshots add constraint sla_snapshots_clock_type_check check(clock_type in ('support','development'));
comment on constraint sla_snapshots_clock_type_check on public.sla_snapshots is 'nexo:phase11:contract:sla_snapshots_clock_type_check:v2:806ff6a2762a99899081e356e146e6d94824d7a2f275cd06b8800af253cd2ae4';
alter table public.sla_snapshots drop constraint if exists sla_snapshots_clock_mode_check;
alter table public.sla_snapshots add constraint sla_snapshots_clock_mode_check check(clock_mode in ('business_hours','24x7'));
comment on constraint sla_snapshots_clock_mode_check on public.sla_snapshots is 'nexo:phase11:contract:sla_snapshots_clock_mode_check:v2:b97dd8e540a93033e2d41f0a5b901b8c188492d9c8686478756ef5bb36f949fd';
alter table public.sla_clock_segments drop constraint if exists sla_clock_segments_check;
alter table public.sla_clock_segments add constraint sla_clock_segments_check check(stopped_at is null or stopped_at>=started_at);
comment on constraint sla_clock_segments_check on public.sla_clock_segments is 'nexo:phase11:contract:sla_clock_segments_check:v2:c6ca24c24236b9ca6953e5796fa061505c3f8a4c28a1ec295e4e42ff448fe92f';

-- Drop obsolete command overloads with RESTRICT so unexpected dependencies
-- abort the whole repair rather than cascading.
do $obsolete_overloads$
declare f record;
begin
 for f in select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('transition_conversation','claim_conversation','update_development_escalation')
  and p.oid not in (coalesce(to_regprocedure('public.transition_conversation(jsonb,text,text,text,bigint)'),0),coalesce(to_regprocedure('public.claim_conversation(jsonb,text,text,text,bigint)'),0),coalesce(to_regprocedure('public.update_development_escalation(jsonb,text,text,text,bigint)'),0))
 loop execute format('drop function %s restrict',f.signature); end loop;
end $obsolete_overloads$;

create or replace function public.phase11_calendar_snapshot(p_calendar_id bigint) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('timezone',c.timezone,'version',c.version,'windows',coalesce((select jsonb_agg(jsonb_build_object('weekday',w.weekday,'start',w.starts_at,'end',w.ends_at) order by w.weekday,w.starts_at) from public.business_calendar_windows w where w.calendar_id=c.id),'[]'::jsonb),'exceptions',coalesce((select jsonb_agg(jsonb_build_object('date',e.exception_date,'closed',e.closed,'windows',e.windows) order by e.exception_date) from public.business_calendar_exceptions e where e.calendar_id=c.id),'[]'::jsonb)) from public.business_calendars c where c.id=p_calendar_id $$;

create or replace function public.phase11_start_snapshot(p_ticket_id bigint,p_escalation_id bigint,p_clock_type text,p_event_id bigint) returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_ticket public.tickets; v_policy public.sla_policies; v_snapshot bigint; v_timezone text;
begin
 select * into v_ticket from public.tickets where id=p_ticket_id;
 if v_ticket.priority_normalized is null then return null; end if;
 select id into v_snapshot from public.sla_snapshots where ticket_id=p_ticket_id and escalation_id is not distinct from p_escalation_id and clock_type=p_clock_type for update;
 if v_snapshot is not null then insert into public.sla_clock_segments(snapshot_id,started_at,start_event_id) values(v_snapshot,now(),p_event_id) on conflict do nothing; return v_snapshot; end if;
 select * into v_policy from public.sla_policies where area_id=v_ticket.area_id and priority=v_ticket.priority_normalized and clock_type=p_clock_type and active order by version desc limit 1;
 if not found then return null; end if;
 select coalesce(c.timezone,'America/Bogota') into v_timezone from (select 1) x left join public.business_calendars c on c.id=v_policy.calendar_id;
 if v_snapshot is null then
  begin
   insert into public.sla_snapshots(ticket_id,escalation_id,clock_type,policy_id,policy_version,calendar_id,calendar_version,clock_mode,timezone,target_minutes,warning_minutes,calendar_snapshot)
   select p_ticket_id,p_escalation_id,p_clock_type,v_policy.id,v_policy.version,v_policy.calendar_id,c.version,v_policy.clock_mode,v_timezone,v_policy.target_minutes,v_policy.warning_minutes,case when v_policy.clock_mode='24x7' then jsonb_build_object('timezone',v_timezone,'windows','[]'::jsonb,'exceptions','[]'::jsonb) else public.phase11_calendar_snapshot(v_policy.calendar_id) end from (select 1) x left join public.business_calendars c on c.id=v_policy.calendar_id returning id into v_snapshot;
  exception when unique_violation then select id into v_snapshot from public.sla_snapshots where ticket_id=p_ticket_id and escalation_id is not distinct from p_escalation_id and clock_type=p_clock_type for update; end;
 end if;
 insert into public.sla_clock_segments(snapshot_id,started_at,start_event_id) values(v_snapshot,now(),p_event_id) on conflict do nothing;
 insert into public.audit_log(actor_name,actor_role,action,target_id,metadata) values('system','service_role','sla.snapshot_created',p_ticket_id::text,jsonb_build_object('snapshot_id',v_snapshot,'clock_type',p_clock_type));
 return v_snapshot;
end $$;

create or replace function public.phase11_request_fingerprint(p_payload jsonb) returns text language sql immutable security definer set search_path=pg_catalog,public as $$ select md5(p_payload::text) $$;

create or replace function public.phase11_replay(p_actor_id text,p_key text,p_event_type text,p_ticket_id bigint,p_payload jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_event public.workflow_events; v_fingerprint text:=public.phase11_request_fingerprint(p_payload);
begin
 select * into v_event from public.workflow_events where actor_id=p_actor_id and idempotency_key=p_key for update;
 if not found then return null; end if;
 if v_event.event_type<>p_event_type or v_event.ticket_id<>p_ticket_id or v_event.request_fingerprint<>v_fingerprint or v_event.request_payload<>p_payload then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='23505'; end if;
 return jsonb_build_object('ticket_id',v_event.ticket_id,'event_id',v_event.id,'event_type',v_event.event_type,'replayed',true);
end $$;

create or replace function public.phase11_build_actor_context(p_actor_id text,p_actor_role text,p_actor_area_id bigint) returns bigint language plpgsql immutable security definer set search_path=pg_catalog,public as $$
begin
 if p_actor_role='admin' then
  if p_actor_id is null or length(p_actor_id) not between 1 and 256 then raise exception 'INVALID_ACTOR_CONTEXT' using errcode='42501'; end if;
  return null;
 end if;
 if p_actor_role is distinct from 'analyst' or p_actor_id is null or p_actor_id!~'^[1-9][0-9]{0,17}$' or p_actor_area_id is null then
  raise exception 'INVALID_ACTOR_CONTEXT' using errcode='42501';
 end if;
 return p_actor_id::bigint;
end $$;

create or replace function public.phase11_lock_authorized_ticket(p_ticket_id bigint,p_actor_analyst_id bigint,p_actor_role text,p_actor_area_id bigint) returns public.tickets language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_ticket public.tickets;
 v_assignment bigint;
begin
 select * into v_ticket from public.tickets where id=p_ticket_id for update;
 if not found then raise exception 'TICKET_NOT_FOUND' using errcode='P0002'; end if;
 select analyst_id into v_assignment from public.ticket_assignments where ticket_id=p_ticket_id;
  if p_actor_role<>'admin' and (p_actor_role<>'analyst' or v_assignment is distinct from p_actor_analyst_id or v_ticket.area_id is distinct from p_actor_area_id) then
  raise exception 'WORKFLOW_FORBIDDEN' using errcode='42501';
 end if;
 return v_ticket;
end $$;

create or replace function public.phase11_validate_transition(p_from text,p_to text,p_waiting_reason text) returns void language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
begin
 if not ((p_from='new' and p_to='in_progress') or (p_from='in_progress' and p_to in ('waiting','closed')) or (p_from='waiting' and p_to='in_progress') or p_from=p_to) then
  raise exception 'ILLEGAL_CONVERSATION_TRANSITION' using errcode='23514';
 end if;
 if (p_to='waiting')<>(p_waiting_reason is not null) then
  raise exception 'WAITING_REASON_REQUIRED' using errcode='23514';
 end if;
end $$;

create or replace function public.transition_conversation(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_ticket public.tickets;
 v_event bigint;
 v_assignment bigint;
 v_existing jsonb;
  p_ticket_id bigint; p_state text; p_waiting_reason text; p_expected_revision bigint; p_idempotency_key text; v_payload jsonb; v_actor_analyst_id bigint;
begin
  if p_command is null or jsonb_typeof(p_command) is distinct from 'object' or not (p_command ?& array['version','ticket_id','state','waiting_reason','expected_revision','idempotency_key']) or (p_command-'version'-'ticket_id'-'state'-'waiting_reason'-'expected_revision'-'idempotency_key')<>'{}'::jsonb or jsonb_typeof(p_command->'version') is distinct from 'number' or p_command->>'version' is distinct from '1' or jsonb_typeof(p_command->'ticket_id') is distinct from 'number' or p_command->>'ticket_id' !~ '^[0-9]{1,18}$' or jsonb_typeof(p_command->'state') is distinct from 'string' or not coalesce(jsonb_typeof(p_command->'waiting_reason') in ('string','null'),false) or jsonb_typeof(p_command->'expected_revision') is distinct from 'number' or p_command->>'expected_revision' !~ '^[0-9]{1,18}$' or jsonb_typeof(p_command->'idempotency_key') is distinct from 'string' then raise exception 'INVALID_WORKFLOW_COMMAND' using errcode='22023'; end if;
  v_actor_analyst_id:=public.phase11_build_actor_context(p_actor_id,p_actor_role,p_actor_area_id);
 p_ticket_id:=(p_command->>'ticket_id')::bigint; p_state:=p_command->>'state'; p_waiting_reason:=p_command->>'waiting_reason'; p_expected_revision:=(p_command->>'expected_revision')::bigint; p_idempotency_key:=p_command->>'idempotency_key';
 if p_ticket_id is null or p_ticket_id<=0 or p_state is null or p_state not in ('new','in_progress','waiting','closed') or p_expected_revision is null or p_expected_revision<0 or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9_-]{8,128}$' then raise exception 'INVALID_WORKFLOW_COMMAND' using errcode='22023'; end if;
 v_payload:=jsonb_build_object('ticket_id',p_ticket_id,'state',p_state,'waiting_reason',p_waiting_reason,'expected_revision',p_expected_revision);
   v_ticket:=public.phase11_lock_authorized_ticket(p_ticket_id,v_actor_analyst_id,p_actor_role,p_actor_area_id);
 v_existing:=public.phase11_replay(p_actor_id,p_idempotency_key,'conversation.transition',p_ticket_id,v_payload); if v_existing is not null then return v_existing; end if;
 if v_ticket.workflow_revision<>p_expected_revision then raise exception 'WORKFLOW_REVISION_CONFLICT' using errcode='40001'; end if;
 perform public.phase11_validate_transition(v_ticket.conversation_state,p_state,p_waiting_reason);
 insert into public.workflow_events(ticket_id,event_type,from_value,to_value,actor_id,actor_name,actor_role,idempotency_key,request_fingerprint,request_payload,metadata) values(p_ticket_id,'conversation.transition',v_ticket.conversation_state,p_state,p_actor_id,p_actor_name,p_actor_role,p_idempotency_key,public.phase11_request_fingerprint(v_payload),v_payload,'{}') returning id into v_event;
 if v_ticket.conversation_state='in_progress' and p_state='waiting' then update public.sla_clock_segments set stopped_at=now(),stop_event_id=v_event,stop_reason=p_waiting_reason where snapshot_id in(select id from public.sla_snapshots where ticket_id=p_ticket_id and clock_type='support') and stopped_at is null;
 elsif v_ticket.conversation_state='waiting' and p_state='in_progress' then insert into public.sla_clock_segments(snapshot_id,started_at,start_event_id) select id,now(),v_event from public.sla_snapshots where ticket_id=p_ticket_id and clock_type='support' and not exists(select 1 from public.sla_clock_segments s where s.snapshot_id=sla_snapshots.id and s.stopped_at is null);
 elsif v_ticket.conversation_state='new' and p_state='in_progress' then perform public.phase11_start_snapshot(p_ticket_id,null,'support',v_event);
 elsif p_state='closed' then update public.sla_clock_segments set stopped_at=now(),stop_event_id=v_event,stop_reason='closed' where snapshot_id in(select id from public.sla_snapshots where ticket_id=p_ticket_id) and stopped_at is null; end if;
 update public.tickets set conversation_state=p_state,waiting_reason=p_waiting_reason,workflow_revision=workflow_revision+1,status=case when p_state='closed' then 'closed' else 'open' end,closed_at=case when p_state='closed' then now() else null end where id=p_ticket_id returning * into v_ticket;
 update public.workflow_events set metadata=to_jsonb(v_ticket) where id=v_event; insert into public.audit_log(actor_name,actor_role,action,target_id,metadata) values(p_actor_name,p_actor_role,'conversation.transition',p_ticket_id::text,jsonb_build_object('event_id',v_event,'revision',v_ticket.workflow_revision)); return jsonb_build_object('ticket_id',p_ticket_id,'event_id',v_event,'event_type','conversation.transition','replayed',false);
end $$;

create or replace function public.claim_conversation(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_ticket public.tickets;
 v_event bigint;
 v_existing jsonb;
 v_assignment bigint;
 p_ticket_id bigint; p_analyst_id bigint; p_expected_revision bigint; p_idempotency_key text; v_payload jsonb;
begin
  if p_command is null or jsonb_typeof(p_command) is distinct from 'object' or not (p_command ?& array['version','ticket_id','expected_revision','idempotency_key']) or (p_command-'version'-'ticket_id'-'expected_revision'-'idempotency_key')<>'{}'::jsonb or jsonb_typeof(p_command->'version') is distinct from 'number' or p_command->>'version' is distinct from '1' or jsonb_typeof(p_command->'ticket_id') is distinct from 'number' or p_command->>'ticket_id' !~ '^[0-9]{1,18}$' or jsonb_typeof(p_command->'expected_revision') is distinct from 'number' or p_command->>'expected_revision' !~ '^[0-9]{1,18}$' or jsonb_typeof(p_command->'idempotency_key') is distinct from 'string' then raise exception 'INVALID_CLAIM_COMMAND' using errcode='22023'; end if;
  p_analyst_id:=public.phase11_build_actor_context(p_actor_id,p_actor_role,p_actor_area_id);
 p_ticket_id:=(p_command->>'ticket_id')::bigint; p_expected_revision:=(p_command->>'expected_revision')::bigint; p_idempotency_key:=p_command->>'idempotency_key';
  if p_ticket_id is null or p_ticket_id<=0 or p_expected_revision is null or p_expected_revision<0 or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9_-]{8,128}$' or p_actor_role is distinct from 'analyst' then raise exception 'INVALID_CLAIM_COMMAND' using errcode='22023'; end if;
  v_payload:=jsonb_build_object('ticket_id',p_ticket_id,'analyst_id',p_analyst_id,'expected_revision',p_expected_revision);
 select t.* into v_ticket from public.tickets t join public.analysts a on a.id=p_analyst_id and a.area_id=t.area_id and a.available join public.dashboard_tokens d on d.id=a.token_id and d.active where t.id=p_ticket_id for update of t;
 if not found then raise exception 'WORKFLOW_FORBIDDEN' using errcode='42501'; end if;
 select analyst_id into v_assignment from public.ticket_assignments where ticket_id=p_ticket_id;
 if v_assignment is not null and v_assignment is distinct from p_analyst_id then raise exception 'WORKFLOW_FORBIDDEN' using errcode='42501'; end if;
 v_existing:=public.phase11_replay(p_analyst_id::text,p_idempotency_key,'conversation.claim',p_ticket_id,v_payload); if v_existing is not null then return v_existing; end if;
 if v_ticket.workflow_revision<>p_expected_revision then raise exception 'WORKFLOW_REVISION_CONFLICT' using errcode='40001'; end if;
 if v_ticket.conversation_state<>'new' then raise exception 'ILLEGAL_CONVERSATION_TRANSITION' using errcode='23514'; end if;
 insert into public.ticket_assignments(ticket_id,analyst_id,assigned_at,assigned_by) values(p_ticket_id,p_analyst_id,now(),'self') on conflict(ticket_id) do update set analyst_id=excluded.analyst_id,assigned_at=excluded.assigned_at,assigned_by=excluded.assigned_by where public.ticket_assignments.analyst_id is null or public.ticket_assignments.analyst_id=excluded.analyst_id;
 if not found then raise exception 'TICKET_ALREADY_ASSIGNED' using errcode='23505'; end if;
 insert into public.workflow_events(ticket_id,event_type,from_value,to_value,actor_id,actor_name,actor_role,idempotency_key,request_fingerprint,request_payload,metadata) values(p_ticket_id,'conversation.claim','new','in_progress',p_analyst_id::text,p_actor_name,'analyst',p_idempotency_key,public.phase11_request_fingerprint(v_payload),v_payload,'{}') returning id into v_event;
 update public.tickets set conversation_state='in_progress',waiting_reason=null,workflow_revision=workflow_revision+1 where id=p_ticket_id returning * into v_ticket;
 perform public.phase11_start_snapshot(p_ticket_id,null,'support',v_event);
 update public.workflow_events set metadata=to_jsonb(v_ticket) where id=v_event;
 insert into public.audit_log(actor_name,actor_role,action,target_id,metadata) values(p_actor_name,'analyst','conversation.claim',p_ticket_id::text,jsonb_build_object('event_id',v_event,'analyst_id',p_analyst_id)); return jsonb_build_object('ticket_id',p_ticket_id,'event_id',v_event,'event_type','conversation.claim','replayed',false);
end $$;

create or replace function public.phase11_lock_latest_escalation(p_ticket_id bigint) returns public.development_escalations language sql security definer set search_path=pg_catalog,public as $$
 select e from public.development_escalations e where e.ticket_id=p_ticket_id order by e.id desc limit 1 for update
$$;

create or replace function public.phase11_validate_escalation_transition(p_ticket public.tickets,p_escalation public.development_escalations,p_status text,p_expected_revision bigint) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_status='requested' then
  if p_ticket.conversation_state<>'in_progress' then raise exception 'ILLEGAL_ESCALATION_REQUEST_STATE' using errcode='23514'; end if;
  if p_ticket.workflow_revision<>p_expected_revision then raise exception 'WORKFLOW_REVISION_CONFLICT' using errcode='40001'; end if;
  if p_escalation.status in ('requested','in_progress') then raise exception 'ACTIVE_ESCALATION_EXISTS' using errcode='23505'; end if;
  return;
 end if;
 if p_escalation.id is null or p_escalation.revision<>p_expected_revision then raise exception 'ESCALATION_REVISION_CONFLICT' using errcode='40001'; end if;
 if not ((p_escalation.status='requested' and p_status in ('in_progress','resolved','cancelled')) or (p_escalation.status='in_progress' and p_status in ('resolved','cancelled'))) then raise exception 'ILLEGAL_ESCALATION_TRANSITION' using errcode='23514'; end if;
end $$;

create or replace function public.phase11_persist_escalation(p_ticket_id bigint,p_escalation public.development_escalations,p_status text,p_actor_id text) returns public.development_escalations language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_result public.development_escalations;
begin
 if p_status='requested' then
  insert into public.development_escalations(ticket_id,status,requested_by) values(p_ticket_id,p_status,p_actor_id) returning * into v_result;
 else
  update public.development_escalations set status=p_status,revision=revision+1,updated_at=now(),resolved_at=case when p_status in ('resolved','cancelled') then now() else null end where id=p_escalation.id returning * into v_result;
 end if;
 return v_result;
end $$;

drop function if exists public.phase11_record_escalation_event(bigint,public.development_escalations,text,text,text,text,text,text,text,jsonb);
create or replace function public.phase11_record_escalation_event(p_escalation public.development_escalations,p_context jsonb) returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_event bigint; v_transition jsonb; v_trusted_actor jsonb; v_payload jsonb;
 v_from text; v_status text; v_note text; v_actor_id text; v_actor_name text; v_actor_role text; v_idempotency_key text;
begin
 if p_escalation.id is null or p_escalation.ticket_id is null or p_context is null or jsonb_typeof(p_context) is distinct from 'object' then raise exception 'INVALID_ESCALATION_EVENT_CONTEXT' using errcode='22023'; end if;
 if not (p_context ?& array['version','transition','trusted_actor','idempotency_key','request_payload'])
  or (p_context-'version'-'transition'-'trusted_actor'-'idempotency_key'-'request_payload')<>'{}'::jsonb
  or jsonb_typeof(p_context->'version') is distinct from 'number' or p_context->>'version' is distinct from '1'
  or jsonb_typeof(p_context->'transition') is distinct from 'object' or jsonb_typeof(p_context->'trusted_actor') is distinct from 'object'
  or jsonb_typeof(p_context->'idempotency_key') is distinct from 'string' or jsonb_typeof(p_context->'request_payload') is distinct from 'object' then raise exception 'INVALID_ESCALATION_EVENT_CONTEXT' using errcode='22023'; end if;
 v_transition:=p_context->'transition'; v_trusted_actor:=p_context->'trusted_actor'; v_payload:=p_context->'request_payload';
 if not (v_transition ?& array['from_status','to_status','note']) or not (v_trusted_actor ?& array['id','name','role'])
  or (v_transition-'from_status'-'to_status'-'note')<>'{}'::jsonb or (v_trusted_actor-'id'-'name'-'role')<>'{}'::jsonb
   or jsonb_typeof(v_transition->'to_status') is distinct from 'string' or jsonb_typeof(v_trusted_actor->'id') is distinct from 'string'
   or jsonb_typeof(v_trusted_actor->'name') is distinct from 'string' or jsonb_typeof(v_trusted_actor->'role') is distinct from 'string'
   or not coalesce(jsonb_typeof(v_transition->'from_status') in ('string','null'),false) or not coalesce(jsonb_typeof(v_transition->'note') in ('string','null'),false) then raise exception 'INVALID_ESCALATION_EVENT_CONTEXT' using errcode='22023'; end if;
 if not (v_payload ?& array['ticket_id','status','note','expected_revision']) or (v_payload-'ticket_id'-'status'-'note'-'expected_revision')<>'{}'::jsonb
  or jsonb_typeof(v_payload->'ticket_id') is distinct from 'number' or v_payload->>'ticket_id' !~ '^[0-9]{1,18}$' or jsonb_typeof(v_payload->'status') is distinct from 'string'
   or not coalesce(jsonb_typeof(v_payload->'note') in ('string','null'),false) or jsonb_typeof(v_payload->'expected_revision') is distinct from 'number' or v_payload->>'expected_revision' !~ '^[0-9]{1,18}$' then raise exception 'INVALID_ESCALATION_EVENT_CONTEXT' using errcode='22023'; end if;
 v_from:=v_transition->>'from_status'; v_status:=v_transition->>'to_status'; v_note:=v_transition->>'note';
 v_actor_id:=v_trusted_actor->>'id'; v_actor_name:=v_trusted_actor->>'name'; v_actor_role:=v_trusted_actor->>'role'; v_idempotency_key:=p_context->>'idempotency_key';
 if v_status not in ('requested','in_progress','resolved','cancelled') or v_status is distinct from p_escalation.status
  or v_from is not null and v_from not in ('requested','in_progress','resolved','cancelled')
  or length(coalesce(v_note,''))>4000 or length(v_actor_id) not between 1 and 256 or length(v_actor_name) not between 1 and 256
  or v_actor_role not in ('analyst','admin') or v_idempotency_key!~'^[A-Za-z0-9_-]{8,128}$'
  or (v_payload->>'ticket_id')::bigint is distinct from p_escalation.ticket_id or v_payload->>'status' is distinct from v_status
  or v_payload->>'note' is distinct from v_note then raise exception 'INVALID_ESCALATION_EVENT_CONTEXT' using errcode='22023'; end if;
 insert into public.workflow_events(ticket_id,escalation_id,event_type,from_value,to_value,actor_id,actor_name,actor_role,idempotency_key,request_fingerprint,request_payload,metadata)
 values(p_escalation.ticket_id,p_escalation.id,'development.status',v_from,v_status,v_actor_id,v_actor_name,v_actor_role,v_idempotency_key,public.phase11_request_fingerprint(v_payload),v_payload,jsonb_build_object('note',v_note,'escalation',to_jsonb(p_escalation))) returning id into v_event;
 insert into public.audit_log(actor_name,actor_role,action,target_id,metadata)
 values(v_actor_name,v_actor_role,'development.'||v_status,p_escalation.ticket_id::text,jsonb_build_object('escalation_id',p_escalation.id,'event_id',v_event));
 return v_event;
end $$;

create or replace function public.phase11_suspend_ticket_for_development(p_ticket_id bigint) returns void language sql security definer set search_path=pg_catalog,public as $$
 update public.tickets set conversation_state='waiting',waiting_reason='development_escalation',workflow_revision=workflow_revision+1 where id=p_ticket_id
$$;
create or replace function public.phase11_resume_ticket_after_development(p_ticket_id bigint) returns void language sql security definer set search_path=pg_catalog,public as $$
 update public.tickets set conversation_state='in_progress',waiting_reason=null,workflow_revision=workflow_revision+1 where id=p_ticket_id
$$;
create or replace function public.phase11_close_support_clock(p_ticket_id bigint,p_event_id bigint) returns void language sql security definer set search_path=pg_catalog,public as $$
 update public.sla_clock_segments set stopped_at=now(),stop_event_id=p_event_id,stop_reason='development_escalation' where snapshot_id in(select id from public.sla_snapshots where ticket_id=p_ticket_id and clock_type='support') and stopped_at is null
$$;
create or replace function public.phase11_close_development_clock(p_escalation_id bigint,p_event_id bigint,p_reason text) returns void language sql security definer set search_path=pg_catalog,public as $$
 update public.sla_clock_segments set stopped_at=now(),stop_event_id=p_event_id,stop_reason=p_reason where snapshot_id in(select id from public.sla_snapshots where escalation_id=p_escalation_id and clock_type='development') and stopped_at is null
$$;
create or replace function public.phase11_resume_support_clock(p_ticket_id bigint,p_event_id bigint) returns void language sql security definer set search_path=pg_catalog,public as $$
 insert into public.sla_clock_segments(snapshot_id,started_at,start_event_id) select ss.id,now(),p_event_id from public.sla_snapshots ss where ss.ticket_id=p_ticket_id and ss.clock_type='support' and not exists(select 1 from public.sla_clock_segments s where s.snapshot_id=ss.id and s.stopped_at is null)
$$;
create or replace function public.phase11_escalation_response(p_ticket_id bigint,p_event_id bigint,p_escalation_id bigint) returns jsonb language sql immutable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('ticket_id',p_ticket_id,'event_id',p_event_id,'event_type','development.status','escalation_id',p_escalation_id,'replayed',false)
$$;

create or replace function public.update_development_escalation(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_ticket public.tickets; v_escalation public.development_escalations; v_existing jsonb; v_event bigint; v_from text;
  p_ticket_id bigint; p_status text; p_note text; p_expected_revision bigint; p_idempotency_key text; v_payload jsonb; v_actor_analyst_id bigint;
begin
  if p_command is null or jsonb_typeof(p_command) is distinct from 'object' or not (p_command ?& array['version','ticket_id','status','note','expected_revision','idempotency_key']) or (p_command-'version'-'ticket_id'-'status'-'note'-'expected_revision'-'idempotency_key')<>'{}'::jsonb or jsonb_typeof(p_command->'version') is distinct from 'number' or p_command->>'version' is distinct from '1' or jsonb_typeof(p_command->'ticket_id') is distinct from 'number' or p_command->>'ticket_id' !~ '^[0-9]{1,18}$' or jsonb_typeof(p_command->'status') is distinct from 'string' or not coalesce(jsonb_typeof(p_command->'note') in ('string','null'),false) or jsonb_typeof(p_command->'expected_revision') is distinct from 'number' or p_command->>'expected_revision' !~ '^[0-9]{1,18}$' or jsonb_typeof(p_command->'idempotency_key') is distinct from 'string' then raise exception 'INVALID_ESCALATION_COMMAND' using errcode='22023'; end if;
  v_actor_analyst_id:=public.phase11_build_actor_context(p_actor_id,p_actor_role,p_actor_area_id);
 p_ticket_id:=(p_command->>'ticket_id')::bigint; p_status:=p_command->>'status'; p_note:=p_command->>'note'; p_expected_revision:=(p_command->>'expected_revision')::bigint; p_idempotency_key:=p_command->>'idempotency_key';
 if p_ticket_id is null or p_ticket_id<=0 or p_status is null or p_status not in ('requested','in_progress','resolved','cancelled') or p_expected_revision is null or p_expected_revision<0 or length(coalesce(p_note,''))>4000 or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9_-]{8,128}$' then raise exception 'INVALID_ESCALATION_COMMAND' using errcode='22023'; end if;
 v_payload:=jsonb_build_object('ticket_id',p_ticket_id,'status',p_status,'note',p_note,'expected_revision',p_expected_revision);
   v_ticket:=public.phase11_lock_authorized_ticket(p_ticket_id,v_actor_analyst_id,p_actor_role,p_actor_area_id);
 v_existing:=public.phase11_replay(p_actor_id,p_idempotency_key,'development.status',p_ticket_id,v_payload);
 if v_existing is not null then return v_existing; end if;
  v_escalation:=public.phase11_lock_latest_escalation(p_ticket_id);
 perform public.phase11_validate_escalation_transition(v_ticket,v_escalation,p_status,p_expected_revision);
 v_from:=v_escalation.status;
  v_escalation:=public.phase11_persist_escalation(p_ticket_id,v_escalation,p_status,p_actor_id);
 v_event:=public.phase11_record_escalation_event(
  p_escalation=>v_escalation,
  p_context=>jsonb_build_object(
   'version',1,
   'transition',jsonb_build_object('from_status',v_from,'to_status',p_status,'note',p_note),
   'trusted_actor',jsonb_build_object('id',p_actor_id,'name',p_actor_name,'role',p_actor_role),
   'idempotency_key',p_idempotency_key,
   'request_payload',v_payload
  )
 );
 if p_status='requested' then
  perform public.phase11_suspend_ticket_for_development(p_ticket_id);
  perform public.phase11_close_support_clock(p_ticket_id,v_event);
  perform public.phase11_start_snapshot(p_ticket_id,v_escalation.id,'development',v_event);
 elsif p_status in ('resolved','cancelled') then
  perform public.phase11_close_development_clock(v_escalation.id,v_event,p_status);
  perform public.phase11_resume_ticket_after_development(p_ticket_id);
  perform public.phase11_resume_support_clock(p_ticket_id,v_event);
 end if;
 return public.phase11_escalation_response(p_ticket_id,v_event,v_escalation.id);
end $$;

drop function if exists public.phase11_lock_authorized_ticket(bigint,text,text,bigint) restrict;

create or replace function public.phase11_transfer_sets_new() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_event bigint; v_payload jsonb;
begin
 if new.area_id is distinct from old.area_id and old.conversation_state<>'closed' then
  v_payload:=jsonb_build_object('ticket_id',old.id,'from_area_id',old.area_id,'to_area_id',new.area_id,'revision',old.workflow_revision);
  insert into public.workflow_events(ticket_id,event_type,from_value,to_value,actor_id,actor_name,actor_role,idempotency_key,request_fingerprint,request_payload,metadata)
  values(old.id,'conversation.transfer',old.area_id::text,new.area_id::text,'system','system','service_role','transfer_'||txid_current()::text||'_'||old.id::text||'_'||old.workflow_revision::text,public.phase11_request_fingerprint(v_payload),v_payload,'{}') returning id into v_event;
  update public.sla_clock_segments set stopped_at=now(),stop_event_id=v_event,stop_reason='area_transfer' where snapshot_id in(select id from public.sla_snapshots where ticket_id=old.id and clock_type='support') and stopped_at is null;
  new.conversation_state:='new'; new.waiting_reason:=null; new.workflow_revision:=old.workflow_revision+1;
 end if; return new;
end $$;
drop trigger if exists phase11_transfer_sets_new on public.tickets;
create trigger phase11_transfer_sets_new before update of area_id on public.tickets for each row execute function public.phase11_transfer_sets_new();

create or replace function public.configure_sla_policy(p_area_id bigint,p_priority text,p_clock_type text,p_clock_mode text,p_calendar_id bigint,p_target_minutes integer,p_warning_minutes integer,p_actor_name text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_version bigint; v_policy public.sla_policies;
begin if p_area_id is null or p_area_id<=0 or p_priority is null or p_priority not in ('critical','high','medium','low') or p_clock_type is null or p_clock_type not in ('support','development') or p_clock_mode is null or p_clock_mode not in ('24x7','business_hours') or p_target_minutes is null or p_target_minutes<=0 or p_warning_minutes is null or p_warning_minutes<0 or p_warning_minutes>=p_target_minutes or p_actor_name is null or btrim(p_actor_name)='' or (p_clock_mode='business_hours' and p_calendar_id is null) then raise exception 'INVALID_SLA_POLICY_COMMAND' using errcode='22023'; end if; perform 1 from public.areas where id=p_area_id and active; if not found then raise exception 'AREA_NOT_FOUND' using errcode='P0002'; end if; select coalesce(max(version),0)+1 into v_version from public.sla_policies where area_id=p_area_id and priority=p_priority and clock_type=p_clock_type; update public.sla_policies set active=false where area_id=p_area_id and priority=p_priority and clock_type=p_clock_type and active; insert into public.sla_policies(area_id,priority,clock_type,clock_mode,calendar_id,target_minutes,warning_minutes,version,created_by) values(p_area_id,p_priority,p_clock_type,p_clock_mode,p_calendar_id,p_target_minutes,p_warning_minutes,v_version,p_actor_name) returning * into v_policy; insert into public.audit_log(actor_name,actor_role,action,target_id,metadata) values(p_actor_name,'admin','sla.policy_configured',v_policy.id::text,to_jsonb(v_policy)); return to_jsonb(v_policy); end $$;

create or replace function public.configure_business_calendar(p_area_id bigint,p_name text,p_timezone text,p_windows jsonb,p_exceptions jsonb,p_actor_name text) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 v_version bigint; v_calendar public.business_calendars; item jsonb; other_item jsonb;
 v_weekday integer; v_start time; v_end time; v_date date; v_closed boolean;
begin
 if p_area_id is null or p_area_id<=0 or p_name is null or btrim(p_name)='' or p_timezone is null or btrim(p_timezone)='' or p_windows is null or p_exceptions is null or p_actor_name is null or btrim(p_actor_name)='' or jsonb_typeof(p_windows) is distinct from 'array' or jsonb_typeof(p_exceptions) is distinct from 'array' then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(p_windows) loop
  if jsonb_typeof(item) is distinct from 'object'
   or not (item ?& array['weekday','start','end']) or (item-'weekday'-'start'-'end')<>'{}'::jsonb
   or jsonb_typeof(item->'weekday') is distinct from 'number' or item->>'weekday' !~ '^[0-6]$'
   or jsonb_typeof(item->'start') is distinct from 'string' or item->>'start' !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
   or jsonb_typeof(item->'end') is distinct from 'string' or item->>'end' !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$' then
   raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023';
  end if;
  v_weekday:=(item->>'weekday')::integer; v_start:=(item->>'start')::time; v_end:=(item->>'end')::time;
  if v_start=v_end then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
 end loop;
 for item in select value from jsonb_array_elements(p_exceptions) loop
  if jsonb_typeof(item) is distinct from 'object'
   or not (item ?& array['date','closed','windows']) or (item-'date'-'closed'-'windows')<>'{}'::jsonb
   or jsonb_typeof(item->'date') is distinct from 'string' or item->>'date' !~ '^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$'
   or jsonb_typeof(item->'closed') is distinct from 'boolean'
   or not coalesce(jsonb_typeof(item->'windows') in ('array','null'),false) then
   raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023';
  end if;
  begin v_date:=(item->>'date')::date;
  exception when invalid_datetime_format or datetime_field_overflow then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end;
  v_closed:=(item->>'closed')::boolean;
  if (v_closed and jsonb_typeof(item->'windows') is distinct from 'null') or (not v_closed and jsonb_typeof(item->'windows') is distinct from 'array') then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
  if not v_closed then
   for other_item in select value from jsonb_array_elements(item->'windows') loop
    if jsonb_typeof(other_item) is distinct from 'object'
     or not (other_item ?& array['start','end']) or (other_item-'start'-'end')<>'{}'::jsonb
     or jsonb_typeof(other_item->'start') is distinct from 'string' or other_item->>'start' !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$'
     or jsonb_typeof(other_item->'end') is distinct from 'string' or other_item->>'end' !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$' then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
    v_start:=(other_item->>'start')::time; v_end:=(other_item->>'end')::time;
    if v_start=v_end then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
   end loop;
   if exists(select 1 from jsonb_array_elements(item->'windows') with ordinality a(w,n) join jsonb_array_elements(item->'windows') with ordinality b(w,n) on a.n<b.n cross join generate_series(-1,1) shift(day) where
    extract(epoch from (a.w->>'start')::time) < extract(epoch from (b.w->>'end')::time)+case when (b.w->>'end')::time<=(b.w->>'start')::time then 86400 else 0 end+shift.day*86400
    and extract(epoch from (b.w->>'start')::time)+shift.day*86400 < extract(epoch from (a.w->>'end')::time)+case when (a.w->>'end')::time<=(a.w->>'start')::time then 86400 else 0 end) then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_exceptions) e group by e->>'date' having count(*)>1) then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(p_windows) with ordinality a(w,n) join jsonb_array_elements(p_windows) with ordinality b(w,n) on a.n<b.n cross join generate_series(-1,1) shift(week) where
  ((a.w->>'weekday')::integer*86400+extract(epoch from (a.w->>'start')::time)) < ((b.w->>'weekday')::integer*86400+extract(epoch from (b.w->>'end')::time)+case when (b.w->>'end')::time<=(b.w->>'start')::time then 86400 else 0 end+shift.week*604800)
  and ((b.w->>'weekday')::integer*86400+extract(epoch from (b.w->>'start')::time)+shift.week*604800) < ((a.w->>'weekday')::integer*86400+extract(epoch from (a.w->>'end')::time)+case when (a.w->>'end')::time<=(a.w->>'start')::time then 86400 else 0 end)) then raise exception 'INVALID_BUSINESS_CALENDAR_COMMAND' using errcode='22023'; end if;
 perform 1 from public.areas where id=p_area_id and active; if not found then raise exception 'AREA_NOT_FOUND' using errcode='P0002'; end if;
 perform 1 from pg_catalog.pg_timezone_names where name=p_timezone; if not found then raise exception 'INVALID_TIMEZONE' using errcode='22023'; end if;
 select coalesce(max(version),0)+1 into v_version from public.business_calendars where area_id=p_area_id and name=p_name;
 update public.business_calendars set active=false,updated_at=now() where area_id=p_area_id and name=p_name and active;
 insert into public.business_calendars(area_id,name,timezone,version) values(p_area_id,p_name,p_timezone,v_version) returning * into v_calendar;
 for item in select value from jsonb_array_elements(p_windows) loop insert into public.business_calendar_windows(calendar_id,weekday,starts_at,ends_at) values(v_calendar.id,(item->>'weekday')::smallint,(item->>'start')::time,(item->>'end')::time); end loop;
 for item in select value from jsonb_array_elements(p_exceptions) loop insert into public.business_calendar_exceptions(calendar_id,exception_date,closed,windows) values(v_calendar.id,(item->>'date')::date,(item->>'closed')::boolean,nullif(item->'windows','null'::jsonb)); end loop;
 insert into public.audit_log(actor_name,actor_role,action,target_id,metadata) values(p_actor_name,'admin','sla.calendar_configured',v_calendar.id::text,to_jsonb(v_calendar)); return to_jsonb(v_calendar);
end $$;

do $acl$ declare r text; item record; grantee_name text; begin
 foreach r in array array['business_calendars','business_calendar_windows','business_calendar_exceptions','sla_policies','development_escalations','workflow_events','sla_snapshots','sla_clock_segments'] loop
  execute format('alter table public.%I enable row level security',r);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',r);
  for grantee_name in select distinct roles.rolname from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a join pg_roles roles on roles.oid=a.grantee where c.oid=to_regclass('public.'||r) and a.grantee<>c.relowner and roles.rolname not in ('postgres','supabase_admin','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user') loop execute format('revoke all on table public.%I from %I',r,grantee_name); end loop;
  execute format('grant select,insert,update on table public.%I to service_role',r);
 end loop;
 for item in select distinct seq.oid,seq.oid::regclass::text identity,seq.relowner from pg_class t join pg_depend d on d.refobjid=t.oid and d.refobjsubid>0 and d.deptype in ('a','i') join pg_class seq on seq.oid=d.objid and seq.relkind='S' where t.oid in (select to_regclass('public.'||name) from unnest(array['business_calendars','business_calendar_windows','business_calendar_exceptions','sla_policies','development_escalations','workflow_events','sla_snapshots','sla_clock_segments']) name) loop
  execute format('revoke all on sequence %s from public,anon,authenticated,service_role',item.identity);
  for grantee_name in select distinct roles.rolname from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('S',c.relowner))) a join pg_roles roles on roles.oid=a.grantee where c.oid=item.oid and a.grantee<>c.relowner and roles.rolname not in ('postgres','supabase_admin','pg_read_all_data','pg_write_all_data','supabase_etl_admin','supabase_read_only_user') loop execute format('revoke all on sequence %s from %I',item.identity,grantee_name); end loop;
  execute format('grant usage,select on sequence %s to service_role',item.identity);
 end loop;
  for item in select p.oid,p.oid::regprocedure::text signature,p.proname,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('phase11_calendar_snapshot','phase11_start_snapshot','phase11_request_fingerprint','phase11_replay','phase11_build_actor_context','phase11_lock_authorized_ticket','phase11_validate_transition','phase11_lock_latest_escalation','phase11_validate_escalation_transition','phase11_persist_escalation','phase11_record_escalation_event','phase11_suspend_ticket_for_development','phase11_resume_ticket_after_development','phase11_close_support_clock','phase11_close_development_clock','phase11_resume_support_clock','phase11_escalation_response','transition_conversation','claim_conversation','update_development_escalation','configure_sla_policy','configure_business_calendar','phase11_transfer_sets_new') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',item.signature);
  for grantee_name in select distinct roles.rolname from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a join pg_roles roles on roles.oid=a.grantee where p.oid=item.oid and a.grantee<>p.proowner and roles.rolname not in ('postgres','supabase_admin') loop execute format('revoke all on function %s from %I',item.signature,grantee_name); end loop;
  execute format('alter function %s owner to %I',item.signature,current_user);
  execute format('alter function %s set search_path=pg_catalog,public',item.signature);
  if item.proname in ('transition_conversation','claim_conversation','update_development_escalation','configure_sla_policy','configure_business_calendar') then
   execute format('grant execute on function %s to service_role',item.signature);
  end if;
 end loop;
end $acl$;
commit;

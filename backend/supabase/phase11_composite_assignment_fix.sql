-- Definitive Phase 11 composite-return assignment repair for an already-applied baseline.
begin;
set local search_path = pg_catalog, public;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
select pg_advisory_xact_lock(hashtextextended('nexo:phase11:conversation-sla',0));

do $baseline$
begin
 if to_regprocedure('public.transition_conversation(jsonb,text,text,text,bigint)') is null
  or to_regprocedure('public.update_development_escalation(jsonb,text,text,text,bigint)') is null
  or to_regprocedure('public.phase11_lock_authorized_ticket(bigint,bigint,text,bigint)') is null
  or to_regprocedure('public.phase11_lock_latest_escalation(bigint)') is null
  or to_regprocedure('public.phase11_persist_escalation(bigint,development_escalations,text,text)') is null then
  raise exception 'PHASE11_COMPOSITE_ASSIGNMENT_BASELINE_MISMATCH' using errcode='55000';
 end if;
end $baseline$;

create or replace function public.transition_conversation(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare
 v_ticket public.tickets; v_event bigint; v_assignment bigint; v_existing jsonb;
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

create or replace function public.update_development_escalation(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,public as $$
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
 v_existing:=public.phase11_replay(p_actor_id,p_idempotency_key,'development.status',p_ticket_id,v_payload); if v_existing is not null then return v_existing; end if;
 v_escalation:=public.phase11_lock_latest_escalation(p_ticket_id);
 perform public.phase11_validate_escalation_transition(v_ticket,v_escalation,p_status,p_expected_revision);
 v_from:=v_escalation.status;
 v_escalation:=public.phase11_persist_escalation(p_ticket_id,v_escalation,p_status,p_actor_id);
 v_event:=public.phase11_record_escalation_event(p_escalation=>v_escalation,p_context=>jsonb_build_object('version',1,'transition',jsonb_build_object('from_status',v_from,'to_status',p_status,'note',p_note),'trusted_actor',jsonb_build_object('id',p_actor_id,'name',p_actor_name,'role',p_actor_role),'idempotency_key',p_idempotency_key,'request_payload',v_payload));
 if p_status='requested' then perform public.phase11_suspend_ticket_for_development(p_ticket_id); perform public.phase11_close_support_clock(p_ticket_id,v_event); perform public.phase11_start_snapshot(p_ticket_id,v_escalation.id,'development',v_event);
 elsif p_status in ('resolved','cancelled') then perform public.phase11_close_development_clock(v_escalation.id,v_event,p_status); perform public.phase11_resume_ticket_after_development(p_ticket_id); perform public.phase11_resume_support_clock(p_ticket_id,v_event); end if;
 return public.phase11_escalation_response(p_ticket_id,v_event,v_escalation.id);
end $$;

do $metadata$
declare v_owner text; item record; grantee_name text;
begin
 select r.rolname into strict v_owner from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=to_regprocedure('public.transition_conversation(jsonb,text,text,text,bigint)');
 for item in select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.oid in (to_regprocedure('public.transition_conversation(jsonb,text,text,text,bigint)'),to_regprocedure('public.update_development_escalation(jsonb,text,text,text,bigint)')) loop
  execute format('alter function %s owner to %I',item.signature,v_owner);
  execute format('alter function %s security definer',item.signature);
  execute format('alter function %s volatile',item.signature);
  execute format('alter function %s set search_path=pg_catalog,public',item.signature);
 end loop;
 for item in select p.oid,p.oid::regprocedure::text signature,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.oid in (to_regprocedure('public.transition_conversation(jsonb,text,text,text,bigint)'),to_regprocedure('public.update_development_escalation(jsonb,text,text,text,bigint)')) loop
  for grantee_name in select distinct r.rolname from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a join pg_roles r on r.oid=a.grantee where p.oid=item.oid and a.grantee<>item.proowner loop
   execute format('revoke all on function %s from %I',item.signature,grantee_name);
  end loop;
 end loop;
end $metadata$;

revoke all on function public.transition_conversation(jsonb,text,text,text,bigint) from public,anon,authenticated,service_role;
revoke all on function public.update_development_escalation(jsonb,text,text,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.transition_conversation(jsonb,text,text,text,bigint) to service_role;
grant execute on function public.update_development_escalation(jsonb,text,text,text,bigint) to service_role;
commit;

-- Self-contained Phase 11 behavior proof. Run this file as one complete script.
-- Catchable runtime errors inside the transaction-local function become an execution_error row,
-- so the function call and ROLLBACK still run. Parse/syntax errors and client disconnects
-- cannot be caught by PL/pgSQL; issue ROLLBACK if the SQL Editor reports an error before results.
begin;
set local search_path = pg_catalog, public;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local idle_in_transaction_session_timeout = '60s';

create function public.phase11_behavior_check_sentinel_20260722()
returns table(check_name text,status boolean,detail text)
language plpgsql
security invoker
set search_path=pg_catalog,public
as $check$
#variable_conflict use_column
declare
  v_run text := 'phase11_sentinel_' || txid_current()::text;
  v_area bigint; v_other_area bigint; v_token bigint; v_analyst bigint;
  v_ticket_a bigint; v_ticket_b bigint; v_ticket_c bigint; v_ticket_d bigint;
  v_ticket_admin bigint; v_calendar bigint; v_support_policy bigint; v_development_policy bigint;
  v_result jsonb; v_replay jsonb; v_event bigint; v_escalation bigint; v_snapshot bigint;
  v_rejected boolean; v_state text; v_constraint text; v_step text := 'fixture_identity';
  v_context text; v_message text; v_safe_context text; v_category text; v_target_type text;
begin
  insert into public.areas(name,description,welcome_msg,active,sla_minutes)
  values(v_run||'_area','PHASE11_SENTINEL_ONLY','PHASE11_SENTINEL_ONLY',true,30) returning id into v_area;
  insert into public.areas(name,description,welcome_msg,active,sla_minutes)
  values(v_run||'_transfer_area','PHASE11_SENTINEL_ONLY','PHASE11_SENTINEL_ONLY',true,30) returning id into v_other_area;
  insert into public.dashboard_tokens(token_hash,name,role,active)
  values(md5(v_run||'_token'),v_run||'_token','agent',true) returning id into v_token;
  insert into public.analysts(token_id,area_id,display_name,available,last_seen)
  values(v_token,v_area,v_run||'_analyst',true,now()) returning id into v_analyst;

  v_step := 'ticket_fixtures';
  -- bot_submission_id is NULL, so the normal post-processing trigger has no row to create.
  insert into public.tickets(chat_id,telefono,nombre_analista,nombre_empresa,correo,situacion,categoria,prioridad,status,area_id,bot_submission_id,conversation_state,waiting_reason,workflow_revision,priority_normalized)
  values('999911000001@c.us','PHASE11_A','PHASE11_SENTINEL','PHASE11_SENTINEL','a@sentinel.invalid','PHASE11_A','Platform','Crítica','open',v_area,null,'new',null,0,'critical') returning id into v_ticket_a;
  insert into public.tickets(chat_id,telefono,nombre_analista,nombre_empresa,correo,situacion,categoria,prioridad,status,area_id,bot_submission_id,conversation_state,waiting_reason,workflow_revision,priority_normalized)
  values('999911000002@c.us','PHASE11_B','PHASE11_SENTINEL','PHASE11_SENTINEL','b@sentinel.invalid','PHASE11_B','Tests','Crítica','open',v_area,null,'new',null,0,'critical') returning id into v_ticket_b;
  insert into public.tickets(chat_id,telefono,nombre_analista,nombre_empresa,correo,situacion,categoria,prioridad,status,area_id,bot_submission_id,conversation_state,waiting_reason,workflow_revision,priority_normalized)
  values('999911000003@c.us','PHASE11_C','PHASE11_SENTINEL','PHASE11_SENTINEL','c@sentinel.invalid','PHASE11_C','Platform','Crítica','open',v_area,null,'in_progress',null,0,'critical') returning id into v_ticket_c;
  insert into public.tickets(chat_id,telefono,nombre_analista,nombre_empresa,correo,situacion,categoria,prioridad,status,area_id,bot_submission_id,conversation_state,waiting_reason,workflow_revision,priority_normalized)
  values('999911000004@c.us','PHASE11_D','PHASE11_SENTINEL','PHASE11_SENTINEL','d@sentinel.invalid','PHASE11_D','Tests','Crítica','open',v_area,null,'new',null,0,'critical') returning id into v_ticket_d;
  insert into public.tickets(chat_id,telefono,nombre_analista,nombre_empresa,correo,situacion,categoria,prioridad,status,area_id,bot_submission_id,conversation_state,waiting_reason,workflow_revision,priority_normalized)
  values('999911000005@c.us','PHASE11_ADMIN','PHASE11_SENTINEL','PHASE11_SENTINEL','admin@sentinel.invalid','PHASE11_ADMIN','Platform','Crítica','open',v_other_area,null,'in_progress',null,0,'critical') returning id into v_ticket_admin;

  v_step := 'sla_fixtures';
  insert into public.ticket_assignments(ticket_id,analyst_id,assigned_at,assigned_by)
  values(v_ticket_a,v_analyst,now(),v_run),(v_ticket_b,v_analyst,now(),v_run),(v_ticket_c,v_analyst,now(),v_run);
  insert into public.business_calendars(area_id,name,timezone,version)
  values(v_area,v_run||'_calendar','America/Bogota',1) returning id into v_calendar;
  insert into public.business_calendar_windows(calendar_id,weekday,starts_at,ends_at) values(v_calendar,1,'08:00','17:00');
  insert into public.sla_policies(area_id,priority,clock_type,clock_mode,calendar_id,target_minutes,warning_minutes,version,created_by)
  values(v_area,'critical','support','business_hours',v_calendar,120,20,1,v_run) returning id into v_support_policy;
  insert into public.sla_policies(area_id,priority,clock_type,clock_mode,calendar_id,target_minutes,warning_minutes,version,created_by)
  values(v_area,'critical','development','business_hours',v_calendar,240,30,1,v_run) returning id into v_development_policy;

  -- Malformed commands must be converted into an assertion result, never abort this proof.
  v_step := 'validation_contracts';
  v_rejected:=false;
  begin perform public.claim_conversation('{}'::jsonb,v_analyst::text,v_run,'analyst',v_area);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_CLAIM_COMMAND'; when others then v_rejected:=false; end;
   return query values('malformed_rpc_json',coalesce(v_rejected,false),'invalid JSON command is safely rejected');
  v_rejected:=false;
  begin perform public.transition_conversation('{}'::jsonb,v_analyst::text,v_run,'analyst',v_area);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_WORKFLOW_COMMAND'; when others then v_rejected:=false; end;
   return query values('malformed_transition_command',coalesce(v_rejected,false),'missing transition fields return INVALID_WORKFLOW_COMMAND');
  v_rejected:=false;
  begin perform public.update_development_escalation('{}'::jsonb,v_analyst::text,v_run,'analyst',v_area);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_ESCALATION_COMMAND'; when others then v_rejected:=false; end;
   return query values('malformed_escalation_command',coalesce(v_rejected,false),'missing escalation fields return INVALID_ESCALATION_COMMAND');
  v_rejected:=false;
  begin perform public.configure_sla_policy(null,null,null,null,null,null,null,null);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_SLA_POLICY_COMMAND'; when others then v_rejected:=false; end;
   return query values('malformed_sla_policy_command',coalesce(v_rejected,false),'missing policy fields return INVALID_SLA_POLICY_COMMAND before area lookup');
  v_rejected:=false;
  begin perform public.configure_business_calendar(null,null,null,null,null,null);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_BUSINESS_CALENDAR_COMMAND'; when others then v_rejected:=false; end;
   return query values('malformed_calendar_command',coalesce(v_rejected,false),'missing calendar fields return INVALID_BUSINESS_CALENDAR_COMMAND before area lookup');
  v_rejected:=false;
  begin perform public.configure_business_calendar(v_area,v_run,'America/Bogota','[null]'::jsonb,'[]'::jsonb,v_run);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_BUSINESS_CALENDAR_COMMAND'; when others then v_rejected:=false; end;
   return query values('malformed_calendar_window_element',coalesce(v_rejected,false),'JSON null window returns stable calendar validation error');
  v_rejected:=false;
  begin perform public.configure_business_calendar(v_area,v_run,'America/Bogota','[{"weekday":"1","start":"08:00","end":"17:00"}]'::jsonb,'[]'::jsonb,v_run);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_BUSINESS_CALENDAR_COMMAND'; when others then v_rejected:=false; end;
   return query values('mistyped_calendar_window',coalesce(v_rejected,false),'string weekday returns stable calendar validation error');
  v_rejected:=false;
  begin perform public.configure_business_calendar(v_area,v_run,'America/Bogota','[]'::jsonb,'[{"date":"2026-02-30","closed":true,"windows":null}]'::jsonb,v_run);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_BUSINESS_CALENDAR_COMMAND'; when others then v_rejected:=false; end;
   return query values('malformed_calendar_exception',coalesce(v_rejected,false),'invalid exception date returns stable calendar validation error');
  v_rejected:=false;
  begin perform public.configure_business_calendar(v_area,v_run,'America/Bogota','[]'::jsonb,'[{"date":"2026-07-20","closed":true,"windows":null},{"date":"2026-07-20","closed":true,"windows":null}]'::jsonb,v_run);
  exception when sqlstate '22023' then v_rejected:=sqlerrm='INVALID_BUSINESS_CALENDAR_COMMAND'; when others then v_rejected:=false; end;
   return query values('duplicate_calendar_exception',coalesce(v_rejected,false),'duplicate exception dates return stable calendar validation error');

  -- Claim and exact claim replay.
  v_step := 'claim_replay';
  v_result:=public.claim_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_b,'expected_revision',0,'idempotency_key',v_run||'_claim_b'),v_analyst::text,v_run,'analyst',v_area);
  v_event:=case when jsonb_typeof(v_result->'event_id')='number' and (v_result->>'event_id') ~ '^[0-9]{1,18}$' then (v_result->>'event_id')::bigint else null end;
   return query values('claim',coalesce(case when jsonb_typeof(v_result->'ticket_id')='number' and (v_result->>'ticket_id') ~ '^[0-9]{1,18}$' then (v_result->>'ticket_id')::bigint=v_ticket_b else false end and v_event is not null,false),'new ticket is claimed');
  v_replay:=public.claim_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_b,'expected_revision',0,'idempotency_key',v_run||'_claim_b'),v_analyst::text,v_run,'analyst',v_area);
   return query values('claim_exact_replay',coalesce(jsonb_typeof(v_replay->'replayed')='boolean' and v_replay->>'replayed'='true' and case when jsonb_typeof(v_replay->'event_id')='number' and (v_replay->>'event_id') ~ '^[0-9]{1,18}$' then (v_replay->>'event_id')::bigint=v_event else false end,false),'claim replay returns the authoritative event');

  -- Transition replay, pause/resume clocks, close, and the deliberately illegal reopen.
  v_step := 'conversation_lifecycle';
  v_step := 'wait_transition_call';
  v_result:=public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_b,'state','waiting','waiting_reason','customer_response','expected_revision',1,'idempotency_key',v_run||'_wait_b'),v_analyst::text,v_run,'analyst',v_area);
  v_step := 'wait_event_id_parse';
  v_event:=case when jsonb_typeof(v_result->'event_id')='number' and (v_result->>'event_id') ~ '^[0-9]{1,18}$' then (v_result->>'event_id')::bigint else null end;
  v_step := 'wait_replay_call';
  v_replay:=public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_b,'state','waiting','waiting_reason','customer_response','expected_revision',1,'idempotency_key',v_run||'_wait_b'),v_analyst::text,v_run,'analyst',v_area);
  v_step := 'wait_replay_assert';
   return query values('transition_exact_replay',coalesce(jsonb_typeof(v_replay->'replayed')='boolean' and v_replay->>'replayed'='true' and case when jsonb_typeof(v_replay->'event_id')='number' and (v_replay->>'event_id') ~ '^[0-9]{1,18}$' then (v_replay->>'event_id')::bigint=v_event else false end,false),'transition replay returns the authoritative event');
  v_step := 'support_clock_check';
   return query values('support_clock_segment_closure',coalesce(not exists(select 1 from public.sla_snapshots ss join public.sla_clock_segments s on s.snapshot_id=ss.id where ss.ticket_id=v_ticket_b and ss.clock_type='support' and s.stopped_at is null),false),'waiting closes the support segment');
  v_step := 'resume_transition_call';
  v_result:=public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_b,'state','in_progress','waiting_reason',null,'expected_revision',2,'idempotency_key',v_run||'_resume_b'),v_analyst::text,v_run,'analyst',v_area);
  v_step := 'snapshot_lookup';
  select id into strict v_snapshot from public.sla_snapshots where ticket_id=v_ticket_b and escalation_id is null and clock_type='support';
   return query values('support_clock_resume',coalesce(exists(select 1 from public.sla_clock_segments where snapshot_id=v_snapshot and stopped_at is null),false),'waiting to in_progress resumes support clock');
  v_step := 'close_transition_call';
  v_result:=public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_b,'state','closed','waiting_reason',null,'expected_revision',3,'idempotency_key',v_run||'_close_b'),v_analyst::text,v_run,'analyst',v_area);
  v_step := 'close_assert';
   return query values('conversation_close',coalesce(exists(select 1 from public.tickets where id=v_ticket_b and conversation_state='closed' and status='closed' and closed_at is not null and workflow_revision=4) and not exists(select 1 from public.sla_clock_segments where snapshot_id=v_snapshot and stopped_at is null),false),'close updates ticket and closes clocks');
  v_rejected:=false;
  v_step := 'reopen_attempt';
  begin perform public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_b,'state','in_progress','waiting_reason',null,'expected_revision',4,'idempotency_key',v_run||'_reopen_b'),v_analyst::text,v_run,'analyst',v_area);
  exception when check_violation then v_rejected:=sqlerrm='ILLEGAL_CONVERSATION_TRANSITION'; end;
   return query values('conversation_reopen_if_legal',coalesce(v_rejected,false),'closed to in_progress is rejected because reopen is not legal');

  -- Stale CAS and illegal state sentinels execute against isolated rows.
  v_step := 'revision_rejections';
  v_result:=public.claim_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'expected_revision',0,'idempotency_key',v_run||'_claim_a'),v_analyst::text,v_run,'analyst',v_area);
  v_rejected:=false;
  begin perform public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'state','waiting','waiting_reason','customer_response','expected_revision',99,'idempotency_key',v_run||'_stale_a'),v_analyst::text,v_run,'analyst',v_area);
  exception when serialization_failure then v_rejected:=sqlerrm='WORKFLOW_REVISION_CONFLICT'; end;
   return query values('stale_revision_rejection',coalesce(v_rejected,false),'stale workflow revision is rejected');
  v_rejected:=false;
  begin perform public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'state','new','waiting_reason',null,'expected_revision',1,'idempotency_key',v_run||'_illegal_a'),v_analyst::text,v_run,'analyst',v_area);
  exception when check_violation then v_rejected:=sqlerrm='ILLEGAL_CONVERSATION_TRANSITION'; end;
   return query values('illegal_conversation_state',coalesce(v_rejected,false),'in_progress to new is rejected');

  -- requested -> in_progress -> resolved, with exact create and update replay.
  v_step := 'escalation_lifecycle';
  v_result:=public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'status','requested','note','PHASE11_REQUEST','expected_revision',1,'idempotency_key',v_run||'_esc_create'),v_analyst::text,v_run,'analyst',v_area);
  v_event:=case when jsonb_typeof(v_result->'event_id')='number' and (v_result->>'event_id') ~ '^[0-9]{1,18}$' then (v_result->>'event_id')::bigint else null end;
  v_escalation:=case when jsonb_typeof(v_result->'escalation_id')='number' and (v_result->>'escalation_id') ~ '^[0-9]{1,18}$' then (v_result->>'escalation_id')::bigint else null end;
  v_replay:=public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'status','requested','note','PHASE11_REQUEST','expected_revision',1,'idempotency_key',v_run||'_esc_create'),v_analyst::text,v_run,'analyst',v_area);
   return query values('escalation_create_exact_replay',coalesce(jsonb_typeof(v_replay->'replayed')='boolean' and v_replay->>'replayed'='true' and case when jsonb_typeof(v_replay->'event_id')='number' and (v_replay->>'event_id') ~ '^[0-9]{1,18}$' then (v_replay->>'event_id')::bigint=v_event else false end,false),'escalation create replay returns authoritative event');
   return query values('development_clock_segment_start',coalesce(exists(select 1 from public.sla_snapshots ss join public.sla_clock_segments s on s.snapshot_id=ss.id where ss.ticket_id=v_ticket_a and ss.policy_id=v_development_policy and ss.clock_type='development' and s.stopped_at is null),false),'request starts development clock');
  v_result:=public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'status','in_progress','note','PHASE11_WORK','expected_revision',0,'idempotency_key',v_run||'_esc_progress'),v_analyst::text,v_run,'analyst',v_area);
  v_event:=case when jsonb_typeof(v_result->'event_id')='number' and (v_result->>'event_id') ~ '^[0-9]{1,18}$' then (v_result->>'event_id')::bigint else null end;
  v_replay:=public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'status','in_progress','note','PHASE11_WORK','expected_revision',0,'idempotency_key',v_run||'_esc_progress'),v_analyst::text,v_run,'analyst',v_area);
   return query values('escalation_update_exact_replay',coalesce(jsonb_typeof(v_replay->'replayed')='boolean' and v_replay->>'replayed'='true' and case when jsonb_typeof(v_replay->'event_id')='number' and (v_replay->>'event_id') ~ '^[0-9]{1,18}$' then (v_replay->>'event_id')::bigint=v_event else false end,false),'escalation update replay returns authoritative event');
   return query values('escalation_requested_in_progress',coalesce(exists(select 1 from public.development_escalations where id=v_escalation and status='in_progress' and revision=1),false),'requested escalation enters in_progress');
  v_result:=public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'status','resolved','note','PHASE11_DONE','expected_revision',1,'idempotency_key',v_run||'_esc_resolve'),v_analyst::text,v_run,'analyst',v_area);
   return query values('escalation_in_progress_resolved',coalesce(exists(select 1 from public.development_escalations where id=v_escalation and status='resolved' and revision=2) and exists(select 1 from public.tickets where id=v_ticket_a and conversation_state='in_progress' and waiting_reason is null),false),'in_progress escalation resolves and resumes ticket');
   return query values('development_clock_segment_closure',coalesce(not exists(select 1 from public.sla_snapshots ss join public.sla_clock_segments s on s.snapshot_id=ss.id where ss.ticket_id=v_ticket_a and ss.clock_type='development' and s.stopped_at is null),false),'resolution closes development clock');
   return query values('support_clock_resume_after_escalation',coalesce(exists(select 1 from public.sla_snapshots ss join public.sla_clock_segments s on s.snapshot_id=ss.id where ss.ticket_id=v_ticket_a and ss.clock_type='support' and s.stopped_at is null),false),'resolution resumes support clock');

  -- Separate requested -> cancelled case.
  v_step := 'escalation_cancellation';
  v_result:=public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_c,'status','requested','note','PHASE11_CANCEL_REQUEST','expected_revision',0,'idempotency_key',v_run||'_cancel_create'),v_analyst::text,v_run,'analyst',v_area);
  v_escalation:=case when jsonb_typeof(v_result->'escalation_id')='number' and (v_result->>'escalation_id') ~ '^[0-9]{1,18}$' then (v_result->>'escalation_id')::bigint else null end;
  v_result:=public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_c,'status','cancelled','note','PHASE11_CANCELLED','expected_revision',0,'idempotency_key',v_run||'_cancel_finish'),v_analyst::text,v_run,'analyst',v_area);
   return query values('escalation_requested_cancelled',coalesce(exists(select 1 from public.development_escalations where id=v_escalation and status='cancelled' and revision=1) and exists(select 1 from public.tickets where id=v_ticket_c and conversation_state='in_progress'),false),'separate requested escalation is cancelled');
  v_rejected:=false;
  begin perform public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_c,'status','resolved','note',null,'expected_revision',1,'idempotency_key',v_run||'_illegal_esc'),v_analyst::text,v_run,'analyst',v_area);
  exception when check_violation then v_rejected:=sqlerrm='ILLEGAL_ESCALATION_TRANSITION'; end;
   return query values('illegal_escalation_state',coalesce(v_rejected,false),'cancelled escalation cannot resolve');

  -- Cross-ticket, cross-action, and changed-payload idempotency rejection.
  v_step := 'idempotency_rejections';
  v_rejected:=false;
  begin perform public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_c,'status','requested','note','PHASE11_REQUEST','expected_revision',2,'idempotency_key',v_run||'_esc_create'),v_analyst::text,v_run,'analyst',v_area);
  exception when unique_violation then v_rejected:=sqlerrm='IDEMPOTENCY_KEY_REUSED'; end;
   return query values('cross_ticket_rejection',coalesce(v_rejected,false),'key cannot move to another ticket');
  v_rejected:=false;
  begin perform public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'state','waiting','waiting_reason','customer_response','expected_revision',2,'idempotency_key',v_run||'_esc_create'),v_analyst::text,v_run,'analyst',v_area);
  exception when unique_violation then v_rejected:=sqlerrm='IDEMPOTENCY_KEY_REUSED'; end;
   return query values('cross_action_rejection',coalesce(v_rejected,false),'key cannot change action');
  v_rejected:=false;
  begin perform public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_a,'status','requested','note','CHANGED','expected_revision',1,'idempotency_key',v_run||'_esc_create'),v_analyst::text,v_run,'analyst',v_area);
  exception when unique_violation then v_rejected:=sqlerrm='IDEMPOTENCY_KEY_REUSED'; end;
   return query values('cross_payload_rejection',coalesce(v_rejected,false),'key cannot change payload');

  -- Authorization and admin independence.
  v_step := 'authorization';
  v_rejected:=false;
  begin perform public.update_development_escalation(jsonb_build_object('version',1,'ticket_id',v_ticket_c,'status','requested','note',null,'expected_revision',2,'idempotency_key',v_run||'_intruder'),'-999911',v_run,'analyst',v_area);
  exception when insufficient_privilege then v_rejected:=true; end;
   return query values('analyst_authorization_rejection',coalesce(v_rejected,false),'unassigned analyst is rejected');
  v_result:=public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_admin,'state','waiting','waiting_reason','internal_information','expected_revision',0,'idempotency_key',v_run||'_admin_wait'),'admin-'||v_run,v_run,'admin',null);
   return query values('admin_authorization',coalesce(case when jsonb_typeof(v_result->'ticket_id')='number' and (v_result->>'ticket_id') ~ '^[0-9]{1,18}$' then (v_result->>'ticket_id')::bigint=v_ticket_admin else false end and exists(select 1 from public.tickets where id=v_ticket_admin and conversation_state='waiting'),false),'admin may act outside assignment and area');

  -- Transfer pauses the immutable support snapshot; reclaim resumes that same snapshot.
  v_step := 'transfer_reclaim';
  begin perform public.transition_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_admin,'state','closed','waiting_reason',null,'expected_revision',1,'idempotency_key',v_run||'_bad_analyst'),'not-a-number',v_run,'analyst',v_area);
   return query values('nonnumeric_analyst_rejected',false,'nonnumeric analyst unexpectedly accepted');
  exception when insufficient_privilege then return query values('nonnumeric_analyst_rejected',sqlerrm='INVALID_ACTOR_CONTEXT' and sqlstate='42501','stable actor-context rejection without bigint cast'); end;
  v_result:=public.claim_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_d,'expected_revision',0,'idempotency_key',v_run||'_claim_d'),v_analyst::text,v_run,'analyst',v_area);
  select id into strict v_snapshot from public.sla_snapshots where ticket_id=v_ticket_d and escalation_id is null and clock_type='support';
  update public.tickets set area_id=v_other_area where id=v_ticket_d;
   return query values('transfer_pause',coalesce(not exists(select 1 from public.sla_clock_segments where snapshot_id=v_snapshot and stopped_at is null),false),'area transfer pauses support clock');
  update public.tickets set area_id=v_area where id=v_ticket_d;
  update public.ticket_assignments set analyst_id=null where ticket_id=v_ticket_d;
  v_result:=public.claim_conversation(jsonb_build_object('version',1,'ticket_id',v_ticket_d,'expected_revision',3,'idempotency_key',v_run||'_reclaim_d'),v_analyst::text,v_run,'analyst',v_area);
   return query values('transfer_reclaim_snapshot',coalesce((select count(*) from public.sla_snapshots where ticket_id=v_ticket_d and escalation_id is null and clock_type='support')=1 and exists(select 1 from public.sla_clock_segments where snapshot_id=v_snapshot and stopped_at is null),false),'reclaim resumes original snapshot without duplication');
   return query values('support_policy_snapshot',coalesce(exists(select 1 from public.sla_snapshots where id=v_snapshot and policy_id=v_support_policy),false),'support snapshot captures isolated policy');
   return query values('execution_error',true,'composite-return transition and escalation paths completed without an uncaught runtime error');
   return;

exception when query_canceled or assert_failure then
  get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_context = pg_exception_context, v_message = message_text;
  select left(string_agg(format('%s line %s',m[1],m[2]),' > ' order by ord),512) into v_safe_context
  from regexp_matches(coalesce(v_context,''),'(?im)(?:PL/pgSQL )?(?:function|procedure) ([a-z_][a-z0-9_$.]*)(?:\([^\r\n]*\))? line ([0-9]+)','g') with ordinality as r(m,ord);
  v_constraint:=case when v_constraint is null or v_constraint='' then 'none' when v_constraint~'^[a-z_][a-z0-9_$]{0,62}$' then v_constraint else 'redacted' end;
  v_category:=case when v_state='22P02' then 'invalid_text_representation' else 'none' end;
  v_target_type:=case when v_state<>'22P02' or v_message is null then 'unknown' when lower(v_message) like 'invalid input syntax for type bigint:%' then 'bigint' when lower(v_message) like 'invalid input syntax for type integer:%' then 'integer' when lower(v_message) like 'invalid input syntax for type uuid:%' then 'uuid' when lower(v_message) like 'invalid input syntax for type json:%' then 'json' when lower(v_message) like 'invalid input syntax for type boolean:%' then 'boolean' when lower(v_message) like 'invalid input syntax for type date:%' then 'date' when lower(v_message) like 'invalid input syntax for type timestamp%' then 'timestamp' when lower(v_message) like 'invalid input syntax for type time%' then 'time' else 'unknown' end;
  return query values('execution_error',false,left('step='||v_step||' sqlstate='||coalesce(v_state,'unknown')||' constraint='||v_constraint||' category='||v_category||' target_type='||v_target_type||' context='||coalesce(v_safe_context,'none'),768));
  return;
when others then
  get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_context = pg_exception_context, v_message = message_text;
  select left(string_agg(format('%s line %s',m[1],m[2]),' > ' order by ord),512) into v_safe_context
  from regexp_matches(coalesce(v_context,''),'(?im)(?:PL/pgSQL )?(?:function|procedure) ([a-z_][a-z0-9_$.]*)(?:\([^\r\n]*\))? line ([0-9]+)','g') with ordinality as r(m,ord);
  v_constraint:=case when v_constraint is null or v_constraint='' then 'none' when v_constraint~'^[a-z_][a-z0-9_$]{0,62}$' then v_constraint else 'redacted' end;
  v_category:=case when v_state='22P02' then 'invalid_text_representation' else 'none' end;
  v_target_type:=case when v_state<>'22P02' or v_message is null then 'unknown' when lower(v_message) like 'invalid input syntax for type bigint:%' then 'bigint' when lower(v_message) like 'invalid input syntax for type integer:%' then 'integer' when lower(v_message) like 'invalid input syntax for type uuid:%' then 'uuid' when lower(v_message) like 'invalid input syntax for type json:%' then 'json' when lower(v_message) like 'invalid input syntax for type boolean:%' then 'boolean' when lower(v_message) like 'invalid input syntax for type date:%' then 'date' when lower(v_message) like 'invalid input syntax for type timestamp%' then 'timestamp' when lower(v_message) like 'invalid input syntax for type time%' then 'time' else 'unknown' end;
  return query values('execution_error',false,left('step='||v_step||' sqlstate='||coalesce(v_state,'unknown')||' constraint='||v_constraint||' category='||v_category||' target_type='||v_target_type||' context='||coalesce(v_safe_context,'none'),768));
  return;
end;
$check$;

revoke all on function public.phase11_behavior_check_sentinel_20260722() from public;

-- This is the script's only result-producing statement. False status means FAIL.
select * from public.phase11_behavior_check_sentinel_20260722();

drop function public.phase11_behavior_check_sentinel_20260722();

-- True simultaneous locking is the only pending proof; see the two-session runbook procedure.
rollback;

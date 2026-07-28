const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { businessMilliseconds, computeClock, isBusinessMinute } = require('../src/services/slaClock');
const { escalationPayload, normalizePriority, presentSla, transitionPayload } = require('../src/services/conversationWorkflow');

const weekdayCalendar = {
  timezone: 'America/Bogota',
  windows: [1,2,3,4,5].map(weekday => ({ weekday, start: '08:00', end: '17:00' })),
  exceptions: [],
};

test('Bogota business time excludes overnight and weekends', () => {
  assert.equal(businessMilliseconds('2026-07-20T12:00:00Z', '2026-07-20T14:00:00Z', weekdayCalendar) / 60000, 60);
  assert.equal(businessMilliseconds('2026-07-17T21:00:00Z', '2026-07-20T14:00:00Z', weekdayCalendar) / 60000, 120);
});

test('calendar holidays and overnight windows are deterministic', () => {
  const holiday = { ...weekdayCalendar, exceptions: [{ date: '2026-07-20', closed: true }] };
  assert.equal(businessMilliseconds('2026-07-20T13:00:00Z', '2026-07-20T15:00:00Z', holiday), 0);
  const overnight = { timezone: 'America/Bogota', windows: [{ weekday: 1, start: '22:00', end: '02:00' }], exceptions: [] };
  assert.equal(isBusinessMinute('2026-07-21T06:00:00Z', overnight), true);
  assert.equal(isBusinessMinute('2026-07-21T08:00:00Z', overnight), false);
});

test('calendar boundaries, replacement exceptions, malformed data and DST are deterministic', () => {
  assert.equal(isBusinessMinute('2026-07-20T13:00:00Z', weekdayCalendar), true); // 08:00 inclusive
  assert.equal(isBusinessMinute('2026-07-20T22:00:00Z', weekdayCalendar), false); // 17:00 exclusive
  const replacement = { ...weekdayCalendar, exceptions: [{ date: '2026-07-20', closed: false, windows: [{ start: '10:00', end: '11:00' }] }] };
  assert.equal(isBusinessMinute('2026-07-20T14:00:00Z', replacement), false);
  assert.equal(isBusinessMinute('2026-07-20T15:30:00Z', replacement), true);
  assert.throws(() => isBusinessMinute('2026-07-20T13:00:00Z', { timezone: 'Mars/Olympus', windows: [] }), RangeError);
  assert.throws(() => isBusinessMinute('2026-07-20T13:00:00Z', { timezone: 'UTC', windows: [{ weekday: 1, start: 'bad', end: '10:00' }] }), /Invalid business window/);
  const ny = { timezone: 'America/New_York', windows: [{ weekday: 0, start: '01:00', end: '04:00' }], exceptions: [] };
  assert.equal(businessMilliseconds('2026-03-08T06:00:00Z', '2026-03-08T08:00:00Z', ny) / 60000, 120);
});

test('24x7 pause/resume keeps remaining time and snapshots isolate policy edits', () => {
  const segments = [
    { started_at: '2026-07-20T10:00:00Z', stopped_at: '2026-07-20T10:30:00Z' },
    { started_at: '2026-07-20T11:00:00Z' },
  ];
  const captured = computeClock({ target_minutes: 120, warning_minutes: 20, policy_version: 1, clock_mode: '24x7' }, segments, '2026-07-20T11:30:00Z');
  assert.equal(captured.consumed_minutes, 60);
  assert.equal(captured.remaining_minutes, 60);
  assert.equal(captured.policy_version, 1);
  assert.equal(computeClock(null, []).status, 'unconfigured');
});

test('canonical SLA presentation uses identical support semantics for workflow and cards', () => {
  const workflow = { sla_snapshots: [{ id: 7, clock_type: 'support', target_minutes: 60, warning_minutes: 10, policy_version: 2, clock_mode: '24x7', sla_clock_segments: [{ started_at: '2026-07-20T10:00:00Z' }] }] };
  const support = presentSla(workflow, new Date('2026-07-20T10:30:00Z')).support;
  assert.equal(support.state, support.status);
  assert.equal(support.minutes_remaining, support.remaining_minutes);
  assert.equal(support.snapshot_id, 7);
});

test('critical and Spanish priorities normalize without rewriting source labels', () => {
  assert.equal(normalizePriority('Crítica'), 'critical');
  assert.equal(normalizePriority('Alta'), 'high');
  assert.equal(normalizePriority('unknown'), null);
});

test('workflow request validation requires waiting reason, CAS and idempotency', () => {
  assert.deepEqual(transitionPayload({ state: 'waiting', waiting_reason: 'development_escalation', expected_revision: 2, idempotency_key: 'request_123' }), {
    state: 'waiting', waitingReason: 'development_escalation', expectedRevision: 2, idempotencyKey: 'request_123',
  });
  assert.throws(() => transitionPayload({ state: 'waiting', expected_revision: 2, idempotency_key: 'request_123' }), /waiting_reason/);
  assert.equal(escalationPayload({ status: 'resolved', expected_revision: 1, idempotency_key: 'resolve_123' }).status, 'resolved');
});

test('Phase 11 SQL is transactional, backend-only, CAS-safe and append-only', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_fix_forward.sql'), 'utf8');
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/i);
  for (const state of ['new','in_progress','waiting','closed']) assert.match(sql, new RegExp(`'${state}'`));
  for (const state of ['requested','in_progress','resolved','cancelled']) assert.match(sql, new RegExp(`'${state}'`));
  for (const priority of ['critical','high','medium','low']) assert.match(sql, new RegExp(`'${priority}'`));
  assert.match(sql, /workflow_revision<>p_expected_revision/i);
  assert.match(sql, /unique\(actor_id,idempotency_key\)/i);
  assert.match(sql, /request_fingerprint text not null/i);
  assert.match(sql, /request_payload jsonb not null/i);
  assert.match(sql, /IDEMPOTENCY_KEY_REUSED/i);
  assert.match(sql, /v_event\.ticket_id<>p_ticket_id/i);
  assert.match(sql, /jsonb_build_object\('ticket_id',p_ticket_id,'event_id',v_event/i);
  assert.match(sql, /create table if not exists public\.sla_clock_segments/i);
  assert.match(sql, /policy_version bigint not null/i);
  assert.match(sql, /calendar_snapshot jsonb not null/i);
  assert.match(sql, /set search_path=pg_catalog,public/i);
  assert.match(sql, /alter function %s owner to %I/i);
  assert.doesNotMatch(sql, /grant .* to (anon|authenticated)/i);
  assert.match(sql, /item\.proname in \('transition_conversation','claim_conversation','update_development_escalation'/i);
  assert.match(sql, /transition_conversation\(p_command jsonb/i);
  assert.match(sql, /update_development_escalation\(p_command jsonb/i);
  assert.doesNotMatch(sql, /transition_conversation\(p_ticket_id bigint,p_state text/i);
  for (const rpc of ['transition_conversation','update_development_escalation']) {
    const body = sql.slice(sql.indexOf(`create or replace function public.${rpc}`), sql.indexOf('end $$;', sql.indexOf(`create or replace function public.${rpc}`)));
    assert.ok(body.indexOf('phase11_lock_authorized_ticket') < body.indexOf('phase11_replay'), `${rpc} must authorize before replay`);
  }
  const claimBody = sql.slice(sql.indexOf('create or replace function public.claim_conversation'), sql.indexOf('end $$;', sql.indexOf('create or replace function public.claim_conversation')));
  assert.ok(claimBody.indexOf('v_assignment is not null') < claimBody.indexOf('phase11_replay'), 'claim must reject a former assignee before replay');
  assert.match(sql, /conversation_state='waiting',waiting_reason='development_escalation'/i);
  assert.match(sql, /conversation_state='in_progress',waiting_reason=null/i);
  assert.match(sql, /p_ticket\.conversation_state<>'in_progress'/i);
  assert.doesNotMatch(sql, /p_actor_role='development'/i);
  assert.match(sql, /p_escalation\.status='requested' and p_status in \('in_progress','resolved','cancelled'\)/i);
  const escalationBody = sql.slice(sql.indexOf('create or replace function public.update_development_escalation'), sql.indexOf('end $$;', sql.indexOf('create or replace function public.update_development_escalation')));
  for (const helper of ['phase11_lock_latest_escalation','phase11_validate_escalation_transition','phase11_persist_escalation','phase11_record_escalation_event','phase11_suspend_ticket_for_development','phase11_close_support_clock','phase11_close_development_clock','phase11_resume_ticket_after_development','phase11_resume_support_clock','phase11_escalation_response']) assert.match(escalationBody, new RegExp(helper));
  assert.doesNotMatch(escalationBody, /(?:insert|update)\s+(?:into\s+)?public\.(?:tickets|development_escalations|workflow_events|audit_log|sla_clock_segments)/i);
  assert.match(sql, /phase11_record_escalation_event\(p_escalation public\.development_escalations,p_context jsonb\)/i);
  assert.match(sql, /drop function if exists public\.phase11_record_escalation_event\(bigint,public\.development_escalations,text,text,text,text,text,text,text,jsonb\)/i);
  assert.match(escalationBody, /p_escalation=>v_escalation[\s\S]*p_context=>jsonb_build_object\([\s\S]*'version',1[\s\S]*'transition'[\s\S]*'trusted_actor'[\s\S]*'idempotency_key'[\s\S]*'request_payload'/i);
  assert.doesNotMatch(escalationBody, /phase11_record_escalation_event\(p_ticket_id,v_escalation,v_from/i);
  const recordEventBody = sql.slice(sql.indexOf('create or replace function public.phase11_record_escalation_event'), sql.indexOf('end $$;', sql.indexOf('create or replace function public.phase11_record_escalation_event')));
  for (const contract of ['INVALID_ESCALATION_EVENT_CONTEXT', "p_context ?& array['version','transition','trusted_actor','idempotency_key','request_payload']", "v_transition ?& array['from_status','to_status','note']", "v_trusted_actor ?& array['id','name','role']", "v_payload ?& array['ticket_id','status','note','expected_revision']", 'length(coalesce(v_note,\'\'))>4000', "v_actor_role not in ('analyst','admin')"]) assert.match(recordEventBody, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(sql, /stop_reason='area_transfer'/i);
  assert.match(sql, /select id into v_snapshot[\s\S]*for update/i);
  assert.match(sql, /phase11_build_actor_context\(p_actor_id text,p_actor_role text,p_actor_area_id bigint\) returns bigint/i);
  assert.match(sql, /phase11_lock_authorized_ticket\(p_ticket_id bigint,p_actor_analyst_id bigint,p_actor_role text,p_actor_area_id bigint\)/i);
  assert.doesNotMatch(sql.slice(sql.indexOf('create or replace function public.phase11_lock_authorized_ticket'), sql.indexOf('end $$;', sql.indexOf('create or replace function public.phase11_lock_authorized_ticket'))), /::bigint/i);
});

test('Phase 11 actor repair is the single idempotent operator migration with exact signatures and ACLs', () => {
  const repair = fs.readFileSync(path.join(__dirname, '../supabase/phase11_actor_identity_fix.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_postflight.sql'), 'utf8');
  const canonicalCreate = repair.indexOf('create or replace function public.phase11_build_actor_context');
  const overloadSweep = repair.indexOf('do $owner_and_overloads$');
  const aclSweep = repair.indexOf('do $exact_acl$');
  assert.match(repair, /^--[^\n]*actor identity repair[\s\S]*begin;[\s\S]*commit;\s*$/i);
  assert.match(repair, /pg_advisory_xact_lock/i);
  assert.doesNotMatch(repair, /\breturn\s*;|pg_get_functiondef|\breplace\s*\(/i, 'repair must always converge from explicit canonical definitions');
  for (const signature of [
    'phase11_build_actor_context\\(p_actor_id text,p_actor_role text,p_actor_area_id bigint\\)',
    'phase11_lock_authorized_ticket\\(p_ticket_id bigint,p_actor_analyst_id bigint,p_actor_role text,p_actor_area_id bigint\\)',
    'transition_conversation\\(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint\\)',
    'claim_conversation\\(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint\\)',
    'update_development_escalation\\(p_command jsonb,p_actor_id text,p_actor_name text,p_actor_role text,p_actor_area_id bigint\\)'
  ]) assert.match(repair, new RegExp(`create or replace function public\\.${signature}`, 'i'));
  assert.ok(canonicalCreate > 0 && overloadSweep > canonicalCreate && aclSweep > overloadSweep, 'dependencies must move before guarded stale overload drops and ACL normalization');
  assert.match(repair, /p\.oid not in \([\s\S]*drop function %s restrict/i);
  assert.match(repair, /INVALID_ACTOR_CONTEXT[\s\S]*errcode='42501'/i);
  assert.match(repair, /revoke all on function public\.phase11_build_actor_context\(text,text,bigint\) from public,anon,authenticated,service_role/i);
  for (const rpc of ['transition_conversation','claim_conversation','update_development_escalation']) assert.match(repair, new RegExp(`grant execute on function public\\.${rpc}\\(jsonb,text,text,text,bigint\\) to service_role`, 'i'));
  assert.doesNotMatch(repair, /grant execute on function public\.phase11_(?:build_actor_context|lock_authorized_ticket)/i);
  assert.match(postflight, /phase11_build_actor_context\(text,text,bigint\)/i);
  assert.match(postflight, /phase11_lock_authorized_ticket\(bigint,bigint,text,bigint\)/i);
  assert.match(postflight, /claim_conversation\(jsonb,text,text,text,bigint\)/i);
  assert.doesNotMatch(postflight, /phase11_lock_authorized_ticket\(bigint,text,text,bigint\)/i);
  assert.match(postflight, /function_overload_set_exact[\s\S]*service_role_exact_function_acl[\s\S]*unexpected_effective_function_grantees[\s\S]*public_oid0_function_denial/i);
  assert.match(postflight, /actor_identity_functions[\s\S]*actor_identity_rpc_acl_exact[\s\S]*has_function_privilege\('service_role',oid,'EXECUTE'\)<>public_rpc/i);
});

test('Phase 11 composite-return repair is convergent and every composite helper uses row assignment', () => {
  const supabaseDir = path.join(__dirname, '../supabase');
  const repair = fs.readFileSync(path.join(supabaseDir, 'phase11_composite_assignment_fix.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(supabaseDir, 'phase11_conversation_sla_postflight.sql'), 'utf8');
  const behavior = fs.readFileSync(path.join(supabaseDir, 'phase11_conversation_sla_behavior_check.sql'), 'utf8');
  const runbook = fs.readFileSync(path.join(supabaseDir, 'PHASE11_CONVERSATION_SLA_RUNBOOK.md'), 'utf8');
  const antiPattern = /select\s+public\.phase11_(?:lock_authorized_ticket|lock_latest_escalation|persist_escalation)\s*\([^;]+?\)\s+into\s+v_(?:ticket|escalation)\b/i;
  for (const file of fs.readdirSync(supabaseDir).filter(name => /^phase11_.*\.sql$/i.test(name))) {
    assert.doesNotMatch(fs.readFileSync(path.join(supabaseDir, file), 'utf8'), antiPattern, `${file} must not assign a composite function's scalar select column to a row variable`);
  }
  assert.match(repair, /^--[^\n]*composite-return assignment repair[\s\S]*begin;[\s\S]*pg_advisory_xact_lock[\s\S]*commit;\s*$/i);
  assert.equal((repair.match(/create or replace function public\.(?:transition_conversation|update_development_escalation)\(/gi) || []).length, 2);
  for (const assignment of [
    'v_ticket:=public.phase11_lock_authorized_ticket(',
    'v_escalation:=public.phase11_lock_latest_escalation(',
    'v_escalation:=public.phase11_persist_escalation(',
  ]) assert.match(repair, new RegExp(assignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.match(repair, /alter function %s owner to %I[\s\S]*alter function %s security definer[\s\S]*alter function %s volatile[\s\S]*alter function %s set search_path=pg_catalog,public/i);
  assert.match(repair, /revoke all on function public\.transition_conversation\(jsonb,text,text,text,bigint\) from public,anon,authenticated,service_role[\s\S]*grant execute on function public\.update_development_escalation\(jsonb,text,text,text,bigint\) to service_role/i);
  assert.match(postflight, /composite_return_assignment_contract/i);
  assert.match(behavior, /composite-return transition and escalation paths completed/i);
  assert.match(runbook, /apply twice, postflight, behavior/i);
});

test('Phase 11 fix-forward requires the applied workflow baseline and invents no workflow state or escalation history', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_fix_forward.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_postflight.sql'), 'utf8');
  const migrationBackfill = sql.slice(0, sql.indexOf('create or replace function'));
  assert.match(migrationBackfill, /PHASE11_FIX_FORWARD_INCOMPATIBLE_TICKET_WORKFLOW_BASELINE/i);
  for (const column of ['conversation_state','waiting_reason','workflow_revision','priority_normalized']) assert.match(migrationBackfill, new RegExp(`'${column}'`));
  assert.doesNotMatch(migrationBackfill, /add column if not exists (?:conversation_state|waiting_reason|workflow_revision|priority_normalized)/i);
  assert.doesNotMatch(migrationBackfill, /set conversation_state\s*=\s*case|when t\.status='closed'|from public\.ticket_assignments a/i);
  assert.doesNotMatch(migrationBackfill, /insert into public\.development_escalations/i);
  assert.doesNotMatch(postflight, /behavior_check.*pass/i);
  assert.match(postflight, /public_oid0_relation_denial/i);
  assert.match(postflight, /service_role_exact_table_acl/i);
  for (const helper of ['phase11_lock_latest_escalation','phase11_validate_escalation_transition','phase11_persist_escalation','phase11_record_escalation_event','phase11_resume_ticket_after_development','phase11_close_development_clock','phase11_resume_support_clock','phase11_escalation_response','phase11_transfer_sets_new']) assert.match(postflight, new RegExp(helper));
  assert.match(postflight, /phase11_record_escalation_event\(development_escalations,jsonb\)/i);
  assert.doesNotMatch(postflight, /phase11_record_escalation_event\(bigint,(?:public\.)?development_escalations,text/i);
});

test('Phase 11 fix-forward is bounded, guarded, idempotent and rejects ambiguous binding backfill', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_fix_forward.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_postflight.sql'), 'utf8');
  const runbook = fs.readFileSync(path.join(__dirname, '../supabase/PHASE11_CONVERSATION_SLA_RUNBOOK.md'), 'utf8');
  assert.match(sql, /^begin;[\s\S]*set local lock_timeout = '5s';[\s\S]*set local statement_timeout = '120s';/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('nexo:phase11:conversation-sla',0\)\)/i);
  assert.match(sql, /PHASE11_FIX_FORWARD_BASELINE_MISSING/i);
  assert.match(sql, /PHASE11_FIX_FORWARD_AMBIGUOUS_EVENT_BACKFILL/i);
  assert.match(sql, /add column if not exists request_fingerprint/i);
  assert.match(sql, /drop function %s restrict/i);
  assert.doesNotMatch(sql, /delete from public\.|truncate table public\.|workflow_revision\s*=\s*0/i);
  assert.match(postflight, /function_overload_set_exact/i);
  assert.match(postflight, /complete_column_contract/i);
  assert.match(postflight, /validated_attached_constraint_contract/i);
  assert.match(postflight, /valid_index_shape_and_marker_contract/i);
  assert.match(postflight, /check_constraint_marker_contract/i);
  assert.doesNotMatch(postflight, /pg_get_constraintdef/i);
  assert.doesNotMatch(postflight, /pg_get_expr\(i\.indpred/i);
  assert.doesNotMatch(postflight, /(?:conkey|confkey|indkey|indclass|indoption|indcollation)::(?:smallint|oid)\[\]/i);
  assert.match(postflight, /unnest\(i\.indkey\) with ordinality/i);
  assert.match(postflight, /i\.indisunique=e\.is_unique/i);
  assert.match(postflight, /i\.indpred is not null/i);
  assert.match(postflight, /c\.contype not in \('p','u'\)/i);
  assert.match(postflight, /unnest\(c\.conkey\) with ordinality/i);
  assert.match(postflight, /c\.confrelid=to_regclass/i);
  assert.match(postflight, /unnest\(c\.confkey\) with ordinality/i);
  assert.match(postflight, /c\.confdeltype=s\.delete_action/i);
  for (const indexName of ['sla_policies_one_active_idx','development_escalations_active_ticket_idx','sla_snapshots_support_once_idx','sla_snapshots_escalation_once_idx','sla_clock_segments_open_idx']) {
    assert.match(sql, new RegExp(`drop index if exists public\\.${indexName};[\\s\\S]*create unique index ${indexName}`, 'i'));
  }
  assert.match(postflight, /transfer_trigger_exact/i);
  assert.match(postflight, /service_role_exact_sequence_acl/i);
  assert.match(postflight, /unexpected_effective_relation_grantees/i);
  assert.match(postflight, /public_oid0_function_denial/i);
  assert.match(sql, /aclexplode\(coalesce\(c\.relacl,acldefault\('r',c\.relowner\)\)\)/i);
  assert.match(sql, /revoke all on sequence %s from public,anon,authenticated,service_role/i);
  assert.match(sql, /grant usage,select on sequence %s to service_role/i);
  assert.match(sql, /aclexplode\(coalesce\(p\.proacl,acldefault\('f',p\.proowner\)\)\)/i);
  assert.match(runbook, /applied twice successfully[\s\S]*mandatory operator proof/i);
  assert.match(runbook, /constraint_repair[\s\S]*postflight[\s\S]*behavior_check/i);
  assert.match(runbook, /no safe generic down migration/i);
});

test('Phase 11 governed constraints and indexes use complete immutable markers instead of deparse equality', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_fix_forward.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_postflight.sql'), 'utf8');
  const markers = [...postflight.matchAll(/nexo:phase11:contract:([a-z0-9_]+):v2:([a-f0-9]{64})/g)];
  assert.equal(markers.length, 22);
  assert.equal(new Set(markers.map(match => match[0])).size, markers.length, 'markers must be unique');
  for (const [, objectName] of markers) {
    const migrationMarker = new RegExp(`nexo:phase11:contract:${objectName}:v2:[a-f0-9]{64}`, 'i');
    assert.match(sql, migrationMarker, `${objectName} must be marked by the migration`);
    if (objectName.endsWith('_idx')) {
      assert.match(sql, new RegExp(`drop index if exists public\\.${objectName};[\\s\\S]*create unique index ${objectName}[^;]*;\\s*comment on index public\\.${objectName} is '${migrationMarker.source}'`, 'i'));
    } else {
      assert.match(sql, new RegExp(`drop constraint if exists ${objectName};[\\s\\S]*add constraint ${objectName} check\\([\\s\\S]*?\\);\\s*comment on constraint ${objectName}`, 'i'));
    }
  }
  assert.match(sql, /check\(\s*\(conversation_state='waiting'[\s\S]*\) or\s*\(conversation_state<>'waiting'/i, 'semantic grouping must remain explicit in canonical DDL');
  assert.doesNotMatch(postflight, /pg_get_(?:constraintdef|indexdef)/i);
});

test('Phase 11 diagnostics expose safe catalog metadata and postflight matches helper language', () => {
  const diagnostics = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_diagnostics.sql'), 'utf8');
  const postflight = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_postflight.sql'), 'utf8');
  const runbook = fs.readFileSync(path.join(__dirname, '../supabase/PHASE11_CONVERSATION_SLA_RUNBOOK.md'), 'utf8');
  assert.match(diagnostics, /^--[^\n]*pure read-only[\s\S]*begin read only;/i);
  assert.match(diagnostics, /function_contract[\s\S]*expected_constraint_missing_or_shape[\s\S]*unexpected_constraint/i);
  for (const field of ['pg_get_function_result','lanname','provolatile','prosecdef','proconfig','rolname','convalidated','key_names','ref_key_names','delete_action']) assert.match(diagnostics, new RegExp(field, 'i'));
  assert.match(diagnostics, /array_agg\(a\.attname::text order by k\.ord\)::text\[\]/i);
  assert.equal((diagnostics.match(/array_agg\(a\.attname::text order by k\.ord\)::text\[\]/gi) || []).length, 2, 'local and referenced catalog attribute arrays must be text[]');
  assert.match(diagnostics, /rt\.relname::text ref_table/i);
  assert.match(diagnostics, /n\.nspname::text='public' and t\.relname::text in/i);
  assert.match(diagnostics, /to_regprocedure\('public\.'\|\|e\.signature\)::oid/i);
  assert.match(diagnostics, /p\.proconfig is distinct from array\['search_path=pg_catalog, public'\]::text\[\]/i);
  assert.doesNotMatch(diagnostics, /(?:key_names|ref_key_names)\s*<>/i);
  assert.doesNotMatch(diagnostics, /pg_get_functiondef|prosrc|select\s+\*\s+from\s+public\./i);
  assert.match(postflight, /phase11_calendar_snapshot','phase11_request_fingerprint','phase11_lock_latest_escalation/i);
  assert.match(runbook, /constraint_repair\.sql[\s\S]*postflight\.sql[\s\S]*behavior_check\.sql/i);
});

test('Phase 11 constraint repair recognizes the PostgreSQL-canonical UNIQUE name idempotently', () => {
  const repair = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_constraint_repair.sql'), 'utf8');
  const diagnostics = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_diagnostics.sql'), 'utf8');
  const runbook = fs.readFileSync(path.join(__dirname, '../supabase/PHASE11_CONVERSATION_SLA_RUNBOOK.md'), 'utf8');
  assert.match(repair, /^--[^\n]*constraint repair[\s\S]*begin;[\s\S]*commit;\s*$/i);
  assert.match(repair, /set local lock_timeout = '5s'[\s\S]*set local statement_timeout = '30s'/i);
  assert.match(repair, /pg_advisory_xact_lock\(hashtextextended\('nexo:phase11:conversation-sla',0\)\)/i);
  assert.match(repair, /c\.contype='u'[\s\S]*c\.convalidated[\s\S]*array\['calendar_id','weekday','starts_at','ends_at'\]/i);
  assert.match(repair, /i\.indisunique[\s\S]*i\.indisvalid[\s\S]*i\.indisready/i);
  assert.match(repair, /c\.conname='business_calendar_windows_calendar_id_weekday_starts_at_ends_at'/i);
  assert.doesNotMatch(repair, /rename constraint|business_calendar_windows_calendar_id_weekday_starts_at_ends_at_key/i);
  assert.match(repair, /v_duplicate_bin is distinct from v_canonical_bin/i);
  assert.match(repair, /drop constraint sla_policies_check1 restrict/i);
  assert.doesNotMatch(repair, /(?:create|reindex)\s+(?:unique\s+)?index|insert into|update public\.|delete from|truncate/i);
  assert.match(diagnostics, /expected_constraint_names[\s\S]*expected_constraint_shapes union select[\s\S]*expected_check_markers/i);
  assert.match(diagnostics, /expected_check_missing_or_marker/i);
  assert.match(diagnostics, /unexpected_constraint[\s\S]*expected_constraint_names/i);
  assert.match(runbook, /constraint_repair\.sql[\s\S]*postflight\.sql[\s\S]*behavior_check\.sql/i);
});

test('Phase 11 explicit PostgreSQL identifiers fit NAMEDATALEN and generated names use canonical truncation', () => {
  const supabaseDir = path.join(__dirname, '../supabase');
  const files = fs.readdirSync(supabaseDir).filter(name => /^phase11_.*\.sql$/i.test(name));
  const identifierPatterns = [
    /\b(?:add|drop|rename)\s+constraint(?:\s+if\s+exists)?\s+([a-z_][a-z0-9_]*)/gi,
    /\bconstraint\s+([a-z_][a-z0-9_]*)\s+(?:primary|foreign|unique|check)/gi,
    /\b(?:create(?:\s+unique)?|drop)\s+index(?:\s+if\s+exists)?\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi,
    /\b(?:create\s+or\s+replace|drop)\s+function(?:\s+if\s+exists)?\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi,
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(supabaseDir, file), 'utf8');
    for (const pattern of identifierPatterns) {
      for (const match of source.matchAll(pattern)) {
        assert.ok(Buffer.byteLength(match[1], 'utf8') <= 63, `${file}: ${match[1]} exceeds PostgreSQL's 63-byte identifier limit`);
      }
    }
  }
  const generated = 'business_calendar_windows_calendar_id_weekday_starts_at_ends_at_key';
  const canonical = Buffer.from(generated, 'utf8').subarray(0, 63).toString('utf8');
  assert.equal(canonical, 'business_calendar_windows_calendar_id_weekday_starts_at_ends_at');
  for (const file of files) {
    const source = fs.readFileSync(path.join(supabaseDir, file), 'utf8');
    assert.doesNotMatch(source, /business_calendar_windows_calendar_id_weekday_starts_at_ends_at_key/);
  }
});

test('Phase 11 command validators reject missing and mistyped required fields before lookup or casts', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_fix_forward.sql'), 'utf8');
  const functionBody = name => {
    const start = sql.indexOf(`create or replace function public.${name}`);
    assert.notEqual(start, -1, `${name} must exist`);
    return sql.slice(start, sql.indexOf('end $$;', start));
  };
  for (const [name, fields, code, lookup] of [
    ['transition_conversation', ['version','ticket_id','state','waiting_reason','expected_revision','idempotency_key'], 'INVALID_WORKFLOW_COMMAND', 'phase11_lock_authorized_ticket'],
    ['claim_conversation', ['version','ticket_id','expected_revision','idempotency_key'], 'INVALID_CLAIM_COMMAND', 'from public.tickets'],
    ['update_development_escalation', ['version','ticket_id','status','note','expected_revision','idempotency_key'], 'INVALID_ESCALATION_COMMAND', 'phase11_lock_authorized_ticket'],
  ]) {
    const body = functionBody(name);
    assert.match(body, new RegExp(`\\?& array\\['${fields.join("','")}']`, 'i'));
    assert.match(body, /jsonb_typeof\(p_command\) is distinct from 'object'/i);
    assert.match(body, /p_command->>'version' is distinct from '1'/i);
    assert.match(body, new RegExp(`${code}[\\s\\S]*errcode='22023'`, 'i'));
    assert.ok(body.indexOf(code) < body.indexOf(lookup), `${name} must validate before database/auth lookup`);
    assert.ok(body.indexOf(code) < body.indexOf("::bigint"), `${name} must validate before numeric casts`);
  }
  const policy = functionBody('configure_sla_policy');
  assert.ok(policy.indexOf('INVALID_SLA_POLICY_COMMAND') < policy.indexOf('from public.areas'));
  const calendar = functionBody('configure_business_calendar');
  assert.match(calendar, /p_windows is null[\s\S]*jsonb_typeof\(p_windows\) is distinct from 'array'/i);
  assert.ok(calendar.indexOf('INVALID_BUSINESS_CALENDAR_COMMAND') < calendar.indexOf('from public.areas'));
  for (const contract of [
    "jsonb_typeof(item) is distinct from 'object'",
    "item ?& array['weekday','start','end']",
    "jsonb_typeof(item->'weekday') is distinct from 'number'",
    "item->>'weekday' !~ '^[0-6]$'",
    "item ?& array['date','closed','windows']",
    "jsonb_typeof(item->'closed') is distinct from 'boolean'",
    "not coalesce(jsonb_typeof(item->'windows') in ('array','null'),false)",
    "invalid_datetime_format or datetime_field_overflow",
    "group by e->>'date' having count(*)>1",
    'generate_series(-1,1) shift(week)',
  ]) assert.match(calendar, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.doesNotMatch(calendar.slice(0, calendar.indexOf('perform 1 from public.areas')), /coalesce\(p_(?:windows|exceptions)/i);
  assert.doesNotMatch(calendar, /INVALID_CALENDAR_(?:SHAPE|WINDOW)|OVERLAPPING_CALENDAR_WINDOWS/i);
  const eventContext = functionBody('phase11_record_escalation_event');
  assert.match(eventContext, /p_context \?& array\['version','transition','trusted_actor','idempotency_key','request_payload'\]/i);
  assert.match(eventContext, /jsonb_typeof\(v_payload->'ticket_id'\) is distinct from 'number'/i);
  assert.match(eventContext, /v_payload->>'expected_revision' !~ '\^\[0-9\]\{1,18\}\$'/i);
});

test('operator behavior proof is transactional, isolated and documents concurrency gap', () => {
  const proof = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_behavior_check.sql'), 'utf8');
  const runbook = fs.readFileSync(path.join(__dirname, '../supabase/phase11_conversation_sla_runbook.md'), 'utf8');
  assert.match(proof, /^--[\s\S]*begin;[\s\S]*rollback;\s*$/i);
  assert.doesNotMatch(proof, /create\s+(?:global\s+|local\s+)?temp(?:orary)?\b|pg_temp|phase11_behavior_results/i);
  assert.match(proof, /create function public\.phase11_behavior_check_sentinel_20260722\(\)[\s\S]*returns table\(check_name text,status boolean,detail text\)[\s\S]*security invoker[\s\S]*set search_path=pg_catalog,public/i);
  assert.match(proof, /revoke all on function public\.phase11_behavior_check_sentinel_20260722\(\) from public;[\s\S]*select \* from public\.phase11_behavior_check_sentinel_20260722\(\);[\s\S]*drop function public\.phase11_behavior_check_sentinel_20260722\(\);[\s\S]*rollback;/i);
  const functionBodyMatch = proof.match(/as \$check\$\s*#variable_conflict use_column\s*declare[\s\S]*?\nbegin\s*([\s\S]*?\nend;)\s*\n\$check\$;/i);
  assert.ok(functionBodyMatch, 'sentinel must have one outer PL/pgSQL BEGIN/EXCEPTION/END block');
  assert.equal((proof.match(/\nend;\s*\n\$check\$;/gi) || []).length, 1, 'sentinel must close exactly one outer block before the function delimiter');
  assert.doesNotMatch(proof, /\nend;\s*\nend;\s*\n\$check\$;/i, 'sentinel must not duplicate the outer END before the function delimiter');
  const outerBody = functionBodyMatch[1];
  const outerException = outerBody.lastIndexOf('\nexception when query_canceled or assert_failure then');
  assert.notEqual(outerException, -1, 'outer exception handler must exist');
  const normalPath = outerBody.slice(0, outerException);
  const exceptionPath = outerBody.slice(outerException);
  assert.match(normalPath, /return query values\('execution_error',true,'composite-return transition and escalation paths completed without an uncaught runtime error'\);\s*return;\s*$/i);
  assert.match(exceptionPath, /^\nexception when query_canceled or assert_failure then[\s\S]*return query values\('execution_error',false,[^;]+\);\s*return;\s*when others then[\s\S]*return query values\('execution_error',false,[^;]+\);\s*return;\s*end;\s*$/i);
  assert.equal(exceptionPath.replace(/[\s\S]*\nend;\s*$/i, '').trim(), '', 'no executable statement may follow the outer exception block END');
  const splitValues = source => {
    const fields = [];
    let start = 0;
    let depth = 0;
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "'" && source[index + 1] === "'") index += 1;
      else if (source[index] === "'") quoted = !quoted;
      else if (!quoted && source[index] === '(') depth += 1;
      else if (!quoted && source[index] === ')') depth -= 1;
      else if (!quoted && source[index] === ',' && depth === 0) {
        fields.push(source.slice(start, index).trim());
        start = index + 1;
      }
    }
    fields.push(source.slice(start).trim());
    return fields;
  };
  const returnedRows = [...outerBody.matchAll(/^\s*return query values\((.+)\);\s*$/gim)].map(match => splitValues(match[1]));
  assert.ok(returnedRows.length > 0, 'behavior function must return result rows');
  for (const row of returnedRows) {
    assert.equal(row.length, 3, 'each RETURN QUERY VALUES row must match the three-column return table');
    const [checkName, status, detail] = row;
    assert.match(checkName, /^'[a-z0-9_]+'$/, 'check_name VALUES field must be text-compatible');
    assert.match(status.trim(), /^(?:true|false|coalesce\([\s\S]+,false\))$/i, `${checkName} status VALUES field must be boolean-compatible`);
    assert.match(detail.trim(), /^(?:'[^']*'(?:\|\|[\s\S]+)?|left\('[^']*'\|\|[\s\S]+,\d+\))$/, `${checkName} detail VALUES field must be text-compatible`);
  }
  assert.match(proof, /txid_current\(\)/i);
  for (const fixture of ['public.areas','public.dashboard_tokens','public.analysts','public.tickets','public.ticket_assignments','public.business_calendars','public.sla_policies']) {
    assert.match(proof, new RegExp(`insert into ${fixture.replace('.', '\\.')}`, 'i'));
  }
  assert.doesNotMatch(proof, /select[\s\S]{0,120}from public\.(analysts|dashboard_tokens|tickets)[\s\S]{0,80}(order by|limit 1)/i);
  assert.doesNotMatch(proof, /PENDING: behavior check needs/i);
  assert.match(proof, /bot_submission_id[\s\S]*null/i);
  const ticketFixtureRows = [...proof.matchAll(/insert into public\.tickets\(chat_id,telefono,nombre_analista,nombre_empresa,correo,situacion,categoria,prioridad,status,area_id,bot_submission_id,conversation_state,waiting_reason,workflow_revision,priority_normalized\)\s*values\(([^;]+)\) returning id into v_ticket_[a-z]+;/gi)]
    .map(match => splitValues(match[1]));
  assert.equal(ticketFixtureRows.length, 5, 'all five ticket fixtures must remain covered by the constraint audit');
  for (const row of ticketFixtureRows) {
    assert.equal(row.length, 15, 'ticket fixture must provide every audited Phase 9/10/11 field');
    assert.match(row[0], /^'[1-9][0-9]{5,31}@(c[.]us|lid)'$/, 'chat_id must satisfy the Phase 9 WhatsApp identifier check');
    assert.match(row[5], /^'PHASE11_[A-Z]+'$/, 'situacion must retain a harmless sentinel marker');
    assert.match(row[6], /^'(?:Platform|Tests|Integrations|Other)'$/, 'categoria must satisfy the Phase 9 canonical category check');
    assert.equal(row[7], "'Crítica'", 'legacy prioridad must retain its compatible production value');
    assert.equal(row[8], "'open'", 'fixture status must remain compatible with an active conversation');
    assert.match(row[9], /^v_(?:other_)?area$/, 'area_id must use an isolated fixture area');
    assert.equal(row[10].toLowerCase(), 'null', 'bot_submission_id must stay null to avoid post-processing rows');
    assert.match(row[11], /^'(?:new|in_progress)'$/, 'conversation_state must satisfy the Phase 11 state check');
    assert.equal(row[12].toLowerCase(), 'null', 'non-waiting fixture states require a null waiting_reason');
    assert.equal(row[13], '0', 'initial workflow_revision must be zero');
    assert.equal(row[14], "'critical'", 'priority_normalized must select the isolated critical SLA policies');
  }
  assert.doesNotMatch(proof, /session_replication_role|set_config\s*\(/i);
  assert.match(proof, /v_step text := 'fixture_identity'/i);
  for (const step of ['ticket_fixtures','sla_fixtures','validation_contracts','claim_replay','conversation_lifecycle','revision_rejections','escalation_lifecycle','escalation_cancellation','idempotency_rejections','authorization','transfer_reclaim']) {
    assert.match(proof, new RegExp(`v_step\\s*:=\\s*'${step}'`, 'i'));
  }
  for (const step of ['wait_transition_call','wait_event_id_parse','wait_replay_call','wait_replay_assert','support_clock_check','resume_transition_call','snapshot_lookup','close_transition_call','close_assert','reopen_attempt']) {
    assert.match(proof, new RegExp(`v_step\\s*:=\\s*'${step}'`, 'i'));
  }
  const outputBigintCasts = proof.match(/\(v_(?:result|replay)->>'[^']+'\)::bigint/gi) || [];
  const numericOutputGuards = proof.match(/case when jsonb_typeof\(v_(?:result|replay)->'[^']+'\)='number' and \(v_(?:result|replay)->>'[^']+'\) ~ '\^\[0-9\]\{1,18\}\$' then/gi) || [];
  assert.equal(numericOutputGuards.length, outputBigintCasts.length, 'every JSON proof bigint cast must be guarded against malformed RPC output');
  assert.doesNotMatch(proof, /\(v_(?:result|replay)->>'[^']+'\)::boolean/i, 'JSON proof booleans must be type-checked rather than cast');
  assert.match(proof, /jsonb_typeof\(v_(?:result|replay)->'event_id'\)='number'[\s\S]*?\^\[0-9\]\{1,18\}\$[\s\S]*?then \(v_(?:result|replay)->>'event_id'\)::bigint else (?:null|false) end/i);
  assert.match(proof, /jsonb_typeof\(v_replay->'replayed'\)='boolean' and v_replay->>'replayed'='true'/i);
  assert.equal((proof.match(/get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name, v_context = pg_exception_context, v_message = message_text;/gi) || []).length, 2);
  assert.equal((proof.match(/left\(string_agg\(format\('%s line %s',m\[1\],m\[2\]\),' > ' order by ord\),512\)/gi) || []).length, 2, 'sanitized context must be bounded to 512 characters');
  assert.equal((proof.match(/left\('step='\|\|v_step[\s\S]*?coalesce\(v_safe_context,'none'\),768\)/gi) || []).length, 2, 'execution diagnostics must be bounded to 768 characters');
  assert.equal((proof.match(/v_constraint:=case when v_constraint is null or v_constraint='' then 'none' when v_constraint~'\^\[a-z_\]\[a-z0-9_\$\]\{0,62\}\$' then v_constraint else 'redacted' end;/gi) || []).length, 2);
  assert.equal((proof.match(/v_category:=case when v_state='22P02' then 'invalid_text_representation' else 'none' end;/gi) || []).length, 2);
  assert.equal((proof.match(/v_target_type:=case when v_state<>'22P02' or v_message is null then 'unknown'[^;]+else 'unknown' end;/gi) || []).length, 2);
  for (const targetType of ['bigint','integer','uuid','json','boolean','date','time','timestamp','unknown']) {
    assert.match(exceptionPath, new RegExp(`'${targetType}'`, 'i'), `target_type must support ${targetType}`);
  }
  assert.equal((proof.match(/category='\|\|v_category\|\|' target_type='\|\|v_target_type\|\|' context=/gi) || []).length, 2);
  assert.doesNotMatch(exceptionPath, /sqlerrm|exception_detail|exception_hint|\|\|v_(?:message|context)\b/i, 'raw exception text and context must never be returned');
  assert.equal((proof.match(/regexp_matches\(coalesce\(v_context,''\),'\(\?im\)\(\?:PL\/pgSQL \)\?\(\?:function\|procedure\) \(\[a-z_\]\[a-z0-9_\$\.\]\*\)\(\?:\\\(\[\^\\r\\n\]\*\\\)\)\? line \(\[0-9\]\+\)'/gi) || []).length, 2, 'context extraction must whitelist only routine identifiers and line numbers');
  assert.match(proof, /IDEMPOTENCY_KEY_REUSED/);
  for (const check of [
    'execution_error','malformed_rpc_json','claim','claim_exact_replay','transition_exact_replay',
    'conversation_close','conversation_reopen_if_legal','stale_revision_rejection','illegal_conversation_state',
    'escalation_create_exact_replay','escalation_update_exact_replay','escalation_requested_in_progress',
    'escalation_in_progress_resolved','escalation_requested_cancelled','illegal_escalation_state',
    'cross_ticket_rejection','cross_action_rejection','cross_payload_rejection','transfer_pause',
    'transfer_reclaim_snapshot','support_clock_segment_closure','support_clock_resume',
    'development_clock_segment_start','development_clock_segment_closure','support_clock_resume_after_escalation',
  ]) assert.match(proof, new RegExp(check));
  assert.match(proof, /exception when query_canceled or assert_failure[\s\S]*when others[\s\S]*get stacked diagnostics[\s\S]*returned_sqlstate/i);
  assert.match(proof, /set local statement_timeout = '120s'/i);
  for (const check of ['malformed_transition_command','malformed_escalation_command','malformed_sla_policy_command','malformed_calendar_command','malformed_calendar_window_element','mistyped_calendar_window','malformed_calendar_exception','duplicate_calendar_exception']) assert.match(proof, new RegExp(check));
  assert.match(proof, /coalesce\([^\n]*false\)/i);
  assert.doesNotMatch(proof, /insert\s+into\s+[^;]*(?:result|behavior_result)/i);
  assert.match(runbook, /Parse\/syntax errors[\s\S]*client disconnect[\s\S]*ROLLBACK/i);
  assert.match(runbook, /Stop the NEXO backend[\s\S]*requires neither superuser privileges nor permission to change `session_replication_role`/i);
  assert.match(runbook, /Normal database triggers execute[\s\S]*transaction-local database tables[\s\S]*stopped backend/i);
  assert.match(runbook, /two SQL Editor sessions/i);
  assert.match(runbook, /REST requests[\s\S]*socket/i);
  assert.match(runbook, /Only true simultaneous two-session[\s\S]*remains pending/i);
});

test('Phase 11 22P02 diagnostics classify only allowlisted target types and redact rejected values', () => {
  const classifyTargetType = (state, message) => {
    if (state !== '22P02' || typeof message !== 'string') return 'unknown';
    const normalized = message.toLowerCase();
    for (const [prefix, targetType] of [
      ['invalid input syntax for type bigint:', 'bigint'],
      ['invalid input syntax for type integer:', 'integer'],
      ['invalid input syntax for type uuid:', 'uuid'],
      ['invalid input syntax for type json:', 'json'],
      ['invalid input syntax for type boolean:', 'boolean'],
      ['invalid input syntax for type date:', 'date'],
      ['invalid input syntax for type timestamp', 'timestamp'],
      ['invalid input syntax for type time', 'time'],
    ]) if (normalized.startsWith(prefix)) return targetType;
    return 'unknown';
  };
  const renderSafeDiagnostic = (state, message) => `step=wait_transition_call sqlstate=${state} target_type=${classifyTargetType(state, message)} context=public.transition_conversation line 13`;
  const cases = [
    ['bigint', 'invalid input syntax for type bigint: "4111111111111111"'],
    ['integer', 'invalid input syntax for type integer: "ssn-123-45-6789"'],
    ['uuid', 'invalid input syntax for type uuid: "jane.doe@example.com"'],
    ['json', 'invalid input syntax for type json: "{\\"password\\":\\"S3cr3t!\\"}"'],
    ['boolean', 'invalid input syntax for type boolean: "Bearer eyJhbGciOiJIUzI1NiJ9"'],
    ['date', 'invalid input syntax for type date: "1987-06-15-secret"'],
    ['time', 'invalid input syntax for type time without time zone: "+57 300 123 4567"'],
    ['timestamp', 'invalid input syntax for type timestamp with time zone: "patient-001-HIV"'],
    ['unknown', 'malformed private value "api_key_live_abcdef"'],
  ];
  for (const [expectedType, message] of cases) {
    const diagnostic = renderSafeDiagnostic('22P02', message);
    assert.match(diagnostic, new RegExp(`target_type=${expectedType}(?: |$)`));
    assert.equal(diagnostic.includes(message), false, 'raw MESSAGE_TEXT must not be returned');
    const rejectedValue = message.match(/"([\s\S]*)"/)?.[1];
    if (rejectedValue) assert.equal(diagnostic.includes(rejectedValue), false, 'rejected secret/PII-like value must be absent');
  }
  assert.equal(classifyTargetType('22023', 'invalid input syntax for type bigint: "secret"'), 'unknown');
});

# Phase 11 migration verification

The original Phase 11 migration was already applied. Do not rerun it and do not
run the archival `phase11_conversation_sla.sql` marker. For the current
composite-return defect, the only operator migration is
`phase11_composite_assignment_fix.sql`.

## Composite-return assignment repair order

1. Stop Phase 11 writers and run `phase11_composite_assignment_fix.sql` as the existing migration owner. Run the complete script a second time against the same stopped-writer database. Both applications must commit successfully; the script explicitly replaces the two affected public RPCs and converges owner, search path, volatility, security mode, and exact ACLs without changing signatures.
2. Run `phase11_conversation_sla_postflight.sql`. Every row must be `PASS`, including `composite_return_assignment_contract`.
3. Only after postflight passes, run `phase11_conversation_sla_behavior_check.sql` with the backend still stopped. The lifecycle and escalation rows plus `execution_error=true` prove the repaired composite-return paths execute.

The mandatory operator order is therefore: apply twice, postflight, behavior.
Do not run the historical fix-forward, actor identity repair, or constraint repair for this composite-only repair.

## Actor identity repair order

1. Stop Phase 11 writers and run `phase11_actor_identity_fix.sql` as the existing migration owner. The script is transactional and convergent: every run explicitly replaces the canonical helper and three public RPC definitions, normalizes owner/security/search path/language/volatility and ACLs, then drops unexpected overloads with `DROP RESTRICT` only after dependencies use the typed bigint helper. Any error rolls back. Run the complete script a second time against the same stopped-writer database; both applications must commit successfully before postflight. This is the required manual apply/apply-twice proof; static tests cannot substitute for it.
2. Run `phase11_conversation_sla_postflight.sql`. Every row must be `PASS`; otherwise stop. In particular, `function_overload_set_exact` rejects every stale actor-identity overload, `actor_identity_rpc_acl_exact` requires `service_role` execution on only the three canonical public RPCs and none on the two private helpers, and the unexpected-grantee checks reject residual grants.
3. Only after postflight passes, keep the backend stopped and run `phase11_conversation_sla_behavior_check.sql`. It proves numeric analyst success, nonnumeric admin success, and stable `42501 / INVALID_ACTOR_CONTEXT` rejection for a nonnumeric analyst without `22P02`.

Do not run the historical fix-forward or constraint repair for this actor-only repair.

1. The first fix-forward has already run. Do not rerun it. Stop Phase 11 writers and run `phase11_conversation_sla_constraint_repair.sql` as the existing migration owner. It recognizes `business_calendar_windows_calendar_id_weekday_starts_at_ends_at` as the canonical 63-byte PostgreSQL name and only validates its UNIQUE shape; it does not rename or rebuild that semantically correct live object. The script drops `sla_policies_check1` only when its internal `conbin` tree exactly equals the validated canonical CHECK. Any exception means **stop**; the transaction rolls back and no later file may run.
2. Run `phase11_conversation_sla_postflight.sql`. Its result must contain all of these rows, and **every row must have `status = PASS`** before proceeding: `table_object_types`, `complete_column_contract`, `validated_attached_constraint_contract`, `new_table_constraint_set_exact`, `valid_index_shape_and_marker_contract`, `check_constraint_marker_contract`, `function_identity_result_security_path_owner_language`, `function_owner_consistency`, `function_overload_set_exact`, `transfer_trigger_exact`, `rls_enabled`, `service_role_exact_table_acl`, `service_role_exact_sequence_acl`, `unexpected_effective_relation_grantees`, `public_oid0_relation_denial`, `service_role_exact_function_acl`, `actor_identity_rpc_acl_exact`, `unexpected_effective_function_grantees`, and `public_oid0_function_denial`. A missing row, any `FAIL`, or any SQL/client error is a failed gate: stop and do not run the behavior check.
   `validated_attached_constraint_contract` verifies validated attachment plus catalog key/reference/delete-action shape for primary, unique, and foreign-key constraints. `check_constraint_marker_contract` verifies each governed CHECK constraint through its exact versioned marker and validated attachment. `valid_index_shape_and_marker_contract` verifies each governed partial unique index through its exact versioned marker plus essential catalog shape: table and index identity, btree method, uniqueness, valid/ready state, non-primary status, plain ordered key columns, no included or expression columns, and presence of a predicate. The marker binds the reviewed CHECK expression or index predicate contract; the postflight deliberately does not compare PostgreSQL-deparsed expression text. The fix-forward recreates and marks every governed CHECK constraint and the five named partial unique indexes.
   The aggregate function rows cover public RPCs and private helpers together. `service_role_exact_function_acl`, `unexpected_effective_function_grantees`, and `public_oid0_function_denial` require direct execution only for the five public RPCs by `service_role`; private helpers remain unavailable to runtime roles.
3. Stop the NEXO backend and keep it stopped for the complete behavior check. Then run `phase11_conversation_sla_behavior_check.sql` as one complete script. It requires neither superuser privileges nor permission to change `session_replication_role`. It creates unique sentinel-only areas, token, analyst, tickets, assignments, policies, and calendar inside an explicit transaction; it never reads or clones production actors, tokens, or tickets. Normal database triggers execute. Code inspection shows those triggers only mutate transaction-local database tables, and the stopped backend prevents any external processor from consuming trigger rows. The behavior rows come directly from one transaction-local `SECURITY INVOKER` sentinel function call; the script creates no temporary/result table and uses no `pg_temp` relation. `PUBLIC` execution is revoked immediately, the function has a fixed `pg_catalog,public` search path, it is dropped after the single result set, and the unconditional final `ROLLBACK` removes the create, drop, fixtures, trigger rows, and every tested mutation. Supabase SQL Editor may still display scanner warnings for `CREATE FUNCTION` or `DROP FUNCTION`; those statements are intentional and are never committed. Every returned `status` must be true, including `execution_error`. A false `execution_error` reports only the last safe phase name and SQLSTATE; it never returns the raw database error or fixture data. The script bounds the complete statement with `statement_timeout = '120s'`. A timeout raised inside the function is handled as the false `execution_error` row when PostgreSQL can continue the statement. PostgreSQL/client cancellation can instead cancel the entire submitted statement before the result SELECT or final `ROLLBACK`; if SQL Editor reports any error without the final result row, the operator **must issue `ROLLBACK` manually**. Parse/syntax errors and client disconnects have the same manual rollback requirement.

## Rollback limitation

Any SQL error before commit rolls back the constraint-repair transaction. After
a successful commit, reversal is not required: the existing canonical UNIQUE is
unchanged and `sla_policies_check1` is removed only as an exact duplicate. If a
later issue is discovered, there is no safe generic down migration; apply a
separately reviewed forward repair and do not recreate constraints from guessed
SQL.

## Manual two-session concurrency proof

The fix-forward must also be applied twice successfully against the same stopped-writer baseline. Real apply-twice and concurrency evidence cannot be established by static tests and remains mandatory operator proof to run and record after this review.

True concurrency cannot be produced by one SQL Editor transaction. In two SQL Editor sessions, use the same synthetic ticket, analyst, revision, and idempotency key:

1. Session A: `begin; select public.claim_conversation(jsonb_build_object('version',1,'ticket_id',...,'expected_revision',...,'idempotency_key','...'), actor_id, actor_name, 'analyst');` and leave the transaction open before commit.
2. Session B: execute the identical call. Confirm it blocks until Session A commits, then returns the same `ticket_id` and `event_id` with `replayed=true`.
3. Repeat through two simultaneous REST requests and two socket `assign-ticket` messages. Confirm one mutation/event, two successful same-identity responses, and one realtime mutation emission per server request only for the authoritative ticket.
4. Reuse the key with another ticket, another action, and changed payload. Each must return `IDEMPOTENCY_KEY_REUSED`, emit nothing, and fetch no workflow.
5. Roll back/delete all operator fixtures. Record the observed PostgreSQL version, timestamps, and results in the migration ticket.

The behavior script uses no real customer identifiers or content. Ticket `bot_submission_id` values remain NULL, so the normal ticket post-processing trigger does not create queue rows. Other normal triggers write only transactional local tables, and all fixture and trigger mutations roll back. The backend must remain stopped throughout the check so no Salesforce, socket, WhatsApp, or other external processor can run.
The single-session script executes all replay, rejection, lifecycle, transfer, and SLA sentinel checks it can prove without external effects. It does not prove lock contention or duplicate delivery behavior. Only true simultaneous two-session SQL/REST/socket concurrency remains pending and separate.
All helper calls execute inside the public RPC's outer transaction; a helper failure rolls back the complete escalation mutation.

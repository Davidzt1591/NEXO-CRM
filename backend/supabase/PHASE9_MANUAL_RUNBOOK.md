# Phase 9 manual Supabase application

Phase 9 is intentionally manual. Do not run these files from the application or a deployment hook.

## SQL Editor run order

1. Pause backend writers that create tickets or update bot sessions. Keep the outage window short.
2. Run `phase9_preflight.sql` in Supabase SQL Editor. Continue only if **every** row is `PASS`.
   - If `tickets.chat_id` is absent or contains nulls, only rows needing backfill require a compatible, valid legacy `telefono`. Existing non-null `chat_id` values are validated independently and are never compared with `telefono`. The PASS detail reports only the safe backfill count.
   - An existing canonical Phase 8/9 function with the approved signature, return type, security mode, and owner may report a repairable search-path count; the migration explicitly normalizes it to `pg_catalog, public`.
3. Run `phase9_analyst_support_conversation.sql` once. Its transaction either commits the complete contract or rolls back on error.
   - Before updating, it verifies that every row with null `tickets.chat_id` has a present, compatible `telefono` matching the canonical regex and length. Any unsafe row aborts the transaction.
   - It preserves every existing non-null `tickets.chat_id`, updates only null values from `telefono::text`, and then verifies every final `chat_id` is non-null and canonical.
   - No temporary helper relation or permanent equality constraint is used because `telefono` may later carry display semantics independent of canonical `chat_id`.
4. Run `phase9_postflight.sql`. Resume backend writers only if **every** row is `PASS`.
    - Postflight validates the final `chat_id` type, nullability, named check constraint, and canonical data. It does not compare `chat_id` with `telefono`, whose display semantics are independent.
    - The exact effective-grantee policy allows the PostgreSQL predefined roles `pg_read_all_data` and `pg_write_all_data`, plus the Supabase platform roles `supabase_etl_admin` and `supabase_read_only_user`. These are inherited or platform-operational database roles, not browser JWT roles, and the validation does not attempt unsafe object-level revocation from them. Every other unexpected effective grantee still fails postflight.
    - Separate checks require `PUBLIC`, `anon`, and `authenticated` to have no effective relation or sequence privileges on any protected Phase 8/9 object. The `anon` and `authenticated` checks include inherited access. The exact required `service_role` ACL remains independently enforced.
5. Re-run the preflight and migration in a non-production clone when validating idempotency or concurrency behavior. Do not use production for destructive experiments.

Static checks prove the SQL contract only. PostgreSQL behavioral concurrency proof remains pending until the migration is applied to a disposable PostgreSQL/Supabase clone and the concurrent claim scenarios in the migration header are executed. Do not represent the static suite as that proof.

The frontend must use NEXO backend routes for Bot Flow Studio persistence. It must never use a Supabase URL/key or call `bot_flow_studio_layouts` / `put_bot_flow_studio_layout` directly.

## Failure, rollback, and fix-forward

- Before `COMMIT`, any error rolls back Phase 9 automatically. Prior failed attempts occurred inside this transaction, so they cannot leave Phase 9 tables, indexes, triggers, or functions behind. No remote probe is performed by this repository task.
- After a failed attempt, rerun `phase9_preflight.sql` from step 2. It is read-only and rerunnable; `partial_phase9_tables` and the catalog contract checks provide the user-run confirmation that rollback left no partial Phase 9 contract before retrying the migration.
- A lock or statement timeout is a safe stop, not permission to increase limits blindly. Quiesce the relevant writer/lock holder and retry.
- After a successful commit there is **no general safe rollback**. New tickets/sessions may immediately depend on the columns, functions, constraints, and post-processing rows. Dropping them could lose state or recreate side effects.
- Prefer fix-forward with a reviewed, separately ordered SQL patch and another read-only pre/postflight pair.
- Restoring from a Supabase backup/PITR is an incident-level whole-database action, not this migration's rollback procedure.

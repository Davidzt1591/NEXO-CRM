# Phase 10 area routing manual runbook

Do not run from the application process. Use an authorized SQL console in this order:

Confirmed production baseline: `public.areas` contains exactly one active row, `id=1`, named `Soporte Integraciones`; no Magneto area exists. Phase 10 must reuse that row without renaming it.

1. Rerun `phase10_area_routing_preflight.sql`. Stop unless it returns `status=PASS` with `Reuse active Soporte Integraciones; create active Soporte Magneto using schema defaults.`
2. If preflight reports a duplicate/inactive approved alias or a required `public.areas` column without a default, stop. Supply no guessed values; review the production schema and prepare an explicit safe change.
3. Run `phase10_area_routing.sql`. It reuses `Soporte Integraciones`, creates `Soporte Magneto` with only `name` and `active`, and relies on the inspected schema defaults for every other column. It is idempotent and transaction-bound.
4. Run `phase10_area_routing_postflight.sql`. It returns one `check_name/status/detail` result set. Stop unless every row is `PASS`; no raw ACL result tab is expected.

## Fix-forward for an already-applied Phase 10

Do not rerun the full migration only to correct ACLs. In an authorized SQL console run, in this exact order:

1. `phase10_area_routing_preflight.sql` — stop unless it returns `PASS`.
2. `phase10_area_routing_acl_fix.sql` — transactionally removes browser/PUBLIC routing table and sequence privileges and restores only the exact backend service-role grants.
3. The updated `phase10_area_routing_postflight.sql` — require every unified result row to be `PASS`.

The fix enables RLS but deliberately does not force it: owner/platform and service-role behavior must remain compatible with Supabase. It preserves the Phase 9 platform-role allowlist and verifies that browser denial on `tickets` remains intact.

The migration is transaction-bound and safe to rerun. An advisory transaction lock serializes canonical-area creation by concurrent Phase 10 executions, and the existing unique area-name constraint plus guarded insert prevents duplicate `Soporte Magneto` creation. Assignment, unassignment, transfer, and analyst area switches MUST use the service-role-only RPCs; never mutate their tables in separate REST steps. Audit insertion is inside each RPC, so an audit failure rolls back routing. `create_routed_ticket` converges duplicate submission IDs by catching the unique-index race.

No disposable PostgreSQL runtime is available in this workspace. Static/adversarial contract tests verify fail-row-safe object resolution, but they do not prove PostgreSQL transaction behavior. An operator must still execute apply twice, verify rollback on an induced failure, run the unified postflight with complete and deliberately partial Phase 10 objects, and exercise concurrent RPC probes in an approved disposable database before production rollout. Do not record that runtime proof until the SQL was actually executed.
5. Smoke-test locally with synthetic data only. Do not send WhatsApp messages, create Salesforce cases, or create production tickets.

Rollback requires first disabling application routing, then dropping the Phase 10 functions and mapping table. Do not roll back while routed tickets are being created. Do not restore the unsafe browser ACLs when rolling back application behavior.

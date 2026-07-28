# Install atomic agent-token revocation

This procedure installs and proves the transactional revocation RPC before the backend path is enabled. Run it only in an approved disposable or pre-production Supabase project first.

> **Operator evidence: PENDING.** Repository tests are static/mocked. No agent executed these statements against a remote database.

## Quick path

1. Disable the token-revocation API/UI for the target environment.
2. Run the preflight and require every row to report `PASS`.
3. Confirm the backend has `SUPABASE_SERVICE_ROLE_KEY`; an anon key is insufficient.
4. Apply the migration twice, then run the postflight and behavioral proofs.
5. Enable revocation only after all evidence is attached to the release record.

## 1. Preflight and service-role check

- Run `admin_token_revocation_audit_preflight.sql` as `postgres` or `supabase_admin`.
- Stop on any `FAIL`; do not apply or modify table ACLs to bypass it.
- In the deployment secret inventory, confirm `SUPABASE_SERVICE_ROLE_KEY` is present. Do not print its value.
- Confirm the backend does not fall back to `SUPABASE_ANON_KEY` for the enablement proof.

## 2. Apply twice

Run `admin_token_revocation_audit.sql` twice without edits. Both executions must commit. This proves the exact-signature replacement and ACL reset are convergent.

## 3. Postflight and ACL proof

Run `admin_token_revocation_audit_postflight.sql`. Require every row to report `PASS`, including exact overload count, owner, fixed search path, definer bit, service-role execution, and PUBLIC/anon/authenticated denial.

Using non-secret test clients, confirm:

- `service_role` can invoke the exact RPC.
- `anon` and `authenticated` receive permission denial.
- No overload other than `(bigint,bigint,text)` exists.

## 4. Behavioral and concurrency proof

Use disposable active admin and agent-token rows. Never use production credentials or copy token hashes into evidence.

1. Invoke two transactions concurrently for the same active agent-token ID with distinct request IDs.
2. Confirm exactly one result is `revoked`; the waiter returns `already_revoked`.
3. Confirm the target is inactive and exactly one `agent_token.revoked` audit exists.
4. Confirm audit metadata contains only `name`, `role`, `actor_token_id`, and `request_id`.
5. Invoke missing, non-agent, and inactive IDs; confirm `not_found`, `wrong_role`, and `already_revoked` with no new audit.

## 5. Induced audit failure and rollback proof

In the disposable environment, begin a transaction and temporarily install a transaction-local condition that makes the `audit_log` insert fail (for example, a deliberately failing temporary test trigger owned by the operator). Invoke the RPC, then roll back all test scaffolding.

Confirm:

- the RPC fails;
- the agent token remains active;
- no transition audit commits;
- no socket/backend enablement is involved in this database-only proof.

Do not run this proof in production.

## 6. Enablement

Enable the backend revoke route only after apply-twice, postflight, ACL, concurrency, and induced audit-failure evidence are reviewed. Run one controlled request and confirm the committed result precedes process-local socket teardown.

## 7. Exact rollback

1. Disable the revoke API/UI and drain requests.
2. Roll back backend code before removing the RPC. Never restore sequential update/audit writes.
3. Keep token and audit rows intact.
4. Run exactly:

```sql
begin;
drop function if exists public.revoke_agent_token_with_audit(bigint, bigint, text);
commit;
```

5. Re-run the relevant catalog check and record that the exact signature is absent.

## Evidence checklist

- [ ] Preflight all PASS
- [ ] Service-role configuration confirmed without exposing the key
- [ ] Apply twice succeeded
- [ ] Concurrency produced one winner and one audit
- [ ] Induced audit failure rolled back token and audit changes
- [ ] ACL/postflight all PASS
- [ ] Backend enablement smoke proof passed
- [ ] Rollback rehearsal completed in the disposable environment

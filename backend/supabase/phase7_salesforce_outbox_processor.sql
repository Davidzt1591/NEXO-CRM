-- NEXO Phase 7 — Salesforce outbox one-shot processor support.
-- Artifact only: apply manually after phase6_salesforce_outbox.sql.
-- Post-application manual validation (not integration proof): verify failed-only
-- retry, preservation of an active retrying lease, and two concurrent claim
-- sessions returning distinct jobs via FOR UPDATE SKIP LOCKED.

ALTER TABLE public.salesforce_outbox
  ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

CREATE INDEX IF NOT EXISTS salesforce_outbox_claim_idx
  ON public.salesforce_outbox (next_attempt_at ASC, created_at ASC)
  WHERE operation = 'case_close' AND status IN ('pending', 'retrying');

CREATE OR REPLACE FUNCTION claim_salesforce_outbox_jobs(
  p_worker_id TEXT,
  p_limit INT DEFAULT 1,
  p_lock_timeout_seconds INT DEFAULT 900
)
RETURNS SETOF public.salesforce_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 10);
  v_lease_seconds INT := LEAST(GREATEST(COALESCE(p_lock_timeout_seconds, 900), 30), 900);
BEGIN
  IF p_worker_id IS NULL OR pg_catalog.btrim(p_worker_id) = '' OR pg_catalog.length(p_worker_id) > 200 THEN
    RAISE EXCEPTION 'worker id is required and must not exceed 200 characters'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.salesforce_outbox
    WHERE operation = 'case_close'
      AND status IN ('pending', 'retrying')
      AND attempts < max_attempts
      AND next_attempt_at <= now()
      AND (locked_at IS NULL OR locked_at < CURRENT_TIMESTAMP - pg_catalog.make_interval(secs => v_lease_seconds))
    ORDER BY next_attempt_at ASC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.salesforce_outbox AS job
  SET status = 'retrying',
      attempts = job.attempts + 1,
      locked_at = CURRENT_TIMESTAMP,
      locked_by = p_worker_id,
      updated_at = CURRENT_TIMESTAMP
  FROM claimable
  WHERE job.id = claimable.id
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_salesforce_outbox_jobs(TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_salesforce_outbox_jobs(TEXT, INT, INT) TO service_role;

CREATE OR REPLACE FUNCTION transition_salesforce_outbox_job(
  p_job_id BIGINT,
  p_worker_id TEXT,
  p_status TEXT,
  p_last_error TEXT DEFAULT NULL,
  p_next_attempt_at TIMESTAMPTZ DEFAULT NULL,
  p_processed_at TIMESTAMPTZ DEFAULT NULL,
  p_lock_timeout_seconds INT DEFAULT 900
)
RETURNS SETOF public.salesforce_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease_seconds INT := LEAST(GREATEST(COALESCE(p_lock_timeout_seconds, 900), 30), 900);
BEGIN
  IF p_status NOT IN ('synced', 'retrying', 'failed') THEN
    RAISE EXCEPTION 'unsupported outbox transition status' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.salesforce_outbox AS job
  SET status = p_status,
      last_error = CASE WHEN p_status = 'synced' THEN NULL ELSE pg_catalog.left(COALESCE(p_last_error, 'SF_OUTBOX_ERROR'), 120) END,
      next_attempt_at = COALESCE(p_next_attempt_at, job.next_attempt_at),
      processed_at = p_processed_at,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = CURRENT_TIMESTAMP
  WHERE job.id = p_job_id
    AND job.locked_by = p_worker_id
    -- Evaluated by PostgreSQL when the transition executes, so a request that
    -- stalls in transit cannot carry an already-stale client-side cutoff.
    AND job.locked_at >= CURRENT_TIMESTAMP - pg_catalog.make_interval(secs => v_lease_seconds)
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION public.transition_salesforce_outbox_job(BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_salesforce_outbox_job(BIGINT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO service_role;

CREATE OR REPLACE FUNCTION retry_salesforce_outbox_job(p_job_id BIGINT)
RETURNS SETOF public.salesforce_outbox
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.salesforce_outbox
  SET status = 'pending',
      max_attempts = attempts + 5,
      last_error = NULL,
      next_attempt_at = CURRENT_TIMESTAMP,
      processed_at = NULL,
      locked_at = NULL,
      locked_by = NULL,
      updated_at = CURRENT_TIMESTAMP
  -- Manual recovery is failed-only. In particular, never clear a retrying
  -- worker's active lease; ownership remains with the claiming worker.
  WHERE id = p_job_id
    AND status = 'failed'
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.retry_salesforce_outbox_job(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_salesforce_outbox_job(BIGINT) TO service_role;

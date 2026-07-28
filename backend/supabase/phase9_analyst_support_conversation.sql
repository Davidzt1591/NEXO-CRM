-- NEXO Phase 9 — analyst-support conversation contract.
-- Execute manually in Supabase SQL editor. The application never runs this file.
-- Manual validation checklist (remote SQL is intentionally not run by tests):
-- 1. Apply, then reapply this entire file and confirm both executions succeed.
-- 2. From two concurrent transactions, call claim_candidate_guidance with distinct
--    tokens for the same eligible chat_id; confirm exactly one claim returns true.
-- 3. Release that token and confirm another claim succeeds; finalize it and confirm
--    no claim succeeds until the 24-hour cooldown expires. Uncertain finalize
--    intentionally retains the claim: guidance delivery has an at-most-once bias.
-- 4. In real PostgreSQL, concurrently call claim_ticket_post_processing with distinct
--    worker UUIDs and confirm each invocation returns at most one distinct row. Static
--    contract tests cannot prove transaction locking, lease expiry, or concurrency.

-- Run phase9_preflight.sql first and continue only when every row is PASS.
-- One transaction prevents a partially applied Phase 9 contract. The local limits
-- fail safely instead of waiting indefinitely behind production traffic.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public, pg_catalog;

-- SECURITY DEFINER routines below use qualified application relations and a
-- pinned search path. Prevent untrusted roles from replacing names in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- Revoke every explicit CREATE source that can make an ordinary role effective
-- on public. Membership-derived CREATE disappears when its grant source is
-- revoked. The schema owner and superusers retain their intrinsic platform
-- authority and are deliberately not altered.
DO $schema_create_hardening$
DECLARE grant_source RECORD;
BEGIN
  FOR grant_source IN
    SELECT DISTINCT acl.grantee, role_source.rolname
    FROM pg_catalog.pg_namespace schema_public
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
      schema_public.nspacl,
      pg_catalog.acldefault('n', schema_public.nspowner)
    )) acl
    LEFT JOIN pg_catalog.pg_roles role_source ON role_source.oid = acl.grantee
    WHERE schema_public.nspname = 'public'
      AND acl.privilege_type = 'CREATE'
       AND (acl.grantee = 0 OR (
         acl.grantee <> schema_public.nspowner
         AND NOT COALESCE(role_source.rolsuper, false)
         AND role_source.rolname NOT IN ('postgres', 'supabase_admin')
       ))
  LOOP
    IF grant_source.grantee = 0 THEN
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    ELSE
      EXECUTE pg_catalog.format(
        'REVOKE CREATE ON SCHEMA public FROM %I', grant_source.rolname
      );
    END IF;
  END LOOP;
END
$schema_create_hardening$;

-- Phase 8 defense in depth. Studio persistence is a backend-only capability;
-- browser roles must have neither direct table access nor RPC execution.
REVOKE ALL ON TABLE public.bot_flow_studio_layouts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.bot_flow_studio_layouts TO service_role;
REVOKE ALL ON SEQUENCE public.bot_flow_studio_layouts_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bot_flow_studio_layouts_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.put_bot_flow_studio_layout(INTEGER, BIGINT, JSONB, INTEGER, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.put_bot_flow_studio_layout(INTEGER, BIGINT, JSONB, INTEGER, TEXT) TO service_role;
ALTER FUNCTION public.put_bot_flow_studio_layout(INTEGER, BIGINT, JSONB, INTEGER, TEXT)
  SECURITY INVOKER;
ALTER FUNCTION public.put_bot_flow_studio_layout(INTEGER, BIGINT, JSONB, INTEGER, TEXT)
  SET search_path = pg_catalog, public;

CREATE TABLE IF NOT EXISTS public.contact_classifications (
  chat_id TEXT PRIMARY KEY CHECK (char_length(chat_id) BETWEEN 12 AND 64 AND chat_id ~ '^[1-9][0-9]{5,31}@(c[.]us|lid)$'),
  classification TEXT NOT NULL DEFAULT 'candidate' CHECK (classification = 'candidate'),
  support_blocked BOOLEAN NOT NULL DEFAULT true,
  source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  marked_by TEXT NOT NULL CHECK (char_length(marked_by) BETWEEN 1 AND 120),
  last_guidance_at TIMESTAMPTZ,
  guidance_claimed_at TIMESTAMPTZ,
  guidance_claim_token UUID,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500)
);

ALTER TABLE public.contact_classifications ADD COLUMN IF NOT EXISTS guidance_claimed_at TIMESTAMPTZ;
ALTER TABLE public.contact_classifications ADD COLUMN IF NOT EXISTS guidance_claim_token UUID;

CREATE INDEX IF NOT EXISTS contact_classifications_blocked_idx
ON public.contact_classifications (support_blocked, marked_at DESC);

ALTER TABLE public.contact_classifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.contact_classifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_classifications TO service_role;

CREATE TABLE IF NOT EXISTS public.app_settings (
  key TEXT PRIMARY KEY CHECK (key IN ('candidate_form_url', 'candidate_guidance_message')),
  value TEXT NOT NULL CHECK (char_length(value) <= 2000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.app_settings TO service_role;

INSERT INTO public.app_settings (key, value) VALUES
  ('candidate_form_url', ''),
  ('candidate_guidance_message', 'Gracias por escribirnos. Este canal atiende únicamente solicitudes de analistas. Si eres candidato o candidata, utiliza el formulario de atención para candidatos o comunícate con la empresa responsable de tu proceso.')
ON CONFLICT (key) DO NOTHING;

DROP FUNCTION IF EXISTS public.claim_candidate_guidance(TEXT);
CREATE OR REPLACE FUNCTION public.claim_candidate_guidance(p_chat_id TEXT, p_token UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.contact_classifications
  SET guidance_claimed_at = now(), guidance_claim_token = p_token
  WHERE chat_id = p_chat_id
    AND classification = 'candidate'
    AND support_blocked = true
    AND (last_guidance_at IS NULL OR last_guidance_at <= now() - interval '24 hours')
    AND (guidance_claimed_at IS NULL OR guidance_claimed_at <= now() - interval '24 hours');
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_candidate_guidance(TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_candidate_guidance(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_candidate_guidance(p_chat_id TEXT, p_token UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.contact_classifications
  SET last_guidance_at = now(), guidance_claimed_at = NULL, guidance_claim_token = NULL
  WHERE chat_id = p_chat_id AND guidance_claim_token = p_token;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_candidate_guidance(p_chat_id TEXT, p_token UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.contact_classifications
  SET guidance_claimed_at = NULL, guidance_claim_token = NULL
  WHERE chat_id = p_chat_id AND guidance_claim_token = p_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_candidate_guidance(TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_candidate_guidance(TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_candidate_guidance(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_candidate_guidance(TEXT, UUID) TO service_role;

ALTER TABLE public.bot_sessions ADD COLUMN IF NOT EXISTS categoria TEXT;
-- Production before Phase 9 stores the WhatsApp identifier in telefono. Only
-- rows missing chat_id use that legacy source; existing chat_id values remain
-- independent from future telefono display semantics.

DO $tickets_chat_id_compatibility$
DECLARE chat_id_type text;
        telefono_type text;
BEGIN
  SELECT typ.typname INTO chat_id_type
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type typ ON typ.oid = a.atttypid
  WHERE a.attrelid = 'public.tickets'::pg_catalog.regclass
    AND a.attname = 'chat_id' AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT typ.typname INTO telefono_type
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type typ ON typ.oid = a.atttypid
  WHERE a.attrelid = 'public.tickets'::pg_catalog.regclass
    AND a.attname = 'telefono' AND a.attnum > 0 AND NOT a.attisdropped;

  IF chat_id_type IS NOT NULL AND chat_id_type <> 'text' THEN
    RAISE EXCEPTION 'public.tickets.chat_id has incompatible type %', chat_id_type;
  END IF;
  IF chat_id_type IS NULL AND telefono_type IS NULL THEN
    RAISE EXCEPTION 'public.tickets requires chat_id or the legacy telefono column';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tickets t WHERE to_jsonb(t)->>'chat_id' IS NULL)
     AND (telefono_type IS NULL OR telefono_type NOT IN ('text', 'varchar', 'bpchar')) THEN
    RAISE EXCEPTION 'public.tickets.telefono has incompatible legacy type %', telefono_type;
  END IF;
END
$tickets_chat_id_compatibility$;

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS chat_id TEXT;

DO $tickets_chat_id_legacy_backfill$
DECLARE unsafe_legacy_values boolean;
BEGIN
  -- Keep every telefono reference behind this branch. A completed rerun can
  -- therefore succeed after the legacy column has been removed.
  IF EXISTS (SELECT 1 FROM public.tickets WHERE chat_id IS NULL) THEN
    EXECUTE $legacy_validation$
      SELECT EXISTS (
        SELECT 1 FROM public.tickets
        WHERE chat_id IS NULL
          AND (telefono IS NULL
            OR telefono::text !~ '^[1-9][0-9]{5,31}@(c[.]us|lid)$'
            OR char_length(telefono::text) NOT BETWEEN 12 AND 64)
      )
    $legacy_validation$ INTO unsafe_legacy_values;

    IF unsafe_legacy_values THEN
      RAISE EXCEPTION 'public.tickets contains rows that cannot be safely backfilled from telefono';
    END IF;

    EXECUTE $legacy_update$
      UPDATE public.tickets
      SET chat_id = telefono::text
      WHERE chat_id IS NULL
    $legacy_update$;
  END IF;
END
$tickets_chat_id_legacy_backfill$;

DO $tickets_chat_id_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tickets
    WHERE chat_id IS NULL
       OR char_length(chat_id) NOT BETWEEN 12 AND 64
       OR chat_id !~ '^[1-9][0-9]{5,31}@(c[.]us|lid)$'
  ) THEN
    RAISE EXCEPTION 'public.tickets.chat_id contains null or incompatible values';
  END IF;
END
$tickets_chat_id_validation$;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_chat_id_whatsapp_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_chat_id_whatsapp_check
  CHECK (char_length(chat_id) BETWEEN 12 AND 64 AND chat_id ~ '^[1-9][0-9]{5,31}@(c[.]us|lid)$') NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_chat_id_whatsapp_check;
ALTER TABLE public.tickets ALTER COLUMN chat_id SET NOT NULL;

ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE public.bot_sessions ADD COLUMN IF NOT EXISTS submission_id TEXT;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS bot_submission_id TEXT;

ALTER TABLE public.bot_sessions DROP CONSTRAINT IF EXISTS bot_sessions_submission_id_check;
ALTER TABLE public.bot_sessions ADD CONSTRAINT bot_sessions_submission_id_check
  CHECK (submission_id IS NULL OR submission_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') NOT VALID;
ALTER TABLE public.bot_sessions VALIDATE CONSTRAINT bot_sessions_submission_id_check;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_bot_submission_id_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_bot_submission_id_check
  CHECK (bot_submission_id IS NULL OR bot_submission_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_bot_submission_id_check;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_bot_submission_id_uidx
ON public.tickets (bot_submission_id) WHERE bot_submission_id IS NOT NULL;

-- Durable, privacy-minimized continuation state for effects that happen only
-- after the ticket insert commits. WhatsApp acknowledgement is deliberately
-- attempt-once: an ambiguous transport failure is observable but never retried
-- automatically because WhatsApp does not provide an application idempotency key.
CREATE TABLE IF NOT EXISTS public.ticket_post_processing (
  ticket_id BIGINT PRIMARY KEY REFERENCES public.tickets(id) ON DELETE CASCADE,
  submission_id UUID NOT NULL UNIQUE,
  chat_id TEXT NOT NULL CHECK (char_length(chat_id) BETWEEN 12 AND 64),
  salesforce_outbox_status TEXT NOT NULL DEFAULT 'pending' CHECK (salesforce_outbox_status IN ('pending', 'processing', 'completed', 'failed')),
  operational_emit_status TEXT NOT NULL DEFAULT 'pending' CHECK (operational_emit_status IN ('pending', 'processing', 'completed', 'failed', 'uncertain')),
  session_cleanup_status TEXT NOT NULL DEFAULT 'pending' CHECK (session_cleanup_status IN ('pending', 'processing', 'completed', 'failed')),
  whatsapp_ack_status TEXT NOT NULL DEFAULT 'pending' CHECK (whatsapp_ack_status IN ('pending', 'completed', 'uncertain')),
  whatsapp_ack_attempts INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_ack_attempts BETWEEN 0 AND 1),
  whatsapp_ack_claim_token UUID,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 120),
  salesforce_outbox_claimed_by UUID,
  salesforce_outbox_claimed_at TIMESTAMPTZ,
  operational_emit_claimed_by UUID,
  operational_emit_claimed_at TIMESTAMPTZ,
  session_cleanup_claimed_by UUID,
  session_cleanup_claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ticket_post_processing ADD COLUMN IF NOT EXISTS whatsapp_ack_claim_token UUID;
ALTER TABLE public.ticket_post_processing ADD COLUMN IF NOT EXISTS salesforce_outbox_claimed_by UUID;
ALTER TABLE public.ticket_post_processing ADD COLUMN IF NOT EXISTS salesforce_outbox_claimed_at TIMESTAMPTZ;
ALTER TABLE public.ticket_post_processing ADD COLUMN IF NOT EXISTS operational_emit_claimed_by UUID;
ALTER TABLE public.ticket_post_processing ADD COLUMN IF NOT EXISTS operational_emit_claimed_at TIMESTAMPTZ;
ALTER TABLE public.ticket_post_processing ADD COLUMN IF NOT EXISTS session_cleanup_claimed_by UUID;
ALTER TABLE public.ticket_post_processing ADD COLUMN IF NOT EXISTS session_cleanup_claimed_at TIMESTAMPTZ;
ALTER TABLE public.ticket_post_processing DROP CONSTRAINT IF EXISTS ticket_post_processing_operational_emit_status_check;
ALTER TABLE public.ticket_post_processing ADD CONSTRAINT ticket_post_processing_operational_emit_status_check
  CHECK (operational_emit_status IN ('pending', 'processing', 'completed', 'failed', 'uncertain'));

ALTER TABLE public.ticket_post_processing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ticket_post_processing FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ticket_post_processing TO service_role;

CREATE OR REPLACE FUNCTION public.initialize_ticket_post_processing()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.bot_submission_id IS NOT NULL THEN
    INSERT INTO public.ticket_post_processing(ticket_id, submission_id, chat_id)
    VALUES (NEW.id, NEW.bot_submission_id::uuid, NEW.chat_id)
    ON CONFLICT (ticket_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tickets_initialize_post_processing ON public.tickets;
CREATE TRIGGER tickets_initialize_post_processing AFTER INSERT ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.initialize_ticket_post_processing();

CREATE OR REPLACE FUNCTION public.ensure_ticket_post_processing(p_ticket_id BIGINT)
RETURNS public.ticket_post_processing LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE result public.ticket_post_processing;
BEGIN
  INSERT INTO public.ticket_post_processing(ticket_id, submission_id, chat_id)
  SELECT id, bot_submission_id::uuid, chat_id FROM public.tickets
  WHERE id = p_ticket_id AND bot_submission_id IS NOT NULL
  ON CONFLICT (ticket_id) DO NOTHING;
  SELECT * INTO result FROM public.ticket_post_processing WHERE ticket_id = p_ticket_id;
  RETURN result;
END;
$$;

DROP FUNCTION IF EXISTS public.claim_ticket_post_processing(UUID, INTEGER);
CREATE OR REPLACE FUNCTION public.claim_ticket_post_processing(p_worker_id UUID)
RETURNS SETOF public.ticket_post_processing LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT ticket_id FROM public.ticket_post_processing
    WHERE (salesforce_outbox_status IN ('pending','failed','processing')
             AND (salesforce_outbox_claimed_at IS NULL OR salesforce_outbox_claimed_at < now() - interval '5 minutes'))
       OR (operational_emit_status IN ('pending','failed','processing')
             AND (operational_emit_claimed_at IS NULL OR operational_emit_claimed_at < now() - interval '5 minutes'))
       OR (session_cleanup_status IN ('pending','failed','processing')
             AND (session_cleanup_claimed_at IS NULL OR session_cleanup_claimed_at < now() - interval '5 minutes'))
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE public.ticket_post_processing p SET
    salesforce_outbox_status = CASE WHEN salesforce_outbox_status IN ('pending','failed','processing')
      AND (salesforce_outbox_claimed_at IS NULL OR salesforce_outbox_claimed_at < now() - interval '5 minutes') THEN 'processing' ELSE salesforce_outbox_status END,
    salesforce_outbox_claimed_by = CASE WHEN salesforce_outbox_status IN ('pending','failed','processing')
      AND (salesforce_outbox_claimed_at IS NULL OR salesforce_outbox_claimed_at < now() - interval '5 minutes') THEN p_worker_id ELSE salesforce_outbox_claimed_by END,
    salesforce_outbox_claimed_at = CASE WHEN salesforce_outbox_status IN ('pending','failed','processing')
      AND (salesforce_outbox_claimed_at IS NULL OR salesforce_outbox_claimed_at < now() - interval '5 minutes') THEN now() ELSE salesforce_outbox_claimed_at END,
    operational_emit_status = CASE WHEN operational_emit_status IN ('pending','failed','processing')
      AND (operational_emit_claimed_at IS NULL OR operational_emit_claimed_at < now() - interval '5 minutes') THEN 'processing' ELSE operational_emit_status END,
    operational_emit_claimed_by = CASE WHEN operational_emit_status IN ('pending','failed','processing')
      AND (operational_emit_claimed_at IS NULL OR operational_emit_claimed_at < now() - interval '5 minutes') THEN p_worker_id ELSE operational_emit_claimed_by END,
    operational_emit_claimed_at = CASE WHEN operational_emit_status IN ('pending','failed','processing')
      AND (operational_emit_claimed_at IS NULL OR operational_emit_claimed_at < now() - interval '5 minutes') THEN now() ELSE operational_emit_claimed_at END,
    session_cleanup_status = CASE WHEN session_cleanup_status IN ('pending','failed','processing')
      AND (session_cleanup_claimed_at IS NULL OR session_cleanup_claimed_at < now() - interval '5 minutes') THEN 'processing' ELSE session_cleanup_status END,
    session_cleanup_claimed_by = CASE WHEN session_cleanup_status IN ('pending','failed','processing')
      AND (session_cleanup_claimed_at IS NULL OR session_cleanup_claimed_at < now() - interval '5 minutes') THEN p_worker_id ELSE session_cleanup_claimed_by END,
    session_cleanup_claimed_at = CASE WHEN session_cleanup_status IN ('pending','failed','processing')
      AND (session_cleanup_claimed_at IS NULL OR session_cleanup_claimed_at < now() - interval '5 minutes') THEN now() ELSE session_cleanup_claimed_at END,
    attempts = attempts + 1, updated_at = now()
  FROM candidates c WHERE p.ticket_id = c.ticket_id RETURNING p.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_ticket_post_processing_effect(
  p_ticket_id BIGINT, p_worker_id UUID, p_effect TEXT, p_completed BOOLEAN, p_error_code TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_effect NOT IN ('salesforce_outbox','operational_emit','session_cleanup') THEN RAISE EXCEPTION 'invalid effect'; END IF;
  UPDATE public.ticket_post_processing SET
    salesforce_outbox_status = CASE WHEN p_effect = 'salesforce_outbox' THEN CASE WHEN p_completed THEN 'completed' ELSE 'failed' END ELSE salesforce_outbox_status END,
    operational_emit_status = CASE WHEN p_effect = 'operational_emit' AND p_completed AND operational_emit_status = 'uncertain' THEN 'completed' WHEN p_effect = 'operational_emit' THEN operational_emit_status ELSE operational_emit_status END,
    session_cleanup_status = CASE WHEN p_effect = 'session_cleanup' THEN CASE WHEN p_completed THEN 'completed' ELSE 'failed' END ELSE session_cleanup_status END,
    salesforce_outbox_claimed_by = CASE WHEN p_effect = 'salesforce_outbox' THEN NULL ELSE salesforce_outbox_claimed_by END,
    salesforce_outbox_claimed_at = CASE WHEN p_effect = 'salesforce_outbox' THEN NULL ELSE salesforce_outbox_claimed_at END,
    operational_emit_claimed_by = CASE WHEN p_effect = 'operational_emit' THEN NULL ELSE operational_emit_claimed_by END,
    operational_emit_claimed_at = CASE WHEN p_effect = 'operational_emit' THEN NULL ELSE operational_emit_claimed_at END,
    session_cleanup_claimed_by = CASE WHEN p_effect = 'session_cleanup' THEN NULL ELSE session_cleanup_claimed_by END,
    session_cleanup_claimed_at = CASE WHEN p_effect = 'session_cleanup' THEN NULL ELSE session_cleanup_claimed_at END,
    last_error_code = CASE WHEN p_completed THEN NULL ELSE left(COALESCE(p_error_code, 'POST_PROCESSING_ERROR'), 120) END,
    updated_at = now()
  WHERE ticket_id = p_ticket_id
    AND CASE p_effect
      WHEN 'salesforce_outbox' THEN salesforce_outbox_claimed_by = p_worker_id
      WHEN 'operational_emit' THEN operational_emit_claimed_by = p_worker_id
      WHEN 'session_cleanup' THEN session_cleanup_claimed_by = p_worker_id
      ELSE FALSE
    END
    AND (p_effect <> 'operational_emit' OR (p_completed AND operational_emit_status = 'uncertain'));
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_ticket_post_processing_attempt_started(
  p_ticket_id BIGINT, p_worker_id UUID, p_effect TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_effect <> 'operational_emit' THEN RAISE EXCEPTION 'invalid ambiguous-sensitive effect'; END IF;
  UPDATE public.ticket_post_processing SET operational_emit_status = 'uncertain',
    last_error_code = 'OPERATIONAL_EMIT_UNCERTAIN', updated_at = now()
  WHERE ticket_id = p_ticket_id AND operational_emit_claimed_by = p_worker_id
    AND operational_emit_status = 'processing';
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.claim_ticket_whatsapp_ack(BIGINT);
CREATE OR REPLACE FUNCTION public.claim_ticket_whatsapp_ack(p_ticket_id BIGINT, p_claim_token UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.ticket_post_processing SET whatsapp_ack_attempts = 1,
    whatsapp_ack_status = 'uncertain', last_error_code = 'WHATSAPP_ACK_UNCERTAIN',
    whatsapp_ack_claim_token = p_claim_token,
    updated_at = now()
  WHERE ticket_id = p_ticket_id AND whatsapp_ack_attempts = 0 AND p_claim_token IS NOT NULL;
  RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.finalize_ticket_whatsapp_ack(BIGINT);
CREATE OR REPLACE FUNCTION public.finalize_ticket_whatsapp_ack(p_ticket_id BIGINT, p_claim_token UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.ticket_post_processing SET whatsapp_ack_status = 'completed', last_error_code = NULL, updated_at = now()
  WHERE ticket_id = p_ticket_id AND whatsapp_ack_attempts = 1
    AND whatsapp_ack_status = 'uncertain' AND whatsapp_ack_claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

-- Normalize every canonical Phase 8/9 routine to one existing Supabase platform
-- owner. Resolve the role through the catalog so an unavailable role is never
-- referenced by a parsed ALTER statement.
DO $function_contract_hardening$
DECLARE approved_owner name;
        item RECORD;
BEGIN
  SELECT rolname INTO approved_owner
  FROM pg_catalog.pg_roles
  WHERE rolname IN ('postgres','supabase_admin')
  ORDER BY CASE rolname WHEN 'postgres' THEN 1 ELSE 2 END
  LIMIT 1;

  IF approved_owner IS NULL THEN
    RAISE EXCEPTION 'No approved Supabase platform function owner exists';
  END IF;

  FOR item IN SELECT identity, must_be_definer FROM (VALUES
    ('public.put_bot_flow_studio_layout(integer,bigint,jsonb,integer,text)',false),
    ('public.claim_candidate_guidance(text,uuid)',true),
    ('public.finalize_candidate_guidance(text,uuid)',true),
    ('public.release_candidate_guidance(text,uuid)',true),
    ('public.initialize_ticket_post_processing()',true),
    ('public.ensure_ticket_post_processing(bigint)',true),
    ('public.claim_ticket_post_processing(uuid)',true),
    ('public.finalize_ticket_post_processing_effect(bigint,uuid,text,boolean,text)',true),
    ('public.mark_ticket_post_processing_attempt_started(bigint,uuid,text)',true),
    ('public.claim_ticket_whatsapp_ack(bigint,uuid)',true),
    ('public.finalize_ticket_whatsapp_ack(bigint,uuid)',true)
  ) expected(identity,must_be_definer)
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s %s', item.identity,
      CASE WHEN item.must_be_definer THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END);
    EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = pg_catalog, public', item.identity);
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO %I', item.identity, approved_owner);
  END LOOP;
END
$function_contract_hardening$;

REVOKE ALL ON FUNCTION public.ensure_ticket_post_processing(BIGINT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.initialize_ticket_post_processing() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_ticket_post_processing(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_ticket_post_processing_effect(BIGINT, UUID, TEXT, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_ticket_post_processing_attempt_started(BIGINT, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_ticket_whatsapp_ack(BIGINT, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_ticket_whatsapp_ack(BIGINT, UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_ticket_post_processing(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ticket_post_processing(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_ticket_post_processing_effect(BIGINT, UUID, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_ticket_post_processing_attempt_started(BIGINT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ticket_whatsapp_ack(BIGINT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_ticket_whatsapp_ack(BIGINT, UUID) TO service_role;

-- Remove explicit grants from every unexpected grantee, including roles added
-- after the original migration was authored. Owners and superusers retain their
-- implicit PostgreSQL powers; postflight accounts for those effective powers.
DO $acl_hardening$
DECLARE item RECORD;
BEGIN
  FOR item IN
    SELECT DISTINCT c.relkind AS kind, n.nspname AS schema_name, c.relname AS object_name,
           grantee.rolname AS grantee
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) acl
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE n.nspname = 'public'
      AND c.relname IN ('bot_flow_studio_layouts','bot_flow_studio_layouts_id_seq','contact_classifications','app_settings','ticket_post_processing','bot_sessions','tickets','bot_flows')
      AND grantee.rolname <> 'service_role' AND grantee.oid <> c.relowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON %s %I.%I FROM %I',
      CASE WHEN item.kind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      item.schema_name, item.object_name, item.grantee);
  END LOOP;

  FOR item IN
    SELECT DISTINCT n.nspname AS schema_name, p.proname, p.oid::pg_catalog.regprocedure::text AS identity,
           grantee.rolname AS grantee
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
    WHERE n.nspname = 'public'
      AND p.proname IN ('put_bot_flow_studio_layout','claim_candidate_guidance','finalize_candidate_guidance','release_candidate_guidance','initialize_ticket_post_processing','ensure_ticket_post_processing','claim_ticket_post_processing','finalize_ticket_post_processing_effect','mark_ticket_post_processing_attempt_started','claim_ticket_whatsapp_ack','finalize_ticket_whatsapp_ack')
      AND grantee.rolname <> 'service_role' AND grantee.oid <> p.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', item.identity, item.grantee);
  END LOOP;
END
$acl_hardening$;

-- Function ACL defaults grant EXECUTE to PUBLIC. Sweep every overload of every
-- protected name (including obsolete signatures) before restoring only the
-- canonical service-role entry points below. Unexpected overloads are retained
-- with zero executable grants; postflight intentionally fails until reviewed.
DO $function_acl_hardening$
DECLARE item RECORD;
        grant_source RECORD;
BEGIN
  FOR item IN
    SELECT p.oid, p.oid::pg_catalog.regprocedure::text AS identity, p.proowner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('put_bot_flow_studio_layout','claim_candidate_guidance','finalize_candidate_guidance','release_candidate_guidance','initialize_ticket_post_processing','ensure_ticket_post_processing','claim_ticket_post_processing','finalize_ticket_post_processing_effect','mark_ticket_post_processing_attempt_started','claim_ticket_whatsapp_ack','finalize_ticket_whatsapp_ack')
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', item.identity);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated, service_role', item.identity);
    FOR grant_source IN
      SELECT DISTINCT r.rolname
      FROM pg_catalog.aclexplode(COALESCE(
        (SELECT p2.proacl FROM pg_catalog.pg_proc p2 WHERE p2.oid = item.oid),
        pg_catalog.acldefault('f', item.proowner)
      )) acl
      JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
      WHERE acl.privilege_type = 'EXECUTE' AND r.oid <> item.proowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', item.identity, grant_source.rolname);
    END LOOP;
  END LOOP;
END
$function_acl_hardening$;

GRANT EXECUTE ON FUNCTION public.put_bot_flow_studio_layout(INTEGER, BIGINT, JSONB, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_candidate_guidance(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_candidate_guidance(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_candidate_guidance(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_ticket_post_processing(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ticket_post_processing(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_ticket_post_processing_effect(BIGINT, UUID, TEXT, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_ticket_post_processing_attempt_started(BIGINT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ticket_whatsapp_ack(BIGINT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_ticket_whatsapp_ack(BIGINT, UUID) TO service_role;

ALTER TABLE public.bot_sessions DROP CONSTRAINT IF EXISTS bot_sessions_categoria_length_check;
ALTER TABLE public.bot_sessions ADD CONSTRAINT bot_sessions_categoria_length_check
  CHECK (categoria IS NULL OR char_length(categoria) BETWEEN 1 AND 32) NOT VALID;
ALTER TABLE public.bot_sessions VALIDATE CONSTRAINT bot_sessions_categoria_length_check;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_categoria_length_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_categoria_length_check
  CHECK (categoria IS NULL OR categoria IN ('Platform', 'Tests', 'Integrations', 'Other')) NOT VALID;
ALTER TABLE public.tickets VALIDATE CONSTRAINT tickets_categoria_length_check;

REVOKE ALL ON TABLE public.bot_sessions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.tickets FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.bot_flows FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tickets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_flows TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS bot_flows_effective_identity_uidx
ON public.bot_flows (version_id, COALESCE(area_id, 0), step_key);

INSERT INTO public.bot_flows (version_id, area_id, step_key, message, sort_order, active, updated_at)
VALUES
  (2, NULL, 'out_of_office', E'Estimado usuario, gracias por contactar al canal de soporte de *Magneto365*. 🌐\n\nLe informamos que actualmente no nos encontramos en horario de atención. Una vez retomemos actividades, estaremos dando respuesta a su requerimiento. Gracias por su comprensión.', 10, true, now()),
  (2, NULL, 'welcome_audience', E'Hola. Te damos la bienvenida al canal de soporte para analistas de *Magneto365*.\n\nPara orientarte, indícanos quién eres:\n*1.* Analista\n*2.* Candidato o candidata', 20, true, now()),
  (2, NULL, 'legacy_migration_audience', E'Actualizamos nuestro flujo de soporte. Para continuar, indícanos quién eres:\n*1.* Analista\n*2.* Candidato o candidata', 25, true, now()),
  (2, NULL, 'audience_invalid', 'Por favor, responde *1* si eres analista o *2* si eres candidato o candidata.', 30, true, now()),
  (2, NULL, 'candidate_exit', E'Gracias por escribirnos. Este canal atiende únicamente solicitudes de analistas.\n\nSi eres candidato o candidata, comunícate con la empresa responsable de tu proceso o utiliza los canales de ayuda disponibles en la plataforma donde realizaste tu postulación. No compartas datos personales adicionales por este chat.', 40, true, now()),
  (2, NULL, 'ask_category', E'¿Con qué tema necesitas ayuda?\n\n*1.* Plataforma\n*2.* Resultados de pruebas\n*3.* Solicitudes\n*4.* Integraciones\n*5.* Otro', 50, true, now()),
  (2, NULL, 'category_invalid', 'Por favor, responde *1*, *2*, *3*, *4* o *5*, o escribe el nombre de una de las opciones.', 60, true, now()),
  (2, NULL, 'other_email_exit', 'No pudimos identificar claramente tu solicitud dentro de las opciones disponibles. Si necesitas soporte, comunícate con nosotros a través de nuestro correo oficial: soporte.mgt@magnetoglobal.com. Nuestro equipo revisará tu caso y te orientará.', 65, true, now()),
  (2, NULL, 'data_notice_and_ask_name', E'Seleccionaste: *{{categoria}}*.\n\nA continuación te pediremos algunos datos para brindarte una atención más cercana y precisa.\n\n¿Cuál es tu nombre completo?', 70, true, now()),
  (2, NULL, 'ask_company', 'Gracias, {{nombre}}. ¿Cuál es el nombre de tu empresa?', 80, true, now()),
  (2, NULL, 'ask_email', '¿Cuál es tu correo electrónico corporativo?', 90, true, now()),
  (2, NULL, 'ask_issue', 'Cuéntanos brevemente qué sucede. Incluye el mensaje de error y el paso en el que se presenta, si aplica.', 100, true, now()),
  (2, NULL, 'confirm_summary', E'Por favor, revisa la información antes de crear el ticket:\n\n*Categoría:* {{categoria}}\n*Nombre:* {{nombre}}\n*Empresa:* {{empresa}}\n*Correo:* {{correo}}\n*Descripción:* {{situacion}}\n\n*1.* Confirmar y crear ticket\n*2.* Corregir información', 110, true, now()),
  (2, NULL, 'confirm_invalid', 'Por favor, responde *1* para confirmar y crear el ticket o *2* para corregir la información.', 120, true, now()),
  (2, NULL, 'restart_data', E'De acuerdo. Volvamos a revisar tus datos.\n\n¿Cuál es tu nombre completo?', 130, true, now()),
  (2, NULL, 'processing', 'Estamos creando tu ticket. Un momento, por favor.', 140, true, now()),
  (2, NULL, 'confirmation', E'✅ Tu solicitud fue registrada correctamente.\n\n{{radicado}}\n\nNuestro equipo revisará el caso y se pondrá en contacto contigo.', 150, true, now()),
  (2, NULL, 'ticket_error', 'No pudimos crear tu ticket en este momento. Tu información no quedó registrada como un caso. Por favor, inténtalo nuevamente más tarde.', 160, true, now())
ON CONFLICT (version_id, COALESCE(area_id, 0), step_key)
DO UPDATE SET message = EXCLUDED.message, sort_order = EXCLUDED.sort_order,
              active = true, updated_at = now();

COMMIT;

-- NEXO Phase 5 — Salesforce media metadata, audit, and report indexes.
-- Artifact only: apply manually in Supabase when promoting this slice.

CREATE INDEX IF NOT EXISTS sf_attachments_ticket_created_idx
  ON sf_attachments (ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sf_attachments_content_document_idx
  ON sf_attachments (sf_content_document_id);

CREATE INDEX IF NOT EXISTS audit_log_created_idx
  ON audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_action_created_idx
  ON audit_log (action, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_target_created_idx
  ON audit_log (target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tickets_status_created_idx
  ON tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS tickets_area_status_created_idx
  ON tickets (area_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_ticket_timestamp_idx
  ON messages (ticket_id, timestamp ASC);

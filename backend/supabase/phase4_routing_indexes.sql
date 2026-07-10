-- Phase 4 — routing/SLA queue indexes only. Run manually in Supabase if needed.
CREATE INDEX IF NOT EXISTS idx_tickets_area_status_created_at
  ON tickets (area_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_status_created_at
  ON tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ticket_assignments_analyst_id
  ON ticket_assignments (analyst_id);

CREATE INDEX IF NOT EXISTS idx_analysts_area_available
  ON analysts (area_id, available);

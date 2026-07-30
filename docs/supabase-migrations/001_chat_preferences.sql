-- Migration: 001_chat_preferences
-- Description: Persist chat mode and silenced state across restarts
-- Run this in the Supabase SQL Editor or via a migration runner.

CREATE TABLE IF NOT EXISTS chat_preferences (
  chat_id TEXT PRIMARY KEY,
  mode TEXT CHECK (mode IN ('auto', 'manual')) DEFAULT 'auto',
  silenced BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Allow the service role to upsert
ALTER TABLE chat_preferences ENABLE ROW LEVEL SECURITY;

-- Policy: service role can do all operations
CREATE POLICY service_role_all ON chat_preferences
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

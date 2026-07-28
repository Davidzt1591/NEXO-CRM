const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/phase8_bot_flow_studio_layouts.sql'), 'utf8');

test('phase8 serializes absent-row first writes before selecting or inserting', () => {
  const lock = sql.indexOf('pg_advisory_xact_lock');
  const select = sql.indexOf('SELECT * INTO current_row');
  const insert = sql.indexOf('RETURN QUERY INSERT INTO bot_flow_studio_layouts');
  assert.ok(lock > 0 && lock < select && select < insert);
  assert.match(sql, /p_version_id::TEXT\s*\|\|\s*':'\s*\|\|\s*COALESCE\(p_area_id::TEXT, 'global'\)/);
  assert.match(sql, /IF current_row\.revision <> p_expected_revision THEN RETURN; END IF;/);
});

test('phase8 grants service_role only the direct and invoker data privileges it needs', () => {
  assert.match(
    sql,
    /REVOKE ALL ON TABLE bot_flow_studio_layouts FROM PUBLIC, anon, authenticated, service_role;/,
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE ON TABLE bot_flow_studio_layouts TO service_role;/,
  );
  assert.doesNotMatch(sql, /GRANT (?:ALL|DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*ON TABLE bot_flow_studio_layouts/i);
});

test('phase8 restricts identity sequence access to service_role minimum privileges', () => {
  assert.match(
    sql,
    /REVOKE ALL ON SEQUENCE bot_flow_studio_layouts_id_seq FROM PUBLIC, anon, authenticated, service_role;/,
  );
  assert.match(
    sql,
    /GRANT USAGE, SELECT ON SEQUENCE bot_flow_studio_layouts_id_seq TO service_role;/,
  );
  assert.doesNotMatch(sql, /GRANT (?:ALL|UPDATE)[^;]*ON SEQUENCE bot_flow_studio_layouts_id_seq/i);
});

test('phase8 keeps RLS and the invoker function security boundary intact', () => {
  assert.match(sql, /ALTER TABLE bot_flow_studio_layouts ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /LANGUAGE plpgsql\s+SECURITY INVOKER\s+SET search_path = public/);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION put_bot_flow_studio_layout\(INTEGER, BIGINT, JSONB, INTEGER, TEXT\) FROM PUBLIC, anon, authenticated;/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION put_bot_flow_studio_layout\(INTEGER, BIGINT, JSONB, INTEGER, TEXT\) TO service_role;/,
  );
});

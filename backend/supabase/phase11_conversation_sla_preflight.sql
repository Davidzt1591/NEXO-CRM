-- Read-only preflight. Run as the migration owner before Phase 11.
with required_relations(name, oid) as (values
  ('tickets',to_regclass('public.tickets')),('areas',to_regclass('public.areas')),
  ('analysts',to_regclass('public.analysts')),('ticket_assignments',to_regclass('public.ticket_assignments')),
  ('audit_log',to_regclass('public.audit_log'))
), checks as (
  select 'required_relations' check_name, bool_and(oid is not null) ok,
    string_agg(name || '=' || coalesce(oid::text,'missing'), ', ') detail from required_relations
  union all
  select 'legacy_ticket_statuses', count(*) filter(where status not in ('open','closed'))=0,
    'unexpected=' || count(*) filter(where status not in ('open','closed')) from public.tickets
  union all
  select 'ticket_assignment_cardinality', count(*)=0,
    'duplicates=' || count(*) from (select ticket_id from public.ticket_assignments group by ticket_id having count(*)>1) d
  union all
  select 'ticket_area_integrity', count(*)=0, 'orphans=' || count(*)
    from public.tickets t left join public.areas a on a.id=t.area_id where t.area_id is not null and a.id is null
)
select check_name, case when ok then 'PASS' else 'FAIL' end status, detail from checks order by check_name;

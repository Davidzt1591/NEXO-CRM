-- Phase 10 read-only preflight. The production baseline has one active
-- "Soporte Integraciones" area and no Magneto area. Returns no PII or area IDs.
do $$
declare
  v_integrations_active integer;
  v_integrations_all integer;
  v_magneto_active integer;
  v_magneto_all integer;
  v_required_columns text;
begin
  if to_regclass('public.audit_log') is null then raise exception 'PHASE10_PREFLIGHT: audit_log is required'; end if;
  if not exists(select 1 from pg_indexes where schemaname='public' and tablename='tickets' and indexdef ilike '%bot_submission_id%' and indexdef ilike '%unique%') then raise exception 'PHASE10_PREFLIGHT: unique bot_submission_id index is required'; end if;

  select count(*), count(*) filter (where active)
    into v_integrations_all, v_integrations_active
  from public.areas
  where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) in ('integraciones','soporte integraciones');

  if v_integrations_all <> 1 or v_integrations_active <> 1 then
    raise exception 'PHASE10_PREFLIGHT: Integrations aliases must resolve to exactly one active area and no inactive/duplicate aliases; matching rows %, active %', v_integrations_all, v_integrations_active;
  end if;

  select count(*), count(*) filter (where active)
    into v_magneto_all, v_magneto_active
  from public.areas
  where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'soporte magneto';

  if v_magneto_all > 1 or (v_magneto_all = 1 and v_magneto_active <> 1) then
    raise exception 'PHASE10_PREFLIGHT: Magneto alias must resolve to at most one active area and no inactive/duplicate aliases; matching rows %, active %', v_magneto_all, v_magneto_active;
  end if;

  if v_magneto_all = 0 then
    select string_agg(a.attname, ', ' order by a.attnum)
      into v_required_columns
    from pg_attribute a
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.areas'::regclass
      and a.attnum > 0 and not a.attisdropped and a.attnotnull
      and a.attname not in ('name','active')
      and a.attidentity = '' and a.attgenerated = '' and d.adbin is null;
    if v_required_columns is not null then
      raise exception 'PHASE10_PREFLIGHT: cannot safely create Soporte Magneto; public.areas requires values without defaults for columns: %', v_required_columns;
    end if;
    raise notice 'PHASE10_PREFLIGHT PASS: reuse active Soporte Integraciones; create active Soporte Magneto using schema defaults';
  else
    raise notice 'PHASE10_PREFLIGHT PASS: reuse active Soporte Integraciones; reuse active Soporte Magneto';
  end if;
end $$;

select 'PASS' as status,
       'Reuse active Soporte Integraciones; ' ||
       case when exists (
         select 1 from public.areas
         where active and lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = 'soporte magneto'
       ) then 'reuse active Soporte Magneto.' else 'create active Soporte Magneto using schema defaults.' end as detail;

-- Narrow Phase 11 constraint repair derived from live catalog diagnostics.
begin;
set local search_path = pg_catalog, public;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
select pg_advisory_xact_lock(hashtextextended('nexo:phase11:conversation-sla',0));

do $repair_windows_unique$
declare
 v_table regclass := to_regclass('public.business_calendar_windows');
 v_canonical_oid oid;
 v_canonical_exact boolean;
begin
 if v_table is null then raise exception 'PHASE11_CONSTRAINT_REPAIR_BASELINE_MISSING: public.business_calendar_windows' using errcode='55000'; end if;
 select c.oid,c.contype='u' and c.convalidated
  and (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)=array['calendar_id','weekday','starts_at','ends_at']::text[]
  and exists(select 1 from pg_index i where i.indexrelid=c.conindid and i.indrelid=v_table and i.indisunique and i.indisvalid and i.indisready and not i.indisprimary and i.indpred is null and i.indexprs is null)
 into v_canonical_oid,v_canonical_exact from pg_constraint c where c.conrelid=v_table and c.conname='business_calendar_windows_calendar_id_weekday_starts_at_ends_at';
 if v_canonical_oid is null then raise exception 'PHASE11_CONSTRAINT_REPAIR_WINDOWS_UNIQUE_MISSING: canonical constraint does not exist' using errcode='55000';
 elsif not coalesce(v_canonical_exact,false) then raise exception 'PHASE11_CONSTRAINT_REPAIR_CANONICAL_WINDOWS_UNIQUE_INCOMPATIBLE: oid=%',v_canonical_oid using errcode='55000';
 end if;
end $repair_windows_unique$;

do $repair_duplicate_check$
declare
 v_table regclass := to_regclass('public.sla_policies');
 v_canonical_oid oid; v_duplicate_oid oid;
 v_canonical_bin text; v_duplicate_bin text;
 v_canonical_validated boolean; v_duplicate_validated boolean;
begin
 if v_table is null then raise exception 'PHASE11_CONSTRAINT_REPAIR_BASELINE_MISSING: public.sla_policies' using errcode='55000'; end if;
 select c.oid,c.conbin::text,c.convalidated into v_canonical_oid,v_canonical_bin,v_canonical_validated from pg_constraint c where c.conrelid=v_table and c.conname='sla_policies_check' and c.contype='c';
 if v_canonical_oid is null or not v_canonical_validated then raise exception 'PHASE11_CONSTRAINT_REPAIR_CANONICAL_SLA_CHECK_MISSING_OR_UNVALIDATED' using errcode='55000'; end if;
 select c.oid,c.conbin::text,c.convalidated into v_duplicate_oid,v_duplicate_bin,v_duplicate_validated from pg_constraint c where c.conrelid=v_table and c.conname='sla_policies_check1' and c.contype='c';
 if v_duplicate_oid is null then return; end if;
 if not v_duplicate_validated or v_duplicate_bin is distinct from v_canonical_bin then
  raise exception 'PHASE11_CONSTRAINT_REPAIR_SLA_CHECK1_NOT_EXACT_DUPLICATE: canonical_oid=%, duplicate_oid=%, canonical_validated=%, duplicate_validated=%, conbin_equal=%',v_canonical_oid,v_duplicate_oid,v_canonical_validated,v_duplicate_validated,(v_duplicate_bin is not distinct from v_canonical_bin) using errcode='55000';
 end if;
 alter table public.sla_policies drop constraint sla_policies_check1 restrict;
end $repair_duplicate_check$;

commit;

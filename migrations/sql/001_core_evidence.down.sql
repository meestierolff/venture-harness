-- Safe rollback for 001_core_evidence.
-- It refuses to drop evidence when any managed table contains data. Export and
-- explicitly archive/delete that data before retrying; never force this script.
begin;

do $$
declare
  table_name text;
  has_rows boolean;
begin
  foreach table_name in array array[
    'experiment_events',
    'commercial_events',
    'submissions',
    'consent_events',
    'product_events',
    'provider_webhook_events',
    'analytics_sync_runs'
  ]
  loop
    if to_regclass('public.' || table_name) is not null then
      execute format('select exists (select 1 from %I limit 1)', table_name) into has_rows;
      if has_rows then
        raise exception using
          errcode = '55000',
          message = format('safe rollback refused: %s contains evidence', table_name),
          hint = 'Export and explicitly archive/delete the data, then rerun this rollback.';
      end if;
    end if;
  end loop;
end
$$;

drop table if exists analytics_sync_runs;
drop table if exists provider_webhook_events;
drop table if exists product_events;
drop table if exists consent_events;
drop table if exists submissions;
drop table if exists commercial_events;
drop table if exists experiment_events;

do $$
begin
  if to_regclass('public.vh_schema_migrations') is not null then
    delete from vh_schema_migrations where version = '001_core_evidence';
  end if;
end
$$;

-- Keep a non-empty shared ledger. Drop it only when this is the final migration.
do $$
begin
  if to_regclass('public.vh_schema_migrations') is not null
     and not exists (select 1 from vh_schema_migrations) then
    drop table vh_schema_migrations;
  end if;
end
$$;

commit;

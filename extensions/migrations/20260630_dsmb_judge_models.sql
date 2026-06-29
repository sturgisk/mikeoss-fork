-- DSMB: user-selected judge models per process run. Safe to re-run.

alter table public.dsmb_process_runs
  add column if not exists judge_models jsonb not null default '[]'::jsonb;

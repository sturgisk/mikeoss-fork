-- DSMB litigation extension (private). Apply after upstream Mike migrations.
-- Safe to re-run.

create table if not exists public.dsmb_matter_vault_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null,
  storage_path text,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, path)
);

create index if not exists idx_dsmb_matter_vault_files_project
  on public.dsmb_matter_vault_files(project_id);

alter table public.dsmb_matter_vault_files enable row level security;

create table if not exists public.dsmb_process_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null,
  process_id text not null,
  variant_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'awaiting_hitl', 'completed', 'failed', 'cancelled')),
  current_phase_id text,
  phase_state jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_dsmb_process_runs_project
  on public.dsmb_process_runs(project_id, created_at desc);

create index if not exists idx_dsmb_process_runs_user
  on public.dsmb_process_runs(user_id, created_at desc);

alter table public.dsmb_process_runs enable row level security;

create table if not exists public.dsmb_process_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.dsmb_process_runs(id) on delete cascade,
  seq integer not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create index if not exists idx_dsmb_process_run_events_run
  on public.dsmb_process_run_events(run_id, seq);

alter table public.dsmb_process_run_events enable row level security;

create table if not exists public.dsmb_hitl_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.dsmb_process_runs(id) on delete cascade,
  phase_id text not null,
  gate_id text not null,
  decision text not null
    check (decision in ('approve', 'edit', 'reject', 'skip')),
  payload jsonb not null default '{}'::jsonb,
  user_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_dsmb_hitl_decisions_run
  on public.dsmb_hitl_decisions(run_id, created_at desc);

alter table public.dsmb_hitl_decisions enable row level security;

revoke all on public.dsmb_matter_vault_files from anon, authenticated;
revoke all on public.dsmb_process_runs from anon, authenticated;
revoke all on public.dsmb_process_run_events from anon, authenticated;
revoke all on public.dsmb_hitl_decisions from anon, authenticated;

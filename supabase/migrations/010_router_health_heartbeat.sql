alter table public.mikrotik_agent_status
  add column if not exists router_last_seen_at timestamptz;

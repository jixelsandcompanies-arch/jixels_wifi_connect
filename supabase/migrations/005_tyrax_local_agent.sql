create table if not exists public.tyrax_agent_status (
  id smallint primary key check (id = 1),
  last_seen_at timestamptz not null
);

create table if not exists public.tyrax_router_commands (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.wifi_sessions(id) on delete cascade,
  mac_address text not null check (mac_address ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'),
  action text not null check (action in ('ALLOW','BLOCK')),
  duration_minutes integer not null check (duration_minutes > 0),
  status text not null default 'PENDING' check (status in ('PENDING','DONE','CANCELLED')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(session_id, action)
);
create index if not exists tyrax_commands_pending on public.tyrax_router_commands(status,created_at);
alter table public.tyrax_agent_status enable row level security;
alter table public.tyrax_router_commands enable row level security;

create or replace function public.complete_tyrax_router_command(p_command_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  command_row public.tyrax_router_commands%rowtype;
  completed_at_value timestamptz := now();
begin
  select * into command_row from public.tyrax_router_commands
    where id = p_command_id and status = 'PENDING' for update;
  if not found then return false; end if;

  if command_row.action = 'ALLOW' then
    update public.wifi_sessions
      set session_status = 'ACTIVE', start_time = completed_at_value,
          expiry_time = completed_at_value + make_interval(mins => command_row.duration_minutes)
      where id = command_row.session_id and session_status = 'WAITING_GATEWAY';
    if not found then raise exception 'Session is not waiting for device authorization'; end if;
  else
    update public.wifi_sessions set session_status = 'EXPIRED'
      where id = command_row.session_id and session_status in ('ACTIVE','WAITING_GATEWAY');
  end if;

  update public.tyrax_router_commands
    set status = 'DONE', completed_at = completed_at_value, last_error = null
    where id = command_row.id;
  return true;
end;
$$;
revoke all on function public.complete_tyrax_router_command(uuid) from public;
grant execute on function public.complete_tyrax_router_command(uuid) to service_role;

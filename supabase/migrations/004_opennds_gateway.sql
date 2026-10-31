alter table public.payments add column if not exists portal_context_id uuid;
alter table public.payments add column if not exists status_token text unique;
create unique index if not exists payments_one_per_portal_context on public.payments(portal_context_id) where portal_context_id is not null;

create table if not exists public.opennds_portal_contexts (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  gateway_hash text not null check (gateway_hash ~ '^[0-9a-f]{64}$'),
  hid text not null check (hid ~ '^[0-9a-f]{64}$'),
  mac_address text not null check (mac_address ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'),
  origin_url text not null default '',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  payment_id uuid references public.payments(id),
  created_at timestamptz not null default now()
);
create table if not exists public.opennds_auth_queue (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.wifi_sessions(id) on delete cascade,
  gateway_hash text not null check (gateway_hash ~ '^[0-9a-f]{64}$'),
  rhid text not null unique check (rhid ~ '^[0-9a-f]{64}$'),
  auth_string text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  status text not null default 'PENDING' check (status in ('PENDING','AUTHENTICATED')),
  created_at timestamptz not null default now(),
  authenticated_at timestamptz
);
create index if not exists opennds_queue_poll on public.opennds_auth_queue(gateway_hash,status,created_at);
alter table public.opennds_portal_contexts enable row level security;
alter table public.opennds_auth_queue enable row level security;
alter table public.wifi_sessions drop constraint if exists wifi_sessions_session_status_check;
alter table public.wifi_sessions add constraint wifi_sessions_session_status_check check (session_status in ('ACTIVE','WAITING_GATEWAY','EXPIRED','REVOKED','GATEWAY_FAILED'));

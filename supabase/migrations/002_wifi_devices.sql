create table if not exists public.wifi_devices (
 id uuid primary key default gen_random_uuid(), mac_address text unique, device_code text unique not null,
 code_expires_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.wifi_devices enable row level security;
alter table public.payments add column if not exists device_id uuid references public.wifi_devices(id);
alter table public.payments add column if not exists confirmed_at timestamptz;
alter table public.wifi_sessions add column if not exists device_id uuid references public.wifi_devices(id);
-- Device-code and payment writes are performed by server-side functions using the service key.

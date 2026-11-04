-- Router inventory only. This does not configure devices or claim connectivity.
create table if not exists public.mikrotik_gateways (
  gateway_id text primary key check (gateway_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  gateway_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wifi_router_registry (
  id uuid primary key default gen_random_uuid(),
  router_name text not null check (char_length(trim(router_name)) between 1 and 80),
  router_mac text not null unique check (router_mac ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'),
  router_ip inet not null unique,
  connection_type text not null check (connection_type in ('ETHERNET','WIRELESS_BRIDGE','WIRELESS_REPEATER','ACCESS_POINT')),
  operating_mode text not null check (operating_mode in ('AP_BRIDGE','WIRELESS_BRIDGE','REPEATER_BRIDGE')),
  parent_gateway_id text not null references public.mikrotik_gateways(gateway_id) on update cascade on delete restrict,
  is_enabled boolean not null default true,
  verification_status text not null default 'NOT_VERIFIED' check (verification_status = 'NOT_VERIFIED'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wifi_router_registry_parent_idx on public.wifi_router_registry(parent_gateway_id);
create index if not exists wifi_router_registry_enabled_idx on public.wifi_router_registry(is_enabled);

alter table public.mikrotik_gateways enable row level security;
alter table public.wifi_router_registry enable row level security;

drop policy if exists "admins manage mikrotik gateways" on public.mikrotik_gateways;
create policy "admins manage mikrotik gateways" on public.mikrotik_gateways
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins manage wifi router registry" on public.wifi_router_registry;
create policy "admins manage wifi router registry" on public.wifi_router_registry
  for all using (public.is_admin()) with check (public.is_admin());

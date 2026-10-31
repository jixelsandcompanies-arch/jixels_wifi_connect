create or replace function public.acknowledge_opennds_auth(p_gateway_hash text, p_rhid text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  queued public.opennds_auth_queue%rowtype;
  activated_at timestamptz := now();
begin
  update public.opennds_auth_queue
    set status = 'AUTHENTICATED', authenticated_at = activated_at
    where gateway_hash = p_gateway_hash and rhid = p_rhid and status = 'PENDING'
    returning * into queued;
  if not found then return false; end if;

  update public.wifi_sessions
    set session_status = 'ACTIVE', start_time = activated_at,
        expiry_time = activated_at + make_interval(mins => queued.duration_minutes)
    where id = queued.session_id and session_status = 'WAITING_GATEWAY';
  if not found then raise exception 'Session is not waiting for gateway authorization'; end if;

  return true;
end;
$$;

revoke all on function public.acknowledge_opennds_auth(text, text) from public;
grant execute on function public.acknowledge_opennds_auth(text, text) to service_role;

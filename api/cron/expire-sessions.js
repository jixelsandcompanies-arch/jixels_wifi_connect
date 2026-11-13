import { supabase } from '../../lib/supabase.js';
import { isMikrotikAgentMode, isTyraxAgentMode, queueMikrotikRouterCommand, queueOpenNdsAuth, queueTyraxRouterCommand } from '../../lib/gateway.js';
/** Gateways enforce paid session limits; this job records expiry and queues device cleanup. */
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const db = supabase(), now = new Date().toISOString();
  // A queued MikroTik grant has not delivered paid access yet. Its clock
  // starts when the agent confirms authorization, not at payment time.
  const expirableStatuses = isMikrotikAgentMode() ? ['ACTIVE'] : ['ACTIVE','WAITING_GATEWAY'];
  const { data: sessions, error } = await db.from('wifi_sessions').select('id,session_status').in('session_status', expirableStatuses).lte('expiry_time', now);
  if (error) return res.status(500).json({ error: error.message });
  if (isTyraxAgentMode()) {
    for (const session of sessions) {
      const { data } = await db.from('wifi_sessions').select('mac_address,payment_id,payments(wifi_packages(duration_minutes))').eq('id', session.id).single();
      const payment = Array.isArray(data?.payments) ? data.payments[0] : data?.payments;
      if (data?.mac_address) {
        await queueTyraxRouterCommand({ sessionId: session.id, macAddress: data.mac_address, action: 'BLOCK', durationMinutes: payment?.wifi_packages?.duration_minutes || 1 });
        if (session.session_status === 'WAITING_GATEWAY') {
          await db.from('tyrax_router_commands').update({ status: 'CANCELLED', last_error: 'Authorization expired before the local agent applied it' }).eq('session_id', session.id).eq('action', 'ALLOW').eq('status', 'PENDING');
          await db.from('wifi_sessions').update({ session_status: 'EXPIRED' }).eq('id', session.id).eq('session_status', 'WAITING_GATEWAY');
        }
      }
    }
    return res.json({ blockQueued: sessions.length });
  }
  if (isMikrotikAgentMode()) {
    for (const session of sessions) {
      const { data: wifiSession } = await db.from('wifi_sessions').select('payment_id').eq('id', session.id).single();
      const { data: payment } = await db.from('payments').select('mikrotik_portal_context_id,wifi_packages(duration_minutes)').eq('id', wifiSession?.payment_id).maybeSingle();
      const { data: context } = await db.from('mikrotik_portal_contexts').select('gateway_id,mac_address,client_ip').eq('id', payment?.mikrotik_portal_context_id).maybeSingle();
      if (!payment || !context) continue;
      await queueMikrotikRouterCommand({ sessionId: session.id, gatewayId: context.gateway_id, macAddress: context.mac_address, clientIp: context.client_ip, action: 'BLOCK', durationMinutes: payment.wifi_packages?.duration_minutes || 1 });
      await db.from('mikrotik_router_commands').update({ status: 'CANCELLED', last_error: 'Session expired before device authorization' }).eq('session_id', session.id).eq('action', 'ALLOW').eq('status', 'PENDING');
      // Keep the session ACTIVE until the agent confirms that the router has
      // removed the bypass. The BLOCK acknowledgement marks it EXPIRED via
      // complete_mikrotik_router_command; a queued command is not revocation.
    }
    const { data: stuck } = await db.from('wifi_sessions').select('id,payment_id').eq('session_status', 'GATEWAY_FAILED').limit(50);
    let retried = 0;
    for (const session of stuck || []) {
      const { data: payment } = await db.from('payments').select('mikrotik_portal_context_id,wifi_packages(duration_minutes)').eq('id', session.payment_id).maybeSingle();
      const { data: context } = await db.from('mikrotik_portal_contexts').select('gateway_id,mac_address,client_ip').eq('id', payment?.mikrotik_portal_context_id).maybeSingle();
      if (!payment || !context) continue;
      try {
        await queueMikrotikRouterCommand({ sessionId: session.id, gatewayId: context.gateway_id, macAddress: context.mac_address, clientIp: context.client_ip, action: 'ALLOW', durationMinutes: payment.wifi_packages.duration_minutes });
        await db.from('wifi_sessions').update({ session_status: 'WAITING_GATEWAY' }).eq('id', session.id).eq('session_status', 'GATEWAY_FAILED');
        retried++;
      } catch { /* retry on the next scheduled run */ }
    }
    return res.json({ expired: sessions.length, retried });
  }
  for (const session of sessions) await db.from('wifi_sessions').update({ session_status: 'EXPIRED' }).eq('id', session.id).in('session_status', ['ACTIVE','WAITING_GATEWAY']);
  const { data: stuck } = await db.from('wifi_sessions').select('id,payment_id').eq('session_status', 'GATEWAY_FAILED').gt('expiry_time', now).limit(50);
  let queued = 0;
  for (const session of stuck || []) {
    const { data: payment } = await db.from('payments').select('portal_context_id,wifi_packages(duration_minutes)').eq('id', session.payment_id).single();
    const { data: context } = await db.from('opennds_portal_contexts').select('hid').eq('id', payment?.portal_context_id).maybeSingle();
    if (!payment || !context) continue;
    try {
      const grant = await queueOpenNdsAuth({ sessionId: session.id, hid: context.hid, durationMinutes: payment.wifi_packages.duration_minutes });
      await db.from('wifi_sessions').update({ session_status: 'WAITING_GATEWAY', gateway_reference: grant.gatewayReference }).eq('id', session.id).eq('session_status', 'GATEWAY_FAILED');
      queued++;
    } catch { /* retry on the next scheduled run */ }
  }
  return res.json({ expired: sessions.length, retried: queued });
}

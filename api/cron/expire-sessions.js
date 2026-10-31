import { supabase } from '../../lib/supabase.js';
import { queueOpenNdsAuth } from '../../lib/gateway.js';
/** openNDS enforces the purchased session length locally; this job updates billing records. */
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const db = supabase(), now = new Date().toISOString();
  const { data: sessions, error } = await db.from('wifi_sessions').select('id').in('session_status', ['ACTIVE','WAITING_GATEWAY']).lte('expiry_time', now);
  if (error) return res.status(500).json({ error: error.message });
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

import { supabase } from '../../lib/supabase.js';
import { gatewayAdapter } from '../../lib/gateway.js';
/** Invoke by Vercel Cron every five minutes; gateway adapters must make revoke idempotent. */
export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const db = supabase(), now = new Date().toISOString();
  const { data: sessions, error } = await db.from('wifi_sessions').select('id').eq('session_status', 'ACTIVE').lte('expiry_time', now);
  if (error) return res.status(500).json({ error: error.message });
  const gateway = gatewayAdapter();
  for (const session of sessions) { try { await gateway.revokeAccess(session.id); await db.from('wifi_sessions').update({ session_status: 'EXPIRED' }).eq('id', session.id); } catch (e) { return res.status(502).json({ error: `Could not revoke ${session.id}` }); } }
  return res.json({ expired: sessions.length });
}

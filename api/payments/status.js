import { supabase } from '../../lib/supabase.js';
import { isMikrotikAgentMode, mikrotikLoginCredentials } from '../../lib/gateway.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const token = String(req.query?.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Invalid checkout reference' });
  const { data, error } = await supabase().from('payments').select('id,status,mikrotik_portal_context_id,wifi_sessions(id,session_status,expiry_time)').eq('status_token', token).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not read payment status' });
  if (!data) return res.status(404).json({ error: 'Payment not found' });
  const session = Array.isArray(data.wifi_sessions) ? data.wifi_sessions[0] : data.wifi_sessions;
  const result = { status: data.status, session: session?.session_status || null, expiresAt: session?.expiry_time || null };
  if (isMikrotikAgentMode() && data.mikrotik_portal_context_id && session?.session_status === 'ACTIVE') {
    result.mikrotikLogin = { url: process.env.MIKROTIK_HOTSPOT_LOGIN_URL, ...mikrotikLoginCredentials(session.id) };
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}

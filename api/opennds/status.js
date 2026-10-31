import { supabase } from '../../lib/supabase.js';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const token = String(req.query?.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Invalid checkout reference' });
  const { data, error } = await supabase().from('payments').select('status,wifi_sessions(session_status,expiry_time)').eq('status_token', token).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not read payment status' });
  if (!data) return res.status(404).json({ error: 'Payment not found' });
  const session = Array.isArray(data.wifi_sessions) ? data.wifi_sessions[0] : data.wifi_sessions;
  return res.status(200).json({ status: data.status, session: session?.session_status || null, expiresAt: session?.expiry_time || null });
}

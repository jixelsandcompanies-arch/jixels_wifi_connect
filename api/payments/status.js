import { supabase } from '../../lib/supabase.js';
import { activateConfirmedPayment } from '../../lib/activate-payment.js';
import { isMikrotikAgentMode } from '../../lib/gateway.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const token = String(req.query?.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Invalid checkout reference' });
  const db = supabase();
  let { data, error } = await db.from('payments').select('id,status,mikrotik_portal_context_id,wifi_sessions(id,session_status,expiry_time)').eq('status_token', token).maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not read payment status' });
  if (!data) return res.status(404).json({ error: 'Payment not found' });
  let session = Array.isArray(data.wifi_sessions) ? data.wifi_sessions[0] : data.wifi_sessions;
  if (data.status === 'SUCCESS' && isMikrotikAgentMode() && session?.session_status === 'GATEWAY_FAILED') {
    const { data: payment } = await db.from('payments').select('*, wifi_packages(*)').eq('id', data.id).maybeSingle();
    if (payment) {
      try { await activateConfirmedPayment(db, payment, payment.raw_callback || {}); }
      catch (retryError) { console.error('Paid Wi-Fi activation retry failed', { paymentId: data.id, message: retryError.message }); }
    }
    ({ data, error } = await db.from('payments').select('id,status,mikrotik_portal_context_id,wifi_sessions(id,session_status,expiry_time)').eq('status_token', token).maybeSingle());
    if (error) return res.status(500).json({ error: 'Could not refresh paid session status' });
    session = Array.isArray(data.wifi_sessions) ? data.wifi_sessions[0] : data.wifi_sessions;
  }
  const result = { status: data.status, session: session?.session_status || null, expiresAt: session?.expiry_time || null };
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}

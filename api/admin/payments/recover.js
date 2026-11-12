import { supabase } from '../../../lib/supabase.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { activateConfirmedPayment } from '../../../lib/activate-payment.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!await requireAdmin(req, res)) return;
  const paymentId = String(req.body?.paymentId || '');
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return res.status(400).json({ error: 'Select a valid confirmed payment.' });

  const db = supabase();
  const { data: payment, error } = await db.from('payments').select('*,wifi_packages(*)').eq('id', paymentId).eq('status', 'SUCCESS').maybeSingle();
  if (error) return res.status(503).json({ error: 'Could not verify this payment.' });
  if (!payment) return res.status(404).json({ error: 'Confirmed payment not found.' });
  const { data: session, error: sessionError } = await db.from('wifi_sessions').select('id,session_status').eq('payment_id', payment.id).maybeSingle();
  if (sessionError) return res.status(503).json({ error: 'Could not load the paid Wi-Fi session.' });
  if (session && !['GATEWAY_FAILED', 'WAITING_GATEWAY'].includes(session.session_status)) {
    return res.status(409).json({ error: `This paid session is ${String(session.session_status).toLowerCase().replaceAll('_', ' ')} and cannot be reactivated.` });
  }
  try {
    await activateConfirmedPayment(db, payment, payment.raw_callback || {});
    return res.status(200).json({ success: true, message: 'Confirmed payment queued for hotspot access. The customer should reconnect to Wi-Fi.' });
  } catch (activationError) {
    console.error('Admin paid access recovery failed', { paymentId, message: activationError.message });
    return res.status(503).json({ error: 'Payment is confirmed, but access could not be queued. Check the gateway agent and try again.' });
  }
}

import { createHash } from 'node:crypto';
import { supabase } from '../../lib/supabase.js';
import { activateConfirmedPayment } from '../../lib/activate-payment.js';
import { isGatewayConfigured, isMikrotikAgentMode, mikrotikGatewayId } from '../../lib/gateway.js';

const kenyaPhone = value => String(value || '').replace(/\D/g, '').replace(/^0/, '254');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isMikrotikAgentMode() || !isGatewayConfigured()) return res.status(503).json({ error: 'Hotspot access recovery is not configured.' });
  const { portalToken, phone, receipt } = req.body || {};
  const normalizedPhone = kenyaPhone(phone);
  const normalizedReceipt = String(receipt || '').trim().toUpperCase();
  if (!/^[a-f0-9]{64}$/.test(portalToken || '') || !/^(?:254(?:1|7)\d{8})$/.test(normalizedPhone) || !/^[A-Z0-9]{6,20}$/.test(normalizedReceipt)) {
    return res.status(400).json({ error: 'Enter the M-Pesa phone and receipt exactly as shown in the payment message.' });
  }

  const db = supabase();
  const tokenHash = createHash('sha256').update(portalToken).digest('hex');
  const { data: currentContext, error: contextError } = await db.from('mikrotik_portal_contexts')
    .select('gateway_id,mac_address').eq('token_hash', tokenHash).eq('gateway_id', mikrotikGatewayId())
    .gt('expires_at', new Date().toISOString()).maybeSingle();
  if (contextError) return res.status(503).json({ error: 'Could not verify this hotspot device. Reopen its sign-in page and try again.' });
  if (!currentContext) return res.status(400).json({ error: 'Reconnect to Barrio- HOTSPOT and reopen this page on the device that paid.' });

  const { data: payment, error: paymentError } = await db.from('payments')
    .select('*,wifi_packages(*)').eq('status', 'SUCCESS').eq('phone', normalizedPhone)
    .eq('mpesa_receipt_number', normalizedReceipt).maybeSingle();
  if (paymentError) return res.status(503).json({ error: 'Could not verify the payment. Try again shortly.' });
  if (!payment) return res.status(404).json({ error: 'Payment not found for this phone and receipt. Do not pay again until you check the M-Pesa message.' });
  const { data: paidContext, error: paidContextError } = await db.from('mikrotik_portal_contexts')
    .select('gateway_id,mac_address').eq('id', payment.mikrotik_portal_context_id).maybeSingle();
  if (paidContextError) return res.status(503).json({ error: 'Could not verify which device made this payment.' });
  if (!paidContext || paidContext.gateway_id !== currentContext.gateway_id || paidContext.mac_address !== currentContext.mac_address) {
    return res.status(404).json({ error: 'That payment belongs to a different device. Reopen the sign-in page on the device that paid.' });
  }

  const { data: priorSession, error: sessionError } = await db.from('wifi_sessions').select('id,session_status').eq('payment_id', payment.id).maybeSingle();
  if (sessionError) return res.status(503).json({ error: 'Could not load the paid hotspot session.' });
  if (priorSession && !['ACTIVE', 'WAITING_GATEWAY', 'GATEWAY_FAILED'].includes(priorSession.session_status)) {
    return res.status(409).json({ error: 'This confirmed payment session has expired. Choose a package to buy new access.' });
  }
  try {
    const session = await activateConfirmedPayment(db, payment, payment.raw_callback || {});
    return res.status(200).json({ success: true, sessionStatus: session?.session_status || 'WAITING_GATEWAY' });
  } catch (activationError) {
    console.error('Customer paid access recovery failed', { paymentId: payment.id, message: activationError.message });
    return res.status(503).json({ error: 'Payment is confirmed, but the hotspot grant could not be queued. Keep the receipt and retry shortly.' });
  }
}

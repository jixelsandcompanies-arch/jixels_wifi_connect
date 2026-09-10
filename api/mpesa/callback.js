import { supabase } from '../../lib/supabase.js';
import { expiryFrom } from '../../lib/packages.js';
import { gatewayAdapter } from '../../lib/gateway.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const callback = req.body?.Body?.stkCallback; if (!callback?.CheckoutRequestID) return res.status(400).end();
  const db = supabase(), id = callback.CheckoutRequestID, ok = callback.ResultCode === 0;
  const { data: payment } = await db.from('payments').select('*, wifi_packages(*)').eq('checkout_request_id', id).single();
  if (!payment) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Unknown checkout ignored' });
  if (!ok) { await db.from('payments').update({ status: 'FAILED', raw_callback: req.body }).eq('id', payment.id).eq('status', 'PENDING'); return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' }); }
  const items = callback.CallbackMetadata?.Item || [], receipt = items.find(x => x.Name === 'MpesaReceiptNumber')?.Value;
  // The unique constraints on receipt and payment_id make callback retries idempotent.
  const { data: already } = await db.from('wifi_sessions').select('id').eq('payment_id', payment.id).maybeSingle();
  if (already) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
  const start = new Date(), expiry = expiryFrom(payment.wifi_packages, start);
  await db.from('payments').update({ status: 'SUCCESS', mpesa_receipt_number: receipt, raw_callback: req.body, confirmed_at: start.toISOString() }).eq('id', payment.id).eq('status', 'PENDING');
  const { data: session, error } = await db.from('wifi_sessions').insert({ payment_id: payment.id, device_id: payment.device_id, phone: payment.phone, package_id: payment.package_id, mac_address: payment.mac_address, start_time: start.toISOString(), expiry_time: expiry.toISOString(), session_status: 'ACTIVE' }).select().single();
  if (error) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
  try { const grant = await gatewayAdapter().grantAccess({ sessionId: session.id, macAddress: session.mac_address, expiresAt: expiry }); await db.from('wifi_sessions').update({ gateway_reference: grant.gatewayReference }).eq('id', session.id); }
  catch (e) { await db.from('wifi_sessions').update({ session_status: 'GATEWAY_FAILED' }).eq('id', session.id); }
  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

import { supabase } from '../../lib/supabase.js';
import { expiryFrom } from '../../lib/packages.js';
import { isTyraxAgentMode, queueOpenNdsAuth, queueTyraxRouterCommand } from '../../lib/gateway.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const callback = req.body?.Body?.stkCallback; if (!callback?.CheckoutRequestID) return res.status(400).end();
  const db = supabase(), id = callback.CheckoutRequestID, ok = callback.ResultCode === 0;
  const { data: payment } = await db.from('payments').select('*, wifi_packages(*)').eq('checkout_request_id', id).single();
  if (!payment) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Unknown checkout ignored' });
  if (payment.status === 'FAILED') return res.status(200).json({ ResultCode: 0, ResultDesc: 'Payment is already finalized' });
  if (!ok) { await db.from('payments').update({ status: 'FAILED', raw_callback: req.body }).eq('id', payment.id).eq('status', 'PENDING'); return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' }); }
  const items = callback.CallbackMetadata?.Item || [], receipt = items.find(x => x.Name === 'MpesaReceiptNumber')?.Value, amount = items.find(x => x.Name === 'Amount')?.Value;
  if (!receipt || Number(amount) !== Number(payment.amount_kes)) {
    await db.from('payments').update({ status: 'FAILED', raw_callback: req.body }).eq('id', payment.id).eq('status', 'PENDING');
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Payment details did not match' });
  }
  // The unique constraints on receipt and payment_id make callback retries idempotent.
  const start = payment.confirmed_at ? new Date(payment.confirmed_at) : new Date(), expiry = expiryFrom(payment.wifi_packages, start);
  if (payment.status === 'PENDING') await db.from('payments').update({ status: 'SUCCESS', mpesa_receipt_number: receipt, raw_callback: req.body, confirmed_at: start.toISOString() }).eq('id', payment.id).eq('status', 'PENDING');
  let { data: session } = await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle();
  if (!session) {
    const { data, error } = await db.from('wifi_sessions').insert({ payment_id: payment.id, device_id: payment.device_id, phone: payment.phone, package_id: payment.package_id, mac_address: payment.mac_address, start_time: start.toISOString(), expiry_time: expiry.toISOString(), session_status: 'WAITING_GATEWAY' }).select().single();
    if (error) { const retry = await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle(); session = retry.data; }
    else session = data;
  }
  if (!session) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Payment recorded; session creation will retry' });
  try {
    let grant;
    if (isTyraxAgentMode()) {
      grant = await queueTyraxRouterCommand({ sessionId: session.id, macAddress: session.mac_address, action: 'ALLOW', durationMinutes: payment.wifi_packages.duration_minutes });
      await db.from('wifi_sessions').update({ session_status: 'WAITING_GATEWAY' }).eq('id', session.id).eq('session_status', 'GATEWAY_FAILED');
    } else {
      const { data: context } = await db.from('opennds_portal_contexts').select('hid').eq('id', payment.portal_context_id).single();
      grant = await queueOpenNdsAuth({ sessionId: session.id, hid: context.hid, durationMinutes: payment.wifi_packages.duration_minutes });
    }
    await db.from('wifi_sessions').update({ gateway_reference: grant.gatewayReference }).eq('id', session.id);
    if (!isTyraxAgentMode()) {
      const { data: queued } = await db.from('opennds_auth_queue').select('status').eq('session_id', session.id).maybeSingle();
      if (queued?.status === 'PENDING') await db.from('wifi_sessions').update({ session_status: 'WAITING_GATEWAY' }).eq('id', session.id).eq('session_status', 'GATEWAY_FAILED');
    }
  } catch { await db.from('wifi_sessions').update({ session_status: 'GATEWAY_FAILED' }).eq('id', session.id).eq('session_status', 'WAITING_GATEWAY'); }
  return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

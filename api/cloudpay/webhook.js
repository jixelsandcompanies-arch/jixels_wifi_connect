import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabase } from '../../lib/supabase.js';
import { expiryFrom } from '../../lib/packages.js';
import { queueOpenNdsAuth } from '../../lib/gateway.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function activate(db, payment, payload) {
  const start = payment.confirmed_at ? new Date(payment.confirmed_at) : new Date();
  const expiry = expiryFrom(payment.wifi_packages, start);
  if (payment.status === 'PENDING') {
    await db.from('payments').update({ status: 'SUCCESS', mpesa_receipt_number: payload.receipt || null, raw_callback: payload, confirmed_at: start.toISOString() }).eq('id', payment.id).eq('status', 'PENDING');
  }

  let { data: session } = await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle();
  if (!session) {
    const { data, error } = await db.from('wifi_sessions').insert({ payment_id: payment.id, phone: payment.phone, package_id: payment.package_id, mac_address: payment.mac_address, start_time: start.toISOString(), expiry_time: expiry.toISOString(), session_status: 'WAITING_GATEWAY' }).select().single();
    if (error) session = (await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle()).data;
    else session = data;
  }
  if (!session || session.session_status === 'ACTIVE') return;

  try {
    const { data: context } = await db.from('opennds_portal_contexts').select('hid').eq('id', payment.portal_context_id).single();
    if (!context) throw new Error('Missing hotspot gateway context');
    const grant = await queueOpenNdsAuth({ sessionId: session.id, hid: context.hid, durationMinutes: payment.wifi_packages.duration_minutes });
    await db.from('wifi_sessions').update({ gateway_reference: grant.gatewayReference }).eq('id', session.id);
  } catch {
    await db.from('wifi_sessions').update({ session_status: 'GATEWAY_FAILED' }).eq('id', session.id).eq('session_status', 'WAITING_GATEWAY');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const secret = process.env.CLOUDPAY_WEBHOOK_SECRET || '';
  if (!secret) return res.status(503).send('Webhook is not configured');

  const body = await rawBody(req);
  const signature = String(req.headers['x-cloudpay-signature'] || '');
  const expected = createHmac('sha256', secret).update(body).digest();
  if (!/^[a-f0-9]{64}$/i.test(signature)) return res.status(401).send('Invalid signature');
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).send('Invalid signature');

  let event;
  try { event = JSON.parse(body.toString('utf8')); }
  catch { return res.status(400).send('Invalid JSON'); }
  if (!event.reference || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(event.status)) return res.status(400).send('Invalid payment event');

  const db = supabase();
  const { data: payment } = await db.from('payments').select('*, wifi_packages(*)').eq('checkout_request_id', event.reference).maybeSingle();
  if (!payment) return res.status(200).send('Unknown payment ignored');
  if (payment.status === 'FAILED') return res.status(200).send('Already processed');

  if (event.status !== 'COMPLETED') {
    if (payment.status !== 'PENDING') return res.status(200).send('Already completed');
    await db.from('payments').update({ status: 'FAILED', raw_callback: event }).eq('id', payment.id).eq('status', 'PENDING');
    return res.status(200).send('Accepted');
  }
  if (event.event !== 'payment.completed' || event.channel !== 'MPESA' || event.currency !== 'KES' || Number(event.amount) !== Number(payment.amount_kes)) return res.status(400).send('Payment details did not match');

  await activate(db, payment, event);
  return res.status(200).send('Accepted');
}

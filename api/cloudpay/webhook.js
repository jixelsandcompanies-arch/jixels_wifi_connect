import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabase } from '../../lib/supabase.js';
import { activateConfirmedPayment } from '../../lib/activate-payment.js';

export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
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
  const eventName = String(event.event || req.headers['x-cloudpay-event'] || '').toLowerCase();
  const paymentEvents = ['payment.completed', 'payment.failed'];
  // CloudPay's dashboard sends signed verification events without a payment
  // reference. Acknowledge those (and other supported non-payment channels)
  // so they are not retried as failed deliveries; never activate access here.
  if (!paymentEvents.includes(eventName) || (event.channel && event.channel !== 'MPESA')) {
    return res.status(200).send('Webhook received');
  }
  if (!event.reference || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(event.status)) return res.status(400).send('Invalid payment event');

  const db = supabase();
  const { data: payment } = await db.from('payments').select('*, wifi_packages(*)').eq('checkout_request_id', event.reference).maybeSingle();
  if (!payment) return res.status(503).send('Payment record not ready; retry webhook');
  if (payment.status === 'FAILED') return res.status(200).send('Already processed');

  const expectedEvent = event.status === 'COMPLETED' ? 'payment.completed' : 'payment.failed';
  if (eventName !== expectedEvent || event.channel !== 'MPESA' || event.currency !== 'KES' || Number(event.amount) !== Number(payment.amount_kes)) {
    return res.status(400).send('Payment details did not match');
  }

  if (event.status !== 'COMPLETED') {
    if (payment.status !== 'PENDING') return res.status(200).send('Already completed');
    const { error } = await db.from('payments').update({ status: 'FAILED', raw_callback: event }).eq('id', payment.id).eq('status', 'PENDING');
    if (error) return res.status(503).send('Could not record payment result; retry webhook');
    return res.status(200).send('Accepted');
  }

  try { await activateConfirmedPayment(db, payment, event); }
  catch (error) {
    console.error('CloudPay payment activation failed', { paymentId: payment.id, code: error.code, message: error.message });
    return res.status(503).send('Could not record payment result; retry webhook');
  }
  return res.status(200).send('Accepted');
}

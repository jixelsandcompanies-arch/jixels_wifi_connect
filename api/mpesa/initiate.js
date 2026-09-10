import { supabase } from '../../lib/supabase.js';
const kenyaPhone = phone => phone.replace(/\D/g, '').replace(/^0/, '254').replace(/^\+/, '');
async function accessToken() { const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64'); const r = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', { headers: { Authorization: `Basic ${basic}` } }); return (await r.json()).access_token; }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { packageId, phone, macAddress = null, deviceCode = null } = req.body;
  const db = supabase(); const { data: plan } = await db.from('wifi_packages').select('*').eq('id', packageId).eq('is_active', true).single();
  if (!plan) return res.status(400).json({ error: 'Selected package is unavailable' });
  let deviceId = null;
  if (deviceCode) { const { data: device } = await db.from('wifi_devices').select('id').eq('device_code', deviceCode.toUpperCase()).gt('code_expires_at', new Date().toISOString()).single(); if (!device) return res.status(400).json({ error: 'That device code has expired or is not available' }); deviceId = device.id; }
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14), password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  const r = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ BusinessShortCode: process.env.MPESA_SHORTCODE, Password: password, Timestamp: timestamp, TransactionType: 'CustomerPayBillOnline', Amount: plan.price_kes, PartyA: kenyaPhone(phone), PartyB: process.env.MPESA_SHORTCODE, PhoneNumber: kenyaPhone(phone), CallBackURL: process.env.MPESA_CALLBACK_URL, AccountReference: `JIX-${plan.slug}`, TransactionDesc: plan.name }) });
  const mpesa = await r.json(); if (!r.ok || !mpesa.CheckoutRequestID) return res.status(502).json({ error: mpesa.errorMessage || 'Could not start M-Pesa payment' });
  const { error } = await db.from('payments').insert({ checkout_request_id: mpesa.CheckoutRequestID, phone: kenyaPhone(phone), package_id: plan.id, amount_kes: plan.price_kes, mac_address: macAddress, device_id: deviceId, status: 'PENDING' });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(202).json({ checkoutRequestId: mpesa.CheckoutRequestID, status: 'PENDING' });
}

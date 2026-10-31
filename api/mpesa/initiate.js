import { supabase } from '../../lib/supabase.js';
import { isGatewayConfigured } from '../../lib/gateway.js';
import { createHash, randomBytes } from 'node:crypto';
const mpesaBase = () => process.env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
async function accessToken() { const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64'); const r = await fetch(`${mpesaBase()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } }); const data = await r.json(); if (!r.ok || !data.access_token) throw new Error('M-Pesa authentication failed'); return data.access_token; }
const kenyaPhone = phone => String(phone || '').replace(/\D/g, '').replace(/^0/, '254');
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { packageId, phone, portalToken, deviceCode = null } = req.body || {};
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET || !process.env.MPESA_SHORTCODE || !process.env.MPESA_PASSKEY || !process.env.MPESA_CALLBACK_URL) return res.status(503).json({ error: 'M-Pesa payments are not configured yet' });
  if (!isGatewayConfigured()) return res.status(503).json({ error: 'Wi-Fi access activation is not configured for this router yet. Please contact the Wi-Fi administrator.' });
  if (!/^[a-f0-9]{64}$/.test(portalToken || '')) return res.status(400).json({ error: 'Connect through the hotspot portal before purchasing.' });
  if (!/^(?:254(?:1|7)\d{8})$/.test(kenyaPhone(phone))) return res.status(400).json({ error: 'Enter a valid Kenyan M-Pesa phone number' });
  if (!packageId) return res.status(400).json({ error: 'Select an available Wi-Fi package' });
  const db = supabase();
  const { data: context } = await db.from('opennds_portal_contexts').select('id,mac_address').eq('token_hash', createHash('sha256').update(portalToken).digest('hex')).gt('expires_at', new Date().toISOString()).is('consumed_at', null).maybeSingle();
  if (!context) return res.status(400).json({ error: 'Hotspot session expired. Reconnect to the Wi-Fi and try again.' });
  const { data: plan } = await db.from('wifi_packages').select('*').eq('id', packageId).eq('is_active', true).single();
  if (!plan) return res.status(400).json({ error: 'Selected package is unavailable' });
  let deviceId = null;
  if (deviceCode) { const { data: device } = await db.from('wifi_devices').select('id').eq('device_code', deviceCode.toUpperCase()).gt('code_expires_at', new Date().toISOString()).single(); if (!device) return res.status(400).json({ error: 'That device code has expired or is not available' }); deviceId = device.id; }
  const kenyaTimestamp = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).reduce((s, p) => s + (p.type === 'year' || p.type === 'month' || p.type === 'day' || p.type === 'hour' || p.type === 'minute' || p.type === 'second' ? p.value : ''), '');
  const timestamp = kenyaTimestamp, password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  const r = await fetch(`${mpesaBase()}/mpesa/stkpush/v1/processrequest`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ BusinessShortCode: process.env.MPESA_SHORTCODE, Password: password, Timestamp: timestamp, TransactionType: 'CustomerPayBillOnline', Amount: plan.price_kes, PartyA: kenyaPhone(phone), PartyB: process.env.MPESA_SHORTCODE, PhoneNumber: kenyaPhone(phone), CallBackURL: process.env.MPESA_CALLBACK_URL, AccountReference: `JIX-${plan.slug}`, TransactionDesc: plan.name }) });
  const mpesa = await r.json(); if (!r.ok || !mpesa.CheckoutRequestID) return res.status(502).json({ error: mpesa.errorMessage || 'Could not start M-Pesa payment' });
  const statusToken = randomBytes(32).toString('hex');
  const { data: payment, error } = await db.from('payments').insert({ checkout_request_id: mpesa.CheckoutRequestID, phone: kenyaPhone(phone), package_id: plan.id, amount_kes: plan.price_kes, mac_address: context.mac_address, portal_context_id: context.id, status_token: statusToken, device_id: deviceId, status: 'PENDING' }).select('id').single();
  if (error) return res.status(500).json({ error: error.message });
  await db.from('opennds_portal_contexts').update({ consumed_at: new Date().toISOString(), payment_id: payment.id }).eq('id', context.id);
  return res.status(202).json({ checkoutRequestId: mpesa.CheckoutRequestID, statusToken, status: 'PENDING' });
}

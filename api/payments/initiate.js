import { supabase } from '../../lib/supabase.js';
import { isGatewayConfigured, isMikrotikAgentMode, isMikrotikAgentOnline, isTyraxAgentMode } from '../../lib/gateway.js';
import { createHash, randomBytes } from 'node:crypto';

const cloudPayEnvironment = () => process.env.CLOUDPAY_ENV || '';
const cloudPayBase = () => cloudPayEnvironment() === 'production'
  ? 'https://www.pay.cloud.or.ke/api'
  : cloudPayEnvironment() === 'sandbox' ? 'https://pay.cloud.or.ke/sandbox/api' : null;
const kenyaPhone = phone => String(phone || '').replace(/\D/g, '').replace(/^0/, '254');

async function cloudPayToken() {
  const key = process.env.CLOUDPAY_CONSUMER_KEY || '';
  const secret = process.env.CLOUDPAY_CONSUMER_SECRET || '';
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const response = await fetch(`${cloudPayBase()}/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}` } });
  const result = await response.json();
  const accessToken = result.access_token || result.data?.access_token;
  if (!response.ok || !accessToken) throw new Error(response.ok ? 'CloudPay did not return an access token' : 'CloudPay authentication failed');
  return accessToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { packageId, phone, portalToken } = req.body || {};
  if (!cloudPayBase()) return res.status(503).json({ success: false, error: 'CloudPay mode is not configured. Set CLOUDPAY_ENV explicitly to production or sandbox.' });
  if (!process.env.CLOUDPAY_CONSUMER_KEY || !process.env.CLOUDPAY_CONSUMER_SECRET || !process.env.CLOUDPAY_WEBHOOK_SECRET) return res.status(503).json({ success: false, error: 'CloudPay is not configured yet. Set CLOUDPAY_CONSUMER_KEY, CLOUDPAY_CONSUMER_SECRET, and CLOUDPAY_WEBHOOK_SECRET in Vercel.' });
  if (!isGatewayConfigured()) return res.status(503).json({ error: 'Wi-Fi access activation is not configured for this router yet. Please contact the Wi-Fi administrator.' });
  if (isTyraxAgentMode()) return res.status(503).json({ error: 'Phone-only device identification requires the openNDS captive portal. The TYRAX router agent cannot identify a device from a phone number.' });
  if (isMikrotikAgentMode() && !(await isMikrotikAgentOnline())) return res.status(503).json({ error: 'The MikroTik access agent is offline. Please try again later.' });
  if (!/^[a-f0-9]{64}$/.test(portalToken || '')) return res.status(400).json({ error: 'Join the hotspot and open its captive portal before purchasing. The connected device is identified automatically.' });
  if (!/^(?:254(?:1|7)\d{8})$/.test(kenyaPhone(phone))) return res.status(400).json({ error: 'Enter a valid Kenyan M-Pesa phone number' });
  if (!packageId) return res.status(400).json({ error: 'Select an available Wi-Fi package' });

  const db = supabase();
  const tokenHash = createHash('sha256').update(portalToken).digest('hex');
  const contextTable = isMikrotikAgentMode() ? 'mikrotik_portal_contexts' : 'opennds_portal_contexts';
  const contextFields = isMikrotikAgentMode() ? 'id,mac_address,client_ip,gateway_id' : 'id,mac_address';
  const { data: context } = await db.from(contextTable).select(contextFields).eq('token_hash', tokenHash).gt('expires_at', new Date().toISOString()).is('consumed_at', null).maybeSingle();
  if (!context) return res.status(400).json({ error: 'Hotspot session expired. Reconnect to the Wi-Fi and try again.' });
  const { data: plan } = await db.from('wifi_packages').select('*').eq('id', packageId).eq('is_active', true).single();
  if (!plan) return res.status(400).json({ error: 'Selected package is unavailable' });

  const statusToken = randomBytes(32).toString('hex');
  const pendingRow = {
    checkout_request_id: null,
    phone: kenyaPhone(phone), package_id: plan.id, amount_kes: plan.price_kes,
    mac_address: context.mac_address, status_token: statusToken, status: 'PENDING',
    [isMikrotikAgentMode() ? 'mikrotik_portal_context_id' : 'portal_context_id']: context.id
  };
  const { data: payment, error: insertError } = await db.from('payments').insert(pendingRow).select('id').single();
  if (insertError) {
    console.error('CloudPay pending payment insert failed', insertError);
    return res.status(500).json({ success: false, error: 'Could not save a pending payment record. Please try again.' });
  }
  try {
    const accessToken = await cloudPayToken();
    // M-Pesa's account reference is limited to 12 characters and the
    // transaction description to 13. Longer values can be rejected before
    // Safaricom sends the customer's STK prompt.
    const transactionReference = `JX${randomBytes(5).toString('hex').toUpperCase()}`;
    const response = await fetch(`${cloudPayBase()}/payments/mpesa/stkpush`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: kenyaPhone(phone), amount: plan.price_kes, transactionReference, description: 'WiFi access' })
    });
    const result = await response.json();
    const reference = result.data?.reference || result.reference;
    if (!response.ok || result.status !== 'success' || !reference) {
      await db.from('payments').update({ status: 'FAILED', raw_callback: result }).eq('id', payment.id).eq('status', 'PENDING');
      return res.status(502).json({ success: false, error: result.message || 'CloudPay could not start the M-Pesa prompt.' });
    }
    const { error: updateError } = await db.from('payments').update({ checkout_request_id: reference }).eq('id', payment.id).eq('status', 'PENDING');
    if (updateError) {
      console.error('CloudPay reference update failed', updateError);
      return res.status(500).json({ success: false, error: 'CloudPay accepted the payment request, but its reference could not be saved. Check your phone before retrying.' });
    }
    await db.from(contextTable).update({ consumed_at: new Date().toISOString(), payment_id: payment.id }).eq('id', context.id);
    return res.status(202).json({ success: true, checkoutRequestId: reference, statusToken, status: 'PENDING', message: 'STK sent. Check your phone and enter your M-Pesa PIN.' });
  } catch (error) {
    await db.from('payments').update({ status: 'FAILED', raw_callback: { error: error.message || 'CloudPay request failed' } }).eq('id', payment.id).eq('status', 'PENDING');
    console.error('CloudPay STK request failed', error);
    return res.status(502).json({ success: false, error: error.message || 'Could not connect to CloudPay.' });
  }
}

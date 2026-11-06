import { supabase } from '../../lib/supabase.js';
import { isGatewayConfigured, isMikrotikAgentMode, isMikrotikAgentOnline, isTyraxAgentMode, mikrotikGatewayId } from '../../lib/gateway.js';
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
  const { data: context, error: contextError } = await db.from(contextTable).select(contextFields).eq('token_hash', tokenHash).gt('expires_at', new Date().toISOString()).is('consumed_at', null).maybeSingle();
  if (contextError) {
    console.error('Portal context lookup failed', { code: contextError.code, message: contextError.message });
    return res.status(503).json({ error: 'Hotspot session could not be verified. Please reconnect and try again.' });
  }
  if (!context) return res.status(400).json({ error: 'Hotspot session expired. Reconnect to the Wi-Fi and try again.' });
  if (isMikrotikAgentMode()) {
    const gatewayId = mikrotikGatewayId();
    if (!gatewayId || context.gateway_id !== gatewayId) {
      console.error('MikroTik payment rejected: portal gateway identity mismatch', { configuredGatewayId: gatewayId, contextGatewayId: context.gateway_id });
      return res.status(403).json({ error: 'This hotspot session belongs to a different or unconfigured gateway. Reopen the hotspot sign-in page.' });
    }
    const { data: gateway, error: gatewayError } = await db.from('mikrotik_gateways').select('gateway_id').eq('gateway_id', gatewayId).maybeSingle();
    if (gatewayError || !gateway) {
      console.error('MikroTik payment rejected: configured gateway is not registered', { gatewayId, code: gatewayError?.code, message: gatewayError?.message });
      return res.status(503).json({ error: 'The MikroTik gateway is not registered. Please contact the Wi-Fi administrator.' });
    }
  }
  if (!cloudPayBase()) return res.status(503).json({ success: false, error: 'CloudPay mode is not configured. Set CLOUDPAY_ENV explicitly to production or sandbox.' });
  if (!process.env.CLOUDPAY_CONSUMER_KEY || !process.env.CLOUDPAY_CONSUMER_SECRET || !process.env.CLOUDPAY_WEBHOOK_SECRET) return res.status(503).json({ success: false, error: 'CloudPay is not configured yet. Set CLOUDPAY_CONSUMER_KEY, CLOUDPAY_CONSUMER_SECRET, and CLOUDPAY_WEBHOOK_SECRET in Vercel.' });
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
  let cloudPayRequestStarted = false;
  try {
    const accessToken = await cloudPayToken();
    // M-Pesa's account reference is limited to 12 characters and the
    // transaction description to 13. Longer values can be rejected before
    // Safaricom sends the customer's STK prompt.
    const transactionReference = `JX${randomBytes(5).toString('hex').toUpperCase()}`;
    cloudPayRequestStarted = true;
    const response = await fetch(`${cloudPayBase()}/payments/mpesa/stkpush`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: kenyaPhone(phone), amount: plan.price_kes, transactionReference, description: 'WiFi access' })
    });
    const result = await response.json();
    const reference = result.data?.reference || result.reference;
    if (!response.ok || result.status !== 'success' || !reference) {
      await db.from('payments').update({ status: 'FAILED', raw_callback: result }).eq('id', payment.id).eq('status', 'PENDING');
      return res.status(502).json({ success: false, status: 'FAILED', statusToken, error: result.message || 'CloudPay could not start the M-Pesa prompt.' });
    }
    const { error: updateError } = await db.from('payments').update({ checkout_request_id: reference }).eq('id', payment.id).eq('status', 'PENDING');
    if (updateError) {
      console.error('CloudPay reference update failed', updateError);
      return res.status(202).json({ success: true, status: 'PENDING', statusToken, error: 'CloudPay accepted the request, but the status is still being checked. Check your phone and do not retry yet.' });
    }
    await db.from(contextTable).update({ consumed_at: new Date().toISOString(), payment_id: payment.id }).eq('id', context.id);
    return res.status(202).json({ success: true, checkoutRequestId: reference, statusToken, status: 'PENDING', message: 'STK sent. Check your phone and enter your M-Pesa PIN.' });
  } catch (error) {
    console.error('CloudPay STK request failed', error);
    if (!cloudPayRequestStarted) {
      await db.from('payments').update({ status: 'FAILED', raw_callback: { error: error.message || 'CloudPay authentication failed' } }).eq('id', payment.id).eq('status', 'PENDING');
      return res.status(502).json({ success: false, status: 'FAILED', statusToken, error: 'CloudPay could not start this payment. You can retry or choose another package.' });
    }
    return res.status(202).json({ success: true, status: 'PENDING', statusToken, error: 'We could not confirm the M-Pesa request result yet. Check your phone and do not retry until this attempt is confirmed failed.' });
  }
}

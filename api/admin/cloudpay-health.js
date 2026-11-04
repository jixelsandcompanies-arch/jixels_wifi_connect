import { requireAdmin } from '../../lib/admin-auth.js';

const baseFor = environment => environment === 'production'
  ? 'https://pay.cloud.or.ke/api'
  : environment === 'sandbox' ? 'https://pay.cloud.or.ke/sandbox/api' : null;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!await requireAdmin(req, res)) return;

  res.setHeader('Cache-Control', 'no-store');
  const environment = process.env.CLOUDPAY_ENV || '';
  const base = baseFor(environment);
  const key = process.env.CLOUDPAY_CONSUMER_KEY || '';
  const secret = process.env.CLOUDPAY_CONSUMER_SECRET || '';
  if (!base || !key || !secret) {
    return res.status(503).json({ authenticated: false, environment: environment || null, error: 'CloudPay mode or consumer credentials are not configured.' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
      signal: controller.signal
    });
    let result = {};
    try { result = await response.json(); } catch { /* handle invalid provider response below */ }
    if (!response.ok || !result.access_token) {
      return res.status(502).json({ authenticated: false, environment, error: response.status === 401 || response.status === 403
        ? 'CloudPay rejected the consumer credentials.'
        : `CloudPay OAuth failed (HTTP ${response.status}).` });
    }
    return res.status(200).json({ authenticated: true, environment });
  } catch (error) {
    return res.status(error.name === 'AbortError' ? 504 : 502).json({ authenticated: false, environment, error: error.name === 'AbortError'
      ? 'CloudPay OAuth timed out.' : 'Could not reach CloudPay OAuth.' });
  } finally {
    clearTimeout(timer);
  }
}

import { handleOpenNdsAuthGet, isGatewayConfigured, isOpenNdsMode, parseFas } from '../../lib/gateway.js';

export default async function handler(req, res) {
  if (!isOpenNdsMode() || !isGatewayConfigured()) return res.status(503).send('openNDS gateway is not configured');
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query?.auth_get) {
    try { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(await handleOpenNdsAuthGet(req.query)); }
    catch { return res.status(403).end(); }
  }
  if (!req.query?.fas || typeof req.query.fas !== 'string') return res.status(400).send('Missing hotspot session');
  try {
    parseFas(req.query.fas);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, `/?fas=${encodeURIComponent(req.query.fas)}`);
  } catch { return res.status(403).send('This hotspot is not connected to the billing portal'); }
}

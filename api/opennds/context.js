import { createHash, randomBytes } from 'node:crypto';
import { supabase } from '../../lib/supabase.js';
import { isGatewayConfigured, isOpenNdsMode, parseFas } from '../../lib/gateway.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isOpenNdsMode() || !isGatewayConfigured()) return res.status(503).json({ error: 'openNDS gateway is not configured' });
  try {
    const context = parseFas(req.body?.fas), token = randomBytes(32).toString('hex');
    const { error } = await supabase().from('opennds_portal_contexts').insert({ token_hash: createHash('sha256').update(token).digest('hex'), ...context, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() });
    if (error) throw error;
    return res.status(200).json({ portalToken: token });
  } catch (error) { return res.status(400).json({ error: error.message || 'Invalid hotspot session' }); }
}

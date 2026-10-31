import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const openNdsGatewayHash = () => sha256(String(process.env.OPENNDS_GATEWAY_NAME || '').trim());
export const isTyraxAgentMode = () => process.env.WIFI_GATEWAY_MODE === 'tyrax-agent';
export const isGatewayConfigured = () => Boolean(
  isTyraxAgentMode()
    ? process.env.TYRAX_AGENT_TOKEN
    : process.env.OPENNDS_FAS_KEY && process.env.OPENNDS_GATEWAY_NAME &&
      process.env.OPENNDS_FAS_URL && process.env.OPENNDS_GATEWAY_NAME.trim()
);
export async function isTyraxAgentOnline(maxAgeMs = 90_000) {
  if (!isTyraxAgentMode() || !process.env.TYRAX_AGENT_TOKEN) return false;
  const { data } = await supabase().from('tyrax_agent_status').select('last_seen_at').eq('id', 1).maybeSingle();
  return Boolean(data?.last_seen_at && Date.now() - Date.parse(data.last_seen_at) <= maxAgeMs);
}

export async function queueTyraxRouterCommand({ sessionId, macAddress, action, durationMinutes }) {
  if (!isTyraxAgentMode() || !['ALLOW', 'BLOCK'].includes(action)) throw new Error('TYRAX local agent is not configured');
  const { error } = await supabase().from('tyrax_router_commands').upsert({
    session_id: sessionId, mac_address: macAddress.toLowerCase(), action,
    duration_minutes: Math.max(1, Math.ceil(durationMinutes || 1)), status: 'PENDING'
  }, { onConflict: 'session_id,action', ignoreDuplicates: true });
  if (error) throw error;
  return { gatewayReference: `${action}:${sessionId}` };
}

export function parseFas(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid openNDS portal request');
  const decoded = Buffer.from(value.replaceAll(' ', '+'), 'base64').toString('utf8');
  const fields = {};
  for (const part of decoded.split(', ')) {
    const at = part.indexOf('=');
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
  }
  if (!/^[0-9a-f]{64}$/i.test(fields.hid || '') || !fields.gatewayname || !fields.clientmac || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(fields.clientmac)) throw new Error('Incomplete openNDS portal request');
  if (sha256(fields.gatewayname.trim()) !== openNdsGatewayHash()) throw new Error('This hotspot gateway is not configured for this portal');
  return { hid: fields.hid.toLowerCase(), gatewayHash: openNdsGatewayHash(), macAddress: fields.clientmac.toLowerCase(), originUrl: fields.originurl || '' };
}

export async function queueOpenNdsAuth({ sessionId, hid, durationMinutes }) {
  const db = supabase(), rhid = sha256(`${hid.trim()}${process.env.OPENNDS_FAS_KEY.trim()}`);
  const { data: prior } = await db.from('opennds_auth_queue').select('rhid').eq('session_id', sessionId).maybeSingle();
  if (prior) return { gatewayReference: prior.rhid };
  const { error } = await db.from('opennds_auth_queue').upsert({
    session_id: sessionId, gateway_hash: openNdsGatewayHash(), rhid,
    auth_string: `${rhid} ${Math.max(1, Math.ceil(durationMinutes))} 0 0 0 0`, duration_minutes: Math.max(1, Math.ceil(durationMinutes)), status: 'PENDING'
  }, { onConflict: 'session_id' });
  if (error) throw error;
  return { gatewayReference: rhid };
}

export async function handleOpenNdsAuthGet(query) {
  const action = String(query.auth_get || ''), gatewayHash = String(query.gatewayhash || ''), payload = String(query.payload || '');
  const key = process.env.OPENNDS_FAS_KEY || '';
  if (!key || !/^[0-9a-f]{64}$/.test(gatewayHash) || gatewayHash !== openNdsGatewayHash() || !['clear', 'list', 'view', 'deauthed', 'custom'].includes(action)) throw new Error('Invalid authmon request');
  // openNDS authmon signs with HMAC-SHA256, not an ordinary digest.
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const actual = createHmac('sha256', key).update(`${action}\n${gatewayHash}\n${payload}`).digest('hex');
  const supplied = String(query.authmac || '');
  if (!/^[0-9a-f]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(actual), Buffer.from(supplied))) throw new Error('Invalid authmon signature');
  const db = supabase();
  // Keep paid, not-yet-acknowledged sessions through gateway restarts.
  if (action === 'clear') return '';
  if (action === 'deauthed' || action === 'custom') return 'ack';
  if (action === 'view' && payload !== 'none') {
    const acked = Buffer.from(payload, 'base64').toString('utf8').trim().split(/\s+/).filter(x => /^[0-9a-f]{64}$/.test(x));
    for (const rhid of acked) {
      const activatedAt = new Date();
      const { data: queued } = await db.from('opennds_auth_queue').update({ status: 'AUTHENTICATED', authenticated_at: activatedAt.toISOString() }).eq('gateway_hash', gatewayHash).eq('rhid', rhid).eq('status', 'PENDING').select('session_id,duration_minutes').maybeSingle();
      if (queued?.session_id) await db.from('wifi_sessions').update({ session_status: 'ACTIVE', start_time: activatedAt.toISOString(), expiry_time: new Date(activatedAt.getTime() + queued.duration_minutes * 60_000).toISOString() }).eq('id', queued.session_id).eq('session_status', 'WAITING_GATEWAY');
    }
    return 'ack';
  }
  const { data, error } = await db.from('opennds_auth_queue').select('auth_string').eq('gateway_hash', gatewayHash).eq('status', 'PENDING').order('created_at').limit(100);
  if (error) throw error;
  return `*${data.map(x => ` ${encodeURIComponent(x.auth_string)}`).join('')}`;
}

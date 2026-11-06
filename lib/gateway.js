import { createHash, createHmac } from 'node:crypto';
import { supabase } from './supabase.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const openNdsGatewayHash = () => sha256(String(process.env.OPENNDS_GATEWAY_NAME || '').trim());
export const gatewayMode = () => process.env.WIFI_GATEWAY_MODE || 'opennds';
export const isTyraxAgentMode = () => process.env.WIFI_GATEWAY_MODE === 'tyrax-agent';
export const isMikrotikAgentMode = () => process.env.WIFI_GATEWAY_MODE === 'mikrotik-agent';
export const mikrotikGatewayId = () => {
  const value = String(process.env.MIKROTIK_GATEWAY_ID || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
};
export const isOpenNdsMode = () => gatewayMode() === 'opennds';
export const isGatewayConfigured = () => {
  if (isTyraxAgentMode()) return Boolean(process.env.TYRAX_AGENT_TOKEN);
  if (isMikrotikAgentMode()) return Boolean(mikrotikGatewayId() && process.env.MIKROTIK_AGENT_TOKEN && process.env.MIKROTIK_CREDENTIAL_SECRET && isLocalHotspotLoginUrl(process.env.MIKROTIK_HOTSPOT_LOGIN_URL));
  if (!isOpenNdsMode()) return false;
  return Boolean(process.env.OPENNDS_FAS_KEY && process.env.OPENNDS_GATEWAY_NAME && process.env.OPENNDS_FAS_URL && process.env.OPENNDS_GATEWAY_NAME.trim());
};
function isLocalHotspotLoginUrl(value) {
  try {
    const url = new URL(value || '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const parts = url.hostname.split('.').map(Number);
    return (parts.length === 4 && parts.every(x => Number.isInteger(x) && x >= 0 && x <= 255) && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168))) || /\.(?:lan|local)$/i.test(url.hostname);
  } catch { return false; }
}
export async function isTyraxAgentOnline(maxAgeMs = 90_000) {
  if (!isTyraxAgentMode() || !process.env.TYRAX_AGENT_TOKEN) return false;
  const { data } = await supabase().from('tyrax_agent_status').select('last_seen_at').eq('id', 1).maybeSingle();
  return Boolean(data?.last_seen_at && Date.now() - Date.parse(data.last_seen_at) <= maxAgeMs);
}

export async function isMikrotikAgentOnline(maxAgeMs = 90_000) {
  if (!isMikrotikAgentMode() || !process.env.MIKROTIK_AGENT_TOKEN) return false;
  const { data } = await supabase().from('mikrotik_agent_status').select('last_seen_at').eq('id', 1).maybeSingle();
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

export async function queueMikrotikRouterCommand({ sessionId, gatewayId, macAddress, clientIp, action, durationMinutes }) {
  if (!isMikrotikAgentMode() || !['ALLOW', 'BLOCK'].includes(action)) throw new Error('MikroTik local agent is not configured');
  const credentials = mikrotikLoginCredentials(sessionId);
  const db = supabase();
  const { error } = await db.from('mikrotik_router_commands').upsert({
    session_id: sessionId, gateway_id: gatewayId, mac_address: macAddress.toLowerCase(), client_ip: clientIp,
    action, duration_minutes: Math.max(1, Math.ceil(durationMinutes || 1)), hotspot_username: credentials.username,
    hotspot_password: action === 'ALLOW' ? credentials.password : null, status: 'PENDING'
  }, { onConflict: 'session_id,action', ignoreDuplicates: true });
  if (error) throw error;
  return { gatewayReference: `${action}:${sessionId}` };
}

export function mikrotikLoginCredentials(sessionId) {
  const secret = process.env.MIKROTIK_CREDENTIAL_SECRET || '';
  if (!secret) throw new Error('MikroTik login credential secret is not configured');
  const cleanSessionId = String(sessionId).replaceAll('-', '');
  return {
    username: `jix_${cleanSessionId.slice(0, 24)}`,
    password: createHmac('sha256', secret).update(`mikrotik-hotspot:${sessionId}`).digest('base64url')
  };
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
  // Authmon base64-encodes every payload before signing and sending it,
  // including the literal "none" used for an ordinary queue poll.
  const decodedPayload = Buffer.from(payload, 'base64').toString('utf8').trim();
  // Keep paid, not-yet-acknowledged sessions through gateway restarts.
  if (action === 'clear') return '';
  if (action === 'deauthed' || action === 'custom') return 'ack';
  if (action === 'view' && decodedPayload !== 'none') {
    // The decoded acknowledgement list is plain whitespace-separated text
    // (for example: "* <rhid>"); ignore its leading protocol marker.
    const acked = decodedPayload.split(/\s+/).filter(x => /^[0-9a-f]{64}$/.test(x));
    for (const rhid of acked) {
      const { error } = await db.rpc('acknowledge_opennds_auth', { p_gateway_hash: gatewayHash, p_rhid: rhid });
      if (error) throw error;
    }
    return 'ack';
  }
  const { data, error } = await db.from('opennds_auth_queue').select('auth_string').eq('gateway_hash', gatewayHash).eq('status', 'PENDING').order('created_at').limit(100);
  if (error) throw error;
  return `*${data.map(x => ` ${encodeURIComponent(x.auth_string)}`).join('')}`;
}

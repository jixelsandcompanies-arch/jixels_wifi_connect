import { timingSafeEqual } from 'node:crypto';
import { supabase } from '../../lib/supabase.js';
import { isGatewayConfigured, isMikrotikAgentMode, mikrotikGatewayId } from '../../lib/gateway.js';

function authorized(req) {
  const expected = process.env.MIKROTIK_AGENT_TOKEN || '';
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(provided)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export default async function handler(req, res) {
  if (!isMikrotikAgentMode() || !isGatewayConfigured() || !authorized(req)) return res.status(401).json({ error: 'Unauthorized MikroTik agent' });
  const db = supabase();
  const { error: heartbeatError } = await db.from('mikrotik_agent_status').upsert({ id: 1, last_seen_at: new Date().toISOString() }, { onConflict: 'id' });
  if (heartbeatError) {
    console.error('MikroTik agent heartbeat failed', { code: heartbeatError.code, message: heartbeatError.message });
    if (req.method === 'GET') return res.status(500).json({ error: 'Could not record MikroTik agent heartbeat' });
  }
  if (req.method === 'GET') {
    const gatewayId = mikrotikGatewayId();
    const { data, error } = await db.from('mikrotik_router_commands').select('id,session_id,gateway_id,mac_address,client_ip,action,duration_minutes,hotspot_username,attempts').eq('status', 'PENDING').eq('gateway_id', gatewayId).order('created_at').limit(20);
    if (error) {
      console.error('MikroTik agent command lookup failed', { code: error.code, message: error.message, gatewayId });
      return res.status(500).json({ error: 'Could not load MikroTik commands' });
    }
    console.info('MikroTik agent poll completed', { gatewayId, pendingCommands: data.length });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ commands: data });
  }
  if (req.method === 'POST') {
    const { commandId, ok, message = '' } = req.body || {};
    if (!/^[0-9a-f-]{36}$/i.test(commandId || '') || typeof ok !== 'boolean') return res.status(400).json({ error: 'Invalid command acknowledgement' });
    const { data: command, error } = await db.from('mikrotik_router_commands').select('id,attempts,gateway_id').eq('id', commandId).eq('status', 'PENDING').maybeSingle();
    if (error || !command) return res.status(404).json({ error: 'Pending MikroTik command not found' });
    if (!ok) {
      const safeMessage = String(message).replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]').slice(0, 500);
      const { error: updateError } = await db.from('mikrotik_router_commands').update({ attempts: command.attempts + 1, last_error: safeMessage }).eq('id', command.id).eq('status', 'PENDING');
      console.warn('MikroTik router command failed', { commandId: command.id, gatewayId: command.gateway_id, attempt: command.attempts + 1, message: safeMessage, updateError: updateError?.message });
      return res.status(202).json({ received: true, retry: true });
    }
    const { data: completed, error: completionError } = await db.rpc('complete_mikrotik_router_command', { p_command_id: command.id });
    if (completionError || !completed) return res.status(500).json({ error: 'Could not finish MikroTik command; it will retry' });
    return res.status(200).json({ received: true });
  }
  return res.status(405).end();
}

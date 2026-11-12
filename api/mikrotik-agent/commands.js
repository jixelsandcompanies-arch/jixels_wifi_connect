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
  if (req.method === 'GET') {
    const now = new Date().toISOString();
    const { error: heartbeatError } = await db.from('mikrotik_agent_status').upsert({ id: 1, last_seen_at: now }, { onConflict: 'id' });
    if (heartbeatError) {
      console.error('MikroTik agent heartbeat failed', { code: heartbeatError.code, message: heartbeatError.message });
      return res.status(500).json({ error: 'Could not record MikroTik agent heartbeat' });
    }
    const gatewayId = mikrotikGatewayId();
    const fields = 'id,session_id,gateway_id,mac_address,client_ip,action,duration_minutes,hotspot_username,hotspot_password,attempts';
    const { data: grants, error: grantError } = await db.from('mikrotik_router_commands').select(fields)
      .eq('status', 'PENDING').eq('gateway_id', gatewayId).eq('action', 'ALLOW').order('created_at').limit(20);
    if (grantError) {
      console.error('MikroTik paid grant lookup failed', { code: grantError.code, message: grantError.message, gatewayId });
      return res.status(500).json({ error: 'Could not load MikroTik commands' });
    }
    let commands = grants || [];
    const remaining = 20 - commands.length;
    if (remaining > 0) {
      const { data: cleanup, error: cleanupError } = await db.from('mikrotik_router_commands').select(fields)
        .eq('status', 'PENDING').eq('gateway_id', gatewayId).eq('action', 'BLOCK').order('created_at').limit(remaining);
      if (cleanupError) {
        console.error('MikroTik cleanup command lookup failed', { code: cleanupError.code, message: cleanupError.message, gatewayId });
        return res.status(500).json({ error: 'Could not load MikroTik commands' });
      }
      commands = commands.concat(cleanup || []);
    }
    console.info('MikroTik agent poll completed', { gatewayId, pendingGrants: grants.length, pendingCleanup: commands.length - grants.length });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ commands });
  }
  if (req.method === 'POST') {
    const { type, routerOnline, commandId, ok, permanent = false, message = '' } = req.body || {};
    if (type === 'heartbeat' && typeof routerOnline === 'boolean') {
      const now = new Date().toISOString();
      const { error } = await db.from('mikrotik_agent_status').upsert({
        id: 1,
        last_seen_at: now,
        router_last_seen_at: routerOnline ? now : null
      }, { onConflict: 'id' });
      if (error) {
        console.error('MikroTik agent health update failed', { code: error.code, message: error.message });
        return res.status(500).json({ error: 'Could not record MikroTik health' });
      }
      return res.status(200).json({ received: true });
    }
    if (!/^[0-9a-f-]{36}$/i.test(commandId || '') || typeof ok !== 'boolean') return res.status(400).json({ error: 'Invalid command acknowledgement' });
    const { data: command, error } = await db.from('mikrotik_router_commands').select('id,session_id,attempts').eq('id', commandId).eq('status', 'PENDING').maybeSingle();
    if (error || !command) return res.status(404).json({ error: 'Pending MikroTik command not found' });
    if (!ok) {
      // A paid ALLOW must remain pending regardless of the router error. The
      // customer can still be online under a different HotSpot identity, so
      // never discard a confirmed purchase as a permanent failure.
      const nextAttempts = command.attempts + 1;
      const { error: updateError } = await db.from('mikrotik_router_commands').update({
        attempts: nextAttempts, last_error: String(message).slice(0, 500)
      }).eq('id', command.id).eq('status', 'PENDING');
      if (updateError) return res.status(500).json({ error: 'Could not record MikroTik command failure' });
      return res.status(202).json({ received: true, retry: true, attempts: nextAttempts });
    }
    const { data: completed, error: completionError } = await db.rpc('complete_mikrotik_router_command', { p_command_id: command.id });
    if (completionError || !completed) return res.status(500).json({ error: 'Could not finish MikroTik command; it will retry' });
    return res.status(200).json({ received: true });
  }
  return res.status(405).end();
}

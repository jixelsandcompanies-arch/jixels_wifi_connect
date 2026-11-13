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
    // Revocations must not wait behind a full batch of new grants.
    const { data: cleanup, error: cleanupError } = await db.from('mikrotik_router_commands').select(fields)
      .eq('status', 'PENDING').eq('gateway_id', gatewayId).eq('action', 'BLOCK').order('created_at').limit(20);
    if (cleanupError) {
      console.error('MikroTik cleanup command lookup failed', { code: cleanupError.code, message: cleanupError.message, gatewayId });
      return res.status(500).json({ error: 'Could not load MikroTik commands' });
    }
    const remaining = 20 - (cleanup || []).length;
    let grants = [];
    if (remaining > 0) {
      const { data, error: grantError } = await db.from('mikrotik_router_commands').select(fields)
        .eq('status', 'PENDING').eq('gateway_id', gatewayId).eq('action', 'ALLOW').order('created_at').limit(remaining);
      if (grantError) {
        console.error('MikroTik paid grant lookup failed', { code: grantError.code, message: grantError.message, gatewayId });
        return res.status(500).json({ error: 'Could not load MikroTik commands' });
      }
      grants = data || [];
    }
    const commands = (cleanup || []).concat(grants);
    let authorizedBindings;
    if (req.query?.reconcile === '1') {
      // Supply the paid sessions that may still own a bypass. The local agent
      // uses this snapshot to remove orphaned Jixels bypasses, including rows
      // left behind by older BLOCK commands that only matched one session ID.
      const sessions = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error: sessionError } = await db.from('wifi_sessions')
          .select('id,payment_id')
          .in('session_status', ['ACTIVE', 'WAITING_GATEWAY'])
          .gt('expiry_time', now).order('id').range(offset, offset + 999);
        if (sessionError) {
          console.error('MikroTik authorized session lookup failed', { code: sessionError.code, message: sessionError.message, gatewayId });
          return res.status(500).json({ error: 'Could not load authorized MikroTik sessions' });
        }
        sessions.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      const paymentIds = [...new Set((sessions || []).map(session => session.payment_id).filter(Boolean))];
      let paymentContexts = [];
      for (let offset = 0; offset < paymentIds.length; offset += 200) {
        const { data, error: paymentError } = await db.from('payments').select('id,mikrotik_portal_context_id')
          .in('id', paymentIds.slice(offset, offset + 200)).eq('status', 'SUCCESS');
        if (paymentError) {
          console.error('MikroTik payment lookup failed', { code: paymentError.code, message: paymentError.message, gatewayId });
          return res.status(500).json({ error: 'Could not load authorized MikroTik payments' });
        }
        paymentContexts.push(...(data || []));
      }
      const contextIds = [...new Set(paymentContexts.map(payment => payment.mikrotik_portal_context_id).filter(Boolean))];
      authorizedBindings = [];
      const contexts = [];
      for (let offset = 0; offset < contextIds.length; offset += 200) {
        const { data, error: contextError } = await db.from('mikrotik_portal_contexts')
          .select('id,gateway_id,mac_address').in('id', contextIds.slice(offset, offset + 200)).eq('gateway_id', gatewayId);
        if (contextError) {
          console.error('MikroTik portal context lookup failed', { code: contextError.code, message: contextError.message, gatewayId });
          return res.status(500).json({ error: 'Could not load authorized MikroTik devices' });
        }
        contexts.push(...(data || []));
      }
      if (contextIds.length) {
        const sessionsByPayment = new Map((sessions || []).map(session => [session.payment_id, session.id]));
        const contextsById = new Map(contexts.map(context => [context.id, context]));
        authorizedBindings = paymentContexts.map(payment => {
          const context = contextsById.get(payment.mikrotik_portal_context_id);
          const sessionId = sessionsByPayment.get(payment.id);
          return context && sessionId ? { mac_address: context.mac_address, session_id: sessionId } : null;
        }).filter(Boolean);
      }
    }
    console.info('MikroTik agent poll completed', { gatewayId, pendingGrants: grants.length, pendingCleanup: (cleanup || []).length, reconciling: req.query?.reconcile === '1' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ commands, ...(authorizedBindings ? { authorizedBindings } : {}) });
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

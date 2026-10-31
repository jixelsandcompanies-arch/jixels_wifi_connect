import { timingSafeEqual } from 'node:crypto';
import { supabase } from '../../lib/supabase.js';

function authorized(req) {
  const expected = process.env.TYRAX_AGENT_TOKEN || '', provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(provided)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized local agent' });
  const db = supabase();
  if (req.method === 'GET') {
    const now = new Date().toISOString();
    const { error: beatError } = await db.from('tyrax_agent_status').upsert({ id: 1, last_seen_at: now }, { onConflict: 'id' });
    if (beatError) return res.status(500).json({ error: 'Could not record local agent heartbeat' });
    const { data: expired, error: expiryError } = await db.from('wifi_sessions').select('id,mac_address').eq('session_status', 'ACTIVE').lte('expiry_time', now).limit(50);
    if (expiryError) return res.status(500).json({ error: 'Could not check session expirations' });
    if (expired?.length) {
      const rows = expired.filter(x => x.mac_address).map(x => ({ session_id: x.id, mac_address: x.mac_address, action: 'BLOCK', duration_minutes: 1, status: 'PENDING' }));
      if (rows.length) {
        const { error } = await db.from('tyrax_router_commands').upsert(rows, { onConflict: 'session_id,action', ignoreDuplicates: true });
        if (error) return res.status(500).json({ error: 'Could not queue expired device blocks' });
      }
    }
    const { data, error } = await db.from('tyrax_router_commands').select('id,session_id,mac_address,action,duration_minutes').eq('status', 'PENDING').order('created_at').limit(50);
    if (error) return res.status(500).json({ error: 'Could not load router commands' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ commands: data });
  }
  if (req.method === 'POST') {
    const { commandId, ok, message = '' } = req.body || {};
    if (!/^[0-9a-f-]{36}$/i.test(commandId || '') || typeof ok !== 'boolean') return res.status(400).json({ error: 'Invalid command acknowledgement' });
    const { data: command, error } = await db.from('tyrax_router_commands').select('id,session_id,action,duration_minutes').eq('id', commandId).eq('status', 'PENDING').maybeSingle();
    if (error || !command) return res.status(404).json({ error: 'Pending command not found' });
    if (!ok) {
      await db.from('tyrax_router_commands').update({ attempts: 1, last_error: String(message).slice(0, 500) }).eq('id', command.id).eq('status', 'PENDING');
      return res.status(202).json({ received: true, retry: true });
    }
    const { data: completed, error: updateError } = await db.rpc('complete_tyrax_router_command', { p_command_id: command.id });
    if (updateError || !completed) return res.status(500).json({ error: 'Could not finish router command; it will retry' });
    return res.status(200).json({ received: true });
  }
  return res.status(405).end();
}

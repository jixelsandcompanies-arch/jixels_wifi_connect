import { supabase } from '../../lib/supabase.js';
import { requireAdmin } from '../../lib/admin-auth.js';
import { gatewayMode } from '../../lib/gateway.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  if (!await requireAdmin(req, res)) return;
  const sessionId = String(req.body?.sessionId || '');
  if (!uuidPattern.test(sessionId)) return res.status(400).json({ error: 'A valid session ID is required.' });

  const db = supabase();
  const { data: session, error: sessionError } = await db.from('wifi_sessions')
    .select('id,session_status,expiry_time').eq('id', sessionId).maybeSingle();
  if (sessionError) {
    console.error('Admin session lookup failed', { code: sessionError.code });
    return res.status(503).json({ error: 'Session could not be checked.' });
  }
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (!['EXPIRED', 'REVOKED'].includes(session.session_status) || Date.parse(session.expiry_time) > Date.now()) {
    return res.status(409).json({ error: 'Only expired or revoked sessions whose access period has ended can be deleted.' });
  }

  const mode = gatewayMode();
  const commandTable = mode === 'mikrotik-agent' ? 'mikrotik_router_commands'
    : mode === 'tyrax-agent' ? 'tyrax_router_commands' : null;
  const pendingQuery = commandTable
    ? db.from(commandTable).select('id', { count: 'exact', head: true }).eq('session_id', sessionId).eq('status', 'PENDING')
    : db.from('opennds_auth_queue').select('id', { count: 'exact', head: true }).eq('session_id', sessionId).eq('status', 'PENDING');
  const { count, error: commandError } = await pendingQuery;
  if (commandError) {
    console.error('Admin session pending-command check failed', { code: commandError.code, mode });
    return res.status(503).json({ error: 'Pending router work could not be checked; session was kept.' });
  }
  if (count) return res.status(409).json({ error: 'This session still has pending router work and cannot be deleted yet.' });

  const { data: deleted, error: deleteError } = await db.from('wifi_sessions').delete()
    .eq('id', sessionId).in('session_status', ['EXPIRED', 'REVOKED'])
    .lte('expiry_time', new Date().toISOString()).select('id');
  if (deleteError) {
    console.error('Admin session delete failed', { code: deleteError.code });
    return res.status(503).json({ error: 'Session could not be deleted.' });
  }
  if (!deleted?.length) return res.status(409).json({ error: 'Session changed while being checked. Refresh and try again.' });
  return res.status(200).json({ deleted: true });
}

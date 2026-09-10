import { supabase } from './supabase.js';

export async function requireAdmin(req, res) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) { res.status(401).json({ error: 'Sign in required' }); return null; }
  const db = supabase();
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Your session has expired' }); return null; }
  const { data: profile } = await db.from('admin_profiles').select('user_id').eq('user_id', user.id).maybeSingle();
  if (!profile) { res.status(403).json({ error: 'This account is not an administrator' }); return null; }
  return user;
}

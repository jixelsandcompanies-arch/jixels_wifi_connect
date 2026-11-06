import { supabase } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'Admin sign-in is not configured. Check the Supabase environment settings in Vercel.' });
  }
  let response;
  try {
    response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email).trim(), password })
    });
  } catch {
    return res.status(502).json({ error: 'Could not reach Supabase. Check your connection and try again.' });
  }
  let data = {};
  try { data = await response.json(); } catch { /* handle an empty or invalid auth response below */ }
  if (!response.ok || !data.access_token) {
    if (response.status >= 500) return res.status(502).json({ error: 'Supabase sign-in is temporarily unavailable. Try again shortly.' });
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const db = supabase();
  const { data: { user }, error: userError } = await db.auth.getUser(data.access_token);
  if (userError || !user) return res.status(502).json({ error: 'Could not verify the Supabase sign-in. Try again.' });
  const { data: profile, error: profileError } = await db.from('admin_profiles').select('user_id').eq('user_id', user.id).maybeSingle();
  if (profileError) return res.status(503).json({ error: 'Could not verify admin access. Check the admin_profiles table and try again.' });
  if (!profile) return res.status(403).json({ error: 'This account is not an administrator. Add its user ID to public.admin_profiles.' });
  return res.status(200).json({ accessToken: data.access_token });
}

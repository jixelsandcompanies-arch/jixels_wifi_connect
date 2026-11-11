import { supabase } from '../lib/supabase.js';
import { requireAdmin } from '../lib/admin-auth.js';
export default async function handler(req, res) {
  const db = supabase();
  if (req.method === 'GET') { const admin = req.headers.authorization && await requireAdmin(req, res); if (req.headers.authorization && !admin) return; const query = db.from('wifi_packages').select(admin ? '*' : 'id,name,price_kes,duration_minutes,is_popular,is_best_value,display_order,is_active').order('display_order'); const { data, error } = admin ? await query : await query.eq('is_active', true); if (error) return res.status(503).json({ error: 'Packages are temporarily unavailable.' }); if (!admin) res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120'); return res.json(data); }
  if (!await requireAdmin(req, res)) return;
  if (req.method === 'POST') { const { assertPackage } = await import('../lib/packages.js'); try { const { data, error } = await db.from('wifi_packages').insert(assertPackage(req.body)).select().single(); return error ? res.status(400).json({ error: error.message }) : res.status(201).json(data); } catch (e) { return res.status(400).json({ error: e.message }); } }
  if (req.method === 'PATCH') { const { assertPackage } = await import('../lib/packages.js'); try { const { id, ...body } = req.body; const { data, error } = await db.from('wifi_packages').update(assertPackage(body)).eq('id', id).select().single(); return error ? res.status(400).json({ error: error.message }) : res.json(data); } catch (e) { return res.status(400).json({ error: e.message }); } }
  return res.status(405).end();
}

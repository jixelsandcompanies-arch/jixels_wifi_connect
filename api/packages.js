import { supabase } from '../lib/supabase.js';
export default async function handler(req, res) {
  const db = supabase();
  if (req.method === 'GET') { const admin = req.headers['x-admin-key'] === process.env.ADMIN_API_KEY; const query = db.from('wifi_packages').select('*').order('display_order'); const { data, error } = admin ? await query : await query.eq('is_active', true); return error ? res.status(500).json({ error: error.message }) : res.json(data); }
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method === 'POST') { const { assertPackage } = await import('../lib/packages.js'); try { const { data, error } = await db.from('wifi_packages').insert(assertPackage(req.body)).select().single(); return error ? res.status(400).json({ error: error.message }) : res.status(201).json(data); } catch (e) { return res.status(400).json({ error: e.message }); } }
  if (req.method === 'PATCH') { const { assertPackage } = await import('../lib/packages.js'); try { const { id, ...body } = req.body; const { data, error } = await db.from('wifi_packages').update(assertPackage(body)).eq('id', id).select().single(); return error ? res.status(400).json({ error: error.message }) : res.json(data); } catch (e) { return res.status(400).json({ error: e.message }); } }
  return res.status(405).end();
}

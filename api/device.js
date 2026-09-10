import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
const code = () => `JX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
export default async function handler(req,res) {
 if(req.method!=='POST') return res.status(405).end();
 const macAddress=String(req.body?.macAddress||'').toLowerCase();
 if(!/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/.test(macAddress)) return res.status(400).json({error:'Device identity unavailable'});
 const db=supabase(), expires=new Date(Date.now()+15*60_000).toISOString();
 for(let i=0;i<3;i++){const deviceCode=code();const {data,error}=await db.from('wifi_devices').upsert({mac_address:macAddress,device_code:deviceCode,code_expires_at:expires},{onConflict:'mac_address'}).select('id,device_code,code_expires_at').single();if(!error)return res.json(data)}
 return res.status(503).json({error:'Could not create device code'});
}

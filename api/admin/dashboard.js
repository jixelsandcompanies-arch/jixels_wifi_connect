import { supabase } from '../../lib/supabase.js';
import { requireAdmin } from '../../lib/admin-auth.js';
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
export default async function handler(req,res) {
  if (!await requireAdmin(req, res)) return;
  const db=supabase(), now=new Date(), nowIso=now.toISOString(), today=midnight(now), week=new Date(now-6*864e5).toISOString(), month=new Date(now.getFullYear(),now.getMonth(),1).toISOString();
  const [active,expired,packages,sessions,payments,activePhones]=await Promise.all([
    db.from('wifi_sessions').select('id',{count:'exact',head:true}).eq('session_status','ACTIVE').gt('expiry_time',nowIso), db.from('wifi_sessions').select('id',{count:'exact',head:true}).eq('session_status','EXPIRED'), db.from('wifi_packages').select('*').order('display_order'), db.from('wifi_sessions').select('phone,start_time,expiry_time,session_status,wifi_packages(name)').order('start_time',{ascending:false}).limit(50), db.from('payments').select('amount_kes,created_at,package_id,status,wifi_packages(name)').eq('status','SUCCESS'), db.from('wifi_sessions').select('phone').eq('session_status','ACTIVE').gt('expiry_time',nowIso)
  ]);
  const failed=[active,expired,packages,sessions,payments,activePhones].find(x=>x.error);
  if(failed) return res.status(500).json({error:'Dashboard data could not be loaded'});
  const sales=payments.data||[], sumSince=start=>sales.filter(x=>x.created_at>=start).reduce((n,x)=>n+x.amount_kes,0), countSince=start=>sales.filter(x=>x.created_at>=start).length;
  const activeCustomers=new Set((activePhones.data||[]).map(x=>x.phone)).size;
  const breakdown=(packages.data||[]).map(p=>{const sold=sales.filter(x=>x.package_id===p.id);return {name:p.name,price_kes:p.price_kes,sold:sold.length,revenue:sold.reduce((n,x)=>n+x.amount_kes,0)}});
  return res.json({metrics:{activeCustomers,onlineNow:active.count||0,todayRevenue:sumSince(today),activeSessions:active.count||0,expiredSessions:expired.count||0,totalPackages:packages.data?.length||0},revenue:{today:{amount:sumSince(today),sales:countSince(today)},week:{amount:sumSince(week),sales:countSince(week)},month:{amount:sumSince(month),sales:countSince(month)},total:{amount:sumSince('1970-01-01'),sales:sales.length}},packages:packages.data||[],sessions:sessions.data||[],breakdown});
}

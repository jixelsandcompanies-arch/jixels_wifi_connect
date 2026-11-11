import { isIP } from 'node:net';
import { supabase } from '../../lib/supabase.js';
import { requireAdmin } from '../../lib/admin-auth.js';
import { isMikrotikAgentMode, mikrotikGatewayId } from '../../lib/gateway.js';

const macPattern = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const connectionModes = {
  ETHERNET: 'AP_BRIDGE',
  ACCESS_POINT: 'AP_BRIDGE',
  WIRELESS_BRIDGE: 'WIRELESS_BRIDGE',
  WIRELESS_REPEATER: 'REPEATER_BRIDGE'
};

function validateRouter(input) {
  const routerName = String(input?.routerName || '').trim();
  const routerMac = String(input?.routerMac || '').trim().toLowerCase();
  const routerIp = String(input?.routerIp || '').trim();
  const connectionType = String(input?.connectionType || '');
  const operatingMode = String(input?.operatingMode || '');
  const parentGatewayId = String(input?.parentGatewayId || '');
  if (!routerName || routerName.length > 80) throw new Error('Enter a device name of 1 to 80 characters.');
  if (!macPattern.test(routerMac)) throw new Error('Enter a valid MAC address.');
  if (!isIP(routerIp)) throw new Error('Enter a valid IP address.');
  if (!Object.hasOwn(connectionModes, connectionType)) throw new Error('Select a supported connection type.');
  if (connectionModes[connectionType] !== operatingMode) throw new Error('Choose the operating mode that matches the connection type.');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(parentGatewayId)) throw new Error('Select a parent MikroTik gateway.');
  return {
    router_name: routerName,
    router_mac: routerMac,
    router_ip: routerIp,
    connection_type: connectionType,
    operating_mode: operatingMode,
    parent_gateway_id: parentGatewayId,
    is_enabled: input?.isEnabled === true
  };
}

async function syncConfiguredGateway(db) {
  if (!isMikrotikAgentMode()) return null;
  const gatewayId = mikrotikGatewayId();
  if (!gatewayId) throw new Error('Configured MikroTik gateway ID is missing or invalid.');
  const { data, error } = await db.from('mikrotik_gateways').upsert({
    gateway_id: gatewayId,
    gateway_name: 'Main MikroTik HotSpot',
    updated_at: new Date().toISOString()
  }, { onConflict: 'gateway_id' }).select('gateway_id,gateway_name').single();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return res.status(405).end();
  if (!await requireAdmin(req, res)) return;
  const db = supabase();

  if (req.method === 'GET') {
    try {
      const configured = await syncConfiguredGateway(db);
      const [gatewaysResult, routersResult, agentResult] = await Promise.all([
        db.from('mikrotik_gateways').select('gateway_id,gateway_name').order('gateway_name'),
        db.from('wifi_router_registry').select('id,router_name,router_mac,router_ip,connection_type,operating_mode,parent_gateway_id,is_enabled,verification_status,created_at,updated_at,mikrotik_gateways(gateway_name)').order('router_name'),
        db.from('mikrotik_agent_status').select('last_seen_at').eq('id', 1).maybeSingle()
      ]);
      const failed = [gatewaysResult, routersResult].find(result => result.error);
      if (failed) return res.status(500).json({ error: 'Router inventory could not be loaded. Confirm migration 008 has been applied.' });
      const heartbeatAge = agentResult.data?.last_seen_at ? Date.now() - Date.parse(agentResult.data.last_seen_at) : null;
      return res.status(200).json({
        configuredGateway: configured,
        parentGateways: gatewaysResult.data || [],
        routers: routersResult.data || [],
        agentHeartbeat: heartbeatAge === null ? 'UNKNOWN' : heartbeatAge <= 90_000 ? 'RECENT' : 'STALE'
      });
    } catch {
      return res.status(503).json({ error: 'MikroTik gateway inventory is not configured.' });
    }
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    if (!isMikrotikAgentMode()) return res.status(503).json({ error: 'Configure the central MikroTik HotSpot before registering access points.' });
    let values;
    try { values = validateRouter(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      await syncConfiguredGateway(db);
      const { data: parent, error: parentError } = await db.from('mikrotik_gateways').select('gateway_id').eq('gateway_id', values.parent_gateway_id).maybeSingle();
      if (parentError || !parent) return res.status(400).json({ error: 'Select a registered MikroTik gateway.' });
      if (req.method === 'POST') {
        const { data, error } = await db.from('wifi_router_registry').insert(values).select('id,router_name,router_mac,router_ip,connection_type,operating_mode,parent_gateway_id,is_enabled,verification_status,created_at,updated_at,mikrotik_gateways(gateway_name)').single();
        if (error) return res.status(400).json({ error: error.code === '23505' ? 'That router IP or MAC address is already registered.' : 'Router could not be saved.' });
        return res.status(201).json(data);
      }
      const id = String(req.body?.id || '');
      if (!uuidPattern.test(id)) return res.status(400).json({ error: 'Invalid router record.' });
      const { data, error } = await db.from('wifi_router_registry').update({ ...values, updated_at: new Date().toISOString() }).eq('id', id).select('id,router_name,router_mac,router_ip,connection_type,operating_mode,parent_gateway_id,is_enabled,verification_status,created_at,updated_at,mikrotik_gateways(gateway_name)').maybeSingle();
      if (error) return res.status(400).json({ error: error.code === '23505' ? 'That router IP or MAC address is already registered.' : 'Router could not be saved.' });
      if (!data) return res.status(404).json({ error: 'Router record not found.' });
      return res.status(200).json(data);
    } catch {
      return res.status(503).json({ error: 'MikroTik gateway inventory is not configured.' });
    }
  }

  const id = String(req.query?.id || '');
  if (!uuidPattern.test(id)) return res.status(400).json({ error: 'Invalid router record.' });
  const { data, error } = await db.from('wifi_router_registry').delete().eq('id', id).select('id').maybeSingle();
  if (error) return res.status(500).json({ error: 'Router record could not be removed.' });
  if (!data) return res.status(404).json({ error: 'Router record not found.' });
  return res.status(200).json({ removed: true });
}

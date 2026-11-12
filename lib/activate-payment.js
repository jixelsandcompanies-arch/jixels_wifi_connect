import { expiryFrom } from './packages.js';
import { isMikrotikAgentMode, queueMikrotikRouterCommand, queueOpenNdsAuth } from './gateway.js';

export async function activateConfirmedPayment(db, payment, payload = payment.raw_callback || {}) {
  const start = payment.confirmed_at ? new Date(payment.confirmed_at) : new Date();
  const expiry = expiryFrom(payment.wifi_packages, start);
  if (payment.status === 'PENDING') {
    const { error } = await db.from('payments').update({ status: 'SUCCESS', mpesa_receipt_number: payload.receipt || null, raw_callback: payload, confirmed_at: start.toISOString() }).eq('id', payment.id).eq('status', 'PENDING');
    if (error) throw error;
  }

  let { data: session } = await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle();
  if (!session) {
    const { data, error } = await db.from('wifi_sessions').insert({ payment_id: payment.id, phone: payment.phone, package_id: payment.package_id, mac_address: payment.mac_address, start_time: start.toISOString(), expiry_time: expiry.toISOString(), session_status: 'WAITING_GATEWAY' }).select().single();
    if (error) session = (await db.from('wifi_sessions').select('*').eq('payment_id', payment.id).maybeSingle()).data;
    else session = data;
  }
  if (!session) throw new Error('Could not create or load the paid Wi-Fi session');
  if (['ACTIVE', 'EXPIRED', 'REVOKED'].includes(session.session_status)) return session;
  if (session.session_status === 'GATEWAY_FAILED') {
    const { error } = await db.from('wifi_sessions').update({ session_status: 'WAITING_GATEWAY' }).eq('id', session.id).eq('session_status', 'GATEWAY_FAILED');
    if (error) throw error;
    session.session_status = 'WAITING_GATEWAY';
  }

  try {
    let grant;
    if (payment.mikrotik_portal_context_id) {
      if (!isMikrotikAgentMode()) throw new Error('MikroTik agent mode is not configured');
      const { data: context } = await db.from('mikrotik_portal_contexts').select('gateway_id,mac_address,client_ip').eq('id', payment.mikrotik_portal_context_id).single();
      if (!context) throw new Error('Missing MikroTik hotspot context');
      grant = await queueMikrotikRouterCommand({ sessionId: session.id, gatewayId: context.gateway_id, macAddress: context.mac_address, clientIp: context.client_ip, action: 'ALLOW', durationMinutes: payment.wifi_packages.duration_minutes });
    } else {
      const { data: context } = await db.from('opennds_portal_contexts').select('hid').eq('id', payment.portal_context_id).single();
      if (!context) throw new Error('Missing openNDS gateway context');
      grant = await queueOpenNdsAuth({ sessionId: session.id, hid: context.hid, durationMinutes: payment.wifi_packages.duration_minutes });
    }
    const { error } = await db.from('wifi_sessions').update({ gateway_reference: grant.gatewayReference }).eq('id', session.id);
    if (error) throw error;
    return session;
  } catch (error) {
    await db.from('wifi_sessions').update({ session_status: 'GATEWAY_FAILED' }).eq('id', session.id).eq('session_status', 'WAITING_GATEWAY');
    throw error;
  }
}

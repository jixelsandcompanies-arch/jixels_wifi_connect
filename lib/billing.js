import { expiryFrom } from './packages.js';
export async function activatePaidSession({ db, gateway, checkoutRequestId, receipt, confirmed = true, paidAt = new Date() }) {
  if (!confirmed) throw new Error('Payment confirmation is required');
  const existing = await db.findSessionByReceipt(receipt);
  if (existing) return { session: existing, duplicate: true };
  const pending = await db.findPendingPayment(checkoutRequestId);
  if (!pending || pending.status !== 'PENDING') throw new Error('Payment is not pending');
  const startsAt = paidAt, expiresAt = expiryFrom(pending.package, startsAt);
  const session = await db.createActiveSession({ ...pending, receipt, startsAt, expiresAt });
  try { const grant = await gateway.grantAccess({ sessionId: session.id, macAddress: pending.mac_address, expiresAt }); await db.setGatewayReference(session.id, grant.gatewayReference); return { session: { ...session, gateway_reference: grant.gatewayReference }, duplicate: false }; }
  catch (error) { await db.markGatewayFailed(session.id, error.message); throw error; }
}

import { supabase } from '../../lib/supabase.js';
import { requireAdmin } from '../../lib/admin-auth.js';
import { activate } from '../cloudpay/webhook.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const receiptPattern = /^[A-Z0-9]{8,16}$/;

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  return digits;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const db = supabase();
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const { data, error } = await db.from('payments')
      .select('id,phone,amount_kes,status,created_at,checkout_request_id,mpesa_receipt_number,wifi_packages(name),wifi_sessions(session_status,expiry_time)')
      .in('status', ['PENDING', 'FAILED'])
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      console.error('Admin payment review list failed', { code: error.code, message: error.message });
      return res.status(503).json({ error: 'Payments needing review could not be loaded.' });
    }
    return res.status(200).json({ payments: data || [] });
  }

  const paymentId = String(req.body?.paymentId || '');
  const receipt = String(req.body?.receipt || '').trim().toUpperCase();
  const note = String(req.body?.verificationNote || '').trim().slice(0, 300);
  if (!uuidPattern.test(paymentId)) return res.status(400).json({ error: 'Select a valid payment.' });
  if (!receiptPattern.test(receipt)) return res.status(400).json({ error: 'Enter the M-Pesa receipt code from the transaction statement.' });
  if (note.length < 8) return res.status(400).json({ error: 'Add a short note about where you verified the payment.' });
  if (req.body?.confirmedPaid !== true) return res.status(400).json({ error: 'Confirm that the receipt, amount, and phone match the payment statement.' });

  const { data: payment, error: lookupError } = await db.from('payments')
    .select('*,wifi_packages(*)')
    .eq('id', paymentId)
    .maybeSingle();
  if (lookupError || !payment) return res.status(404).json({ error: 'Payment record not found.' });
  if (!['PENDING', 'FAILED'].includes(payment.status)) return res.status(409).json({ error: 'Only pending or failed payments can be manually reconciled.' });
  if (normalizePhone(payment.phone) !== normalizePhone(req.body?.verifiedPhone)) return res.status(400).json({ error: 'The verified phone number does not match this payment.' });
  if (Number(req.body?.verifiedAmount) !== Number(payment.amount_kes)) return res.status(400).json({ error: 'The verified amount does not match this payment.' });

  const { data: receiptOwner, error: receiptLookupError } = await db.from('payments')
    .select('id')
    .eq('mpesa_receipt_number', receipt)
    .neq('id', payment.id)
    .maybeSingle();
  if (receiptLookupError) return res.status(503).json({ error: 'Could not verify whether this receipt was already used.' });
  if (receiptOwner) return res.status(409).json({ error: 'That M-Pesa receipt is already linked to another payment.' });

  const confirmedAt = payment.confirmed_at || new Date().toISOString();
  const previousStatus = payment.status;
  const priorRaw = payment.raw_callback && typeof payment.raw_callback === 'object' && !Array.isArray(payment.raw_callback)
    ? payment.raw_callback : {};
  const { data: updated, error: updateError } = await db.from('payments').update({
    status: 'SUCCESS',
    mpesa_receipt_number: receipt,
    confirmed_at: confirmedAt,
    raw_callback: {
      ...priorRaw,
      admin_verification: {
        verified_by: admin.id,
        verified_at: new Date().toISOString(),
        previous_status: previousStatus,
        receipt,
        verified_amount_kes: Number(payment.amount_kes),
        verified_phone: normalizePhone(payment.phone),
        note
      }
    }
  }).eq('id', payment.id).in('status', ['PENDING', 'FAILED']).select('id').maybeSingle();
  if (updateError) {
    console.error('Admin payment reconciliation failed', { paymentId: payment.id, code: updateError.code, message: updateError.message });
    return res.status(updateError.code === '23505' ? 409 : 503).json({ error: updateError.code === '23505' ? 'That receipt is already linked to another payment.' : 'Payment could not be reconciled.' });
  }
  if (!updated) return res.status(409).json({ error: 'Payment status changed while it was being reviewed. Refresh and check the latest status.' });

  const confirmedPayment = { ...payment, status: 'SUCCESS', mpesa_receipt_number: receipt, confirmed_at: confirmedAt };
  await activate(db, confirmedPayment, { receipt, source: 'admin_verified' });
  const { data: session, error: sessionError } = await db.from('wifi_sessions')
    .select('session_status,expiry_time')
    .eq('payment_id', payment.id)
    .maybeSingle();
  if (sessionError || !session) {
    console.error('Admin-confirmed payment has no Wi-Fi session yet', { paymentId: payment.id, code: sessionError?.code, message: sessionError?.message });
    return res.status(202).json({ paymentStatus: 'SUCCESS', sessionStatus: 'WAITING_GATEWAY', message: 'Payment recorded; Wi-Fi authorization is still pending.' });
  }
  return res.status(202).json({
    paymentStatus: 'SUCCESS',
    sessionStatus: session.session_status,
    expiresAt: session.expiry_time,
    message: session.session_status === 'ACTIVE'
      ? 'Payment verified and Wi-Fi access is active.'
      : 'Payment verified; Wi-Fi authorization is queued and waiting for the MikroTik agent.'
  });
}

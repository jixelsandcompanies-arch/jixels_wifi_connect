// Legacy unsigned callback endpoint retired. CloudPay payments are accepted
// only through /api/cloudpay/webhook after raw-body signature verification.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  return res.status(410).json({ error: 'This callback endpoint has been retired. Use the signed CloudPay webhook.' });
}

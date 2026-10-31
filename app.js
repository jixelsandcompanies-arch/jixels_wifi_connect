const grid = document.querySelector('#planGrid');
const modal = document.querySelector('#purchaseModal');
const fmt = n => `KSh ${Number(n).toLocaleString('en-KE')}`;
const duration = m => m === 90 ? '1 hour 30 minutes' : m >= 1440 ? `${m / 1440} days` : m >= 60 ? `${m / 60} hours` : `${m} minutes`;
let selected, portalToken = null;
const params = new URLSearchParams(location.search);
const fas = params.get('fas');
if (fas) {
  history.replaceState({}, '', location.pathname);
  fetch('/api/opennds/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fas }) })
    .then(async r => { const body = await r.json(); if (!r.ok) throw new Error(body.error || 'Hotspot session could not be verified'); portalToken = body.portalToken; })
    .catch(error => { portalError = error.message; });
}
let portalError = null;
function open(p) {
  selected = p;
  document.querySelectorAll('.plan').forEach(card => card.classList.toggle('selected', card.dataset.packageId === p.id));
  document.querySelector('#modalName').textContent = p.name;
  document.querySelector('#modalPrice').textContent = fmt(p.price_kes);
  document.querySelector('#modalDescription').textContent = `Internet access for ${duration(p.duration_minutes)}`;
  document.querySelector('#modalPay').textContent = `Pay ${fmt(p.price_kes)}`;
  document.querySelector('#modalStatus').textContent = 'Your M-Pesa PIN is entered only in the official prompt on your phone — never here.';
  modal.showModal();
}
function render(plans) {
  grid.replaceChildren();
  if (!plans.length) { grid.innerHTML = '<p>No internet packages are available right now. Please contact the Wi-Fi administrator.</p>'; return; }
  plans.forEach((p, i) => {
    const card = document.createElement('article'); card.dataset.packageId = p.id; card.tabIndex = 0; card.className = `plan ${p.is_popular ? 'popular' : ''} ${p.is_best_value ? 'best' : ''}`;
    card.innerHTML = `${p.is_popular ? '<span>POPULAR</span>' : ''}${p.is_best_value ? '<span>BEST VALUE</span>' : ''}<i aria-hidden="true">${['◷','◴','◮','☼','◔','▣','▤','▦'][i % 8]}</i><h3></h3><b>${fmt(p.price_kes)}</b><p>◷ ${duration(p.duration_minutes)}</p><button type="button">Buy Now</button>`;
    card.querySelector('h3').textContent = p.name; card.onclick = () => open(p); card.onkeydown = e => { if (e.key === 'Enter') open(p); }; grid.append(card);
  });
}
async function load() {
  try { const r = await fetch('/api/packages'); if (!r.ok) throw new Error(); render(await r.json()); }
  catch { grid.innerHTML = '<p>Packages could not be loaded. Check your connection and try again.</p>'; }
}
load();
document.querySelector('.close').onclick = () => modal.close();
document.querySelector('#modalPay').onclick = async () => {
  const status = document.querySelector('#modalStatus');
  if (portalError || !portalToken) { status.textContent = portalError || 'Connect to Jixels Wi-Fi to start a secure checkout.'; return; }
  const phone = document.querySelector('#modalPhone').value.trim().replace(/[\s-]/g, '');
  if (!/^(?:0(?:1|7)\d{8}|254(?:1|7)\d{8})$/.test(phone)) { status.textContent = 'Enter a valid Kenyan M-Pesa number, starting with 01 or 07.'; return; }
  status.textContent = 'Starting your M-Pesa request…';
  try {
    const r = await fetch('/api/mpesa/initiate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: selected.id, phone, portalToken }) });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error || 'Could not start payment.');
    status.textContent = 'Check your phone for the M-Pesa prompt. Approve it to activate your internet package.';
    document.querySelector('#modalPay').disabled = true;
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const check = await fetch(`/api/opennds/status?token=${encodeURIComponent(result.statusToken)}`, { cache: 'no-store' });
      if (!check.ok) continue;
      const state = await check.json();
      if (state.status === 'FAILED') { status.textContent = 'Payment was not completed. You can try again.'; break; }
      if (state.status === 'SUCCESS' && state.session === 'ACTIVE') { status.textContent = 'Payment confirmed. Your Wi-Fi is now active.'; break; }
      if (state.status === 'SUCCESS' && state.session === 'GATEWAY_FAILED') { status.textContent = 'Payment was received, but this hotspot could not activate your device. Contact the Wi-Fi administrator with your payment message.'; break; }
      if (state.status === 'SUCCESS') status.textContent = 'Payment confirmed. Connecting your device to Wi-Fi…';
    }
    document.querySelector('#modalPay').disabled = false;
  } catch (error) { document.querySelector('#modalPay').disabled = false; status.textContent = error.message || 'We could not start the payment. Please try again.'; }
};

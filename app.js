const grid = document.querySelector('#planGrid');
const modal = document.querySelector('#purchaseModal');
const fmt = value => `KSh ${Number(value).toLocaleString('en-KE')}`;
const duration = minutes => minutes === 90 ? '1 hour 30 minutes' : minutes >= 1440 ? `${minutes / 1440} days` : minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`;
let selected, portalToken = null, portalError = null, portalReady = Promise.resolve();

const params = new URLSearchParams(location.search);
const fas = params.get('fas');
if (fas) {
  history.replaceState({}, '', location.pathname);
  portalReady = fetch('/api/opennds/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fas }) })
    .then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Hotspot session could not be verified.');
      portalToken = result.portalToken;
    })
    .catch(error => { portalError = error.message; });
}

function openPackage(item) {
  selected = item;
  document.querySelectorAll('.plan').forEach(card => card.classList.toggle('selected', card.dataset.packageId === item.id));
  document.querySelector('#modalName').textContent = item.name;
  document.querySelector('#modalPrice').textContent = fmt(item.price_kes);
  document.querySelector('#modalDescription').textContent = `Internet access for ${duration(item.duration_minutes)}`;
  document.querySelector('#modalPay').textContent = `Pay ${fmt(item.price_kes)}`;
  document.querySelector('#modalStatus').textContent = 'Enter your M-Pesa PIN only in the official prompt on your phone. Never share it here.';
  modal.showModal();
}

function renderPackages(packages) {
  grid.replaceChildren();
  if (!packages.length) {
    grid.innerHTML = '<p>No internet packages are available right now. Please contact the Wi-Fi administrator.</p>';
    return;
  }
  packages.forEach(item => {
    const card = document.createElement('article');
    card.dataset.packageId = item.id;
    card.tabIndex = 0;
    card.className = `plan ${item.is_popular ? 'popular' : ''} ${item.is_best_value ? 'best' : ''}`;
    card.innerHTML = `${item.is_popular ? '<span>POPULAR</span>' : ''}${item.is_best_value ? '<span>BEST VALUE</span>' : ''}<i aria-hidden="true">Wi-Fi</i><h3></h3><b>${fmt(item.price_kes)}</b><p>${duration(item.duration_minutes)}</p><button type="button">Buy Now</button>`;
    card.querySelector('h3').textContent = item.name;
    card.onclick = () => openPackage(item);
    card.onkeydown = event => { if (event.key === 'Enter') openPackage(item); };
    grid.append(card);
  });
}

async function loadPackages() {
  try {
    const response = await fetch('/api/packages');
    if (!response.ok) throw new Error('Packages could not be loaded.');
    renderPackages(await response.json());
  } catch {
    grid.innerHTML = '<p>Packages could not be loaded. Check your connection and try again.</p>';
  }
}

document.querySelector('.close').onclick = () => modal.close();
loadPackages();

document.querySelector('#modalPay').onclick = async () => {
  const status = document.querySelector('#modalStatus');
  const payButton = document.querySelector('#modalPay');
  payButton.disabled = true;
  status.textContent = 'Verifying the connected Wi-Fi device...';
  await portalReady;
  if (portalError) { status.textContent = portalError; payButton.disabled = false; return; }
  if (!portalToken) { status.textContent = 'Join Barrio- HOTSPOT and open its sign-in page to buy access for this device.'; payButton.disabled = false; return; }
  const phone = document.querySelector('#modalPhone').value.trim().replace(/[\s-]/g, '');
  if (!/^(?:0(?:1|7)\d{8}|254(?:1|7)\d{8})$/.test(phone)) {
    status.textContent = 'Enter a valid Kenyan M-Pesa number, starting with 01 or 07.';
    payButton.disabled = false;
    return;
  }
  status.textContent = 'Starting your M-Pesa request...';
  try {
    const response = await fetch('/api/mpesa/initiate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: selected.id, phone, portalToken }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start payment.');
    status.textContent = 'Check your phone for the M-Pesa prompt. Approve it to activate your internet package.';
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const check = await fetch(`/api/opennds/status?token=${encodeURIComponent(result.statusToken)}`, { cache: 'no-store' });
      if (!check.ok) continue;
      const state = await check.json();
      if (state.status === 'FAILED') { status.textContent = 'Payment was not completed. You can try again.'; break; }
      if (state.status === 'SUCCESS' && state.session === 'ACTIVE') { status.textContent = 'Payment confirmed. Your Wi-Fi is now active.'; break; }
      if (state.status === 'SUCCESS' && state.session === 'GATEWAY_FAILED') { status.textContent = 'Payment was received, but this hotspot could not activate your device. Contact the Wi-Fi administrator with your payment message.'; break; }
      if (state.status === 'SUCCESS') status.textContent = 'Payment confirmed. Connecting your device to Wi-Fi...';
    }
  } catch (error) {
    status.textContent = error.message || 'We could not start the payment. Please try again.';
  } finally {
    payButton.disabled = false;
  }
};

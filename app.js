const grid = document.querySelector('#planGrid');
const modal = document.querySelector('#purchaseModal');
const fmt = value => `KSh ${Number(value).toLocaleString('en-KE')}`;
const duration = minutes => minutes === 90 ? '1 hour 30 minutes' : minutes >= 1440 ? `${minutes / 1440} days` : minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`;
let selected, portalToken = null, portalError = null, portalReady = Promise.resolve();
let paymentState = 'idle';

function setPaymentStatus(message, loading = false) {
  document.querySelector('#modalStatusText').textContent = message;
  document.querySelector('#modalStatus').setAttribute('aria-busy', String(loading));
  const button = document.querySelector('#modalPay');
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', String(loading));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const params = new URLSearchParams(location.search);
const fas = params.get('fas');
const mikrotikPortal = params.get('gateway') === 'mikrotik';
if (fas) {
  history.replaceState({}, '', location.pathname);
  portalReady = fetchWithTimeout('/api/opennds/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fas }) })
    .then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Hotspot session could not be verified.');
      portalToken = result.portalToken;
    })
    .catch(error => { portalError = error.name === 'AbortError' ? 'The hotspot check timed out. Reopen the captive portal and try again.' : error.message; });
} else if (mikrotikPortal) {
  const clientMac = params.get('clientmac');
  const clientIp = params.get('clientip');
  history.replaceState({}, '', location.pathname);
  portalReady = fetchWithTimeout('/api/mikrotik/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientMac, clientIp }) })
    .then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The MikroTik hotspot could not verify this device.');
      portalToken = result.portalToken;
    })
    .catch(error => { portalError = error.name === 'AbortError' ? 'The hotspot check timed out. Reopen the captive portal and try again.' : error.message; });
}

function openPackage(item) {
  selected = item;
  document.querySelectorAll('.plan').forEach(card => card.classList.toggle('selected', card.dataset.packageId === item.id));
  document.querySelector('#modalName').textContent = item.name;
  document.querySelector('#modalPrice').textContent = fmt(item.price_kes);
  document.querySelector('#modalDescription').textContent = `Internet access for ${duration(item.duration_minutes)}`;
  const payButton = document.querySelector('#modalPay');
  if (paymentState === 'idle') {
    payButton.disabled = false;
    payButton.textContent = `Pay ${fmt(item.price_kes)}`;
    setPaymentStatus('Enter your M-Pesa PIN only in the official prompt on your phone. Never share it here.');
  } else {
    payButton.disabled = true;
    payButton.textContent = paymentState === 'pending' || paymentState === 'starting' ? 'Payment in progress' : paymentState === 'confirmed' ? 'Payment confirmed' : 'Payment already submitted';
  }
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
    const badge = item.is_popular ? 'Popular' : item.is_best_value ? 'Best value' : '';
    card.innerHTML = `${badge ? `<span>${badge}</span>` : ''}<i aria-hidden="true">Wi-Fi</i><h3></h3><b>${fmt(item.price_kes)}</b><p>${duration(item.duration_minutes)}</p><button type="button">Buy Now</button>`;
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

document.querySelector('.close').addEventListener('click', () => modal.close());
loadPackages();

document.querySelector('#paymentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const payButton = document.querySelector('#modalPay');
  if (paymentState !== 'idle') {
    setPaymentStatus(paymentState === 'pending' || paymentState === 'starting' || paymentState === 'verifying'
      ? 'A payment request is already being processed. Check your phone and wait for its result.'
      : 'This checkout attempt has already been used. Reopen the hotspot sign-in page to try again.');
    return;
  }
  paymentState = 'verifying';
  payButton.disabled = true;
  payButton.textContent = 'Checking device…';
  setPaymentStatus('Verifying the connected Wi-Fi device...', true);
  const phone = document.querySelector('#modalPhone').value.trim().replace(/[\s-]/g, '');
  const restorePayButton = message => {
    paymentState = 'idle';
    setPaymentStatus(message);
    payButton.textContent = selected ? `Pay ${fmt(selected.price_kes)}` : 'Choose a package';
    payButton.disabled = false;
  };
  if (!selected) { restorePayButton('Select an internet package before paying.'); return; }
  if (!/^(?:0(?:1|7)\d{8}|254(?:1|7)\d{8})$/.test(phone)) {
    restorePayButton('Enter a valid Kenyan M-Pesa number, starting with 01 or 07.');
    document.querySelector('#modalPhone').focus();
    return;
  }
  await portalReady;
  if (portalError) { restorePayButton(portalError); return; }
  if (!portalToken) { restorePayButton('Join Barrio- HOTSPOT and open its sign-in page to buy access for this device.'); return; }
  paymentState = 'starting';
  payButton.textContent = 'Starting payment...';
  setPaymentStatus('Starting your M-Pesa request...', true);
  try {
    const response = await fetchWithTimeout('/api/payments/initiate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: selected.id, phone, portalToken }) }, 20000);
    let result = {};
    try { result = await response.json(); } catch { /* preserve the HTTP result for safe retry handling */ }
    if (!response.ok) {
      const message = result.error || 'Could not start payment.';
      if (response.status < 500 || response.status === 503) {
        restorePayButton(message);
        return;
      }
      paymentState = 'uncertain';
      payButton.textContent = 'Check payment status';
      setPaymentStatus(`${message} Check your phone before trying again. Do not submit another payment until you know whether this request started.`);
      return;
    }
    paymentState = 'pending';
    payButton.textContent = 'Payment in progress';
    setPaymentStatus('Check your phone for the M-Pesa prompt. Approve it to activate your internet package.', true);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      let check;
      try { check = await fetchWithTimeout(`/api/payments/status?token=${encodeURIComponent(result.statusToken)}`, { cache: 'no-store' }, 10000); }
      catch { continue; }
      if (!check.ok) continue;
      const state = await check.json();
      if (state.status === 'FAILED') {
        paymentState = 'failed';
        payButton.textContent = 'Payment not completed';
        setPaymentStatus('Payment was not completed. Reopen the hotspot sign-in page before starting another attempt.');
        break;
      }
      if (state.status === 'SUCCESS' && state.session === 'ACTIVE' && state.mikrotikLogin) {
        paymentState = 'confirmed';
        payButton.textContent = 'Payment confirmed';
        setPaymentStatus('Payment confirmed. Signing this device in to the hotspot...');
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = state.mikrotikLogin.url;
        for (const [name, value] of Object.entries({ username: state.mikrotikLogin.username, password: state.mikrotikLogin.password, dst: `${location.origin}/?connected=1` })) {
          const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
        }
        document.body.append(form);
        form.submit();
        break;
      }
      if (state.status === 'SUCCESS' && state.session === 'ACTIVE') {
        paymentState = 'confirmed';
        payButton.textContent = 'Payment confirmed';
        setPaymentStatus('Payment confirmed. Your Wi-Fi is now active.');
        break;
      }
      if (state.status === 'SUCCESS' && state.session === 'GATEWAY_FAILED') {
        paymentState = 'activation_failed';
        payButton.textContent = 'Payment received';
        setPaymentStatus('Payment was received, but this hotspot could not activate your device. Contact support with your payment message.');
        break;
      }
      if (state.status === 'SUCCESS') setPaymentStatus('Payment confirmed. Connecting your device to Wi-Fi...', true);
    }
    if (paymentState === 'pending') {
      paymentState = 'timeout';
      payButton.textContent = 'Payment submitted';
      setPaymentStatus('This payment is still being confirmed. Do not submit another payment. If Wi-Fi does not activate, contact support with your M-Pesa message.');
    }
  } catch (error) {
    paymentState = 'uncertain';
    payButton.textContent = 'Check payment status';
    setPaymentStatus('We could not confirm whether the payment request started. Check your phone and do not submit another payment until you know its status.');
  } finally {
    payButton.disabled = paymentState !== 'idle';
  }
});

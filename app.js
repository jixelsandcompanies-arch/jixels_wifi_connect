const grid = document.querySelector('#planGrid');
const modal = document.querySelector('#purchaseModal');
const fmt = value => `KSh ${Number(value).toLocaleString('en-KE')}`;
const duration = minutes => minutes === 90 ? '1 hour 30 minutes' : minutes >= 1440 ? `${minutes / 1440} days` : minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`;
let selected, portalToken = null, portalRequest = null, activeStatusToken = null, checkingPaymentStatus = false;
let paymentState = 'idle';

function setPaymentStatus(message, loading = false) {
  document.querySelector('#modalStatusText').textContent = message;
  document.querySelector('#modalStatus').setAttribute('aria-busy', String(loading));
  const button = document.querySelector('#modalPay');
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', String(loading));
}

function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return '254' + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
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
  portalRequest = { url: '/api/opennds/context', body: { fas } };
} else if (mikrotikPortal) {
  const clientMac = params.get('clientmac');
  const clientIp = params.get('clientip');
  history.replaceState({}, '', location.pathname);
  portalRequest = { url: '/api/mikrotik/context', body: { clientMac, clientIp } };
}

async function createPortalContext() {
  if (!portalRequest) throw new Error('Join Barrio- HOTSPOT and open its sign-in page to buy access for this device.');
  const response = await fetchWithTimeout(portalRequest.url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(portalRequest.body)
  }, 15000);
  let result = {};
  try { result = await response.json(); } catch { /* display a safe context error below */ }
  if (!response.ok || !result.portalToken) throw new Error(result.error || 'The hotspot could not verify this device. Reopen its sign-in page and try again.');
  portalToken = result.portalToken;
  return portalToken;
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
  } else if (paymentState === 'timeout' && activeStatusToken) {
    payButton.disabled = false;
    payButton.textContent = 'Check payment status';
    setPaymentStatus('This payment has not been confirmed yet. Check its status before starting another payment.');
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
    const buyButton = card.querySelector('button');
    buyButton.onclick = event => {
      event.stopPropagation();
      openPackage(item);
    };
    card.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPackage(item);
      }
    };
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
document.querySelector('#modalChoosePackage').addEventListener('click', () => modal.close());
loadPackages();

const paymentForm = document.querySelector('#paymentForm');
const payButton = document.querySelector('#modalPay');
async function checkPaymentStatus(maxWaitMs = 0) {
  if (!activeStatusToken || checkingPaymentStatus) return;
  checkingPaymentStatus = true;
  paymentState = 'pending';
  payButton.disabled = true;
  payButton.textContent = 'Checking payment...';
  setPaymentStatus('Checking the payment result. Do not pay again while it is pending.', true);
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  try {
    do {
      try {
        const response = await fetchWithTimeout(`/api/payments/status?token=${encodeURIComponent(activeStatusToken)}`, { cache: 'no-store' }, 10000);
        if (response.ok) {
          const state = await response.json();
          if (state.status === 'FAILED') {
            activeStatusToken = null;
            paymentState = 'idle';
            payButton.textContent = selected ? `Pay ${fmt(selected.price_kes)}` : 'Choose a package';
            setPaymentStatus('This payment was not completed. You can retry this package or choose another one below. You can stay on this page.');
            return;
          }
          if (state.status === 'SUCCESS' && state.session === 'ACTIVE') {
            activeStatusToken = null;
            paymentState = 'confirmed';
            payButton.textContent = 'Payment confirmed';
            setPaymentStatus('Payment confirmed. Your Wi-Fi is now active.');
            return;
          }
          if (state.status === 'SUCCESS' && state.session === 'GATEWAY_FAILED') {
            activeStatusToken = null;
            paymentState = 'activation_failed';
            payButton.textContent = 'Payment received';
            setPaymentStatus('Payment was received, but this hotspot could not activate your device. Do not pay again. Contact support with your M-Pesa message.');
            return;
          }
          if (state.status === 'SUCCESS') setPaymentStatus('Payment confirmed. Connecting your device to Wi-Fi...', true);
        }
      } catch { /* try again during the short automatic check window */ }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(5000, deadline - Date.now())));
    } while (Date.now() <= deadline);
    paymentState = 'timeout';
    payButton.textContent = 'Check payment status';
    setPaymentStatus('Still waiting for confirmation. Tap Check payment status to check again. Do not start another payment while this one is pending.');
  } finally {
    checkingPaymentStatus = false;
    payButton.disabled = !['idle', 'timeout'].includes(paymentState);
  }
}

const handlePaymentSubmit = async event => {
  event.preventDefault();
  console.log('Pay clicked');
  if (paymentState === 'timeout' && activeStatusToken) {
    await checkPaymentStatus(0);
    return;
  }
  if (paymentState !== 'idle') {
    setPaymentStatus(paymentState === 'pending' || paymentState === 'starting' || paymentState === 'verifying'
      ? 'A payment request is already being processed. Check your phone and wait for its result.'
      : 'This payment has already been submitted. Do not pay again; check its status or contact support.');
    return;
  }
  paymentState = 'verifying';
  payButton.disabled = true;
  payButton.textContent = 'Checking device...';
  setPaymentStatus('Verifying the connected Wi-Fi device...', true);
  const phone = normalizeKenyanPhone(document.querySelector('#modalPhone').value);
  console.log('Phone normalized', phone || '(invalid)');
  const restorePayButton = message => {
    paymentState = 'idle';
    setPaymentStatus(message);
    payButton.textContent = selected ? `Pay ${fmt(selected.price_kes)}` : 'Choose a package';
    payButton.disabled = false;
  };
  if (!selected) { restorePayButton('Select an internet package before paying.'); return; }
  if (!phone) {
    restorePayButton('Enter a valid Kenyan M-Pesa number, starting with 01 or 07.');
    document.querySelector('#modalPhone').focus();
    return;
  }
  try { await createPortalContext(); }
  catch (error) { restorePayButton(error.message || 'The hotspot could not verify this device.'); return; }
  paymentState = 'starting';
  payButton.textContent = 'Sending STK...';
  setPaymentStatus('Sending STK...', true);
  try {
    console.log('Calling /api/pay');
    const response = await fetchWithTimeout('/api/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: selected.id, phone, amount: selected.price_kes, packageName: selected.name, portalToken }) }, 20000);
    let result = {};
    try { result = await response.json(); } catch { /* preserve the HTTP result for safe retry handling */ }
    console.log('API response', { status: response.status, ok: response.ok, body: result });
    if (!response.ok) {
      const message = result.error || 'Could not start payment.';
      if (result.status === 'FAILED' && result.statusToken) {
        activeStatusToken = result.statusToken;
        paymentState = 'pending';
        await checkPaymentStatus(0);
        return;
      }
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
    activeStatusToken = result.statusToken || null;
    if (!activeStatusToken) {
      paymentState = 'uncertain';
      payButton.textContent = 'Payment status unavailable';
      setPaymentStatus('The payment request was accepted but its status link is missing. Check your phone; do not pay again.');
      return;
    }
    payButton.textContent = 'Payment in progress';
    console.log('STK sent', result.checkoutRequestId);
    setPaymentStatus(result.error || 'Check your phone for STK Push - Enter PIN', true);
    await checkPaymentStatus(90000);
  } catch (error) {
    paymentState = 'uncertain';
    payButton.textContent = 'Check payment status';
    setPaymentStatus('We could not confirm whether the payment request started. Check your phone and do not submit another payment until you know its status.');
  } finally {
    payButton.disabled = !['idle', 'timeout'].includes(paymentState);
  }
};

// Some captive portal webviews swallow the form's submit event on a button tap.
// Handle the tap itself and cancel its default submit; keep submit for keyboard users.
paymentForm.addEventListener('submit', handlePaymentSubmit);
payButton.addEventListener('click', event => {
  event.preventDefault();
  handlePaymentSubmit(event);
});

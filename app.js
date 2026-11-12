const grid = document.querySelector('#planGrid');
const modal = document.querySelector('#purchaseModal');
const fmt = value => `KSh ${Number(value).toLocaleString('en-KE')}`;
const duration = minutes => minutes === 90 ? '1 hour 30 minutes' : minutes >= 1440 ? `${minutes / 1440} days` : minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`;
let selected, portalToken = null, portalError = null, portalReady = Promise.resolve();
let paymentState = 'idle';
let recoveryMode = false;

function announceConnected(message = 'Wi-Fi access is active on this device. Reconnect to Barrio- HOTSPOT if internet does not start automatically.') {
  const notice = document.querySelector('#connectionNotice');
  if (notice) { notice.textContent = message; notice.hidden = false; }
  modal.close();
  document.querySelector('#planGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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
  recoveryMode = false;
  const receiptLabel = document.querySelector('#modalReceiptLabel');
  if (receiptLabel) receiptLabel.hidden = true;
  const phoneLabel = document.querySelector('#modalPhone').closest?.('label');
  if (phoneLabel) phoneLabel.hidden = false;
  const choice = document.querySelector('.choice');
  if (choice) choice.hidden = false;
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

async function restorePaidAccess() {
  const payButton = document.querySelector('#modalPay');
  const phone = normalizeKenyanPhone(document.querySelector('#modalPhone').value);
  const receipt = document.querySelector('#modalReceipt').value.trim().toUpperCase();
  if (!phone) { setPaymentStatus('Enter the Kenyan M-Pesa phone number used for payment.'); return; }
  if (!/^[A-Z0-9]{6,20}$/.test(receipt)) { setPaymentStatus('Enter the M-Pesa receipt from your payment message.'); return; }
  payButton.disabled = true;
  payButton.textContent = 'Checking Wi-Fi access...';
  setPaymentStatus('Verifying your receipt and asking the hotspot to activate Wi-Fi...', true);
  await portalReady;
  if (portalError) { setPaymentStatus(portalError); payButton.disabled = false; payButton.textContent = 'Restore access'; return; }
  if (!portalToken) { setPaymentStatus('Reconnect to Barrio- HOTSPOT and open this page from its sign-in screen on the device that paid.'); payButton.disabled = false; payButton.textContent = 'Restore access'; return; }
  try {
    const response = await fetchWithTimeout('/api/payments/recover-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portalToken, phone, receipt })
    }, 10000);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not verify this payment.');
    if (result.sessionStatus === 'ACTIVE') {
      payButton.textContent = 'Wi-Fi active';
      announceConnected('The hotspot authorized this device for your paid session. Reconnect to Barrio- HOTSPOT. If internet still does not work, contact Wi-Fi support with your M-Pesa receipt.');
      return;
    }

    const statusToken = String(result.statusToken || '');
    if (!/^[a-f0-9]{64}$/.test(statusToken)) throw new Error('Payment verified, but the hotspot status check could not start. Try again shortly.');
    const deadline = Date.now() + 12000;
    let lastError = '';
    let attempt = 0;
    while (Date.now() < deadline) {
      if (attempt > 0) {
        setPaymentStatus('Payment verified. Waiting for the hotspot to confirm access; do not pay again.', true);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      attempt++;
      try {
        const check = await fetchWithTimeout(`/api/payments/status?token=${encodeURIComponent(statusToken)}`, { cache: 'no-store' }, 7000);
        const state = await check.json().catch(() => ({}));
        if (!check.ok) lastError = state.error || 'The hotspot status check is temporarily unavailable.';
        else if (state.status === 'SUCCESS' && state.session === 'ACTIVE') {
          payButton.textContent = 'Wi-Fi active';
          announceConnected('The hotspot authorized this device for your paid session. Reconnect to Barrio- HOTSPOT. If internet still does not work, contact Wi-Fi support with your M-Pesa receipt.');
          return;
        }
      } catch (statusError) {
        lastError = statusError.message || 'The hotspot status check is temporarily unavailable.';
      }
    }
    payButton.disabled = false;
    payButton.textContent = 'Check access again';
    setPaymentStatus(`Payment is verified, but the hotspot has not confirmed access yet. Your payment is safe; do not pay again. Press “Check access again” in a moment.${lastError ? ` (${lastError})` : ''}`, false);
  } catch (error) {
    setPaymentStatus(error.message || 'Could not restore access. Check the receipt and reconnect to the hotspot.');
    payButton.disabled = false;
    payButton.textContent = 'Restore access';
  }
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
document.querySelector('#changePackage')?.addEventListener('click', () => {
  if (['starting', 'pending'].includes(paymentState)) {
    setPaymentStatus('Wait for the payment result before changing packages. Do not submit another payment.');
    return;
  }
  modal.close();
  document.querySelector('#planGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
loadPackages();

const paymentForm = document.querySelector('#paymentForm');
const payButton = document.querySelector('#modalPay');
const handlePaymentSubmit = async event => {
  event.preventDefault();
  if (recoveryMode) { await restorePaidAccess(); return; }
  console.log('Pay clicked');
  if (paymentState !== 'idle') {
    setPaymentStatus(paymentState === 'pending' || paymentState === 'starting' || paymentState === 'verifying'
      ? 'A payment request is already being processed. Check your phone and wait for its result.'
      : 'This checkout attempt has already been used. Reopen the hotspot sign-in page to try again.');
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
  await portalReady;
  if (portalError) { restorePayButton(portalError); return; }
  if (!portalToken) { restorePayButton('Join Barrio- HOTSPOT and open its sign-in page to buy access for this device.'); return; }
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
    console.log('STK sent', result.checkoutRequestId);
    setPaymentStatus('Check your phone for STK Push - Enter PIN', true);
    const deadline = Date.now() + 30_000;
    let paymentConfirmed = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      let check;
      try { check = await fetchWithTimeout(`/api/payments/status?token=${encodeURIComponent(result.statusToken)}`, { cache: 'no-store' }, 10000); }
      catch { continue; }
      if (!check.ok) continue;
      const state = await check.json();
      if (state.status === 'SUCCESS') paymentConfirmed = true;
      if (state.status === 'FAILED') {
        paymentState = 'failed';
        payButton.textContent = 'Payment not completed';
        setPaymentStatus('Payment was not completed. Reopen the hotspot sign-in page before starting another attempt.');
        break;
      }
      if (state.status === 'SUCCESS' && state.session === 'ACTIVE') {
        paymentState = 'confirmed';
        payButton.textContent = 'Payment confirmed';
        announceConnected('Payment confirmed and the hotspot authorized this device for the paid session. Reconnect to Barrio- HOTSPOT. If internet still does not work, contact Wi-Fi support with your M-Pesa receipt.');
        break;
      }
      if (state.status === 'SUCCESS' && ['GATEWAY_FAILED', 'WAITING_GATEWAY'].includes(state.session)) {
        paymentState = 'pending';
        payButton.textContent = 'Payment received';
        setPaymentStatus('Payment is confirmed, but hotspot authorization is still pending. Do not pay again; use “Already paid? Restore access” to retry.', false);
        paymentState = 'activation_pending';
        break;
      }
      if (state.status === 'SUCCESS') setPaymentStatus('Payment is confirmed. The hotspot is applying access now...', true);
    }
    if (paymentState === 'pending') {
      paymentState = paymentConfirmed ? 'activation_pending' : 'timeout';
      payButton.textContent = paymentConfirmed ? 'Payment received' : 'Payment submitted';
      setPaymentStatus(paymentConfirmed
        ? 'Payment is confirmed, but the hotspot has not confirmed authorization. Use Already paid? Restore access to retry. Do not pay again.'
        : 'This payment is still being confirmed. Do not submit another payment. If Wi-Fi does not activate, contact support with your M-Pesa message.');
    }
  } catch (error) {
    paymentState = 'uncertain';
    payButton.textContent = 'Check payment status';
    setPaymentStatus('We could not confirm whether the payment request started. Check your phone and do not submit another payment until you know its status.');
  } finally {
    payButton.disabled = paymentState !== 'idle';
  }
};

// Some captive portal webviews swallow the form's submit event on a button tap.
// Handle the tap itself and cancel its default submit; keep submit for keyboard users.
paymentForm.addEventListener('submit', handlePaymentSubmit);
payButton.addEventListener('click', event => {
  event.preventDefault();
  handlePaymentSubmit(event);
});

document.querySelector('#restoreAccess')?.addEventListener('click', () => {
  recoveryMode = true;
  document.querySelector('#modalName').textContent = 'Restore paid Wi-Fi access';
  document.querySelector('#modalPrice').textContent = 'No new payment';
  document.querySelector('#modalDescription').textContent = 'Enter the phone number and M-Pesa receipt for the payment made on this device.';
  const choice = document.querySelector('.choice');
  if (choice) choice.hidden = true;
  document.querySelector('#modalReceiptLabel').hidden = false;
  document.querySelector('#modalPhone').closest('label').hidden = false;
  payButton.disabled = false;
  payButton.textContent = 'Restore access';
  setPaymentStatus('We will verify your receipt and this connected device. No new payment will be started.');
  modal.showModal();
});

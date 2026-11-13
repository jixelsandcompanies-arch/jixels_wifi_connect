import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Pay submit posts normalized phone after portal check and displays STK feedback', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const cards = [];
  const makeElement = () => ({ textContent: '', value: '', disabled: false, attributes: {}, dataset: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, callback) { listeners.set(this.id || name, callback); }, focus() {}, scrollIntoView() {} });
  const grid = { replaceChildren() { cards.length = 0; }, append(card) { cards.push(card); }, innerHTML: '' };
  const elements = new Map([
    ['#planGrid', grid], ['#purchaseModal', { showModal() {}, close() {} }], ['#modalName', makeElement()],
    ['#modalPrice', makeElement()], ['#modalDescription', makeElement()], ['#modalPhone', makeElement()],
    ['#modalPay', Object.assign(makeElement(), { id: 'modalPay' })], ['#modalStatus', makeElement()],
    ['#modalStatusText', makeElement()], ['#paymentForm', Object.assign(makeElement(), { id: 'paymentForm' })], ['.close', makeElement()]
  ]);
  const requests = [];
  const document = {
    querySelector(selector) { return elements.get(selector) || null; },
    querySelectorAll(selector) { return selector === '.plan' ? cards : []; },
    createElement(tag) { if (tag !== 'article') throw new Error(`Unexpected element ${tag}`); return { dataset: {}, classList: { toggle() {} }, querySelector: () => makeElement() }; },
    body: { append() {} }
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (url === '/api/packages') return { ok: true, json: async () => [{ id: 'pkg-1', name: '1 Hour', price_kes: 10, duration_minutes: 60 }] };
    if (url === '/api/mikrotik/context') return { ok: true, json: async () => ({ portalToken: 'a'.repeat(64) }) };
    if (url === '/api/pay') {
      queueMicrotask(() => { assert.equal(elements.get('#modalPay').textContent, 'Sending STK...'); });
      return { ok: true, status: 202, json: async () => ({ success: true, checkoutRequestId: 'cloud-ref-1', statusToken: 'b'.repeat(64) }) };
    }
    if (String(url).startsWith('/api/payments/status')) return { ok: true, json: async () => ({ status: 'FAILED' }) };
    throw new Error(`Unexpected request ${url}`);
  };
  runInNewContext(source, {
    document, fetch,
    location: { search: '?gateway=mikrotik&clientmac=aa:bb:cc:dd:ee:ff&clientip=192.0.2.1', origin: 'https://example.test', pathname: '/' },
    history: { replaceState() {} }, URLSearchParams, Date, setTimeout: (fn, delay) => setTimeout(fn, delay === 3000 ? 0 : delay), clearTimeout, AbortController, encodeURIComponent, console
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cards.length, 1);
  cards[0].onclick();
  elements.get('#modalPhone').value = '0115613332';
  const pending = listeners.get('paymentForm')({ preventDefault() {} });
  assert.equal(elements.get('#modalPay').textContent, 'Checking device...');
  assert.equal(elements.get('#modalPay').disabled, true);
  await pending;
  const pay = requests.find(request => request.url === '/api/pay');
  assert.ok(requests.some(request => request.url === '/api/packages'));
  assert.equal(pay.options.method, 'POST');
  assert.deepEqual(JSON.parse(pay.options.body), { packageId: 'pkg-1', phone: '254115613332', amount: 10, packageName: '1 Hour', portalToken: 'a'.repeat(64) });
  assert.match(elements.get('#modalStatusText').textContent, /Payment was not completed/);
  assert.ok(requests.some(request => request.url.startsWith('/api/payments/status')));
});

test('Already paid verifies the receipt once and polls status until access is active', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const makeElement = id => ({ id, textContent: '', value: '', hidden: false, disabled: false, attributes: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, callback) { listeners.set(this.id || name, callback); }, closest() { return makeElement('phoneLabel'); }, focus() {}, scrollIntoView() {} });
  const grid = { replaceChildren() {}, append() {}, scrollIntoView() {}, innerHTML: '' };
  const modal = { showModal() {}, close() { this.closed = true; } };
  const elements = new Map([
    ['#planGrid', grid], ['#purchaseModal', modal], ['#modalName', makeElement('modalName')],
    ['#modalPrice', makeElement('modalPrice')], ['#modalDescription', makeElement('modalDescription')],
    ['#modalPhone', makeElement('modalPhone')], ['#modalReceipt', makeElement('modalReceipt')],
    ['#modalReceiptLabel', makeElement('modalReceiptLabel')], ['#modalPay', makeElement('modalPay')],
    ['#modalStatus', makeElement('modalStatus')], ['#modalStatusText', makeElement('modalStatusText')],
    ['#paymentForm', makeElement('paymentForm')], ['#restoreAccess', makeElement('restoreAccess')],
    ['#connectionNotice', makeElement('connectionNotice')], ['.close', makeElement('close')],
    ['.choice', makeElement('choice')]
  ]);
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (url === '/api/packages') return { ok: true, json: async () => [] };
    if (url === '/api/mikrotik/context') return { ok: true, json: async () => ({ portalToken: 'a'.repeat(64) }) };
    if (url === '/api/payments/recover-login') return { ok: true, json: async () => ({ success: true, sessionStatus: 'WAITING_GATEWAY', statusToken: 'c'.repeat(64) }) };
    if (String(url).startsWith('/api/payments/status')) return { ok: true, json: async () => ({ status: 'SUCCESS', session: 'ACTIVE' }) };
    throw new Error(`Unexpected request ${url}`);
  };
  runInNewContext(source, {
    document: { querySelector(selector) { return elements.get(selector) || null; }, querySelectorAll() { return []; } },
    fetch, location: { search: '?gateway=mikrotik&clientmac=aa:bb:cc:dd:ee:ff&clientip=192.0.2.1', origin: 'https://example.test', pathname: '/' },
    history: { replaceState() {} }, URLSearchParams, Date, setTimeout: (fn, delay) => setTimeout(fn, delay === 3000 ? 0 : delay), clearTimeout, AbortController, encodeURIComponent, console
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  elements.get('#modalPhone').value = '0115613332';
  elements.get('#modalReceipt').value = 'ABC123456';
  listeners.get('restoreAccess')();
  await listeners.get('paymentForm')({ preventDefault() {} });
  assert.equal(requests.filter(request => request.url === '/api/payments/recover-login').length, 1);
  assert.equal(requests.filter(request => request.url.startsWith('/api/payments/status')).length, 1);
  assert.equal(elements.get('#connectionNotice').hidden, false);
  assert.equal(modal.closed, true);
});

test('Pay keeps polling while the MikroTik grant is waiting, then confirms access', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const makeElement = id => ({ id, textContent: '', value: '', hidden: true, disabled: false, attributes: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, callback) { listeners.set(this.id || name, callback); }, focus() {}, scrollIntoView() {} });
  const cards = [];
  const grid = { replaceChildren() { cards.length = 0; }, append(card) { cards.push(card); }, scrollIntoView() {}, innerHTML: '' };
  const modal = { showModal() {}, close() { this.closed = true; } };
  const elements = new Map([
    ['#planGrid', grid], ['#purchaseModal', modal], ['#modalName', makeElement('modalName')],
    ['#modalPrice', makeElement('modalPrice')], ['#modalDescription', makeElement('modalDescription')],
    ['#modalPhone', makeElement('modalPhone')], ['#modalPay', makeElement('modalPay')],
    ['#modalStatus', makeElement('modalStatus')], ['#modalStatusText', makeElement('modalStatusText')],
    ['#paymentForm', makeElement('paymentForm')], ['#connectionNotice', makeElement('connectionNotice')],
    ['.close', makeElement('close')]
  ]);
  let statusChecks = 0;
  const fetch = async url => {
    if (url === '/api/packages') return { ok: true, json: async () => [{ id: 'pkg-1', name: '1 Hour', price_kes: 10, duration_minutes: 60 }] };
    if (url === '/api/mikrotik/context') return { ok: true, json: async () => ({ portalToken: 'a'.repeat(64) }) };
    if (url === '/api/pay') return { ok: true, status: 202, json: async () => ({ success: true, checkoutRequestId: 'cloud-ref-1', statusToken: 'b'.repeat(64) }) };
    if (String(url).startsWith('/api/payments/status')) {
      statusChecks++;
      return { ok: true, json: async () => statusChecks === 1
        ? ({ status: 'SUCCESS', session: 'WAITING_GATEWAY' })
        : ({ status: 'SUCCESS', session: 'ACTIVE' }) };
    }
    throw new Error(`Unexpected request ${url}`);
  };
  runInNewContext(source, {
    document: { querySelector(selector) { return elements.get(selector) || null; }, querySelectorAll(selector) { return selector === '.plan' ? cards : []; }, createElement() { return { dataset: {}, classList: { toggle() {} }, querySelector: () => makeElement('buyButton') }; } },
    fetch, location: { search: '?gateway=mikrotik&clientmac=aa:bb:cc:dd:ee:ff&clientip=192.0.2.1', origin: 'https://example.test', pathname: '/' },
    history: { replaceState() {} }, URLSearchParams, Date, setTimeout: (fn, delay) => setTimeout(fn, delay === 3000 || delay === 1000 ? 0 : delay), clearTimeout, AbortController, encodeURIComponent, console
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  cards[0].onclick();
  elements.get('#modalPhone').value = '0115613332';
  await listeners.get('paymentForm')({ preventDefault() {} });
  assert.equal(statusChecks, 2);
  assert.equal(elements.get('#connectionNotice').hidden, false);
  assert.equal(modal.closed, true);
});

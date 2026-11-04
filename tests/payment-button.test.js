import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Pay form gives immediate feedback and a visible message when no hotspot token exists', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const cards = [];
  const makeElement = () => ({
    textContent: '', value: '', disabled: false, attributes: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { listeners.set(this.id || name, callback); }
  });
  const grid = { replaceChildren() { cards.length = 0; }, append(card) { cards.push(card); }, innerHTML: '' };
  const modal = { showModal() {}, close() {} };
  const elements = new Map([
    ['#planGrid', grid], ['#purchaseModal', modal], ['#modalName', makeElement()],
    ['#modalPrice', makeElement()], ['#modalDescription', makeElement()], ['#modalPhone', makeElement()],
    ['#modalPay', Object.assign(makeElement(), { id: 'modalPay' })],
    ['#modalStatus', makeElement()], ['#modalStatusText', makeElement()],
    ['#paymentForm', Object.assign(makeElement(), { id: 'paymentForm' })],
    ['.close', makeElement()]
  ]);
  const requests = [];
  const document = {
    querySelector(selector) { return elements.get(selector) || null; },
    querySelectorAll(selector) { return selector === '.plan' ? cards : []; },
    createElement(tag) {
      if (tag !== 'article') throw new Error(`Unexpected element ${tag}`);
      return { dataset: {}, classList: { toggle() {} }, querySelector: () => makeElement() };
    },
    body: { append() {} }
  };
  const fetch = async url => {
    requests.push(String(url));
    return { ok: true, json: async () => [{ id: 'package-10', name: '1 Hour', price_kes: 10, duration_minutes: 60 }] };
  };

  runInNewContext(source, {
    document, fetch, location: { search: '', origin: 'https://example.test', pathname: '/' },
    history: { replaceState() {} }, URLSearchParams, Date, setTimeout, clearTimeout,
    encodeURIComponent, console
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(cards.length, 1);
  cards[0].onclick();
  elements.get('#modalPhone').value = '0115613332';
  const submit = listeners.get('paymentForm');
  assert.equal(typeof submit, 'function');

  const pending = submit({ preventDefault() {} });
  assert.equal(elements.get('#modalPay').textContent, 'Checking device…');
  assert.equal(elements.get('#modalPay').disabled, true);
  await pending;

  assert.match(elements.get('#modalStatusText').textContent, /open its sign-in page/i);
  assert.equal(elements.get('#modalPay').textContent, 'Pay KSh 10');
  assert.equal(elements.get('#modalPay').disabled, false);
  assert.deepEqual(requests, ['/api/packages']);
});

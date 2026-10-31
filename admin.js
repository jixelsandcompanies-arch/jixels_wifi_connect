const $ = selector => document.querySelector(selector);
const fmt = n => `KSh ${Number(n).toLocaleString('en-KE')}`;
const dur = m => m === 90 ? '1 hour 30 minutes' : m % 1440 === 0 ? `${m / 1440} days` : m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`;
let catalogue = [], token = sessionStorage.getItem('jixelsAdminToken');
const auth = () => token ? { Authorization: `Bearer ${token}` } : {};
const toast = message => { $('#toast').textContent = message; $('#toast').style.display = 'block'; setTimeout(() => $('#toast').style.display = 'none', 2500); };
function showLogin() {
  if ($('.login')) return;
  document.body.insertAdjacentHTML('afterbegin', '<div class="login"><form id="loginForm"><b>Jixels</b><h1>Admin sign in</h1><p>Sign in with an administrator account.</p><label>Email<input id="loginEmail" type="email" autocomplete="username" required></label><label>Password<input id="loginPassword" type="password" autocomplete="current-password" required></label><button>Sign in</button><small id="loginError" role="alert"></small></form></div>');
  $('#loginForm').onsubmit = async e => {
    e.preventDefault(); const error = $('#loginError'); error.textContent = 'Signing in…';
    try { const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#loginEmail').value, password: $('#loginPassword').value }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Sign in failed'); token = d.accessToken; sessionStorage.setItem('jixelsAdminToken', token); $('.login').remove(); await load(); }
    catch (err) { error.textContent = err.message; }
  };
}
async function load() {
  try {
    const r = await fetch('/api/admin/dashboard', { headers: auth() });
    if (r.status === 401 || r.status === 403) { sessionStorage.removeItem('jixelsAdminToken'); token = null; showLogin(); return; }
    if (!r.ok) throw new Error((await r.json()).error || 'Dashboard could not be loaded');
    const d = await r.json(); catalogue = d.packages;
    $('#metrics').innerHTML = [['Active Customers', d.metrics.activeCustomers], ['Online Now', d.metrics.onlineNow], ["Today's Revenue", fmt(d.metrics.todayRevenue)], ['Active Sessions', d.metrics.activeSessions], ['Expired Sessions', d.metrics.expiredSessions], ['Total Packages', d.metrics.totalPackages]].map(([label, value]) => `<div class="metric"><small>${label}</small><b>${value}</b></div>`).join('');
    $('#packageTotal').textContent = `${catalogue.length} packages`;
    $('#packages').innerHTML = catalogue.length ? catalogue.map(p => `<article class="package"><span class="badge">${p.is_best_value ? 'BEST VALUE' : p.is_popular ? 'POPULAR' : 'PACKAGE'}</span><h3>${escapeHtml(p.name)}</h3><b>${fmt(p.price_kes)}</b><p>${dur(p.duration_minutes)}</p><span class="${p.is_active ? 'active' : 'inactive'}">${p.is_active ? '● Active' : '○ Inactive'}</span><button type="button" data-id="${p.id}">Edit</button></article>`).join('') : '<p>No packages found. Check the Supabase package migration.</p>';
    document.querySelectorAll('.package button').forEach(b => b.onclick = () => openEditor(catalogue.find(p => p.id === b.dataset.id)));
    $('#sessions').innerHTML = d.sessions.length ? d.sessions.map(s => `<div class="row"><span>${escapeHtml(s.phone)} · ${escapeHtml(s.wifi_packages?.name || 'Package unavailable')}</span><span>${new Date(s.start_time).toLocaleString()}</span><b>${escapeHtml(s.session_status)}</b></div>`).join('') : '<p>No sessions recorded yet.</p>';
    $('#revenue').innerHTML = Object.entries(d.revenue).map(([period, value]) => `<div class="row"><span>${period[0].toUpperCase() + period.slice(1)}</span><b>${fmt(value.amount)} · ${value.sales} sales</b></div>`).join('');
    $('#breakdown').innerHTML = d.breakdown.map(x => `<div class="row"><span>${escapeHtml(x.name)} — ${fmt(x.price_kes)}</span><span>${x.sold} sold · ${fmt(x.revenue)}</span></div>`).join('');
  } catch (err) { $('#metrics').innerHTML = `<div class="metric error">${escapeHtml(err.message)}</div>`; }
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function openEditor(p = { is_active: true, display_order: catalogue.length }) {
  $('#form').reset(); p ||= { is_active: true };
  for (const key of ['id', 'name', 'price_kes', 'description', 'display_order', 'is_active', 'is_popular', 'is_best_value']) { const el = $('#' + key); if (el) el.type === 'checkbox' ? el.checked = Boolean(p[key]) : el.value = p[key] ?? ''; }
  const minutes = Number(p.duration_minutes || 60); $('#duration').value = minutes % 1440 === 0 ? minutes / 1440 : minutes % 60 === 0 ? minutes / 60 : minutes; $('#unit').value = minutes % 1440 === 0 ? '1440' : minutes % 60 === 0 ? '60' : '1';
  $('#error').textContent = ''; $('#title').textContent = p.id ? 'Edit package' : 'Add package'; $('#editor').showModal();
}
$('#add').onclick = () => openEditor(); $('#cancel').onclick = () => $('#editor').close();
$('#form').onsubmit = async e => {
  e.preventDefault(); const id = $('#id').value, name = $('#name').value.trim();
  const data = { id: id || undefined, name, slug: id ? catalogue.find(p => p.id === id).slug : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), price_kes: Number($('#price_kes').value), duration_minutes: Number($('#duration').value) * Number($('#unit').value), description: $('#description').value.trim(), display_order: Number($('#display_order').value), is_active: $('#is_active').checked, is_popular: $('#is_popular').checked, is_best_value: $('#is_best_value').checked };
  try { const r = await fetch('/api/packages', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', ...auth() }, body: JSON.stringify(data) }); const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Package could not be saved'); $('#editor').close(); toast('Package saved'); await load(); }
  catch (err) { $('#error').textContent = err.message; }
};
$('#logout').onclick = () => { sessionStorage.removeItem('jixelsAdminToken'); token = null; showLogin(); };
token ? load() : showLogin();

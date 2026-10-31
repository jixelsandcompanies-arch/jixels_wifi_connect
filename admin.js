const $ = selector => document.querySelector(selector);
const fmt = value => `KSh ${Number(value || 0).toLocaleString('en-KE')}`;
const durationLabel = minutes => minutes === 90 ? '1 hr 30 min' : minutes % 1440 === 0 ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}` : minutes % 60 === 0 ? `${minutes / 60} hr${minutes === 60 ? '' : 's'}` : `${minutes} min`;
const kenyaTime = value => value ? new Intl.DateTimeFormat('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '--';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
let catalogue = [], breakdown = [], token = sessionStorage.getItem('jixelsAdminToken'), toastTimer, deferredInstallPrompt = null;
const authHeaders = () => token ? { Authorization: `Bearer ${token}` } : {};

function notify(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (response.status === 401 || response.status === 403) {
    sessionStorage.removeItem('jixelsAdminToken');
    token = null;
    showLogin();
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showLogin() {
  document.body.classList.remove('admin-authenticated');
  if ($('.login')) return;
  document.body.insertAdjacentHTML('afterbegin', '<div class="login"><form id="loginForm"><b>Barrio- HOTSPOT</b><h1>Admin sign in</h1><p>Use your administrator account to manage this hotspot.</p><label>Email<input id="loginEmail" type="email" autocomplete="username" required></label><label>Password<div class="password-input"><input id="loginPassword" type="password" autocomplete="current-password" required><button id="togglePassword" type="button" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m4 4 16 16"/></svg></button></div></label><button id="loginSubmit" type="submit">Sign in</button><small id="loginError" role="alert"></small></form></div>');
  $('#togglePassword').onclick = () => {
    const input = $('#loginPassword'), button = $('#togglePassword');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.classList.toggle('visible', reveal);
    button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} password`);
    button.setAttribute('aria-pressed', String(reveal));
  };
  $('#loginForm').onsubmit = async event => {
    event.preventDefault();
    const submit = $('#loginSubmit'), error = $('#loginError');
    submit.disabled = true;
    error.textContent = 'Signing in...';
    try {
      const data = await requestJson('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value }) });
      token = data.accessToken;
      sessionStorage.setItem('jixelsAdminToken', token);
      $('.login').remove();
      await loadDashboard();
    } catch (exception) {
      error.textContent = exception.message || 'Sign in failed. Check your email and password.';
    } finally { submit.disabled = false; }
  };
}

function renderMetrics(metrics) {
  const items = [
    ['Revenue today', fmt(metrics.todayRevenue), 'Confirmed M-Pesa payments'],
    ['Online now', Number(metrics.onlineNow || 0).toLocaleString('en-KE'), 'Active hotspot sessions'],
    ['Active customers', Number(metrics.activeCustomers || 0).toLocaleString('en-KE'), 'Unique customers with access'],
    ['Active packages', Number(metrics.activePackages ?? metrics.totalPackages ?? 0).toLocaleString('en-KE'), 'Plans available for sale']
  ];
  $('#metrics').innerHTML = items.map(([label, value, note]) => `<article class="metric"><small>${label}</small><b>${escapeHtml(value)}</b><span class="metric-note">${note}</span></article>`).join('');
}

function renderPackages() {
  const query = $('#packageSearch').value.trim().toLocaleLowerCase();
  const filter = $('#packageFilter').value;
  const filtered = catalogue.filter(item => {
    const matchesQuery = `${item.name} ${item.description || ''}`.toLocaleLowerCase().includes(query);
    const matchesStatus = filter === 'all' || (filter === 'active' ? item.is_active : !item.is_active);
    return matchesQuery && matchesStatus;
  });
  $('#packageTotal').textContent = `${filtered.length} of ${catalogue.length} package${catalogue.length === 1 ? '' : 's'}`;
  if (!filtered.length) {
    $('#packages').innerHTML = `<tr><td colspan="6" class="table-message">${catalogue.length ? 'No packages match this search.' : 'No packages yet. Add your first Wi-Fi package to get started.'}</td></tr>`;
    return;
  }
  $('#packages').innerHTML = filtered.map(item => {
    const tags = [item.is_popular ? 'Popular' : '', item.is_best_value ? 'Best value' : ''].filter(Boolean).join(' | ');
    const sold = breakdown.find(row => row.package_id === item.id)?.sold || 0;
    return `<tr>
      <td><span class="package-name">${escapeHtml(item.name)}</span>${tags ? `<span class="package-tags">${escapeHtml(tags)}</span>` : ''}</td>
      <td>${fmt(item.price_kes)}</td><td>${escapeHtml(durationLabel(item.duration_minutes))}</td><td>${Number(sold).toLocaleString('en-KE')}</td>
      <td><span class="status-pill ${item.is_active ? '' : 'inactive'}">${item.is_active ? 'Active' : 'Inactive'}</span></td>
      <td><button class="action-button" type="button" data-action="edit" data-id="${escapeHtml(item.id)}">Edit</button> <button class="action-button" type="button" data-action="toggle" data-id="${escapeHtml(item.id)}">${item.is_active ? 'Disable' : 'Enable'}</button></td>
    </tr>`;
  }).join('');
}

function statusClass(status) {
  const value = String(status || '').toLowerCase().replace(/[^a-z-]/g, '-');
  return ['active', 'waiting-gateway', 'expired', 'revoked', 'gateway-failed'].includes(value) ? value : '';
}

function renderSessions(sessions) {
  $('#sessions').innerHTML = sessions.length ? sessions.map(session => `<tr>
    <td>${escapeHtml(session.phone)}</td><td>${escapeHtml(session.wifi_packages?.name || 'Package unavailable')}</td>
    <td>${escapeHtml(kenyaTime(session.start_time))}</td><td>${escapeHtml(kenyaTime(session.expiry_time))}</td>
    <td><span class="status-pill ${statusClass(session.session_status)}">${escapeHtml(String(session.session_status || 'Unknown').replaceAll('_', ' '))}</span></td>
  </tr>`).join('') : '<tr><td colspan="5" class="table-message">No customer sessions recorded yet.</td></tr>';
}

function renderRevenue(revenue) {
  const labels = [['Today', revenue.today], ['Last 7 days', revenue.week], ['This month', revenue.month], ['All time', revenue.total]];
  $('#revenue').innerHTML = labels.map(([label, row]) => `<div class="revenue-row"><span>${label}<small>${Number(row.sales || 0).toLocaleString('en-KE')} confirmed sales</small></span><b>${fmt(row.amount)}</b></div>`).join('');
  $('#breakdown').innerHTML = breakdown.length ? breakdown.map(row => `<div class="breakdown-row"><span>${escapeHtml(row.name)}<small>${Number(row.sold || 0).toLocaleString('en-KE')} sold</small></span><b>${fmt(row.revenue)}</b></div>`).join('') : '<p class="table-message">No package sales to show yet.</p>';
}

async function loadDashboard() {
  try {
    const data = await requestJson('/api/admin/dashboard', { headers: authHeaders(), cache: 'no-store' });
    document.body.classList.add('admin-authenticated');
    catalogue = Array.isArray(data.packages) ? data.packages : [];
    breakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
    renderMetrics(data.metrics || {});
    renderPackages();
    renderSessions(Array.isArray(data.sessions) ? data.sessions : []);
    renderRevenue(data.revenue || {});
    $('#updatedAt').textContent = `Updated ${kenyaTime(new Date().toISOString())}`;
  } catch (exception) {
    if (!token) return;
    document.body.classList.add('admin-authenticated');
    $('#metrics').innerHTML = `<div class="metric" role="alert"><small>Dashboard unavailable</small><b class="error">${escapeHtml(exception.message)}</b></div>`;
    $('#packages').innerHTML = `<tr><td colspan="6" class="table-message">${escapeHtml(exception.message)}</td></tr>`;
    $('#sessions').innerHTML = '<tr><td colspan="5" class="table-message">Dashboard data could not be loaded.</td></tr>';
    $('#revenue').innerHTML = '<p class="table-message">Revenue data could not be loaded.</p>';
  }
}

function openEditor(item = null) {
  const form = $('#form');
  form.reset();
  $('#id').value = item?.id || '';
  $('#name').value = item?.name || '';
  $('#price_kes').value = item?.price_kes ?? '';
  $('#description').value = item?.description || '';
  $('#display_order').value = item?.display_order ?? catalogue.length + 1;
  const minutes = Number(item?.duration_minutes || 60);
  const unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
  $('#duration').value = minutes / unit;
  $('#unit').value = String(unit);
  $('#is_active').checked = item ? Boolean(item.is_active) : true;
  $('#is_popular').checked = Boolean(item?.is_popular);
  $('#is_best_value').checked = Boolean(item?.is_best_value);
  $('#error').textContent = '';
  $('#title').textContent = item ? 'Edit package' : 'Add package';
  $('#savePackage').textContent = item ? 'Save changes' : 'Create package';
  $('#editor').showModal();
}

async function savePackage(item, successMessage) {
  const editing = Boolean(item.id);
  const button = $('#savePackage');
  button.disabled = true;
  try {
    const payload = { ...item };
    delete payload.id;
    const saved = await requestJson('/api/packages', { method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ...payload, ...(editing ? { id: item.id } : {}) }) });
    const index = catalogue.findIndex(row => row.id === saved.id);
    if (index >= 0) catalogue[index] = saved;
    else catalogue.push(saved);
    $('#editor').close();
    notify(successMessage);
    await loadDashboard();
  } catch (exception) {
    $('#error').textContent = exception.message || 'Package could not be saved.';
  } finally { button.disabled = false; }
}

$('#form').onsubmit = event => {
  event.preventDefault();
  const name = $('#name').value.trim();
  const slug = name.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `package-${Date.now()}`;
  const id = $('#id').value;
  const existing = catalogue.find(item => item.id === id);
  const item = {
    ...(id ? { id } : {}), name,
    slug: existing?.slug || slug,
    price_kes: Number($('#price_kes').value),
    duration_minutes: Number($('#duration').value) * Number($('#unit').value),
    description: $('#description').value.trim(), display_order: Number($('#display_order').value),
    is_active: $('#is_active').checked, is_popular: $('#is_popular').checked, is_best_value: $('#is_best_value').checked
  };
  if (!name || !Number.isInteger(item.price_kes) || item.price_kes < 1 || !Number.isInteger(item.duration_minutes) || item.duration_minutes < 1 || !item.description) {
    $('#error').textContent = 'Enter a package name, description, positive whole-number price and duration.';
    return;
  }
  savePackage(item, id ? 'Package changes saved.' : 'Package created.');
};

$('#packages').addEventListener('click', async event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  const item = catalogue.find(row => row.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.action === 'edit') return openEditor(item);
  if (button.dataset.action === 'toggle') {
    button.disabled = true;
    await savePackage({ ...item, is_active: !item.is_active }, item.is_active ? 'Package disabled.' : 'Package enabled.');
  }
});

function setMenu(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#sidebarBackdrop').classList.toggle('visible', open);
  $('#menuToggle').setAttribute('aria-expanded', String(open));
  $('#menuToggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}

const adminPages = {
  overview: ['Overview', 'BUSINESS MANAGEMENT', 'Monitor your hotspot and billing activity.'],
  packages: ['Packages', 'CUSTOMER PLANS', 'Create packages, update prices, and control availability.'],
  sessions: ['Sessions', 'CUSTOMER ACCESS', 'Review recent Wi-Fi sessions and their status.'],
  revenue: ['Payments & revenue', 'BILLING REPORTS', 'Track confirmed payments and package sales.']
};

function showAdminPage(page, updateHistory = false) {
  if (!adminPages[page]) page = 'overview';
  document.querySelectorAll('[data-page-view]').forEach(view => {
    const active = view.dataset.pageView === page;
    view.hidden = !active;
    view.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-link').forEach(link => {
    const active = link.dataset.page === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const [title, eyebrow, description] = adminPages[page];
  $('#pageTitle').textContent = title;
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageDescription').textContent = description;
  if (updateHistory) history.pushState({ adminPage: page }, '', `#${page}Page`);
  setMenu(false);
}

document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  showAdminPage(link.dataset.page, true);
}));
$('.brand').addEventListener('click', event => { event.preventDefault(); showAdminPage('overview', true); });
window.addEventListener('popstate', () => {
  const page = document.querySelector(`.nav-link[href="${location.hash}"]`)?.dataset.page || 'overview';
  showAdminPage(page);
});
$('#menuToggle').onclick = () => setMenu(!$('#sidebar').classList.contains('open'));
$('#sidebarBackdrop').onclick = () => setMenu(false);
$('#refresh').onclick = loadDashboard;
$('#add').onclick = () => openEditor();
$('#cancel').onclick = () => $('#editor').close();
$('#cancelBottom').onclick = () => $('#editor').close();
$('#packageSearch').oninput = renderPackages;
$('#packageFilter').onchange = renderPackages;
$('#logout').onclick = () => { sessionStorage.removeItem('jixelsAdminToken'); token = null; showLogin(); };
$('#installApp').onclick = async () => {
  if (!deferredInstallPrompt) {
    notify('To install, use your browser menu and choose Install app or Add to Home screen.');
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === 'accepted') $('#installApp').hidden = true;
  deferredInstallPrompt = null;
};
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});
window.addEventListener('appinstalled', () => { $('#installApp').hidden = true; });
if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) $('#installApp').hidden = true;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('keydown', event => { if (event.key === 'Escape') setMenu(false); });

const initialPage = document.querySelector(`.nav-link[href="${location.hash}"]`)?.dataset.page || 'overview';
showAdminPage(initialPage);
token ? loadDashboard() : showLogin();

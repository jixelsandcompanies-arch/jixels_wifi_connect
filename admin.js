const $ = selector => document.querySelector(selector);
const fmt = value => `KSh ${Number(value || 0).toLocaleString('en-KE')}`;
const durationLabel = minutes => minutes === 90 ? '1 hr 30 min' : minutes % 1440 === 0 ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}` : minutes % 60 === 0 ? `${minutes / 60} hr${minutes === 60 ? '' : 's'}` : `${minutes} min`;
const kenyaTime = value => value ? new Intl.DateTimeFormat('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '--';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
function readAdminToken() {
  try { return sessionStorage.getItem('jixelsAdminToken'); } catch { return null; }
}
function storeAdminToken(value) {
  try { sessionStorage.setItem('jixelsAdminToken', value); } catch { /* keep the session in memory if storage is blocked */ }
}
function clearAdminToken() {
  try { sessionStorage.removeItem('jixelsAdminToken'); } catch { /* storage may be blocked in captive browsers */ }
}
let catalogue = [], breakdown = [], routerDevices = [], parentGateways = [], token = readAdminToken(), toastTimer, deferredInstallPrompt = null;
let currentAdminPage = 'overview';
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
    clearAdminToken();
    token = null;
    showLogin();
  }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin() {
  document.body.classList.remove('admin-authenticated');
  if (!$('.login')) document.body.insertAdjacentHTML('afterbegin', '<div class="login"><form id="loginForm"><b>Barrio- HOTSPOT</b><h1>Admin sign in</h1><p>Use your administrator account to manage this hotspot.</p><label>Email<input id="loginEmail" type="email" autocomplete="username" required></label><label>Password<div class="password-input"><input id="loginPassword" type="password" autocomplete="current-password" required><button id="togglePassword" type="button" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m4 4 16 16"/></svg></button></div></label><button id="loginSubmit" type="submit">Sign in</button><small id="loginError" role="alert"></small></form></div>');
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
      storeAdminToken(token);
      const loaded = await loadDashboard();
      if (!loaded) throw new Error('Could not load the admin dashboard. Check your connection and try again.');
    } catch (exception) {
      error.textContent = exception.message || 'Sign in failed. Check your email and password.';
    } finally { submit.disabled = false; }
  };
}

// Bind the visible fallback login form before other UI startup work.
showLogin();

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
    $('.login')?.remove();
    catalogue = Array.isArray(data.packages) ? data.packages : [];
    breakdown = Array.isArray(data.breakdown) ? data.breakdown : [];
    renderMetrics(data.metrics || {});
    renderPackages();
    renderSessions(Array.isArray(data.sessions) ? data.sessions : []);
    renderRevenue(data.revenue || {});
    $('#updatedAt').textContent = `Updated ${kenyaTime(new Date().toISOString())}`;
  } catch (exception) {
    if (!token) {
      showLogin();
      const loginError = $('#loginError');
      if (loginError) loginError.textContent = exception.message || 'Admin dashboard could not be loaded.';
      return false;
    }
    document.body.classList.remove('admin-authenticated');
    showLogin();
    const loginError = $('#loginError');
    if (loginError) loginError.textContent = exception.message || 'Admin dashboard could not be loaded.';
    return false;
  }
  return true;
}

async function checkCloudPay() {
  const button = $('#checkCloudPay');
  const status = $('#cloudPayHealthStatus');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Checking...';
  status.textContent = 'Checking CloudPay OAuth...';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const result = await requestJson('/api/admin/cloudpay-health', { headers: authHeaders(), cache: 'no-store', signal: controller.signal });
    status.textContent = `Connected to CloudPay ${result.environment}. Credentials accepted.`;
  } catch (error) {
    status.textContent = error.name === 'AbortError'
      ? 'CloudPay check timed out. Check your connection and try again.'
      : error.message || 'CloudPay authentication check failed.';
  } finally {
    clearTimeout(timer);
    button.disabled = false;
    button.textContent = 'Check CloudPay';
  }
}

const connectionLabels = { ETHERNET: 'Ethernet connection', WIRELESS_BRIDGE: 'Wireless bridge', WIRELESS_REPEATER: 'Wireless repeater', ACCESS_POINT: 'Access Point mode' };
const modeLabels = { AP_BRIDGE: 'Access point / bridge', WIRELESS_BRIDGE: 'Wireless client bridge', REPEATER_BRIDGE: 'Repeater bridge' };
const modeForConnection = { ETHERNET: 'AP_BRIDGE', ACCESS_POINT: 'AP_BRIDGE', WIRELESS_BRIDGE: 'WIRELESS_BRIDGE', WIRELESS_REPEATER: 'REPEATER_BRIDGE' };

function renderRouterInventory(data) {
  routerDevices = Array.isArray(data.routers) ? data.routers : [];
  parentGateways = Array.isArray(data.parentGateways) ? data.parentGateways : [];
  const rows = $('#routers');
  $('#gatewayNotice').textContent = data.configuredGateway
    ? `Central gateway: ${data.configuredGateway.gateway_name} (${data.configuredGateway.gateway_id}). Agent heartbeat: ${data.agentHeartbeat === 'RECENT' ? 'recent' : data.agentHeartbeat === 'STALE' ? 'stale' : 'not seen'}. A recent heartbeat confirms the agent contacted Jixels; it does not verify router or access point connectivity.`
    : 'No central MikroTik gateway is configured in this deployment. Access points cannot be registered until the gateway is configured.';
  $('#addRouter').disabled = parentGateways.length === 0;
  if (!routerDevices.length) {
    rows.innerHTML = '<tr><td colspan="8" class="table-message">No routers or access points are registered.</td></tr>';
    return;
  }
  rows.innerHTML = routerDevices.map(device => {
    const status = 'Not verified';
    const statusClassName = 'inactive';
    return `<tr>
      <td><span class="package-name">${escapeHtml(device.router_name)}</span></td>
      <td>${escapeHtml(device.router_ip)}<small class="router-mac">${escapeHtml(device.router_mac)}</small></td>
      <td>${escapeHtml(connectionLabels[device.connection_type] || device.connection_type)}</td>
      <td>${escapeHtml(modeLabels[device.operating_mode] || device.operating_mode)}</td>
      <td>${escapeHtml(device.mikrotik_gateways?.gateway_name || device.parent_gateway_id)}</td>
      <td><span class="status-pill ${device.is_enabled ? '' : 'inactive'}">${device.is_enabled ? 'Enabled' : 'Disabled'}</span></td>
      <td><span class="status-pill ${statusClassName}">${status}</span></td>
      <td><button class="action-button" type="button" data-router-action="edit" data-id="${escapeHtml(device.id)}">Edit</button> <button class="action-button" type="button" data-router-action="toggle" data-id="${escapeHtml(device.id)}">${device.is_enabled ? 'Disable' : 'Enable'}</button> <button class="action-button" type="button" data-router-action="remove" data-id="${escapeHtml(device.id)}">Remove</button></td>
    </tr>`;
  }).join('');
}

async function loadRouterInventory() {
  const rows = $('#routers');
  rows.innerHTML = '<tr><td colspan="8" class="table-message">Loading router inventory...</td></tr>';
  try {
    const data = await requestJson('/api/admin/routers', { headers: authHeaders(), cache: 'no-store' });
    renderRouterInventory(data);
  } catch (exception) {
    $('#gatewayNotice').textContent = 'Router inventory is unavailable. Apply migration 008 and confirm the central MikroTik gateway settings.';
    rows.innerHTML = `<tr><td colspan="8" class="table-message">${escapeHtml(exception.message)}</td></tr>`;
  }
}

function openRouterEditor(device = null) {
  const form = $('#routerForm');
  form.reset();
  $('#routerId').value = device?.id || '';
  $('#routerName').value = device?.router_name || '';
  $('#routerMac').value = device?.router_mac || '';
  $('#routerIp').value = device?.router_ip || '';
  $('#connectionType').value = device?.connection_type || 'ETHERNET';
  $('#operatingMode').value = device?.operating_mode || modeForConnection[$('#connectionType').value];
  $('#routerEnabled').checked = device ? Boolean(device.is_enabled) : true;
  $('#parentGateway').innerHTML = parentGateways.map(gateway => `<option value="${escapeHtml(gateway.gateway_id)}">${escapeHtml(gateway.gateway_name)} (${escapeHtml(gateway.gateway_id)})</option>`).join('');
  if (device) $('#parentGateway').value = device.parent_gateway_id;
  $('#routerError').textContent = '';
  $('#routerEditorTitle').textContent = device ? 'Edit router or access point' : 'Register router or access point';
  $('#saveRouter').textContent = device ? 'Save changes' : 'Register device';
  $('#routerEditor').showModal();
}

const connectionTypeInput = $('#connectionType');
if (connectionTypeInput) connectionTypeInput.onchange = () => { $('#operatingMode').value = modeForConnection[connectionTypeInput.value]; };
$('#routerForm').onsubmit = async event => {
  event.preventDefault();
  const id = $('#routerId').value;
  const payload = {
    routerName: $('#routerName').value.trim(), routerMac: $('#routerMac').value.trim(), routerIp: $('#routerIp').value.trim(),
    connectionType: $('#connectionType').value, operatingMode: $('#operatingMode').value,
    parentGatewayId: $('#parentGateway').value, isEnabled: $('#routerEnabled').checked,
    ...(id ? { id } : {})
  };
  const button = $('#saveRouter');
  button.disabled = true;
  try {
    await requestJson('/api/admin/routers', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(payload) });
    $('#routerEditor').close();
    notify(id ? 'Router details updated.' : 'Router registered. Its connection is not yet verified.');
    await loadRouterInventory();
  } catch (exception) {
    $('#routerError').textContent = exception.message || 'Router could not be saved.';
  } finally { button.disabled = false; }
};

const routerTable = $('#routers');
if (routerTable) routerTable.addEventListener('click', async event => {
  const button = event.target.closest('button[data-router-action]');
  if (!button) return;
  const device = routerDevices.find(item => item.id === button.dataset.id);
  if (!device) return;
  if (button.dataset.routerAction === 'edit') return openRouterEditor(device);
  if (button.dataset.routerAction === 'remove') {
    if (!window.confirm(`Remove ${device.router_name} from the inventory? This will not change the physical router.`)) return;
    button.disabled = true;
    try {
      await requestJson(`/api/admin/routers?id=${encodeURIComponent(device.id)}`, { method: 'DELETE', headers: authHeaders() });
      notify('Router removed from inventory.');
      await loadRouterInventory();
    } catch (exception) { notify(exception.message || 'Router could not be removed.', true); button.disabled = false; }
    return;
  }
  if (button.dataset.routerAction === 'toggle') {
    button.disabled = true;
    try {
      await requestJson('/api/admin/routers', { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({
        id: device.id, routerName: device.router_name, routerMac: device.router_mac, routerIp: device.router_ip,
        connectionType: device.connection_type, operatingMode: device.operating_mode, parentGatewayId: device.parent_gateway_id, isEnabled: !device.is_enabled
      }) });
      notify(device.is_enabled ? 'Router disabled in inventory.' : 'Router enabled in inventory.');
      await loadRouterInventory();
    } catch (exception) { notify(exception.message || 'Router could not be updated.', true); button.disabled = false; }
  }
});

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

const packagesTable = $('#packages');
if (packagesTable) packagesTable.addEventListener('click', async event => {
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
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebarBackdrop');
  const toggle = $('#menuToggle');
  if (!sidebar || !backdrop || !toggle) return;
  sidebar.classList.toggle('open', open);
  backdrop.classList.toggle('visible', open);
  backdrop.setAttribute('aria-hidden', String(!open));
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
}

const adminPages = {
  overview: ['Overview', 'BUSINESS MANAGEMENT', 'Monitor your hotspot and billing activity.'],
  packages: ['Packages', 'CUSTOMER PLANS', 'Create packages, update prices, and control availability.'],
  sessions: ['Sessions', 'CUSTOMER ACCESS', 'Review recent Wi-Fi sessions and their status.'],
  revenue: ['Payments & revenue', 'BILLING REPORTS', 'Track confirmed payments and package sales.'],
  routers: ['Router Management', 'NETWORK DEVICES', 'Register and review access points connected to the central MikroTik gateway.']
};

function showAdminPage(page, updateHistory = false) {
  if (!adminPages[page]) page = 'overview';
  currentAdminPage = page;
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
  if (page === 'routers' && token) loadRouterInventory();
}

document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  showAdminPage(link.dataset.page, true);
}));
const brandLink = $('.brand');
if (brandLink) brandLink.addEventListener('click', event => { event.preventDefault(); showAdminPage('overview', true); });
window.addEventListener('popstate', () => {
  const page = document.querySelector(`.nav-link[href="${location.hash}"]`)?.dataset.page || 'overview';
  showAdminPage(page);
});
const menuToggle = $('#menuToggle');
if (menuToggle) menuToggle.addEventListener('click', event => {
  event.preventDefault();
  setMenu(!$('#sidebar')?.classList.contains('open'));
});
const sidebarBackdrop = $('#sidebarBackdrop');
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setMenu(false));
const refreshButton = $('#refresh');
if (refreshButton) refreshButton.onclick = () => currentAdminPage === 'routers' ? loadRouterInventory() : loadDashboard();
const checkCloudPayButton = $('#checkCloudPay');
if (checkCloudPayButton) checkCloudPayButton.addEventListener('click', checkCloudPay);
const addButton = $('#add');
if (addButton) addButton.onclick = () => openEditor();
const addRouterButton = $('#addRouter');
if (addRouterButton) addRouterButton.onclick = () => openRouterEditor();
const cancelButton = $('#cancel');
if (cancelButton) cancelButton.onclick = () => $('#editor').close();
const cancelBottomButton = $('#cancelBottom');
if (cancelBottomButton) cancelBottomButton.onclick = () => $('#editor').close();
const closeRouterEditorButton = $('#closeRouterEditor');
if (closeRouterEditorButton) closeRouterEditorButton.onclick = () => $('#routerEditor').close();
const cancelRouterButton = $('#cancelRouter');
if (cancelRouterButton) cancelRouterButton.onclick = () => $('#routerEditor').close();
const packageSearchInput = $('#packageSearch');
if (packageSearchInput) packageSearchInput.oninput = renderPackages;
const packageFilterSelect = $('#packageFilter');
if (packageFilterSelect) packageFilterSelect.onchange = renderPackages;
const logoutButton = $('#logout');
if (logoutButton) logoutButton.onclick = () => { clearAdminToken(); token = null; showLogin(); };
const installAppButton = $('#installApp');
if (installAppButton) installAppButton.onclick = async () => {
  if (!deferredInstallPrompt) {
    notify('To install, use your browser menu and choose Install app or Add to Home screen.');
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === 'accepted') installAppButton.hidden = true;
  deferredInstallPrompt = null;
};
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
});
window.addEventListener('appinstalled', () => { const installButton = $('#installApp'); if (installButton) installButton.hidden = true; });
if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) $('#installApp').hidden = true;
if ('serviceWorker' in navigator) {
  let refreshingForWorkerUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshingForWorkerUpdate) return;
    refreshingForWorkerUpdate = true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then(registration => registration.update())
    .catch(() => {});
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') setMenu(false); });

const initialPage = document.querySelector(`.nav-link[href="${location.hash}"]`)?.dataset.page || 'overview';
showAdminPage(initialPage);
token ? loadDashboard() : showLogin();

/**
 * Northwind Realty — content admin.
 *
 * Loads everything from /api/state, edits a working copy in memory, and writes the
 * whole document back with a single Save. The server stores data.json and
 * regenerates data.js, which is the file the public website loads.
 */
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const TOKEN_KEY = 'northwind:admin-token';

// Never let unavailable site storage abort this script. The public site already
// wraps its localStorage calls for exactly this reason; the panel has to as
// well, because a throw on the line below would kill admin.js outright, leaving
// the sign-in form to submit natively and reload the page in a loop. Losing the
// saved token only costs a sign-in after a reload.
const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* session only */ } },
  remove(key) { try { window.localStorage.removeItem(key); } catch { /* nothing to clear */ } }
};

let token = store.get(TOKEN_KEY) || '';
let data = null;
let dirty = false;
let toastTimer;
let drawer = null;
let enquiries = [];

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

function announce(message) {
  const toast = $('#toast');
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3000);
}

async function api(path, options = {}) {
  // Remember which session this request was sent with. A request left over from
  // an earlier page load can come back 401 *after* the user has already signed in
  // again, and it must not be allowed to sign that new session out.
  const sentToken = token;

  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sentToken ? { Authorization: `Bearer ${sentToken}` } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    if (sentToken === token) {
      token = '';
      store.remove(TOKEN_KEY);
      showLogin();
    }
    throw new Error('Session expired — sign in again.');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

/* ---- auth --------------------------------------------------------------- */
function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#password').focus();
}

async function startApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  const payload = await api('/api/state');
  data = payload.data;
  markDirty(false);
  renderAll();
  // The inbox is a convenience, not a prerequisite: if it fails to load the
  // content editor still works, so the error is left for the Refresh button.
  loadEnquiries();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#login-error');
  error.hidden = true;
  try {
    const payload = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#password').value })
    });
    token = payload.token;
    store.set(TOKEN_KEY, token);
    $('#password').value = '';
    await startApp();
    announce('Signed in');
  } catch (problem) {
    error.textContent = problem.message;
    error.hidden = false;
  }
});

$('#logout').addEventListener('click', () => {
  if (dirty && !window.confirm('You have unsaved changes. Sign out anyway?')) return;
  token = '';
  store.remove(TOKEN_KEY);
  dirty = false;
  showLogin();
});

/* ---- save --------------------------------------------------------------- */
function markDirty(value = true) {
  dirty = value;
  const label = $('#save-state');
  label.textContent = value ? 'Unsaved changes' : 'All changes saved';
  label.classList.toggle('is-dirty', value);
  $('#save').disabled = !value;
}

$('#save').addEventListener('click', async () => {
  const button = $('#save');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await api('/api/data', { method: 'PUT', body: JSON.stringify(data) });
    markDirty(false);
    announce('Saved — the website now shows your changes');
  } catch (problem) {
    announce(problem.message);
  } finally {
    button.textContent = 'Save changes';
    button.disabled = !dirty;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

/* ---- drawer ------------------------------------------------------------- */
function openDrawer({ title, html, onApply }) {
  drawer = { onApply };
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').hidden = false;
  requestAnimationFrame(() => {
    $('#drawer').classList.add('is-open');
    $('#scrim').classList.add('is-open');
  });
  const first = $('#drawer-body input, #drawer-body select, #drawer-body textarea');
  if (first) first.focus();
}

function closeDrawer() {
  drawer = null;
  $('#drawer').classList.remove('is-open');
  $('#scrim').classList.remove('is-open');
  window.setTimeout(() => { $('#drawer').hidden = true; }, 200);
}

$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-cancel').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#drawer-apply').addEventListener('click', () => {
  if (!drawer) return;
  try {
    drawer.onApply();
    closeDrawer();
    markDirty();
    renderAll();
  } catch (problem) {
    announce(problem.message);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drawer) closeDrawer();
});

/* ---- rendering ---------------------------------------------------------- */
function renderAll() {
  renderListings();
  renderAgents();
  renderOffices();
  renderSettings();
}

const statusClass = (status) => (status === 'For rent' ? 'pill--rent' : status === 'Sold' ? 'pill--sold' : 'pill--sale');

function renderListings() {
  const query = $('#listing-search').value.trim().toLowerCase();
  const status = $('#listing-status').value;
  const rows = data.listings.filter((listing) => {
    if (status && listing.status !== status) return false;
    if (!query) return true;
    return `${listing.title} ${listing.address} ${listing.city} ${listing.type}`.toLowerCase().includes(query);
  });

  if (!rows.length) {
    $('#listings-body').innerHTML = '<div class="empty">No listings match. Try clearing the search, or add a new one.</div>';
    return;
  }

  $('#listings-body').innerHTML = `
    <div class="table-card">
      <div class="row row--head">
        <span>Photo</span><span>Listing</span><span>Status</span><span>Price</span><span></span>
      </div>
      ${rows.map((listing) => `
        <div class="row" data-id="${escapeHtml(listing.id)}">
          <div class="row__image"><img src="/${escapeHtml(listing.image)}" alt="" loading="lazy" /></div>
          <div>
            <div class="row__title">${escapeHtml(listing.title)}</div>
            <div class="row__meta">${escapeHtml(listing.address)}, ${escapeHtml(listing.city)} · ${listing.beds} bed · ${escapeHtml(listing.type)}</div>
          </div>
          <div><span class="pill ${statusClass(listing.status)}">${escapeHtml(listing.status)}</span>${listing.featured ? '<span class="pill pill--featured">Featured</span>' : ''}</div>
          <div class="row__price">${listing.status === 'For rent' ? `${money.format(listing.price)}<span class="row__meta"> /mo</span>` : money.format(listing.price)}</div>
          <div class="row__actions">
            <button class="btn btn--secondary btn--sm" data-edit="${escapeHtml(listing.id)}" type="button">Edit</button>
            <button class="btn btn--danger btn--sm" data-delete="${escapeHtml(listing.id)}" type="button">Delete</button>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderAgents() {
  $('#agents-body').innerHTML = data.agents.map((agent) => `
    <article class="entity" data-id="${escapeHtml(agent.id)}">
      <div class="entity__head">
        <span class="avatar avatar--${escapeHtml(agent.tint)}">${escapeHtml(agent.initials)}</span>
        <div>
          <div class="entity__name">${escapeHtml(agent.name)}</div>
          <div class="entity__meta">${escapeHtml(agent.role)}</div>
        </div>
      </div>
      <div class="entity__text">${escapeHtml(agent.email)}<br />${escapeHtml(agent.phone)}</div>
      <div class="entity__actions">
        <button class="btn btn--secondary btn--sm" data-edit-agent="${escapeHtml(agent.id)}" type="button">Edit</button>
        <button class="btn btn--danger btn--sm" data-delete-agent="${escapeHtml(agent.id)}" type="button">Delete</button>
      </div>
    </article>`).join('') || '<div class="empty">No agents yet.</div>';
}

function renderOffices() {
  $('#offices-body').innerHTML = data.offices.map((office, index) => `
    <article class="entity" data-index="${index}">
      <div class="entity__head">
        <div>
          <div class="entity__name">${escapeHtml(office.city)}</div>
          <div class="entity__meta">${escapeHtml(office.hours)}</div>
        </div>
      </div>
      <div class="entity__text">${escapeHtml(office.address)}<br />${escapeHtml(office.phone)}</div>
      <div class="entity__actions">
        <button class="btn btn--secondary btn--sm" data-edit-office="${index}" type="button">Edit</button>
        <button class="btn btn--danger btn--sm" data-delete-office="${index}" type="button">Delete</button>
      </div>
    </article>`).join('') || '<div class="empty">No offices yet.</div>';
}

const settingFields = [
  { key: 'name', label: 'Company name', hint: 'Used in the logo, page titles and the footer.' },
  { key: 'tagline', label: 'Home page eyebrow', hint: 'The small line above the headline.' },
  { key: 'heroTitle', label: 'Home page headline', hint: 'HTML is allowed, e.g. Find the home that <em>actually</em> fits.' },
  { key: 'heroLead', label: 'Home page intro', hint: 'One or two sentences under the headline.' },
  { key: 'brandColor', label: 'Brand colour', type: 'color' },
  { key: 'brandDark', label: 'Brand colour (dark)', type: 'color' },
  { key: 'accentColor', label: 'Accent colour', type: 'color' },
  { key: 'email', label: 'Contact email', type: 'email' },
  { key: 'phone', label: 'Contact phone', type: 'tel' },
  { key: 'footerNote', label: 'Footer description' },
  { key: 'copyright', label: 'Footer copyright' }
];

function renderSettings() {
  $('#settings-form').innerHTML = settingFields.map((field) => {
    const value = escapeHtml(data.site[field.key] ?? '');
    if (field.type === 'color') {
      return `<div class="field field--full">
        <span>${field.label}</span>
        <div class="color-field">
          <input type="color" name="${field.key}" value="${value}" />
          <input type="text" name="${field.key}-text" value="${value}" />
        </div>
      </div>`;
    }
    const wide = ['heroTitle', 'heroLead', 'footerNote', 'copyright', 'tagline'].includes(field.key);
    return `<div class="field${wide ? ' field--full' : ''}">
      <span>${field.label}</span>
      <input type="${field.type || 'text'}" name="${field.key}" value="${value}" />
      ${field.hint ? `<small class="hint">${field.hint}</small>` : ''}
    </div>`;
  }).join('');
}

$('#settings-form').addEventListener('input', (event) => {
  const field = event.target;
  const key = field.name.replace('-text', '');
  if (field.type === 'color') {
    const twin = $(`[name="${field.name}-text"]`);
    if (twin) twin.value = field.value;
  } else if (field.name.endsWith('-text')) {
    const twin = $(`[name="${key}"]`);
    if (twin && /^#[0-9a-f]{6}$/i.test(field.value)) twin.value = field.value;
  }
  data.site[key] = field.value;
  markDirty();
});

$$('.tabs button').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tabs button').forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
  $$('.panel').forEach((panel) => { panel.hidden = panel.id !== `panel-${tab.dataset.tab}`; });
  // Pick up anything submitted from the website while the panel was closed.
  if (tab.dataset.tab === 'enquiries') loadEnquiries();
}));

$('#listing-search').addEventListener('input', renderListings);
$('#listing-status').addEventListener('change', renderListings);

/* ---- enquiries ----------------------------------------------------------- */
const formatWhen = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const telHref = (phone) => `tel:${String(phone).replace(/[^0-9+]/g, '')}`;

function updateEnquiryBadge() {
  const badge = $('#enquiry-badge');
  const count = enquiries.filter((item) => !item.read && !item.archived).length;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

async function loadEnquiries() {
  try {
    const payload = await api('/api/enquiries');
    enquiries = payload.data.enquiries || [];
    updateEnquiryBadge();
    renderEnquiries();
  } catch (problem) {
    announce(problem.message);
  }
}

function renderEnquiries() {
  const query = $('#enquiry-search').value.trim().toLowerCase();
  const kind = $('#enquiry-kind').value;
  const state = $('#enquiry-state').value;

  const rows = enquiries.filter((item) => {
    if (kind && item.kind !== kind) return false;
    if (state === 'archived') { if (!item.archived) return false; }
    else if (state === 'unread') { if (item.read || item.archived) return false; }
    else if (item.archived) return false;
    if (!query) return true;
    const haystack = `${item.name} ${item.email} ${item.phone} ${item.intent} ${item.detail} ${item.message} ${item.listingTitle}`;
    return haystack.toLowerCase().includes(query);
  });

  if (!rows.length) {
    const noun = state === 'archived' ? 'Nothing archived yet.' : 'No enquiries yet.';
    $('#enquiries-body').innerHTML = `<div class="empty">${noun} Messages sent from the contact page and viewing requests from a property page arrive here.</div>`;
    return;
  }

  $('#enquiries-body').innerHTML = rows.map((item) => {
    const isBooking = item.kind === 'booking';
    const heading = isBooking ? `Viewing — ${item.listingTitle || 'a property'}` : (item.intent || 'Enquiry');
    const notes = [item.message, isBooking ? '' : item.detail].filter(Boolean);
    const contact = [
      item.email ? `<a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a>` : '<span class="entity__meta">no email</span>',
      item.phone ? `<a href="${escapeHtml(telHref(item.phone))}">${escapeHtml(item.phone)}</a>` : '',
      isBooking && item.date ? `<strong>wants ${escapeHtml(item.date)}</strong>` : '',
      !isBooking && item.channel ? `prefers ${escapeHtml(item.channel)}` : '',
      !isBooking && item.updates ? 'wants new listings' : ''
    ].filter(Boolean).join(' &middot; ');

    return `
      <article class="enquiry${item.read ? '' : ' is-unread'}" data-id="${escapeHtml(item.id)}">
        <header class="enquiry__head">
          <div>
            <div class="enquiry__who">${escapeHtml(item.name)}${item.read ? '' : '<span class="enquiry__dot" aria-label="Unread"></span>'}</div>
            <div class="enquiry__meta">${escapeHtml(heading)} · ${escapeHtml(formatWhen(item.createdAt))}</div>
          </div>
          <span class="pill ${isBooking ? 'pill--rent' : 'pill--sale'}">${isBooking ? 'Viewing' : 'Message'}</span>
        </header>
        <div class="enquiry__contact">${contact}</div>
        ${notes.length ? `<div class="enquiry__body">${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</div>` : ''}
        <footer class="enquiry__actions">
          <button class="btn btn--secondary btn--sm" data-enquiry-read="${escapeHtml(item.id)}" type="button">${item.read ? 'Mark unread' : 'Mark read'}</button>
          <button class="btn btn--secondary btn--sm" data-enquiry-archive="${escapeHtml(item.id)}" type="button">${item.archived ? 'Unarchive' : 'Archive'}</button>
          <span class="grow"></span>
          <button class="btn btn--danger btn--sm" data-enquiry-delete="${escapeHtml(item.id)}" type="button">Delete</button>
        </footer>
      </article>`;
  }).join('');
}

async function patchEnquiry(id, changes) {
  try {
    await api('/api/enquiry', { method: 'PATCH', body: JSON.stringify({ id, ...changes }) });
    await loadEnquiries();
  } catch (problem) {
    announce(problem.message);
  }
}

async function deleteEnquiry(id) {
  const item = enquiries.find((entry) => entry.id === id);
  if (!item) return;
  if (!window.confirm(`Delete the enquiry from ${item.name}? This cannot be undone.`)) return;
  try {
    await api('/api/enquiry', { method: 'DELETE', body: JSON.stringify({ id }) });
    announce('Enquiry deleted');
    await loadEnquiries();
  } catch (problem) {
    announce(problem.message);
  }
}

$('#enquiry-search').addEventListener('input', renderEnquiries);
$('#enquiry-kind').addEventListener('change', renderEnquiries);
$('#enquiry-state').addEventListener('change', renderEnquiries);
$('#enquiries-refresh').addEventListener('click', loadEnquiries);
$('#enquiries-archive-read').addEventListener('click', async () => {
  const targets = enquiries.filter((item) => item.read && !item.archived);
  if (!targets.length) {
    announce('Nothing to archive - there are no read enquiries');
    return;
  }
  for (const item of targets) {
    try {
      await api('/api/enquiry', { method: 'PATCH', body: JSON.stringify({ id: item.id, archived: true }) });
    } catch (problem) {
      announce(problem.message);
      return;
    }
  }
  announce(`Archived ${targets.length} read ${targets.length === 1 ? 'enquiry' : 'enquiries'}`);
  await loadEnquiries();
});

document.addEventListener('click', (event) => {
  const readButton = event.target.closest('[data-enquiry-read]');
  if (readButton) {
    const item = enquiries.find((entry) => entry.id === readButton.dataset.enquiryRead);
    if (item) patchEnquiry(item.id, { read: !item.read });
    return;
  }
  const archiveButton = event.target.closest('[data-enquiry-archive]');
  if (archiveButton) {
    const item = enquiries.find((entry) => entry.id === archiveButton.dataset.enquiryArchive);
    if (item) patchEnquiry(item.id, { archived: !item.archived });
    return;
  }
  const removeButton = event.target.closest('[data-enquiry-delete]');
  if (removeButton) deleteEnquiry(removeButton.dataset.enquiryDelete);
});

/* ---- photos ------------------------------------------------------------- */
async function uploadPhoto(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  const payload = await api('/api/photo', { method: 'POST', body: JSON.stringify({ name: file.name, dataUrl }) });
  return payload.path;
}

// Removing a photo from a listing only removes the reference. The file itself
// is deleted once, after the edit is applied, and only if no other listing
// points at it - the same image is often shared, and deleting it on the first
// removal left every other listing showing a broken picture.
async function removeUnreferencedPhotos(paths) {
  for (const path of paths) {
    if (!path || !path.startsWith('assets/homes/')) continue;
    const stillUsed = data.listings.some((listing) =>
      listing.image === path || (listing.images || []).includes(path));
    if (stillUsed) continue;
    try {
      await api('/api/photo', { method: 'DELETE', body: JSON.stringify({ path }) });
    } catch (problem) {
      announce(problem.message);
    }
  }
}



/* ---- editors ------------------------------------------------------------ */
const newId = (prefix) => `${prefix}${Date.now().toString(36)}`;

const listingTemplate = {
  id: '', title: '', address: '', city: 'Harbor Point', type: 'House', status: 'For sale',
  price: 500000, beds: 3, baths: 2, area: 1500, lot: '', year: new Date().getFullYear(), parking: 1,
  featured: false, listed: new Date().toISOString().slice(0, 10), agentId: '',
  image: 'assets/homes/property-01.svg', images: [], features: [], description: ''
};

const renderPhotos = (draft) => draft.images.map((image, index) => `
  <div class="photo"><img src="/${escapeHtml(image)}" alt="" />${index === 0 ? '' : `<button type="button" class="photo__cover" data-make-cover="${index}" aria-label="Make this the cover photo" title="Make this the cover photo">&#9733;</button>`}<button type="button" data-remove-photo="${index}" aria-label="Remove photo">&times;</button></div>`).join('');

const renderFeatures = (draft) => draft.features.map((feature, index) => `
  <span class="tag">${escapeHtml(feature)}<button type="button" data-remove-feature="${index}" aria-label="Remove">&times;</button></span>`).join('');

function editListing(existing) {
  const isNew = !existing;
  const draft = existing
    ? JSON.parse(JSON.stringify(existing))
    : { ...JSON.parse(JSON.stringify(listingTemplate)), id: newId('p'), agentId: data.agents[0]?.id || '' };
  draft.features = draft.features || [];
  draft.images = draft.images && draft.images.length ? [...draft.images] : [draft.image];
  draft.removedPhotos = [];

  const html = `
    <fieldset>
      <legend>The basics</legend>
      <div class="form-grid">
        <label class="field field--full"><span>Title</span><input name="title" value="${escapeHtml(draft.title)}" required /></label>
        <label class="field"><span>Address</span><input name="address" value="${escapeHtml(draft.address)}" /></label>
        <label class="field"><span>City or area</span><input name="city" value="${escapeHtml(draft.city)}" /></label>
        <label class="field"><span>Property type</span>
          <select name="type">${['House', 'Apartment', 'Townhouse', 'Villa', 'Loft'].map((type) => `<option${type === draft.type ? ' selected' : ''}>${type}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Status</span>
          <select name="status">${['For sale', 'For rent', 'Sold'].map((status) => `<option${status === draft.status ? ' selected' : ''}>${status}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Price (no commas)</span><input name="price" type="number" min="0" step="1000" value="${Number(draft.price) || 0}" required /></label>
        <label class="field"><span>Listed on</span><input name="listed" type="date" value="${escapeHtml(draft.listed)}" /></label>
        <label class="field field--check"><input name="featured" type="checkbox"${draft.featured ? ' checked' : ''} /> <span>Feature on the home page</span></label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Specification</legend>
      <div class="form-grid">
        <label class="field"><span>Bedrooms</span><input name="beds" type="number" min="0" value="${Number(draft.beds) || 0}" /></label>
        <label class="field"><span>Bathrooms</span><input name="baths" type="number" min="0" value="${Number(draft.baths) || 0}" /></label>
        <label class="field"><span>Floor area (ft²)</span><input name="area" type="number" min="0" value="${Number(draft.area) || 0}" /></label>
        <label class="field"><span>Plot</span><input name="lot" value="${escapeHtml(draft.lot)}" placeholder="620 m2 or 0.8 acres" /></label>
        <label class="field"><span>Year built</span><input name="year" type="number" min="1800" max="2100" value="${Number(draft.year) || 2000}" /></label>
        <label class="field"><span>Parking spaces</span><input name="parking" type="number" min="0" value="${Number(draft.parking) || 0}" /></label>
        <label class="field field--full"><span>Listed by</span>
          <select name="agentId">${data.agents.map((agent) => `<option value="${escapeHtml(agent.id)}"${agent.id === draft.agentId ? ' selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}</select>
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Description</legend>
      <label class="field"><textarea name="description">${escapeHtml(draft.description)}</textarea></label>
    </fieldset>

    <fieldset>
      <legend>Photos</legend>
      <div class="photo-list" id="photo-list">${renderPhotos(draft)}</div>
      <div class="photo-actions">
        <label class="btn btn--secondary btn--sm">Upload photos<input id="photo-input" type="file" accept="image/*" multiple hidden /></label>
        <small class="hint">The first photo is used as the cover.</small>
      </div>
    </fieldset>

    <fieldset>
      <legend>Features</legend>
      <div class="tags" id="feature-tags">${renderFeatures(draft)}</div>
      <div class="photo-actions" style="margin-top:0">
        <input id="feature-input" type="text" placeholder="e.g. Underfloor heating" style="flex:1;padding:9px 12px;border:1px solid #e4e7ec;border-radius:9px" />
        <button class="btn btn--secondary btn--sm" type="button" id="feature-add">Add</button>
      </div>
    </fieldset>`;

  openDrawer({
    title: isNew ? 'New listing' : `Edit: ${draft.title}`,
    html,
    onApply: () => {
      const body = $('#drawer-body');
      const value = (name) => ($(`.field [name="${name}"]`, body)?.value ?? '').trim();
      const updated = {
        ...draft,
        title: value('title') || 'Untitled listing',
        address: value('address'),
        city: value('city'),
        type: value('type'),
        status: value('status'),
        price: Number(value('price')) || 0,
        listed: value('listed'),
        featured: $('[name="featured"]', body).checked,
        beds: Number(value('beds')) || 0,
        baths: Number(value('baths')) || 0,
        area: Number(value('area')) || 0,
        lot: value('lot'),
        year: Number(value('year')) || 0,
        parking: Number(value('parking')) || 0,
        agentId: value('agentId'),
        description: value('description'),
        images: [...draft.images],
        image: draft.images[0] || 'assets/homes/property-01.svg',
        features: [...draft.features]
      };
      const index = data.listings.findIndex((item) => item.id === draft.id);
      if (index === -1) data.listings.unshift(updated);
      else data.listings[index] = updated;
      // Now the edit is real, so any photo it dropped can be cleared from disk -
      // but only if nothing else still refers to it.
      if (draft.removedPhotos.length) removeUnreferencedPhotos(draft.removedPhotos);
    }
  });
  wireListingDrawer(draft);
}

function wireListingDrawer(draft) {
  const body = $('#drawer-body');

  const refreshPhotos = () => { $('#photo-list', body).innerHTML = renderPhotos(draft); };
  const refreshFeatures = () => { $('#feature-tags', body).innerHTML = renderFeatures(draft); };

  $('#photo-input', body).addEventListener('change', async (event) => {
    const files = [...event.target.files];
    if (!files.length) return;
    announce(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}...`);
    const uploaded = [];
    for (const file of files) {
      try {
        uploaded.push(await uploadPhoto(file));
      } catch (problem) {
        announce(problem.message);
      }
    }
    // New photos go to the front, not the back. On the public site the first
    // photo is the cover - it is what every card and the home page show, and
    // the detail page's main gallery image. Appending left the upload saved but
    // invisible, which looked like nothing had happened.
    draft.images.unshift(...uploaded);
    event.target.value = '';
    refreshPhotos();
    announce(uploaded.length > 1
      ? `${uploaded.length} photos uploaded - the first is now the cover`
      : 'Photo uploaded - it is now the cover');
  });

  body.addEventListener('click', (event) => {
    const coverButton = event.target.closest('[data-make-cover]');
    if (coverButton) {
      const index = Number(coverButton.dataset.makeCover);
      if (index > 0) {
        const [chosen] = draft.images.splice(index, 1);
        draft.images.unshift(chosen);
        refreshPhotos();
        announce('Cover photo changed');
      }
      return;
    }
    const photoButton = event.target.closest('[data-remove-photo]');
    if (photoButton) {
      const index = Number(photoButton.dataset.removePhoto);
      const [removed] = draft.images.splice(index, 1);
      // Remember it, but do not delete anything yet: Cancel must be safe, and
      // other listings may still use the file.
      draft.removedPhotos.push(removed);
      refreshPhotos();
      return;
    }
    const featureButton = event.target.closest('[data-remove-feature]');
    if (featureButton) {
      draft.features.splice(Number(featureButton.dataset.removeFeature), 1);
      refreshFeatures();
    }
  });

  const addFeature = () => {
    const input = $('#feature-input', body);
    const value = input.value.trim();
    if (!value) return;
    draft.features.push(value);
    input.value = '';
    refreshFeatures();
  };
  $('#feature-add', body).addEventListener('click', addFeature);
  $('#feature-input', body).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addFeature(); }
  });
}

function editAgent(existing) {
  const isNew = !existing;
  const draft = existing
    ? { ...existing }
    : { id: newId('a'), name: '', role: 'Sales advisor', initials: '', tint: 'teal', listings: 0, phone: '', email: '', bio: '' };
  const tints = ['teal', 'sand', 'lilac', 'slate'];

  openDrawer({
    title: isNew ? 'New agent' : `Edit: ${draft.name}`,
    html: `
      <fieldset>
        <legend>Agent</legend>
        <div class="form-grid">
          <label class="field field--full"><span>Name</span><input name="name" value="${escapeHtml(draft.name)}" /></label>
          <label class="field"><span>Role</span><input name="role" value="${escapeHtml(draft.role)}" /></label>
          <label class="field"><span>Initials</span><input name="initials" maxlength="3" value="${escapeHtml(draft.initials)}" placeholder="EM" /></label>
          <label class="field"><span>Colour</span>
            <select name="tint">${tints.map((tint) => `<option${tint === draft.tint ? ' selected' : ''}>${tint}</option>`).join('')}</select>
          </label>
          <label class="field"><span>Sales on record</span><input name="listings" type="number" min="0" value="${Number(draft.listings) || 0}" /></label>
          <label class="field"><span>Phone</span><input name="phone" value="${escapeHtml(draft.phone)}" /></label>
          <label class="field"><span>Email</span><input name="email" type="email" value="${escapeHtml(draft.email)}" /></label>
          <label class="field field--full"><span>Short bio</span><textarea name="bio">${escapeHtml(draft.bio)}</textarea></label>
        </div>
      </fieldset>`,
    onApply: () => {
      const body = $('#drawer-body');
      const value = (name) => ($(`.field [name="${name}"]`, body)?.value ?? '').trim();
      const name = value('name') || 'New agent';
      const updated = {
        ...draft,
        name,
        role: value('role'),
        initials: value('initials') || name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
        tint: value('tint'),
        listings: Number(value('listings')) || 0,
        phone: value('phone'),
        email: value('email'),
        bio: value('bio')
      };
      const index = data.agents.findIndex((agent) => agent.id === draft.id);
      if (index === -1) data.agents.push(updated);
      else data.agents[index] = updated;
    }
  });
}

function editOffice(existing, index) {
  const isNew = existing === undefined;
  const draft = existing ? { ...existing } : { city: '', address: '', phone: '', hours: '' };

  openDrawer({
    title: isNew ? 'New office' : `Edit: ${draft.city}`,
    html: `
      <fieldset>
        <legend>Office</legend>
        <div class="form-grid">
          <label class="field field--full"><span>City or area</span><input name="city" value="${escapeHtml(draft.city)}" /></label>
          <label class="field field--full"><span>Address</span><input name="address" value="${escapeHtml(draft.address)}" /></label>
          <label class="field"><span>Phone</span><input name="phone" value="${escapeHtml(draft.phone)}" /></label>
          <label class="field"><span>Opening hours</span><input name="hours" value="${escapeHtml(draft.hours)}" placeholder="Mon-Fri 9:00-18:00" /></label>
        </div>
      </fieldset>`,
    onApply: () => {
      const body = $('#drawer-body');
      const value = (name) => ($(`.field [name="${name}"]`, body)?.value ?? '').trim();
      const updated = {
        city: value('city') || 'New office',
        address: value('address'),
        phone: value('phone'),
        hours: value('hours')
      };
      if (isNew) data.offices.push(updated);
      else data.offices[index] = updated;
    }
  });
}

/* ---- list actions ------------------------------------------------------- */
$('#new-listing').addEventListener('click', () => editListing(null));
$('#new-agent').addEventListener('click', () => editAgent(null));
$('#new-office').addEventListener('click', () => editOffice(undefined, -1));

document.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    editListing(data.listings.find((listing) => listing.id === editButton.dataset.edit));
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    const listing = data.listings.find((item) => item.id === deleteButton.dataset.delete);
    if (listing && window.confirm(`Delete "${listing.title}"? This cannot be undone.`)) {
      data.listings = data.listings.filter((item) => item.id !== listing.id);
      markDirty();
      renderAll();
      announce('Listing deleted - remember to save');
    }
    return;
  }
  const editAgentButton = event.target.closest('[data-edit-agent]');
  if (editAgentButton) {
    editAgent(data.agents.find((agent) => agent.id === editAgentButton.dataset.editAgent));
    return;
  }
  const deleteAgentButton = event.target.closest('[data-delete-agent]');
  if (deleteAgentButton) {
    const agent = data.agents.find((item) => item.id === deleteAgentButton.dataset.deleteAgent);
    if (agent && window.confirm(`Delete agent ${agent.name}?`)) {
      data.agents = data.agents.filter((item) => item.id !== agent.id);
      markDirty();
      renderAll();
      announce('Agent deleted - remember to save');
    }
    return;
  }
  const editOfficeButton = event.target.closest('[data-edit-office]');
  if (editOfficeButton) {
    const index = Number(editOfficeButton.dataset.editOffice);
    editOffice(data.offices[index], index);
    return;
  }
  const deleteOfficeButton = event.target.closest('[data-delete-office]');
  if (deleteOfficeButton) {
    const index = Number(deleteOfficeButton.dataset.deleteOffice);
    if (window.confirm(`Delete the ${data.offices[index].city} office?`)) {
      data.offices.splice(index, 1);
      markDirty();
      renderAll();
      announce('Office deleted - remember to save');
    }
  }
});

/* ---- boot --------------------------------------------------------------- */
if (token) {
  startApp().catch(() => showLogin());
} else {
  showLogin();
}

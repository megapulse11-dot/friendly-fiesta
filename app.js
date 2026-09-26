/**
 * Northwind Realty — shared behaviour.
 *
 * Every page loads this file; each block guards on the elements it needs, so the same
 * script drives the home page, the results page, the detail page and the contact page.
 * No dependencies, no build step, and the only storage used is `localStorage` for
 * saved homes and the chosen layout.
 */
const { listings, agents, offices, site = {} } = NORTHWIND;
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const numberFormat = new Intl.NumberFormat('en-US');
const FAVORITES_KEY = 'northwind:favorites';
const VIEW_KEY = 'northwind:view';
const PAGE_SIZE = 6;
let toastTimer;

/* ---- helpers ------------------------------------------------------------ */
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

const isRent = (listing) => listing.status === 'For rent';
const formatPrice = (listing) => currency.format(listing.price) + (isRent(listing) ? ' <small>/ month</small>' : '');
const formatArea = (listing) => `${numberFormat.format(listing.area)} ft²`;
const agentFor = (listing) => agents.find((agent) => agent.id === listing.agentId) || agents[0];
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
const formatListed = (value) => new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function announce(message) {
  const toast = $('#toast');
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

/* ---- saved homes -------------------------------------------------------- */
function readFavorites() {
  try {
    return JSON.parse(window.localStorage.getItem(FAVORITES_KEY)) || [];
  } catch {
    return [];
  }
}

function writeFavorites(ids) {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    announce('Saved homes are unavailable in this browser');
  }
}

function toggleFavorite(id) {
  const saved = readFavorites();
  const index = saved.indexOf(id);
  const isSaved = index === -1;
  if (isSaved) saved.push(id); else saved.splice(index, 1);
  writeFavorites(saved);
  syncFavoriteButtons();
  const listing = listings.find((item) => item.id === id);
  announce(isSaved ? `Saved ${listing?.title || 'this home'}` : `Removed ${listing?.title || 'this home'}`);
}

function syncFavoriteButtons() {
  const saved = readFavorites();
  $$('[data-favorite]').forEach((button) => {
    const isSaved = saved.includes(button.dataset.favorite);
    button.setAttribute('aria-pressed', String(isSaved));
    button.setAttribute('aria-label', isSaved ? 'Remove from saved homes' : 'Save this home');
  });
}

/* ---- card template ------------------------------------------------------ */
function propertyCard(listing, options = {}) {
  const agent = agentFor(listing);
  const statusClass = listing.status === 'Sold' ? 'card--sold' : '';
  const description = options.withDescription
    ? `<p class="card-description">${escapeHtml(listing.description)}</p>`
    : '';
  return `
    <article class="property-card ${statusClass}" data-listing="${listing.id}">
      <div class="card-media">
        <img src="${listing.image}" alt="${escapeHtml(listing.title)}" loading="lazy" width="1200" height="900" />
        <div class="card-badges">
          ${listing.status === 'Sold' ? '<span class="badge badge--muted">Sold</span>' : ''}
          ${isRent(listing) ? '<span class="badge badge--accent">To rent</span>' : ''}
          ${listing.featured && !isRent(listing) ? '<span class="badge badge--solid">Featured</span>' : ''}
        </div>
        <button class="favorite-button" type="button" data-favorite="${listing.id}" aria-pressed="false" aria-label="Save this home">${icon('heart')}</button>
      </div>
      <div class="card-body">
        <p class="card-price">${formatPrice(listing)}</p>
        <h3 class="card-title"><a href="property.html?id=${listing.id}">${escapeHtml(listing.title)}</a></h3>
        <p class="card-address">${icon('pin', 'icon--sm')}${escapeHtml(listing.address)}, ${escapeHtml(listing.city)}</p>
        <div class="card-specs">
          <span>${icon('bed', 'icon--sm')}${listing.beds} bed${listing.beds === 1 ? '' : 's'}</span>
          <span>${icon('bath', 'icon--sm')}${listing.baths} bath${listing.baths === 1 ? '' : 's'}</span>
          <span>${icon('area', 'icon--sm')}${formatArea(listing)}</span>
        </div>
        ${description}
        <div class="card-footer">
          <span class="card-agent"><span class="avatar avatar--${agent.tint}">${agent.initials}</span>${escapeHtml(agent.name)}</span>
          <a class="section-link" href="property.html?id=${listing.id}">View ${icon('arrow-right', 'icon--sm')}</a>
        </div>
      </div>
    </article>`;
}

/* ---- header & navigation ------------------------------------------------ */
function initHeader() {
  const header = $('.site-header');
  const menuButton = $('[data-menu-toggle]');

  if (header) {
    const onScroll = () => header.classList.toggle('is-stuck', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  if (menuButton) {
    menuButton.addEventListener('click', () => {
      const open = document.body.classList.toggle('nav-open');
      menuButton.setAttribute('aria-expanded', String(open));
    });
  }

  $$('.nav-scrim, .main-nav a').forEach((element) => {
    element.addEventListener('click', () => {
      document.body.classList.remove('nav-open');
      menuButton?.setAttribute('aria-expanded', 'false');
    });
  });

  const page = document.body.dataset.page === 'property' ? 'properties' : document.body.dataset.page;
  $$('.main-nav a').forEach((link) => {
    if (link.dataset.nav === page) link.setAttribute('aria-current', 'page');
  });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-favorite]');
  if (button) toggleFavorite(button.dataset.favorite);
});

/* ---- home page ---------------------------------------------------------- */
function renderHome() {
  const featuredGrid = $('#featured-grid');
  if (featuredGrid) {
    const featured = listings.filter((listing) => listing.featured && listing.status !== 'Sold').slice(0, 6);
    featuredGrid.innerHTML = featured.map((listing) => propertyCard(listing)).join('');
  }

  const agentGrid = $('#agent-grid');
  if (agentGrid) {
    agentGrid.innerHTML = agents.map((agent) => `
      <article class="agent-card">
        <span class="avatar avatar--${agent.tint} avatar--lg">${agent.initials}</span>
        <h3>${escapeHtml(agent.name)}</h3>
        <p class="agent-role">${escapeHtml(agent.role)}</p>
        <p class="agent-stat">${agent.listings} sales on record</p>
        <div class="agent-links">
          <a class="icon-button" href="contact.html" aria-label="Email ${escapeHtml(agent.name)}">${icon('mail', 'icon--sm')}</a>
          <a class="icon-button" href="contact.html" aria-label="Call ${escapeHtml(agent.name)}">${icon('phone', 'icon--sm')}</a>
        </div>
      </article>`).join('');
  }

  const statBand = $('#stat-band');
  if (statBand) {
    const available = listings.filter((listing) => listing.status !== 'Sold').length;
    const totalValue = listings.filter((listing) => !isRent(listing) && listing.status !== 'Sold')
      .reduce((sum, listing) => sum + listing.price, 0);
    const stats = [
      { value: numberFormat.format(available), label: 'Homes on the books' },
      { value: `$${numberFormat.format(Math.round(totalValue / 1000000))}M`, label: 'Current inventory value' },
      { value: '11', label: 'Average days on market' },
      { value: '98%', label: 'Asking price achieved' }
    ];
    statBand.innerHTML = stats.map((stat) => `<div><strong>${stat.value}</strong><span>${stat.label}</span></div>`).join('');
  }
}

function initSearchPanel() {
  const panel = $('#hero-search');
  if (!panel) return;

  let intent = 'sale';
  const tabs = $$('.search-tab', panel);
  const budgetField = $('[name="budget"]', panel);

  const budgetOptions = {
    sale: [['', 'Any budget'], ['0-750000', 'Up to $750k'], ['750000-1500000', '$750k – $1.5M'], ['1500000-2500000', '$1.5M – $2.5M'], ['2500000-', '$2.5M+']],
    rent: [['', 'Any rent'], ['0-2500', 'Up to $2,500'], ['2500-4000', '$2,500 – $4,000'], ['4000-', '$4,000+']]
  };

  const renderBudget = () => {
    budgetField.innerHTML = budgetOptions[intent]
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
  };

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    intent = tab.dataset.intent;
    tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
    renderBudget();
  }));

  renderBudget();

  $('form', panel).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    const query = String(data.get('query') || '').trim();
    const budget = String(data.get('budget') || '');
    if (query) params.set('q', query);
    if (intent === 'rent') params.set('status', 'For rent');
    if (budget) params.set('budget', budget);
    window.location.href = `properties.html${params.toString() ? `?${params}` : ''}`;
  });
}

/* ---- results page ------------------------------------------------------- */
function initResults() {
  const form = $('#filter-form');
  if (!form) return;

  const grid = $('#results-grid');
  const countLabel = $('#result-count');
  const chipRow = $('#chip-row');
  const loadMoreWrap = $('#load-more-wrap');
  const emptyState = $('#empty-state');
  let visible = PAGE_SIZE;
  let view = window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';

  const readState = () => {
    const params = new URLSearchParams(window.location.search);
    return {
      q: params.get('q') || '',
      type: params.get('type') || '',
      status: params.get('status') || '',
      budget: params.get('budget') || '',
      beds: params.get('beds') || '',
      sort: params.get('sort') || 'featured'
    };
  };

  const writeState = (state) => {
    const params = new URLSearchParams();
    Object.entries(state).forEach(([key, value]) => { if (value && !(key === 'sort' && value === 'featured')) params.set(key, value); });
    const query = params.toString();
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
  };

  const matches = (listing, state) => {
    if (state.status && listing.status !== state.status) return false;
    if (state.type && listing.type !== state.type) return false;
    if (state.beds && listing.beds < Number(state.beds)) return false;
    if (state.q) {
      const haystack = `${listing.title} ${listing.address} ${listing.city} ${listing.type}`.toLowerCase();
      if (!haystack.includes(state.q.toLowerCase())) return false;
    }
    if (state.budget) {
      const [min, max] = state.budget.split('-').map(Number);
      if (listing.price < min) return false;
      if (max && listing.price > max) return false;
    }
    return true;
  };

  const sorters = {
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    newest: (a, b) => b.listed.localeCompare(a.listed),
    'area-desc': (a, b) => b.area - a.area,
    featured: (a, b) => Number(b.featured) - Number(a.featured) || b.listed.localeCompare(a.listed)
  };

  const describeChips = (state) => {
    const chips = [];
    if (state.q) chips.push({ key: 'q', label: `“${state.q}”` });
    if (state.type) chips.push({ key: 'type', label: state.type });
    if (state.status) chips.push({ key: 'status', label: state.status });
    if (state.beds) chips.push({ key: 'beds', label: `${state.beds}+ beds` });
    if (state.budget) {
      const selected = $(`[name="budget"] option[value="${state.budget}"]`)?.textContent;
      chips.push({ key: 'budget', label: selected || state.budget });
    }
    return chips;
  };

  function render() {
    const state = readState();
    const results = listings.filter((listing) => matches(listing, state)).sort(sorters[state.sort]);

    grid.innerHTML = results.slice(0, visible).map((listing) => propertyCard(listing, { withDescription: view === 'list' })).join('');
    grid.classList.toggle('is-list', view === 'list');
    countLabel.innerHTML = `<strong>${results.length}</strong> home${results.length === 1 ? '' : 's'} found`;
    emptyState.hidden = results.length !== 0;
    grid.hidden = results.length === 0;
    loadMoreWrap.hidden = results.length <= visible;

    const chips = describeChips(state);
    chipRow.innerHTML = chips.map((chip) => `
      <span class="chip">${escapeHtml(chip.label)}
        <button type="button" data-clear="${chip.key}" aria-label="Remove ${escapeHtml(chip.label)} filter">${icon('x', 'icon--sm')}</button>
      </span>`).join('');

    syncFavoriteButtons();
    writeState(state);
  }

  // Reflect the URL state into the controls before the first render.
  const initial = readState();
  Object.entries(initial).forEach(([key, value]) => {
    if (!value) return;
    const control = form.elements[key] || $(`[name="${key}"]`);
    if (control) control.value = value;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    visible = PAGE_SIZE;
    render();
  });

  form.addEventListener('reset', () => {
    window.setTimeout(() => { visible = PAGE_SIZE; render(); }, 0);
  });

  form.addEventListener('change', (event) => {
    if (event.target.name === 'sort') return;
    visible = PAGE_SIZE;
    render();
  });

  $$('[name="sort"]').forEach((control) => control.addEventListener('change', render));

  $('[data-clear-all]')?.addEventListener('click', () => {
    form.reset();
    visible = PAGE_SIZE;
    render();
  });

  chipRow.addEventListener('click', (event) => {
    const button = event.target.closest('[data-clear]');
    if (!button) return;
    form.elements[button.dataset.clear].value = '';
    visible = PAGE_SIZE;
    render();
  });

  $('#load-more')?.addEventListener('click', () => {
    visible += PAGE_SIZE;
    render();
  });

  $$('.view-toggle button').forEach((button) => button.addEventListener('click', () => {
    view = button.dataset.view;
    try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* storage is optional */ }
    $$('.view-toggle button').forEach((item) => item.classList.toggle('is-active', item === button));
    render();
  }));
  $$('.view-toggle button').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));

  render();
}

/* ---- property detail ---------------------------------------------------- */
function initDetail() {
  const root = $('#property-detail');
  if (!root) return;

  const id = new URLSearchParams(window.location.search).get('id');
  const listing = listings.find((item) => item.id === id);

  if (!listing) {
    root.innerHTML = `
      <div class="not-found">
        <h1>We could not find that home</h1>
        <p style="margin:12px auto 24px;max-width:420px;color:var(--muted)">The listing may have sold or been withdrawn. Browse everything currently on the market instead.</p>
        <a class="button button--primary" href="properties.html">Browse all homes</a>
      </div>`;
    document.title = 'Listing not found — Northwind Realty';
    return;
  }

  const agent = agentFor(listing);
  document.title = `${listing.title} — Northwind Realty`;

  root.innerHTML = `
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href="index.html">Home</a>${icon('chevron', 'icon--sm')}
      <a href="properties.html">Properties</a>${icon('chevron', 'icon--sm')}
      <span>${escapeHtml(listing.title)}</span>
    </nav>
    <div class="detail-layout">
      <div>
        <div class="gallery">
          <div class="gallery-main"><img id="gallery-main-image" src="${listing.images[0]}" alt="${escapeHtml(listing.title)}" width="1200" height="750" /></div>
          <div class="gallery-thumbs" role="group" aria-label="Property photos">
            ${listing.images.map((image, index) => `
              <button type="button" data-gallery="${image}" aria-current="${index === 0}" aria-label="Show photo ${index + 1}">
                <img src="${image}" alt="" width="400" height="300" />
              </button>`).join('')}
          </div>
        </div>

        <div class="detail-title">
          <div>
            <h1>${escapeHtml(listing.title)}</h1>
            <p class="card-address">${icon('pin', 'icon--sm')}${escapeHtml(listing.address)}, ${escapeHtml(listing.city)}</p>
            <p class="detail-price">${currency.format(listing.price)}<small>${isRent(listing) ? ' per month' : ` · listed ${formatListed(listing.listed)}`}</small></p>
          </div>
          <div class="detail-actions">
            <button class="favorite-button" type="button" data-favorite="${listing.id}" aria-pressed="false" aria-label="Save this home">${icon('heart')}</button>
            <button class="button button--secondary" type="button" data-share>${icon('share', 'icon--sm')} Share</button>
          </div>
        </div>

        <dl class="spec-grid">
          <div><dt>Bedrooms</dt><dd>${listing.beds}</dd></div>
          <div><dt>Bathrooms</dt><dd>${listing.baths}</dd></div>
          <div><dt>Floor area</dt><dd>${formatArea(listing)}</dd></div>
          <div><dt>Plot</dt><dd>${escapeHtml(listing.lot)}</dd></div>
          <div><dt>Property type</dt><dd>${escapeHtml(listing.type)}</dd></div>
          <div><dt>Year built</dt><dd>${listing.year}</dd></div>
          <div><dt>Parking</dt><dd>${listing.parking} car${listing.parking === 1 ? '' : 's'}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(listing.status)}</dd></div>
        </dl>

        <section class="detail-section">
          <h2>About this home</h2>
          <p class="prose" style="margin-top:14px">${escapeHtml(listing.description)}</p>
        </section>

        <section class="detail-section">
          <h2>What you get</h2>
          <ul class="feature-grid">
            ${listing.features.map((feature) => `<li>${icon('check', 'icon--sm')}${escapeHtml(feature)}</li>`).join('')}
          </ul>
        </section>
      </div>

      <aside class="agent-card--sticky" aria-labelledby="agent-name">
        <span class="avatar avatar--${agent.tint} avatar--lg">${agent.initials}</span>
        <h2 id="agent-name" style="margin-top:14px">${escapeHtml(agent.name)}</h2>
        <p class="agent-role">${escapeHtml(agent.role)}</p>
        <p>${escapeHtml(agent.bio)}</p>
        <div class="agent-meta">
          <a href="tel:${agent.phone.replace(/[^+\d]/g, '')}">${icon('phone', 'icon--sm')}${escapeHtml(agent.phone)}</a>
          <a href="mailto:${agent.email}">${icon('mail', 'icon--sm')}${escapeHtml(agent.email)}</a>
          <span>${icon('home', 'icon--sm')}${agent.listings} sales on record</span>
        </div>
        <button class="button button--primary button--block" type="button" data-viewing>Book a viewing</button>
        <a class="button button--ghost button--block" style="margin-top:8px" href="contact.html">Ask a question</a>
      </aside>
    </div>
    <div id="similar-mount"></div>

    <dialog class="dialog" id="viewing-dialog" aria-labelledby="viewing-title">
      <form class="dialog-shell" id="viewing-form">
        <!-- Honeypot: hidden from people, filled in by spam bots. -->
        <input type="text" name="botcheck" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />
        <header class="dialog-header">
          <div>
            <h2 id="viewing-title">Book a viewing</h2>
            <p>${escapeHtml(listing.title)} · ${escapeHtml(listing.address)}</p>
          </div>
          <button class="icon-button" type="button" data-close-dialog aria-label="Close">${icon('x', 'icon--sm')}</button>
        </header>
        <div class="form-grid">
          <label class="field"><span>Name</span><input name="name" type="text" autocomplete="name" required /></label>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required /></label>
          <label class="field"><span>Preferred date</span><input name="date" type="date" required /></label>
          <label class="field"><span>Phone <small>Optional</small></span><input name="phone" type="tel" autocomplete="tel" /></label>
        </div>
        <footer class="dialog-actions">
          <button class="button button--secondary" type="button" data-close-dialog>Cancel</button>
          <button class="button button--primary" type="submit">Request viewing</button>
        </footer>
      </form>
    </dialog>`;

  $('#similar-mount').innerHTML = `
    <section class="section" aria-labelledby="similar-title">
      <div class="section-head section-head--split">
        <div>
          <p class="eyebrow">More like this</p>
          <h2 class="section-title" id="similar-title">Similar homes</h2>
        </div>
        <a class="section-link" href="properties.html">See all properties ${icon('arrow-right', 'icon--sm')}</a>
      </div>
      <div class="card-grid">
        ${listings
          .filter((item) => item.id !== listing.id && item.status !== 'Sold')
          .sort((a, b) => Number(b.type === listing.type) - Number(a.type === listing.type))
          .slice(0, 3)
          .map((item) => propertyCard(item))
          .join('')}
      </div>
    </section>`;

  $('.gallery-thumbs', root).addEventListener('click', (event) => {
    const button = event.target.closest('[data-gallery]');
    if (!button) return;
    $('#gallery-main-image').src = button.dataset.gallery;
    $$('.gallery-thumbs button', root).forEach((item) => item.setAttribute('aria-current', String(item === button)));
  });

  $('[data-share]', root)?.addEventListener('click', async () => {
    const shareData = { title: listing.title, text: listing.address, url: window.location.href };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(window.location.href);
        announce('Link copied to your clipboard');
      }
    } catch {
      announce('Sharing was cancelled');
    }
  });

  const dialog = $('#viewing-dialog', root);
  $('[data-viewing]', root).addEventListener('click', () => {
    dialog.showModal();
    document.body.classList.add('dialog-open');
    $('#viewing-form input[name="name"]', root).focus();
  });
  $$('[data-close-dialog]', root).forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
  $('#viewing-form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const submit = lockSubmit(form);

    try {
      await postEnquiry({
        kind: 'booking',
        name: fields.get('name'),
        email: fields.get('email'),
        phone: fields.get('phone'),
        date: fields.get('date'),
        listingId: listing.id,
        listingTitle: listing.title
      }, form);
      form.reset();
      dialog.close();
      announce(`Viewing request sent for ${listing.title}`);
    } catch (problem) {
      announce(problem.message);
    } finally {
      submit.done();
    }
  });

  syncFavoriteButtons();
}

/* ---- enquiries ----------------------------------------------------------- */
/*
 * Where a submission is sent.
 *
 * Two paths, chosen automatically:
 *
 *   1. On localhost the admin server is running, so enquiries go straight to
 *      /api/enquiry and land in enquiries.json, ready under the Enquiries tab.
 *
 *   2. Anywhere else - the published site on GitHub Pages - there is no server,
 *      so they go to a form service and arrive as an email.
 *
 * Set ONE of these to make the published forms work. All three are free.
 *
 *   Cloudflare Worker (recommended) - the one in worker/. Keeps enquiries in
 *   storage and hands them to the local admin panel, so the public site and the
 *   panel share a single Enquiries inbox. Paste the worker's /enquiry address
 *   into ENQUIRY_ENDPOINT below. See worker/README.md.
 *
 *   Web3Forms - no account at all. Type your email into
 *   https://web3forms.com and it shows an access key immediately. Paste it
 *   into ENQUIRY_KEY below. Delivers by email only, so these do not reach the
 *   admin inbox.
 *
 *   Formspree, or any service that accepts a JSON POST - paste the whole URL
 *   into ENQUIRY_ENDPOINT instead.
 */
const ENQUIRY_KEY = '';        // Web3Forms, e.g. 'a1b2c3d4-1234-5678-9abc-def012345678'
const ENQUIRY_ENDPOINT = '';   // Formspree, e.g. 'https://formspree.io/f/abcdefgh'

const isLocalServer = () =>
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1' ||
  location.hostname === '[::1]' ||
  location.protocol === 'file:';

// Resolve the destination, or explain why there isn't one.
function enquiryTarget() {
  if (ENQUIRY_KEY) {
    return { url: 'https://api.web3forms.com/submit', extra: { access_key: ENQUIRY_KEY } };
  }
  if (ENQUIRY_ENDPOINT) {
    return { url: ENQUIRY_ENDPOINT, extra: {} };
  }
  return null;
}

async function postEnquiry(payload, form) {
  // Running from the local admin server: use it.
  if (isLocalServer()) return postToLocalServer(payload);
  const target = enquiryTarget();
  if (!target) {
    throw new Error('This form is not connected yet. The site owner needs to add a form endpoint in app.js.');
  }
  return postToFormService(payload, target, form);
}

async function postToLocalServer(payload) {
  let response;
  try {
    response = await fetch('/api/enquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error('Could not reach the site server. Start it with start-admin.cmd and load the site from http://localhost:8001.');
  }

  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `The server could not save this (${response.status}).`);
  }
  return result;
}

async function postToFormService(payload, target, form) {
  // Fields the services understand, so an enquiry arrives as a readable email
  // rather than a JSON blob.
  const body = {
    ...payload,
    ...target.extra,
    from_name: payload.name || 'Website enquiry',
    replyto: payload.email || ''
  };
  // Honeypot: hidden from people, filled in by bots. A bot that completes
  // every field gets this one too and is silently discarded.
  const honeypot = form ? $('[name="botcheck"]', form) : null;
  if (honeypot && honeypot.value.trim()) return { ok: true, discarded: true };

  let response;
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('The message could not be sent. Please email us instead.');
  }

  let result = {};
  try { result = await response.json(); } catch { /* empty body is fine */ }
  if (!response.ok || result.success === false) {
    throw new Error((result.message ? `${result.message}. ` : '') + 'The message could not be sent. Please email us instead.');
  }
  return { ok: true };
}

function lockSubmit(form) {
  const button = $('button[type="submit"]', form);
  if (!button) return { done() {} };
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending…';
  return {
    done() {
      button.disabled = false;
      button.textContent = label;
    }
  };
}

function initForms() {
  $('#contact-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get('name') || '').trim();
    const submit = lockSubmit(form);

    try {
      await postEnquiry({
        kind: 'message',
        name,
        email: fields.get('email'),
        phone: fields.get('phone'),
        intent: fields.get('intent'),
        detail: fields.get('detail'),
        channel: fields.get('channel'),
        message: fields.get('message'),
        updates: fields.get('updates') === 'on'
      }, form);
      form.reset();
      announce(`Thanks ${name || 'for getting in touch'} — an agent will reply within one working day.`);
    } catch (problem) {
      announce(problem.message);
    } finally {
      submit.done();
    }
  });

  $('#newsletter-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    event.currentTarget.reset();
    announce('You are on the list — new listings land first.');
  });
}

/* ---- footer & offices --------------------------------------------------- */
function initFooter() {
  const list = $('#footer-offices');
  if (list) {
    list.innerHTML = offices.map((office) => `<li><a href="contact.html">${escapeHtml(office.city)}</a><br /><span>${escapeHtml(office.address)}</span></li>`).join('');
  }

  const officeList = $('#office-list');
  if (officeList) {
    officeList.innerHTML = offices.map((office) => `
      <article class="office-card">
        <svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-pin"></use></svg>
        <div>
          <h3>${escapeHtml(office.city)}</h3>
          <p>${escapeHtml(office.address)}<br />${escapeHtml(office.phone)}<br />${escapeHtml(office.hours)}</p>
        </div>
      </article>`).join('');
  }
}

/* ---- site settings ------------------------------------------------------ */
function applySiteSettings() {
  const root = document.documentElement;
  [['--brand', site.brandColor], ['--brand-dark', site.brandDark], ['--accent', site.accentColor]]
    .forEach(([property, value]) => { if (value) root.style.setProperty(property, value); });

  if (site.name) {
    document.title = document.title.replace('Northwind Realty', site.name);
    $$('.brand').forEach((brand) => {
      const mark = brand.querySelector('.brand-mark');
      brand.textContent = site.name;
      if (mark) brand.insertBefore(mark, brand.firstChild);
    });
  }

  [['[data-site="tagline"]', site.tagline],
    ['[data-site="heroTitle"]', site.heroTitle],
    ['[data-site="heroLead"]', site.heroLead],
    ['[data-site="footerNote"]', site.footerNote],
    ['[data-site="copyright"]', site.copyright]]
    .forEach(([selector, value]) => {
      const element = $(selector);
      if (element && value) element.innerHTML = value;
    });

  const emailLink = $('[data-site="email"]');
  if (emailLink && site.email) emailLink.href = `mailto:${site.email}`;
  const phoneLink = $('[data-site="phone"]');
  if (phoneLink && site.phone) phoneLink.href = `tel:${String(site.phone).replace(/[^+\d]/g, '')}`;
}

/* ---- boot --------------------------------------------------------------- */
applySiteSettings();
initHeader();
renderHome();
initSearchPanel();
initResults();
initDetail();
initForms();
initFooter();
syncFavoriteButtons();

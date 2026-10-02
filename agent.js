/*
 * Agent sign in, upload and listing management.
 *
 * Talks to the Cloudflare worker, which is the only part of this project with a
 * server behind it. The public website is static and knows nothing about agents;
 * everything here goes over the network to the worker, and nothing here touches
 * data.json - approving a listing is the office's job, in the admin panel.
 *
 * The token is kept in localStorage and sent as a bearer token. That is a
 * deliberate trade: an HttpOnly cookie would be unreadable by script, but it can
 * only be sent to one origin, and this page is on GitHub Pages while the worker
 * is on workers.dev. A cross-site cookie would need SameSite=None and would
 * still not be readable by the worker when the page is opened from a file://
 * path. localStorage keeps the two origins simple; the token is short-lived and
 * every request re-reads the account, so suspending an agent stops it at once.
 */

// Set this to the worker's address, e.g.
// https://northwind-enquiries.<your-subdomain>.workers.dev
const API = 'https://northwind-enquiries.YOUR-SUBDOMAIN.workers.dev';

const TOKEN_KEY = 'northwind.agent.token';

/* Mirrors HOME_TYPES and LAND_TYPES in the website's app.js. */
const HOME_TYPES = ['House', 'Apartment', 'Townhouse', 'Villa', 'Loft'];
const LAND_TYPES = [
  'Virgin land',
  'Residential land',
  'Agricultural land',
  'Commercial land',
  'Industrial land',
  'Beachfront land',
  'Ranch land',
  'Orchard land',
  'Mixed-use land',
  'Plot'
];

const $ = (selector) => document.querySelector(selector);

const store = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      // Private browsing modes can throw on storage access.
      return '';
    }
  },
  set token(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to do; the session simply will not survive a reload */
    }
  }
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));

let toastTimer = 0;
function announce(message) {
  const toast = $('#toast');
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3500);
}

function showError(id, message) {
  const box = $(id);
  box.textContent = message || '';
  box.hidden = !message;
}

/**
 * One place every call goes through, so the token, the error shape and the
 * "your session ended" behaviour are the same on every route.
 */
async function api(path, options = {}) {
  const sent = store.token;
  const headers = Object.assign({}, options.headers || {});
  if (sent) headers.Authorization = 'Bearer ' + sent;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options = Object.assign({}, options, { body: JSON.stringify(options.json) });
    delete options.json;
  }

  const response = await fetch(API + path, Object.assign({}, options, { headers }));

  let payload = {};
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {};
    }
  }

  if (response.status === 401 && sent) {
    // The token expired or the account was suspended. Clear it rather than
    // looping on a request that will keep failing.
    store.token = '';
    showDesk(false);
  }

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'That did not work. Please try again.');
  }
  return payload;
}

/* ---- the two screens ------------------------------------------------------ */

function showDesk(signedIn) {
  $('#gate').hidden = signedIn;
  $('#desk').hidden = !signedIn;
  $('#signout').hidden = !signedIn;
}

async function afterSignIn(agent) {
  $('#who').textContent = agent.name;
  showDesk(true);
  await loadListings();
}

$('#signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('#gate-error', '');
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('/agent/signin', {
      method: 'POST',
      json: { email: $('#signin-email').value, password: $('#signin-password').value }
    });
    store.token = result.token;
    $('#signin-password').value = '';
    await afterSignIn(result.agent);
  } catch (error) {
    showError('#gate-error', error.message);
  } finally {
    button.disabled = false;
  }
});

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('#gate-error', '');
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('/agent/register', {
      method: 'POST',
      json: {
        name: $('#reg-name').value,
        email: $('#reg-email').value,
        phone: $('#reg-phone').value,
        password: $('#reg-password').value
      }
    });
    store.token = result.token;
    $('#reg-password').value = '';
    await afterSignIn(result.agent);
    announce('Account created. You can upload a listing now.');
  } catch (error) {
    showError('#gate-error', error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('.tabs [data-mode]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    document.querySelectorAll('.tabs [data-mode]').forEach((other) => {
      other.setAttribute('aria-selected', String(other === tab));
    });
    $('#signin-form').hidden = mode !== 'signin';
    $('#register-form').hidden = mode !== 'register';
    showError('#gate-error', '');
  });
});

$('#signout').addEventListener('click', () => {
  // The worker holds no server-side session to clear, so this only forgets the
  // local copy; the API's sign-out route says as much.
  store.token = '';
  $('#who').textContent = '';
  showDesk(false);
});

/* ---- the list ------------------------------------------------------------- */

const STATE_LABEL = {
  pending: 'With the office',
  approved: 'Live on the website',
  rejected: 'Not approved'
};

let listings = [];

async function loadListings() {
  const result = await api('/agent/listings');
  listings = result.listings || [];
  renderListings();
}

function renderListings() {
  const list = $('#listings');
  $('#empty').hidden = listings.length > 0;

  list.innerHTML = listings
    .map((item) => {
      const editable = item.state === 'pending';
      const money = new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(item.price);

      const photo = item.photos && item.photos.length
        ? `<img class="card__img" src="${escapeHtml(item.photos[0])}" alt="" />`
        : '<div class="card__img card__img--none" aria-hidden="true"></div>';

      const note =
        item.state === 'rejected' && item.note
          ? `<p class="card__note">${escapeHtml(item.note)}</p>`
          : '';

      const actions = editable
        ? `<button class="button button--secondary" data-edit="${escapeHtml(item.id)}">Edit</button>
           <button class="button button--danger" data-delete="${escapeHtml(item.id)}">Delete</button>`
        : item.state === 'approved'
          ? '<a class="button button--secondary" href="/properties.html">View the website</a>'
          : '<button class="button button--secondary" data-reupload="' + escapeHtml(item.id) + '">Upload again</button>';

      return `<li class="card">
        ${photo}
        <div class="card__body">
          <p class="card__state card__state--${escapeHtml(item.state)}">${escapeHtml(
            STATE_LABEL[item.state] || item.state
          )}</p>
          <h3 class="card__title">${escapeHtml(item.title)}</h3>
          <p class="card__meta">${escapeHtml(item.type)}${item.lot ? ' · ' + escapeHtml(item.lot) : ''}</p>
          <p class="card__price">${escapeHtml(money)} · ${escapeHtml(item.status)}</p>
          ${note}
          <div class="card__actions">${actions}</div>
        </div>
      </li>`;
    })
    .join('');
}

/* ---- the upload dialog ---------------------------------------------------- */

let editing = null;
let pendingFiles = [];

const form = $('#listing-form');

/** Land and homes ask for different things, so only one set is ever shown. */
function applyCategory() {
  const land = $('#f-category').value === 'land';
  $('#home-fields').hidden = land;
  $('#land-fields').hidden = !land;
  $('#wrap-plot').hidden = !land;
  applyStayVisibility();
}

/**
 * Short stays belong to rentals.
 *
 * A sale price with a nightly rate beside it means nothing, and a bundle of
 * empty date boxes on a form for a house someone is selling is noise. So the
 * whole panel follows the status, and the price label follows it too - "monthly
 * rent" and "asking price" are the same field with very different meanings.
 */
function applyStayVisibility() {
  const isRent = $('#f-status').value === 'For rent';
  const land = $('#f-category').value === 'land';
  const panel = $('#stay-fields');
  const hint = $('#f-price-hint');
  if (hint) hint.textContent = isRent ? 'monthly rent' : land ? 'asking price' : 'price';
  if (!panel) return;
  panel.hidden = !isRent || land;
  // Anything filled in while the panel was open must not survive being hidden,
  // or a sale would be submitted carrying rates the website will never show.
  if (panel.hidden) {
    $$('input[type="checkbox"]', panel).forEach((box) => { box.checked = false; });
    ['#f-nightly', '#f-weekly', '#f-from', '#f-to'].forEach((id) => { if ($(id)) $(id).value = ''; });
  }
}

function fillTypes(selected) {
  const land = $('#f-category').value === 'land';
  const list = land ? LAND_TYPES : HOME_TYPES;
  $('#f-type').innerHTML = list.map((type) => `<option>${escapeHtml(type)}</option>`).join('');
  if (selected && list.includes(selected)) $('#f-type').value = selected;
}

$('#f-category').addEventListener('change', () => {
  applyCategory();
  fillTypes();
});

$('#f-status').addEventListener('change', applyStayVisibility);

function renderThumbs(files) {
  $('#thumbs').innerHTML = files
    .map(
      (file, index) => `<li class="thumb"><span>${escapeHtml(file.name)}</span>` +
        `<button type="button" class="thumb__x" data-drop="${index}" ` +
        `aria-label="Remove ${escapeHtml(file.name)}">&times;</button></li>`
    )
    .join('');
}

/**
 * Fill the form for a new listing or an edit.
 *
 * The category is set before the type list is built, because the list of types
 * depends on it - and `form.reset()` puts the category back to its markup
 * default, so it is re-applied afterwards rather than in between.
 */
function openDrawer(listing) {
  editing = listing || null;
  showError('#drawer-error', '');
  pendingFiles = [];

  $('#drawer-title').textContent = listing ? 'Edit listing' : 'Upload a listing';
  $('#drawer-save').textContent = listing ? 'Save changes' : 'Send to the office';

  const land = listing ? LAND_TYPES.includes(listing.type) : false;

  form.reset();
  $('#f-category').value = land ? 'land' : 'home';
  applyCategory();
  fillTypes(listing ? listing.type : undefined);

  const value = (id, fallback) => (listing && listing[id] !== undefined ? listing[id] : fallback);
  $('#f-title').value = value('title', '');
  $('#f-status').value = value('status', 'For sale');
  $('#f-price').value = value('price', '');
  $('#f-city').value = value('city', '');
  $('#f-address').value = value('address', '');
  $('#f-description').value = value('description', '');
  $('#f-features').value = listing && listing.features ? listing.features.join('\n') : '';

  if (land) {
    const plot = (listing && listing.land) || {};
    $('#f-plot').value = plot.plotAcres || '';
    $('#f-unit').value = plot.plotUnit || 'acres';
    $('#f-zoning').value = plot.zoning || '';
    $('#f-deed').value = plot.titleDeed || '';
    $('#f-access').value = plot.access || '';
    $('#f-landmarks').value = plot.landmarks || '';
    $('#f-utilities').value = plot.utilities || '';
  } else {
    $('#f-beds').value = value('beds', 0);
    $('#f-baths').value = value('baths', 0);
    $('#f-area').value = value('area', 0);
    $('#f-year').value = value('year', 0);
  }

  renderThumbs([]);

  $('#scrim').hidden = false;
  $('#drawer').hidden = false;
  $('#f-title').focus();
}

function closeDrawer() {
  $('#scrim').hidden = true;
  $('#drawer').hidden = true;
  editing = null;
  pendingFiles = [];
}

$('#f-photos').addEventListener('change', (event) => {
  pendingFiles = pendingFiles.concat(Array.from(event.target.files || []));
  event.target.value = '';
  renderThumbs(pendingFiles);
});

$('#thumbs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-drop]');
  if (!button) return;
  pendingFiles.splice(Number(button.dataset.drop), 1);
  renderThumbs(pendingFiles);
});

/** The form, shaped the way the worker expects it. */
function collectListing() {
  const land = $('#f-category').value === 'land';
  const text = (id) => $(id).value.trim();
  const number = (id) => Number($(id).value) || 0;

  const listing = {
    title: text('#f-title'),
    type: $('#f-type').value,
    status: $('#f-status').value,
    price: Number($('#f-price').value),
    city: text('#f-city'),
    address: text('#f-address'),
    description: text('#f-description'),
    features: text('#f-features')
  };

  if (land) {
    listing.land = {
      plotAcres: Number($('#f-plot').value) || 0,
      plotUnit: $('#f-unit').value,
      zoning: text('#f-zoning'),
      titleDeed: text('#f-deed'),
      access: text('#f-access'),
      landmarks: text('#f-landmarks'),
      utilities: text('#f-utilities')
    };
  } else {
    listing.beds = number('#f-beds');
    listing.baths = number('#f-baths');
    listing.area = number('#f-area');
    listing.year = number('#f-year');
  }

  /*
   * Short stays, sent only when the agent has actually said something about
   * them. The worker drops anything it does not recognise and refuses to store
   * rates on a listing with no terms at all, so an untouched form sends nothing
   * rather than sending a row of zeroes.
   */
  const stays = $$('input[name="stays"]:checked', $('#stay-fields') || document).map((box) => box.value);
  if (stays.length && !land && $('#f-status').value === 'For rent') {
    listing.stays = stays;
    if (number('#f-nightly')) listing.nightly = number('#f-nightly');
    if (number('#f-weekly')) listing.weekly = number('#f-weekly');
    if (number('#f-min-nights') > 1) listing.minNights = number('#f-min-nights');
    if (text('#f-from')) listing.availableFrom = text('#f-from');
    if (text('#f-to')) listing.availableTo = text('#f-to');
  }

  return listing;
}

$('#drawer-save').addEventListener('click', async () => {
  showError('#drawer-error', '');
  const button = $('#drawer-save');
  button.disabled = true;
  const wasEditing = Boolean(editing);

  try {
    const listing = collectListing();
    const saved = wasEditing
      ? await api('/agent/listings/' + editing.id, { method: 'PUT', json: listing })
      : await api('/agent/listings', { method: 'POST', json: listing });

    const id = (saved.submission && saved.submission.id) || (editing && editing.id);

    // Photographs go up separately as multipart. A photo that fails should not
    // lose the listing, which is already safely stored by this point - so it is
    // reported rather than allowed to unwind the save.
    if (pendingFiles.length && id) {
      const body = new FormData();
      pendingFiles.forEach((file) => body.append('photos', file));
      try {
        await api('/agent/listings/' + id + '/photos', { method: 'POST', body });
      } catch (error) {
        announce('The listing was saved, but the photographs were not: ' + error.message);
      }
    }

    closeDrawer();
    await loadListings();
    announce(wasEditing ? 'Listing updated.' : 'Sent to the office for approval.');
  } catch (error) {
    showError('#drawer-error', error.message);
  } finally {
    button.disabled = false;
  }
});

$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-cancel').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
});

$('#new-listing').addEventListener('click', () => openDrawer(null));

/* ---- actions on a listing ------------------------------------------------- */

$('#listings').addEventListener('click', async (event) => {
  const target = event.target;
  const editId = target.dataset && target.dataset.edit;
  const deleteId = target.dataset && target.dataset.delete;
  // A rejected listing is not editable, so "upload again" reopens the form as a
  // fresh submission rather than an edit of something the office has closed.
  const againId = target.dataset && target.dataset.reupload;

  if (editId || againId) {
    const id = editId || againId;
    openDrawer(listings.find((item) => item.id === id));
    return;
  }

  if (deleteId) {
    if (!window.confirm('Delete this listing? This cannot be undone.')) return;
    try {
      await api('/agent/listings/' + deleteId, { method: 'DELETE' });
      await loadListings();
      announce('Listing deleted.');
    } catch (error) {
      announce(error.message);
    }
  }
});

/* ---- start ---------------------------------------------------------------- */

fillTypes();
applyCategory();

(async function start() {
  if (!store.token) {
    showDesk(false);
    return;
  }
  try {
    const me = await api('/agent/me');
    $('#who').textContent = me.agent.name;
    showDesk(true);
    await loadListings();
  } catch {
    store.token = '';
    showDesk(false);
  }
})();

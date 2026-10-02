/**
 * Northwind Realty — shared behaviour.
 *
 * Every page loads this file; each block guards on the elements it needs, so the same
 * script drives the home page, the results page, the detail page and the contact page.
 * No dependencies, no build step, and the only storage used is `localStorage` for
 * saved homes and the chosen layout.
 */
const { listings, agents, offices, site = {} } = NORTHWIND;
const numberFormat = new Intl.NumberFormat('en-US');
const FAVORITES_KEY = 'northwind:favorites';
const VIEW_KEY = 'northwind:view';
const CURRENCY_KEY = 'northwind:currency';
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

/*
 * The two categories of thing the agency sells.
 *
 * `HOME_TYPES` are built-on dwellings, so they are described by bedrooms,
 * bathrooms and floor area. `LAND_TYPES` are parcels of ground, and the figures
 * that decide whether one suits a buyer - plot size, zoning, title, access - are
 * entirely different. So land is kept as its own list rather than being appended
 * to the property types: that is what lets a card, a detail page and a filter
 * swap between two sets of facts instead of showing "0 bedrooms" for a field.
 */
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
const PROPERTY_TYPES = [...HOME_TYPES, ...LAND_TYPES];

/** A listing is land when its type says so, or when it carries a land block. */
const isLand = (listing) => Boolean(listing.land) || LAND_TYPES.includes(listing.type);
const isHome = (listing) => !isLand(listing);

const isRent = (listing) => listing.status === 'For rent';

/* ---- short stays ---------------------------------------------------------- */
/*
 * Rentals taken for a set period rather than a year: a few nights, a week, a
 * couple of months, a whole weekend.
 *
 * The shape of this is deliberately additive. `price` stays what it always was
 * - the monthly rent for a rental, the asking price for a sale - so the budget
 * bands, the sorting, the currency conversion and the "/ month" suffix all keep
 * working on every listing without being taught about a new field. `nightly` and
 * `weekly` are optional overrides on top of it, and anything left out is derived
 * rather than shown as a gap.
 *
 * An owner who wants a discount for staying longer writes one: a high nightly
 * rate and a lower monthly price is exactly that, and it needs no extra concept.
 */
const STAY_TERMS = ['Nightly', 'Weekly', 'Monthly'];

/** Does this listing accept anything shorter than a full tenancy? */
const isShortStay = (listing) =>
  Array.isArray(listing.stays) && listing.stays.some((term) => STAY_TERMS.includes(term));

/**
 * The nightly rate for a listing, preferring what the owner actually wrote and
 * falling back through weekly and monthly so a card can never show a blank.
 *
 * Rounding is to the nearest whole unit: a nightly rate of 172.857 would look
 * like a bug on a listing card, and nobody prices a weekend to the penny.
 */
function nightlyRate(listing) {
  if (Number(listing.nightly) > 0) return Math.round(listing.nightly);
  if (Number(listing.weekly) > 0) return Math.round(Number(listing.weekly) / 7);
  if (isRent(listing) && Number(listing.price) > 0) return Math.round(Number(listing.price) / 30);
  return 0;
}

function weeklyRate(listing) {
  if (Number(listing.weekly) > 0) return Math.round(Number(listing.weekly));
  return nightlyRate(listing) * 7;
}

/**
 * A rate is only shown as a headline if the owner has something to say about it.
 * A one-month let is not a special offer and is left to the ordinary rent path.
 */
const shortStayRates = (listing) => {
  if (!isShortStay(listing)) return null;
  const rates = [];
  // A nightly rate is offered when the owner says nights are acceptable, or
  // writes a nightly figure. It is NOT offered merely because a weekly rate
  // exists: somebody who takes weeks and not nights has usually said so on
  // purpose, and deriving a night rate for them would promise a booking they
  // will refuse.
  if (listing.stays.includes('Nightly') || Number(listing.nightly) > 0) {
    rates.push({ term: 'Nightly', value: nightlyRate(listing), unit: 'night' });
  }
  if (listing.stays.includes('Weekly') || Number(listing.weekly) > 0) {
    rates.push({ term: 'Weekly', value: weeklyRate(listing), unit: 'week' });
  }
  if (listing.stays.includes('Monthly')) {
    rates.push({ term: 'Monthly', value: Number(listing.price), unit: 'month' });
  }
  return rates.length ? rates : null;
};

/** The shortest booking this listing will accept, in nights. */
const minNights = (listing) => (Number(listing.minNights) > 0 ? Number(listing.minNights) : 1);

/**
 * A hot deal, and only while it is actually hot.
 *
 * `hotUntil` is what stops this becoming a permanent decoration. A listing
 * flagged hot with no end date is treated as running indefinitely, because some
 * agencies do want a standing promotion; anything with a date quietly stops
 * being hot the day after, with no one having to remember to clear it.
 */
function isHot(listing) {
  if (!listing.hot) return false;
  if (!listing.hotUntil) return true;
  const until = new Date(`${listing.hotUntil}T23:59:59`);
  return !Number.isNaN(until.getTime()) && until.getTime() >= Date.now();
}

/** "Available 1 – 20 Oct", or nothing when the owner has not said. */
function availabilityWindow(listing) {
  const from = listing.availableFrom;
  const to = listing.availableTo;
  if (!from && !to) return '';
  const day = 86400000;
  const fmt = (value) =>
    new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  // A month or so is two different months, so the year only helps when it spans.
  if (from && to) {
    const showYear = new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`) > day * 45;
    const suffix = showYear ? ` ${new Date(`${to}T00:00:00`).getFullYear()}` : '';
    return `Available ${fmt(from)} – ${fmt(to)}${suffix}`;
  }
  return from ? `Available from ${fmt(from)}` : `Available until ${fmt(to)}`;
}
const formatArea = (listing) => `${numberFormat.format(listing.area)} ft²`;

/*
 * Plot size is the headline number for land, so it gets its own formatter rather
 * than reusing `lot`. That string is free text ("620 m2", "0.8 acres") and is
 * shown as-is for houses; `land.plotAcres` is the numeric field filters and
 * sorting can actually compare. `plotUnit` decides which unit it is read in.
 */
const PLOT_UNITS = { acres: 'acres', hectares: 'hectares', 'sq m': 'm²' };
const formatPlot = (listing) => {
  const size = Number(listing.land?.plotAcres);
  if (!Number.isFinite(size) || size <= 0) return listing.lot || '-';
  const unit = PLOT_UNITS[listing.land?.plotUnit] || 'acres';
  /*
   * Plot sizes span four orders of magnitude, from a quarter-acre corner plot to a
   * hundred-acre parcel, so a fixed number of decimals is wrong at one end or the
   * other: two decimals printed 20 acres as "20.00", and one decimal rounded a
   * quarter-acre to "0.3 acres" - which overstates the land being sold. Counting
   * from the size itself keeps 0.25 at 0.25 and 20 at 20, and 2.5 at 2.5.
   */
  const digits = size >= 10 ? 0 : size >= 1 ? Math.min(2, (String(size).split('.')[1] || '').length) : 2;
  return `${size.toFixed(digits)} ${unit}`;
};

const agentFor = (listing) => agents.find((agent) => agent.id === listing.agentId) || agents[0];
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
const formatListed = (value) => new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/*
 * Prices are rendered as empty elements carrying their base-currency amount, and
 * filled in by paintPrices(). That keeps the amount in one place — the data — and
 * means switching currency is a single pass over the document rather than a
 * re-render of every list on whichever page happens to be open.
 */
const priceAttrs = (amount, suffix = '', compact = false) =>
  `data-price="${amount}"${suffix ? ` data-price-suffix="${suffix}"` : ''}${compact ? ' data-price-compact' : ''}`;

function announce(message) {
  const toast = $('#toast');
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

/* ---- currency ----------------------------------------------------------- */
/*
 * Every price is stored once, in the base currency the agency publishes in
 * (site.currency, set in the admin panel). Visitors can read the site in any
 * other currency; the rates come from Frankfurter, a free key-less service that
 * republishes the European Central Bank's daily reference rates.
 *
 * This is the only request the site makes. It is a read-only GET that carries
 * nothing about the visitor, and everything here degrades to the base currency if
 * it fails — which is what the site showed before this existed, so a failed
 * request is a missing feature rather than a broken page.
 */
const RATES_URL = 'https://api.frankfurter.app/latest';
const CURRENCY_NAMES_URL = 'https://api.frankfurter.app/currencies';
/*
 * Frankfurter republishes the ECB's daily reference rates, and the ECB quotes only
 * the currencies of its own member states plus a few majors - 30 in all. Anything
 * outside that set (the Kenyan shilling, for one) has no rate there at all, so
 * asking Frankfurter for it returns a set that simply does not contain the code.
 *
 * This second key-less service covers ~160 currencies, and is consulted only for
 * codes the first source could not quote. Frankfurter stays the source of the
 * rate date shown to the reader, because ECB reference rates are the ones with a
 * real publication date and a defensible provenance.
 */
const SUPPLEMENT_RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const RATE_TIMEOUT = 7000;

/**
 * Used to label the picker if the currency list cannot be fetched. Kept to the
 * currencies a property site is plausibly read in, rather than all ~30.
 */
const FALLBACK_CURRENCIES = {
  AUD: 'Australian Dollar', BRL: 'Brazilian Real', CAD: 'Canadian Dollar', CHF: 'Swiss Franc',
  CNY: 'Chinese Yuan', CZK: 'Czech Koruna', DKK: 'Danish Krone', EUR: 'Euro',
  GBP: 'British Pound', HKD: 'Hong Kong Dollar', HUF: 'Hungarian Forint', IDR: 'Indonesian Rupiah',
  ILS: 'Israeli New Shekel', INR: 'Indian Rupee', ISK: 'Icelandic Krona', JPY: 'Japanese Yen',
  KES: 'Kenyan Shilling', KRW: 'South Korean Won', MXN: 'Mexican Peso', MYR: 'Malaysian Ringgit',
  NOK: 'Norwegian Krone', NZD: 'New Zealand Dollar', PHP: 'Philippine Peso', PLN: 'Polish Zloty',
  SEK: 'Swedish Krona', SGD: 'Singapore Dollar', TRY: 'Turkish Lira', USD: 'US Dollar',
  ZAR: 'South African Rand'
};

const baseCurrency = /^[A-Z]{3}$/i.test(String(site.currency || '')) ? String(site.currency).toUpperCase() : 'USD';

let rates = null;        // { CODE: number } against the base currency
let rateDate = '';       // the day the rate set was published
let supplement = null;   // { CODE: number } per USD, for codes Frankfurter omits
let supplementDate = ''; // the day that service last updated, for its own rates
let displayCurrency = baseCurrency;
let currencyNames = null;

/** Set by whichever page-level render is on screen, so chips and prices agree. */
let repaintPrices = () => {};

function readCurrencyPreference() {
  try {
    const saved = window.localStorage.getItem(CURRENCY_KEY);
    if (saved && /^[A-Z]{3}$/i.test(saved)) return saved.toUpperCase();
  } catch {
    // Storage is optional; fall through to the base currency.
  }
  return baseCurrency;
}

/*
 * Units of `to` per 1 `from`, using the supplement set.
 *
 * That service quotes everything against the dollar only, so reaching a
 * base currency other than USD means crossing two of its rates. Doing it this
 * way rather than asking the service to re-base it keeps one request and one
 * consistent set of numbers.
 */
function crossRate(from, to) {
  if (from === to) return 1;
  const a = supplement?.[from];
  const b = supplement?.[to];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return b / a;
}

function rateFor(code) {
  if (code === baseCurrency) return 1;
  const rate = rates?.[code];
  if (Number.isFinite(rate) && rate > 0) return rate;
  return crossRate(baseCurrency, code);
}

/**
 * The day the rate actually in use was published.
 *
 * A supplement rate has no ECB publication date, so it is reported with the day
 * that service last updated instead of borrowing Frankfurter's, which would
 * date a number from a different source.
 */
function rateDateFor(code) {
  if (code === baseCurrency) return '';
  if (Number.isFinite(rates?.[code]) && rates[code] > 0) return rateDate;
  return crossRate(baseCurrency, code) === null ? '' : supplementDate;
}

/**
 * The currency prices are actually drawn in right now.
 *
 * If the visitor picked a currency and the rates have not arrived (or failed to)
 * we keep drawing the base currency rather than relabelling an unconverted number
 * as euros. Showing the right number in the wrong symbol is worse than showing the
 * number we are sure of.
 */
function effectiveCurrency() {
  return rateFor(displayCurrency) === null ? baseCurrency : displayCurrency;
}

const convert = (amount, code) => (rateFor(code) ?? 1) * (Number(amount) || 0);

const moneyFormatters = new Map();
function moneyFormatter(code) {
  if (!moneyFormatters.has(code)) {
    moneyFormatters.set(code, new Intl.NumberFormat('en', {
      style: 'currency', currency: code, maximumFractionDigits: 0
    }));
  }
  return moneyFormatters.get(code);
}

function compactFormatter(code) {
  return new Intl.NumberFormat('en', {
    style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1
  });
}

/** A full price, e.g. $2,850,000 or €2,498,000. */
const formatMoney = (amount) => moneyFormatter(effectiveCurrency()).format(convert(amount, effectiveCurrency()));

/** A short price for stat bands and filter labels, e.g. $750k or €1.5M. */
const formatCompact = (amount) => compactFormatter(effectiveCurrency()).format(convert(amount, effectiveCurrency()));

/**
 * Fill every price placeholder on the page. Safe to call repeatedly, and cheap
 * enough to run on every filter keystroke.
 */
function paintPrices(scope = document) {
  const code = effectiveCurrency();
  $$('[data-price]', scope).forEach((element) => {
    const amount = Number(element.dataset.price) || 0;
    const formatter = element.hasAttribute('data-price-compact') ? compactFormatter(code) : moneyFormatter(code);
    const suffix = element.dataset.priceSuffix;
    element.innerHTML = formatter.format(convert(amount, code)) + (suffix ? ` <small>${escapeHtml(suffix)}</small>` : '');
  });
}

/*
 * Budget bands stay in base-currency numbers so that filtering, sorting and any
 * shared URL keep meaning the same thing whichever currency is on screen; only
 * the label the visitor reads is reworded.
 */
const BUDGET_LABELS = {
  '0-750000': (c) => `Up to ${c(750000)}`,
  '750000-1500000': (c) => `${c(750000)} – ${c(1500000)}`,
  '1500000-2500000': (c) => `${c(1500000)} – ${c(2500000)}`,
  '2500000-5000000': (c) => `${c(2500000)} – ${c(5000000)}`,
  '5000000-15000000': (c) => `${c(5000000)} – ${c(15000000)}`,
  '15000000-': (c) => `${c(15000000)}+`,
  // Kept: a saved URL naming the old top band still filters exactly as before.
  '2500000-': (c) => `${c(2500000)}+`,
  '0-2500': (c) => `Up to ${c(2500)}`,
  '2500-4000': (c) => `${c(2500)} – ${c(4000)}`,
  '4000-': (c) => `${c(4000)}+`,
  // Nightly bands, for the short-stay search. The values are per night, so these
  // are deliberately tiny next to the sale bands above: a night is a night
  // whatever currency it is shown in, and the arithmetic stays honest.
  '0-100': (c) => `Up to ${c(100)} a night`,
  '100-200': (c) => `${c(100)} – ${c(200)} a night`,
  '200-350': (c) => `${c(200)} – ${c(350)} a night`,
  '350-': (c) => `${c(350)}+ a night`
};

function paintBudgetLabels(scope = document) {
  $$('[name="budget"] option', scope).forEach((option) => {
    const label = BUDGET_LABELS[option.value];
    if (label) option.textContent = label(formatCompact);
  });
}

function paintCurrencyNote() {
  const note = $('[data-currency-note]');
  if (!note) return;
  const code = effectiveCurrency();
  // A supplement rate has a different publication rhythm to an ECB one, so the
  // note says which set the number on screen came from rather than implying the
  // whole page is on ECB reference rates.
  const date = rateDateFor(code);
  if (code === baseCurrency) note.textContent = '';
  else if (date) note.textContent = `Converted at reference rates from ${date}`;
  else note.textContent = 'Converted — rate date unavailable';
  note.hidden = code === baseCurrency;
}

/** Re-draw every price-bearing surface for the currency now on screen. */
function applyCurrency() {
  paintPrices();
  paintBudgetLabels();
  repaintPrices();
  paintCurrencyNote();
  const select = $('[data-currency-select]');
  if (select) select.value = effectiveCurrency();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), RATE_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    return await response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function buildCurrencyOptions(select) {
  const names = currencyNames || FALLBACK_CURRENCIES;
  const labelFor = (code) => names[code] || FALLBACK_CURRENCIES[code] || 'Currency';
  /*
   * The base currency is put in unconditionally rather than filtered against the
   * service's list. It is the one currency this site is certain about, and the
   * rate set never quotes a currency against itself — so a service that omits it
   * (or a failed request, which leaves only the fallback list) would otherwise
   * produce a picker with no valid selection and render as an empty box.
   *
   * The fallback list is merged in as well, for the opposite reason: it is where
   * currencies the ECB does not publish live, and a code with no rate behind it
   * would be a dead end in the picker.
   */
  const codes = [...new Set([
    baseCurrency, displayCurrency, ...Object.keys(names), ...Object.keys(FALLBACK_CURRENCIES)
  ])].sort();
  select.replaceChildren(...codes.map((code) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${code} — ${labelFor(code)}`;
    return option;
  }));
  select.value = effectiveCurrency();
}

async function initCurrency() {
  const picker = $('[data-currency-picker]');
  const select = $('[data-currency-select]');
  displayCurrency = readCurrencyPreference();

  // Draw straight away in the base currency so no price is ever blank. The
  // picker is revealed here rather than in the markup so that a visitor with
  // JavaScript switched off is not offered a control that cannot work.
  if (picker) picker.hidden = false;
  if (select) {
    select.disabled = true;
    buildCurrencyOptions(select);
  }
  applyCurrency();

  const [names, latest, extra] = await Promise.all([
    fetchJson(CURRENCY_NAMES_URL).catch(() => null),
    fetchJson(`${RATES_URL}?base=${encodeURIComponent(baseCurrency)}`).catch(() => null),
    // Only useful for the codes Frankfurter cannot quote, but which codes those
    // are is not known until its list arrives, so it is fetched alongside. It is
    // the third and last request, and every one of them failing is survivable.
    // An empty SUPPLEMENT_RATES_URL turns this second source off entirely.
    SUPPLEMENT_RATES_URL ? fetchJson(SUPPLEMENT_RATES_URL).catch(() => null) : null
  ]);

  if (names && !Array.isArray(names)) currencyNames = names;
  // Only trust a rate set that is actually quoted against our base currency.
  if (latest?.rates && (!latest.base || latest.base === baseCurrency)) {
    rates = latest.rates;
    rateDate = latest.date || '';
  }
  // This service always quotes against USD and reports success in `result`, so
  // both are checked before its numbers are trusted for anything.
  if (extra && extra.result === 'success' && extra.rates && typeof extra.rates === 'object') {
    supplement = extra.rates;
    // Its `time_last_update_utc` is an RFC-1123 string ("Sun, 27 Sep 2026 ..."),
    // not the ISO day Frankfurter returns, so truncating it would yield
    // "Sun, 27 Se". The Unix stamp alongside it is unambiguous, and is used to
    // build a plain YYYY-MM-DD day that reads the same as the other source's.
    const stamp = Number(extra.time_last_update_unix);
    if (Number.isFinite(stamp) && stamp > 0) {
      supplementDate = new Date(stamp * 1000).toISOString().slice(0, 10);
    }
  }

  if (select) {
    buildCurrencyOptions(select);
    select.disabled = false;
    select.addEventListener('change', () => {
      displayCurrency = select.value;
      try { window.localStorage.setItem(CURRENCY_KEY, displayCurrency); } catch { /* storage is optional */ }
      applyCurrency();
      /*
       * This has to describe what is on screen, not what was asked for. When no
       * rate could be found the prices are still in the base currency, and saying
       * "converted to EUR" over an unconverted figure is the one message that
       * would make a working fallback look like a fault.
       */
      const shown = effectiveCurrency();
      if (shown === displayCurrency) {
        const date = rateDateFor(shown);
        announce(`Prices converted to ${shown}${date ? ` using rates from ${date}` : ''}`);
      } else {
        announce(`No rate is available for ${displayCurrency}, so prices are shown in ${baseCurrency}`);
      }
    });
    // If a saved choice never became available, say so rather than quietly resetting it.
    if (displayCurrency !== effectiveCurrency()) {
      select.title = `Live rates are unavailable, so prices are shown in ${baseCurrency}`;
    }
  }

  applyCurrency();
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

/*
 * The three figures printed under a card's address.
 *
 * A house is bought on how many rooms it has and how big it is; land is bought on
 * how much ground there is and what it is zoned and titled for. Both render into
 * the same row so a grid mixing houses and parcels still lines up, and the icon
 * beside each figure changes with it.
 */
function cardSpecs(listing) {
  if (isLand(listing)) {
    const zoning = listing.land?.zoning;
    const title = listing.land?.titleDeed;
    return [
      `<span>${icon('area', 'icon--sm')}${escapeHtml(formatPlot(listing))}</span>`,
      zoning ? `<span>${icon('pin', 'icon--sm')}${escapeHtml(zoning)}</span>` : '',
      title ? `<span>${icon('check', 'icon--sm')}${escapeHtml(title)}</span>` : ''
    ].filter(Boolean).join('');
  }
  return `<span>${icon('bed', 'icon--sm')}${listing.beds} bed${listing.beds === 1 ? '' : 's'}</span>
          <span>${icon('bath', 'icon--sm')}${listing.baths} bath${listing.baths === 1 ? '' : 's'}</span>
          <span>${icon('area', 'icon--sm')}${formatArea(listing)}</span>`;
}

/*
 * The full specification table on a listing page.
 *
 * Land never has bedrooms or a build year, so those rows are dropped rather than
 * printed as zero, and the rows that actually decide a land purchase - plot size,
 * zoning, the title, and how you reach it - take their place. `type` and `status`
 * are common to both, so they are appended either way and the grid keeps its
 * eight-row shape.
 */
function detailSpecs(listing) {
  const common = `<div><dt>Property type</dt><dd>${escapeHtml(listing.type)}</dd></div>
    <div><dt>Status</dt><dd>${escapeHtml(listing.status)}</dd></div>`;

  if (isLand(listing)) {
    const land = listing.land || {};
    const access = land.access;
    return `<div><dt>Plot size</dt><dd>${escapeHtml(formatPlot(listing))}</dd></div>
      ${land.zoning ? `<div><dt>Zoning</dt><dd>${escapeHtml(land.zoning)}</dd></div>` : ''}
      ${land.titleDeed ? `<div><dt>Title</dt><dd>${escapeHtml(land.titleDeed)}</dd></div>` : ''}
      ${access ? `<div><dt>Access</dt><dd>${escapeHtml(access)}</dd></div>` : ''}
      ${land.landmarks ? `<div><dt>Landmarks</dt><dd>${escapeHtml(land.landmarks)}</dd></div>` : ''}
      ${land.utilities ? `<div><dt>Utilities</dt><dd>${escapeHtml(land.utilities)}</dd></div>` : ''}
      <div><dt>Listed on</dt><dd>${formatListed(listing.listed)}</dd></div>
      ${common}`;
  }

  return `<div><dt>Bedrooms</dt><dd>${listing.beds}</dd></div>
    <div><dt>Bathrooms</dt><dd>${listing.baths}</dd></div>
    <div><dt>Floor area</dt><dd>${formatArea(listing)}</dd></div>
    <div><dt>Plot</dt><dd>${escapeHtml(listing.lot)}</dd></div>
    <div><dt>Year built</dt><dd>${listing.year}</dd></div>
    <div><dt>Parking</dt><dd>${listing.parking} car${listing.parking === 1 ? '' : 's'}</dd></div>
    ${common}`;
}

/* ---- card template ------------------------------------------------------ */
function propertyCard(listing, options = {}) {
  const agent = agentFor(listing);
  const statusClass = listing.status === 'Sold' ? 'card--sold' : '';
  const description = options.withDescription
    ? `<p class="card-description">${escapeHtml(listing.description)}</p>`
    : '';
  return `
    <article class="property-card ${statusClass}${isHot(listing) ? ' card--hot' : ''}" data-listing="${listing.id}">
      <div class="card-media">
        <img src="${listing.image}" alt="${escapeHtml(listing.title)}" loading="lazy" width="1200" height="900" />
        <div class="card-badges">
          ${isHot(listing) ? '<span class="badge badge--hot">Hot deal</span>' : ''}
          ${listing.status === 'Sold' ? '<span class="badge badge--muted">Sold</span>' : ''}
          ${isRent(listing) ? `<span class="badge badge--accent">To rent</span>` : ''}
          ${isShortStay(listing) ? '<span class="badge badge--brand">Short stay</span>' : ''}
          ${listing.featured && !isRent(listing) ? '<span class="badge badge--solid">Featured</span>' : ''}
        </div>
        <button class="favorite-button" type="button" data-favorite="${listing.id}" aria-pressed="false" aria-label="Save this home">${icon('heart')}</button>
      </div>
      <div class="card-body">
        ${cardPriceBlock(listing)}
        <h3 class="card-title"><a href="property.html?id=${listing.id}">${escapeHtml(listing.title)}</a></h3>
        <p class="card-address">${icon('pin', 'icon--sm')}${escapeHtml(listing.address)}, ${escapeHtml(listing.city)}</p>
        <div class="card-specs">${cardSpecs(listing)}</div>
        ${shortStayNote(listing)}
        ${description}
        <div class="card-footer">
          <span class="card-agent"><span class="avatar avatar--${agent.tint}">${agent.initials}</span>${escapeHtml(agent.name)}</span>
          <a class="section-link" href="property.html?id=${listing.id}">View ${icon('arrow-right', 'icon--sm')}</a>
        </div>
      </div>
    </article>`;
}

/**
 * The price line.
 *
 * A short stay leads with the rate a visitor searching for a weekend actually
 * compares on - the night - and puts the week beside it in the quieter colour.
 * The monthly rate is still here for anyone letting for three months, which is
 * the other half of what this feature is for.
 */
function cardPriceBlock(listing) {
  const rates = shortStayRates(listing);
  if (!rates) {
    return `<p class="card-price" ${priceAttrs(listing.price, isRent(listing) ? '/ month' : '')}></p>`;
  }

  const head = rates[0];
  const rest = rates.slice(1).map((rate) => `
    <span ${priceAttrs(rate.value, ` / ${rate.unit}`, true)}></span>`).join('');

  return `
    <p class="card-price card-price--stay">
      <strong ${priceAttrs(head.value, ` / ${head.unit}`)}></strong>
      ${rest}
    </p>`;
}

/** The line under the specs: minimum stay, and the window it is open for. */
function shortStayNote(listing) {
  if (!isShortStay(listing)) return '';
  const notes = [];
  const nights = minNights(listing);
  if (nights > 1) notes.push(`Minimum ${nights} nights`);
  const window = availabilityWindow(listing);
  if (window) notes.push(window);
  if (!notes.length) return '';
  return `<p class="card-stay">${icon('calendar', 'icon--sm')}${escapeHtml(notes.join(' · '))}</p>`;
}

/* ---- theme --------------------------------------------------------------- */
/*
 * Light and dark.
 *
 * The stylesheet already knows how to do both from `prefers-color-scheme`, so
 * this does not have to be clever. What it adds is a control: a reader whose
 * system is light can still ask for dark and have it stick across pages and
 * across visits.
 *
 * The preference is resolved to a concrete `data-theme` rather than left as
 * "follow the system", so every rule downstream reads one attribute instead of
 * branching on a media query. A tiny inline script in each page head has already
 * set that attribute before first paint - this only picks it up, wires the
 * button, and keeps following the system while the reader has not said otherwise.
 */
const THEME_KEY = 'northwind:theme';
const THEME_META = { light: '#0f423a', dark: '#0d1113' };

const SUN_GLYPH = '<svg class="icon icon--sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/></svg>';
const MOON_GLYPH = '<svg class="icon icon--moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>';

function initTheme() {
  const system = window.matchMedia('(prefers-color-scheme: dark)');

  // Read the preference here as well as in the head script. The head script is
  // what prevents a flash of the wrong theme; this is what makes the toggle work
  // even if that script did not run, or if another tab changed the preference.
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* storage off */ }
  if (stored !== 'light' && stored !== 'dark') stored = null;

  // Still tracking the system, because no choice has been made in this browser.
  let following = stored === null;

  let button = $('.theme-toggle');
  let current = stored
    || document.documentElement.dataset.theme
    || (system.matches ? 'dark' : 'light');

  function apply(value) {
    current = value;
    document.documentElement.dataset.theme = value;

    // The address bar colour on mobile follows the page, so it has to follow too.
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_META[value]);

    if (button) {
      const next = value === 'dark' ? 'light' : 'dark';
      const label = `Switch to ${next} theme`;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }

  apply(current);

  system.addEventListener?.('change', (event) => {
    if (following) apply(event.matches ? 'dark' : 'light');
  });

  // The button is added here rather than in the markup so that every page gets
  // it without the five copies of the header being kept in step by hand.
  const host = $('.header-actions');
  if (host && !button) {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'icon-button theme-toggle';
    control.innerHTML = `${SUN_GLYPH}${MOON_GLYPH}`;
    control.addEventListener('click', () => {
      following = false;
      const next = current === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(THEME_KEY, next); } catch { /* lasts one page */ }
      announce(`Switched to ${next} theme`);
    });
    host.append(control);
    // Assigned before apply() so the new button is described and labelled, not
    // just appended.
    button = control;
  }

  apply(current);
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

  // Hot deals, if there are any. A promotion that has run out is not hot any
  // more, so isHot() filters them on their own and this can simply check whether
  // anything survived. The section stays hidden otherwise.
  const hotSection = $('#hot-section');
  const hotGrid = $('#hot-grid');
  if (hotSection && hotGrid) {
    const hot = listings
      .filter((listing) => isHot(listing) && listing.status !== 'Sold')
      .slice(0, 3);
    if (hot.length) {
      hotGrid.innerHTML = hot.map((listing) => propertyCard(listing)).join('');
      hotSection.hidden = false;
    }
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
      { money: totalValue, compact: true, label: 'Current inventory value' },
      { value: '11', label: 'Average days on market' },
      { value: '98%', label: 'Asking price achieved' }
    ];
    statBand.innerHTML = stats.map((stat) => {
      const value = stat.money === undefined
        ? `<strong>${stat.value}</strong>`
        : `<strong ${priceAttrs(stat.money, '', stat.compact)}></strong>`;
      return `<div>${value}<span>${stat.label}</span></div>`;
    }).join('');
  }
}

const HERO_SLIDE_MS = 6500;

/**
 * assets/homes/ is not only artwork of the homes. It also holds mockups left in
 * the folder by other work - a billboard, a cap logo, a t-shirt, a sticker - and
 * one listing still points its `image` at the billboard. Those are not
 * photographs of anything being sold here, so they are kept out of the hero by
 * name. Real photography dropped into the folder needs nothing added here: it is
 * used as it comes, which is the swap the README asks for.
 */
const NOT_A_HOME = /billboard|logo|tshirt|shirt|sticker|keyring|cap-wirh/i;

/*
 * The hero slideshow.
 *
 * The hero was a flat green wash, which said nothing about what was actually on
 * sale. It now cycles the portfolio's own photography behind the headline. The
 * frames are built from the listings rather than listed out here, so real
 * photographs, pointed at by `image` and sized 16:10 as README:130 describes,
 * appear behind the hero with no further change to this file.
 *
 * The accessibility this site already insists on is kept, and a moving background
 * earns three obligations that a still does not: it does not move at all for a
 * reader who has asked for reduced motion, it holds still while it is being
 * hovered or focused, and it can be stopped outright by a button rather than only
 * by a timer nobody can reach.
 */
function initHeroSlideshow() {
  const layer = $('[data-hero-slides]');
  const slider = $('.hero-slider');
  const dots = $('[data-hero-dots]');
  const caption = $('[data-hero-caption]');
  if (!layer || !slider || !dots || !caption) return;

  // One frame per distinct image. The portfolio reuses photographs between
  // listings, and the placeholder set is six files across twelve listings, so
  // without this the hero would show the same picture twice in a row.
  const slides = [];
  const seen = new Set();
  listings.forEach((listing) => {
    const image = listing.image;
    if (listing.status === 'Sold' || !image || seen.has(image) || NOT_A_HOME.test(image)) return;
    seen.add(image);
    slides.push(listing);
  });

  // A single frame is a photograph, not a slideshow, and there would be nothing
  // for the controls to do. Leave the hero as the plain background.
  if (slides.length < 2) return;

  layer.innerHTML = slides.map((listing, index) => `
    <div class="hero-slide${index === 0 ? ' is-active' : ''}">
      <img src="${escapeHtml(listing.image)}" alt="" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async" />
    </div>`).join('');

  dots.innerHTML = slides.map((listing, index) => `
    <button class="hero-dot" type="button" data-goto="${index}" aria-label="Show ${escapeHtml(listing.title)}"${index === 0 ? ' aria-current="true"' : ''}></button>`).join('');

  const frames = $$('.hero-slide', layer);
  const dotButtons = $$('.hero-dot', dots);
  const prev = $('[data-hero-prev]');
  const next = $('[data-hero-next]');
  const toggle = $('[data-hero-toggle]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let index = 0;
  let timer = null;
  let playing = false;

  function paint(target) {
    index = (target + frames.length) % frames.length;
    frames.forEach((frame, i) => frame.classList.toggle('is-active', i === index));
    dotButtons.forEach((dot, i) => {
      if (i === index) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
    const listing = slides[index];
    caption.textContent = `${listing.title} · ${listing.city}`;
    caption.href = `property.html?id=${encodeURIComponent(listing.id)}`;
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (!playing || reduceMotion.matches) return;
    timer = setInterval(() => paint(index + 1), HERO_SLIDE_MS);
  }

  function setPlaying(value) {
    playing = value;
    toggle.setAttribute('aria-pressed', String(!playing));
    toggle.setAttribute('aria-label', playing ? 'Pause the slideshow' : 'Play the slideshow');
    toggle.innerHTML = icon(playing ? 'pause' : 'play', 'icon--fill');
    schedule();
  }

  // Only now, with the dots built, is the control row worth showing.
  slider.hidden = false;
  paint(0);
  setPlaying(!reduceMotion.matches);

  // Every deliberate move restarts the clock, so a slideshow someone is actually
  // reading does not swap out from under them.
  prev.addEventListener('click', () => { paint(index - 1); schedule(); });
  next.addEventListener('click', () => { paint(index + 1); schedule(); });
  toggle.addEventListener('click', () => setPlaying(!playing));

  dots.addEventListener('click', (event) => {
    const dot = event.target.closest('.hero-dot');
    if (!dot) return;
    paint(Number(dot.dataset.goto));
    schedule();
  });

  // Hold still while a pointer is on it or focus is inside it - somebody reaching
  // for the pause button should not have the frame change under their cursor.
  const hold = () => { clearInterval(timer); timer = null; };
  slider.addEventListener('mouseenter', hold);
  slider.addEventListener('mouseleave', schedule);
  slider.addEventListener('focusin', hold);
  slider.addEventListener('focusout', schedule);

  // Same in a background tab, where nobody is watching it anyway.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hold();
    else schedule();
  });

  // Turning reduced motion on mid-visit should stop it, not just slow it down.
  const onMotionChange = () => setPlaying(!reduceMotion.matches);
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);
  else reduceMotion.addListener(onMotionChange);
}

function initSearchPanel() {
  const panel = $('#hero-search');
  if (!panel) return;

  let intent = 'sale';
  const tabs = $$('.search-tab', panel);
  const budgetField = $('[name="budget"]', panel);

  // The numbers in these bands are base-currency amounts, so the query string a
  // search produces means the same thing in every currency. The labels below are
  // only the starting text — paintBudgetLabels() rewords them on boot and
  // whenever the visitor changes currency.
  const budgetOptions = {
    sale: [['', 'Any budget'], ['0-750000', 'Up to $750k'], ['750000-1500000', '$750k – $1.5M'], ['1500000-2500000', '$1.5M – $2.5M'], ['2500000-5000000', '$2.5M – $5M']],
    rent: [['', 'Any rent'], ['0-2500', 'Up to $2,500'], ['2500-4000', '$2,500 – $4,000'], ['4000-', '$4,000+']],
    // Land is priced by the parcel and its paperwork rather than by the rooms it
    // will hold, so it gets bands an acre of ground actually falls into.
    land: [['', 'Any budget'], ['0-2500000', 'Up to $2.5M'], ['2500000-7500000', '$2.5M – $7.5M'], ['7500000-20000000', '$7.5M – $20M'], ['20000000-', '$20M+']],
    // A short stay is budgeted by the night, because that is what somebody
    // planning a weekend is actually shopping for. The bands are matched against
    // nightlyRate() rather than against the monthly price, so a three-month let
    // priced at its monthly rate is still found by the right search.
    short: [['', 'Any nightly rate'], ['0-100', 'Up to $100 a night'], ['100-200', '$100 – $200 a night'], ['200-350', '$200 – $350 a night'], ['350-', '$350+ a night']]
  };

  const renderBudget = () => {
    budgetField.innerHTML = budgetOptions[intent]
      .map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`)
      .join('');
    paintBudgetLabels(budgetField);
  };

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    intent = tab.dataset.intent;
    tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
    // Land is a category as well as an intent, so the type list is trimmed to the
    // group that can actually match rather than left offering apartments. A short
    // stay is the same idea: you cannot spend a weekend on a parcel of land, so
    // the land half of the type list goes too.
    const landOnly = intent === 'land';
    const homesOnly = intent === 'short';
    $$('[name="type"] option[data-group]', panel).forEach((option) => {
      option.hidden = (landOnly && option.dataset.group !== 'land')
        || (homesOnly && option.dataset.group !== 'home');
    });
    renderBudget();
  }));

  renderBudget();

  $('form', panel).addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    const query = String(data.get('query') || '').trim();
    const budget = String(data.get('budget') || '');
    const type = String(data.get('type') || '');
    if (query) params.set('q', query);
    // Land is sold, never rented, so the Land tab is a category filter rather than
    // a status: it means "parcels of ground, for sale".
    if (intent === 'land') params.set('kind', 'land');
    if (intent === 'rent') params.set('status', 'For rent');
    // A short stay is a rental that also accepts a shorter term, so it needs both
    // halves: the status, because these are all "For rent", and the kind, because
    // without it a visitor looking for a weekend gets every long let as well.
    if (intent === 'short') { params.set('kind', 'short'); params.set('status', 'For rent'); }
    if (type) params.set('type', type);
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
    const value = (key) => (clearedFromUrl.has(key) ? '' : (params.get(key) || ''));
    return {
      q: value('q'),
      kind: value('kind'),
      type: value('type'),
      status: value('status'),
      budget: value('budget'),
      beds: value('beds'),
      term: value('term'),
      hot: value('hot'),
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
    // `kind` narrows to a whole category, and it is deliberately not exclusive of
    // `type`: picking "Land" with "Agricultural land" chosen means agricultural
    // land, and the type box is already restricted to that group by the form.
    if (state.kind === 'land' && !isLand(listing)) return false;
    if (state.kind === 'home' && isLand(listing)) return false;
    // "Short" is a rental that also accepts a shorter term, so it implies the
    // rental status rather than replacing it: a weekend cannot be bought.
    if (state.kind === 'short' && (!isRent(listing) || !isShortStay(listing))) return false;
    if (state.hot && !isHot(listing)) return false;
    if (state.status && listing.status !== state.status) return false;
    if (state.type && listing.type !== state.type) return false;
    // The term box only narrows within short stays. Left applying to everything it
    // would silently hide every ordinary let whenever a shared URL carried it, so
    // it is treated as a leftover unless the search is already about short stays.
    if (state.term && isShortStay(listing) && !listing.stays.includes(state.term)) return false;
    // Bedrooms are a house fact. A land parcel stores zero there, so asking for
    // "3+ beds" over land would match nothing - the bedroom control is hidden
    // while the Land category is on, and a shared URL that still carries it is
    // treated as a leftover rather than as a filter.
    if (state.beds && !isLand(listing) && listing.beds < Number(state.beds)) return false;
    if (state.q) {
      const haystack = `${listing.title} ${listing.address} ${listing.city} ${listing.type} ${listing.land?.zoning || ''}`.toLowerCase();
      if (!haystack.includes(state.q.toLowerCase())) return false;
    }
    if (state.budget) {
      const [min, max] = state.budget.split('-').map(Number);
      // A short-stay search budgets by the night and everything else budgets by
      // the price on the listing, which for a rental is the month. Same control,
      // two different numbers behind it.
      const amount = state.kind === 'short' ? nightlyRate(listing) : listing.price;
      if (amount < min) return false;
      if (max && amount > max) return false;
    }
    return true;
  };

  const sorters = {
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    newest: (a, b) => b.listed.localeCompare(a.listed),
    'area-desc': (a, b) => {
      // "Size" means plot size for land and floor area for a house, so each is
      // compared with its own listing rather than across the two.
      const sizeOf = (item) => (isLand(item) ? Number(item.land?.plotAcres) || 0 : item.area || 0);
      return sizeOf(b) - sizeOf(a);
    },
    // A live hot deal outranks a featured one, because isHot() already knows the
    // promotion has run out and stops treating it as hot on its own.
    featured: (a, b) => Number(isHot(b)) - Number(isHot(a))
      || Number(b.featured) - Number(a.featured)
      || b.listed.localeCompare(a.listed)
  };

  const describeChips = (state) => {
    const chips = [];
    if (state.q) chips.push({ key: 'q', label: `“${state.q}”` });
    if (state.kind) {
      const kindLabel = { land: 'Land', short: 'Short stay', home: 'Homes' }[state.kind] || 'Homes';
      chips.push({ key: 'kind', label: kindLabel });
    }
    if (state.type) chips.push({ key: 'type', label: state.type });
    if (state.status) chips.push({ key: 'status', label: state.status });
    if (state.term) chips.push({ key: 'term', label: `${state.term} stays` });
    if (state.beds) chips.push({ key: 'beds', label: `${state.beds}+ beds` });
    if (state.hot) chips.push({ key: 'hot', label: 'Hot deals only' });
    if (state.budget) {
      const selected = $(`[name="budget"] option[value="${state.budget}"]`)?.textContent;
      chips.push({ key: 'budget', label: selected || state.budget });
    }
    return chips;
  };

  /*
   * Keep the two controls that only make sense for one category in step with the
   * category box.
   *
   * "Bedrooms" is meaningless for a parcel of ground, so it is hidden rather than
   * left on screen to be ignored, and the property-type list is trimmed to the
   * group that can actually match. Hiding is done with the `hidden` attribute on
   * each <option>, so the untrimmed list is still in the HTML for anyone arriving
   * with JavaScript switched off.
   */
  const syncCategoryControls = (state) => {
    const bedsField = $('[data-beds-field]', form);
    if (bedsField) {
      const onLand = state.kind === 'land';
      bedsField.hidden = onLand;
      const bedsControl = form.elements.beds;
      // Drop a bedroom minimum left over from the houses when switching to land,
      // or it would sit in the URL describing something the visitor cannot see.
      if (onLand && bedsControl) bedsControl.value = '';
    }

    // The term box belongs to short stays alone. On any other category it would be
    // a control that cannot narrow anything, so it is hidden and cleared rather
    // than left on screen to be ignored.
    const termField = $('[data-term-field]', form);
    if (termField) {
      termField.hidden = state.kind !== 'short';
      const termControl = form.elements.term;
      if (state.kind !== 'short' && termControl) termControl.value = '';
    }

    $$('[name="type"] option[data-group]', form).forEach((option) => {
      // "short" is a category of homes, not a third group of type, so it is
      // expressed as "homes only" rather than as a group of its own.
      const group = state.kind === 'short' ? 'home' : state.kind;
      option.hidden = Boolean(state.kind) && option.dataset.group !== group;
    });
  };

  function render() {
    const state = readState();
    syncCategoryControls(state);
    const results = listings.filter((listing) => matches(listing, state)).sort(sorters[state.sort]);

    grid.innerHTML = results.slice(0, visible).map((listing) => propertyCard(listing, { withDescription: view === 'list' })).join('');
    paintPrices(grid);
    grid.classList.toggle('is-list', view === 'list');
    // "N homes found" was written before land existed. Counting whichever category is
    // on screen keeps the sentence honest in every filter combination.
    const noun = state.kind === 'land' ? 'plot' : state.kind === 'short' ? 'short stay' : state.kind === 'home' ? 'home' : 'listing';
    countLabel.innerHTML = `<strong>${results.length}</strong> ${noun}${results.length === 1 ? '' : 's'} found`;
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
    // The URL now carries the cleaned state, so the record of what was just
    // cleared has done its job and must not suppress a filter put back later.
    clearedFromUrl.clear();
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
    const key = button.dataset.clear;
    const control = form.elements[key];
    if (control) control.value = '';
    // Remembered either way: a chip with no control behind it would otherwise
    // reappear on the next render, because the URL still carried the filter.
    clearedFromUrl.add(key);
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

  // A filter chip copies its wording from the budget option it came from, so
  // changing currency has to rebuild the chips, not just repaint the prices.
  repaintPrices = render;
  render();
}

/**
 * The rates table on a short stay.
 *
 * Every rate carries its own unit, because a night and a month are not the same
 * purchase and pretending otherwise is how a weekend ends up looking like a
 * bargain. The note underneath says the two things a visitor cannot infer from
 * the numbers: the shortest booking, and the window the place is actually open.
 */
function ratesTable(listing) {
  const rates = shortStayRates(listing);
  if (!rates) return '';

  const rows = rates.map((rate) => `
    <div class="rates-row">
      <dt>Per ${rate.unit.replace(/s$/, '')}</dt>
      <dd ${priceAttrs(rate.value)}></dd>
    </div>`).join('');

  const notes = [];
  const nights = minNights(listing);
  if (nights > 1) notes.push(`Minimum stay ${nights} nights`);
  const window = availabilityWindow(listing);
  if (window) notes.push(window);

  return `
    <section class="detail-section">
      <h2>Rates</h2>
      <dl class="rates">
        ${rows}
        ${notes.length ? `<div class="rates-note">${icon('calendar', 'icon--sm')}${escapeHtml(notes.join(' · '))}</div>` : ''}
      </dl>
    </section>`;
}

/** The promotion banner. Says what the promotion is, not just that there is one. */
function hotBanner(listing) {
  if (!isHot(listing)) return '';
  const until = listing.hotUntil
    ? ` · ends ${new Date(`${listing.hotUntil}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
    : '';
  const stay = isShortStay(listing) ? ' on a short stay' : '';
  return `<p class="hot-banner">${icon('sparkle', 'icon--sm')} Hot deal${stay}${until}</p>`;
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
        <p class="gone-note">The listing may have sold or been withdrawn. Browse everything currently on the market instead.</p>
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
        ${hotBanner(listing)}
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
            <p class="detail-price" ${priceAttrs(listing.price, isRent(listing) ? 'per month' : `· listed ${formatListed(listing.listed)}`)}></p>
          </div>
          <div class="detail-actions">
            <button class="favorite-button" type="button" data-favorite="${listing.id}" aria-pressed="false" aria-label="Save this home">${icon('heart')}</button>
            <button class="button button--secondary" type="button" data-share>${icon('share', 'icon--sm')} Share</button>
          </div>
        </div>

        ${ratesTable(listing)}

        <dl class="spec-grid">${detailSpecs(listing)}</dl>

        <section class="detail-section">
          <h2>${isLand(listing) ? 'About this plot' : 'About this home'}</h2>
          <p class="prose prose--spaced">${escapeHtml(listing.description)}</p>
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
        <h2 class="detail-subhead" id="agent-name">${escapeHtml(agent.name)}</h2>
        <p class="agent-role">${escapeHtml(agent.role)}</p>
        <p>${escapeHtml(agent.bio)}</p>
        <div class="agent-meta">
          <a href="tel:${agent.phone.replace(/[^+\d]/g, '')}">${icon('phone', 'icon--sm')}${escapeHtml(agent.phone)}</a>
          <a href="mailto:${agent.email}">${icon('mail', 'icon--sm')}${escapeHtml(agent.email)}</a>
          <span>${icon('home', 'icon--sm')}${agent.listings} sales on record</span>
        </div>
        <button class="button button--primary button--block" type="button" data-viewing>Book a viewing</button>
        <a class="button button--ghost button--block detail-ask" href="contact.html">Ask a question</a>
      </aside>
    </div>
    <div id="similar-mount"></div>

    <dialog class="dialog" id="viewing-dialog" aria-labelledby="viewing-title">
      <form class="dialog-shell" id="viewing-form">
        <!-- Honeypot: hidden from people, filled in by spam bots. -->
        <input type="text" name="botcheck" tabindex="-1" autocomplete="off" aria-hidden="true" />
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
// First, because everything after it paints tokens off the root element.
initTheme();
applySiteSettings();
initHeader();
renderHome();
initHeroSlideshow();
initSearchPanel();
initResults();
initDetail();
initForms();
initFooter();
syncFavoriteButtons();

// Last, because the currency layer paints prices and so needs every list already
// in the document. The first pass draws the base currency straight away; a
// converted one replaces it as soon as the rates arrive.
initCurrency().catch(() => { /* the base-currency pass already ran */ });

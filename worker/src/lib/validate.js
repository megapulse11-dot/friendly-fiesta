/*
 * Validation for agent submissions.
 *
 * Everything an agent sends passes through here before it reaches D1, and the
 * shape that comes out is exactly the shape data.json uses. That is deliberate:
 * approval then becomes a straight copy instead of a translation, so a field
 * added to the website later needs no change here.
 *
 * Two rules run through all of it:
 *
 *   - Numbers are numbers. Every numeric field is parsed with Number() and
 *     checked with Number.isFinite, so a price is stored as the number it
 *     represents rather than as text that later sorts as a string.
 *   - Text is trimmed, stripped of control characters and cut to a limit. No
 *     value is ever stored at whatever length it arrived.
 */

// Mirrors HOME_TYPES and LAND_TYPES in the website's app.js. A type outside
// these falls through both isLand() and the filter lists and renders as a
// broken card, so the list is enforced here rather than trusted.
export const HOME_TYPES = ['House', 'Apartment', 'Townhouse', 'Villa', 'Loft'];
export const LAND_TYPES = [
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

export const STATUSES = ['For sale', 'For rent', 'Sold'];
export const PLOT_UNITS = ['acres', 'hectares', 'sq m'];

const LIMITS = {
  title: 120,
  address: 200,
  city: 80,
  type: 40,
  status: 20,
  lot: 40,
  description: 4000,
  features: 12,
  // One sentence's worth. The cancellation terms are shown verbatim on the rates
  // table, so this is a real display limit rather than a storage one - a longer
  // term would wrap over three lines beside a deposit figure.
  cancellation: 200
};

const LAND_LIMITS = {
  zoning: 60,
  titleDeed: 60,
  access: 120,
  landmarks: 240,
  utilities: 240
};

/** Strip control characters (which can carry terminal escapes) and trim. */
export function clean(value, max) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * A whole number within an inclusive range, or `fallback`.
 *
 * `fallback` rather than an error, because for most numeric fields a missing
 * value is normal - a plot of land has no bedrooms - and the office would rather
 * see 0 than an error the agent cannot act on.
 */
export function wholeNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/**
 * Price is the one numeric field that must be present and plausible, so it is
 * checked separately: a listing at zero or at ninety billion is a typo, and
 * silently storing it would publish a wrong number on the public site.
 */
export function priceValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < 1 || rounded > 1_000_000_000_000) return null;
  return rounded;
}

/**
 * Features are a list of short phrases. A submitted array is capped and cleaned;
 * a comma-separated string is accepted too, because that is what people paste.
 */
export function featureList(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value === null || value === undefined ? '' : value)
        .split(/[\n,]/)
        .map((item) => item.trim());
  const cleaned = parts
    .map((item) => clean(item, 80))
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, LIMITS.features);
}

/** A listing is land when its type says so, matching isLand() in app.js. */
export const isLandType = (type) => LAND_TYPES.includes(type);

/**
 * The lengths of stay a listing will accept, in the order the site shows them.
 *
 * Anything unrecognised is dropped rather than stored. An agent can send any
 * JSON they like, and a term nobody recognises would be a string the website
 * silently ignores while still deciding the listing is a short stay - which is
 * exactly the kind of half-state that shows up later as an empty rates table.
 */
export const STAY_TERMS = ['Nightly', 'Weekly', 'Monthly'];

export function stayTerms(value) {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.map((term) => (typeof term === 'string' ? term.trim() : '')));
  return STAY_TERMS.filter((term) => wanted.has(term));
}

/**
 * An ISO calendar date, or nothing.
 *
 * Checked rather than cleaned, because this ends up in a Date and a string like
 * "next Friday" or "2026-13-45" would become a real date on the page or an
 * Invalid Date that renders as "NaN".
 *
 * The round trip has to be compared, not merely taken. JavaScript does not
 * reject an impossible day - `new Date('2026-02-30')` is the 2nd of March, not
 * an Invalid Date - so parsing alone would quietly accept 30 February and store
 * a date nobody wrote. Reading the value back out and requiring it to match is
 * what actually rejects it.
 */
export function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const trimmed = value.trim();
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === trimmed ? trimmed : null;
}

/* ---- a listing ------------------------------------------------------------ */

/**
 * Validate one submission body.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, error }` - one message, shown
 * to the agent, naming the first field that is wrong. Collecting every problem
 * at once would be friendlier, but it also means echoing a whole invalid
 * payload back into a form; one clear message is easier to act on and keeps this
 * function's contract simple.
 */
export function validateListing(body) {
  const source = body && typeof body === 'object' ? body : {};

  const title = clean(source.title, LIMITS.title);
  if (title.length < 4) {
    return { ok: false, error: 'Give the listing a title of at least 4 characters.' };
  }

  const type = clean(source.type, LIMITS.type);
  if (![...HOME_TYPES, ...LAND_TYPES].includes(type)) {
    return { ok: false, error: 'Choose whether this is a home or a type of land.' };
  }

  const status = clean(source.status, LIMITS.status);
  if (!STATUSES.includes(status)) {
    return { ok: false, error: 'Choose a status: for sale, for rent or sold.' };
  }

  const price = priceValue(source.price);
  if (price === null) {
    return { ok: false, error: 'Enter a price between 1 and 1,000,000,000,000.' };
  }

  const description = clean(source.description, LIMITS.description);
  if (description.length < 20) {
    return { ok: false, error: 'Write at least 20 characters describing the property.' };
  }

  const land = isLandType(type);
  const value = {
    title,
    type,
    status,
    price,
    description,
    address: clean(source.address, LIMITS.address),
    city: clean(source.city, LIMITS.city),
    lot: clean(source.lot, LIMITS.lot),
    // Never taken from the request. A listing being featured puts it in the
    // largest, most prominent slot on the home page, which is a decision for
    // the office, not something an agent can set by hand.
    featured: false,
    features: featureList(source.features),
    images: []
  };

  /*
   * Short stays and promotions.
   *
   * Both are optional, and both are dropped rather than rejected when they do
   * not make sense: an agent filling in a rental form is not trying to break
   * anything, and refusing a whole listing because a nightly rate was left
   * blank would be a worse outcome than storing a listing without one.
   *
   * The same reasoning keeps `hot` away from the agent. A promotion is a
   * commercial decision with a date attached, and the office is the only body
   * that should be setting "this is hot until the 20th".
   */
  const stays = stayTerms(source.stays);
  if (stays.length) {
    value.stays = stays;
    // A nightly or weekly rate is only stored when it is actually a number. The
    // website derives anything left out from the monthly price, so a blank here
    // is a valid answer rather than a missing one.
    const nightly = priceValue(source.nightly);
    const weekly = priceValue(source.weekly);
    if (nightly !== null) value.nightly = nightly;
    if (weekly !== null) value.weekly = weekly;
    const minNights = wholeNumber(source.minNights, 1, 365, 0);
    if (minNights) value.minNights = minNights;

    /*
     * The figures a guest cannot work out for themselves.
     *
     * A short stay is quoted per night, and what decides what a week actually
     * costs is everything the nightly rate does not cover: the deposit held
     * against the property, the cleaning fee charged once, the service fee, and
     * the booking fee added to the first payment. All optional - plenty of
     * owners take none of them, and a listing that says nothing about them is
     * not incomplete, just straightforward.
     *
     * Capped rather than merely range-checked, one cap per figure rather than one
     * shared: a deposit is a multiple of the stay and a booking fee is not, so an
     * agent typing six zeroes into either field should be told rather than
     * published. Absent stays absent - a stored 0 would render as "no cleaning
     * fee", which is a promise the office never made.
     */
    const deposit = priceValue(source.deposit);
    if (deposit !== null) {
      if (deposit > 50_000_000) {
        return { ok: false, error: 'The deposit looks too large - check the figure.' };
      }
      value.deposit = deposit;
    }

    const cleaningFee = priceValue(source.cleaningFee);
    if (cleaningFee !== null) {
      if (cleaningFee > 1_000_000) {
        return { ok: false, error: 'The cleaning fee looks too large - check the figure.' };
      }
      value.cleaningFee = cleaningFee;
    }

    const serviceFee = priceValue(source.serviceFee);
    if (serviceFee !== null) {
      if (serviceFee > 1_000_000) {
        return { ok: false, error: 'The service fee looks too large - check the figure.' };
      }
      value.serviceFee = serviceFee;
    }

    const bookingFee = priceValue(source.bookingFee);
    if (bookingFee !== null) {
      if (bookingFee > 1_000_000) {
        return { ok: false, error: 'The booking fee looks too large - check the figure.' };
      }
      value.bookingFee = bookingFee;
    }

    /*
     * Cancellation, as free text or as a number of days.
     *
     * Both are accepted because both are real: a number is the common case and
     * the site turns it into a sentence, while free text is needed for terms a
     * number cannot express ("balance due on arrival, non-refundable"). Text
     * wins on the site when both are sent.
     */
    const cancellation = clean(source.cancellation, LIMITS.cancellation);
    if (cancellation) value.cancellation = cancellation;

    const cancellationDays = wholeNumber(source.cancellationDays, 1, 365, 0);
    if (cancellationDays) value.cancellationDays = cancellationDays;
  }

  const availableFrom = isoDate(source.availableFrom);
  if (availableFrom) value.availableFrom = availableFrom;
  const availableTo = isoDate(source.availableTo);
  if (availableTo) value.availableTo = availableTo;

  /*
   * A parcel has no rooms, so bedrooms, bathrooms, floor area, year and parking
   * are forced to zero rather than accepted. The website's land cards read plot
   * size instead, and storing a bedroom count on land is how a listing ends up
   * filtering under "3 beds" for a field of grass.
   */
  if (land) {
    value.beds = 0;
    value.baths = 0;
    value.area = 0;
    value.year = 0;
    value.parking = 0;

    const plot = source.land && typeof source.land === 'object' ? source.land : {};
    const plotAcres = wholeNumber(plot.plotAcres !== undefined ? plot.plotAcres : plot.plot, 0, 10000000, 0);
    if (!plotAcres) {
      return { ok: false, error: 'Enter the plot size, in the unit you chose.' };
    }

    const plotUnit = clean(plot.plotUnit, 20);
    value.land = {
      plotAcres,
      plotUnit: PLOT_UNITS.includes(plotUnit) ? plotUnit : 'acres',
      zoning: clean(plot.zoning, LAND_LIMITS.zoning),
      titleDeed: clean(plot.titleDeed, LAND_LIMITS.titleDeed),
      access: clean(plot.access, LAND_LIMITS.access),
      landmarks: clean(plot.landmarks, LAND_LIMITS.landmarks),
      utilities: clean(plot.utilities, LAND_LIMITS.utilities)
    };

    /*
     * The website's land card shows `lot` as the headline figure, and the README
     * calls for it to be kept in step with plotAcres - so it is derived here
     * rather than typed twice and left to drift.
     */
    value.lot = plotAcres + ' ' + value.land.plotUnit;
  } else {
    value.beds = wholeNumber(source.beds, 0, 99, 0);
    value.baths = wholeNumber(source.baths, 0, 99, 0);
    value.area = wholeNumber(source.area, 0, 1000000, 0);
    value.year = wholeNumber(source.year, 0, 2100, 0);
    value.parking = wholeNumber(source.parking, 0, 99, 0);
  }

  return { ok: true, value };
}

/* ---- an account ----------------------------------------------------------- */

/** Email, deliberately conservative: one @, no spaces, a dot in the domain. */
export function normaliseEmail(value) {
  const email = clean(value, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return null;
  return email;
}

/**
 * Password rules, stated the same way the sign-up form states them.
 *
 * The floor is deliberately modest. This is an account an agent makes for
 * themselves to upload listings they already work on; it is not a bank token.
 * The real protection is that the only thing the user can choose is a password,
 * so the server enforces a minimum rather than trusting the form to have done it.
 */
export function checkPassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 10) {
    return { ok: false, error: 'Use a password of at least 10 characters.' };
  }
  if (password.length > 200) {
    return { ok: false, error: 'That password is longer than 200 characters.' };
  }
  return { ok: true };
}

/** A display name, cleaned to a single line of ordinary text. */
export function cleanName(value) {
  return clean(value, 80).replace(/\s+/g, ' ');
}

#!/usr/bin/env node
/**
 * Pre-render one static page per listing, into property/.
 *
 *   node scripts/build-property-pages.mjs          write the pages
 *   node scripts/build-property-pages.mjs --check  fail if any are stale
 *
 * The problem this solves
 *
 * property.html serves every listing on the site. It is one file, and the only
 * thing in it that says which house it is arrives from ?id= after JavaScript has
 * run. So the raw HTML carries a generic title, a generic description, a generic
 * canonical URL and no <h1> at all - and app.js rewrites all four in the browser
 * for whoever is looking at it.
 *
 * That is fine for a person and poor for everything else. A crawler that does
 * run JavaScript sees the corrected version, but only after a round trip it may
 * not bother with. A link preview - Facebook, Slack, iMessage, LinkedIn - is
 * fetched by a server that never runs JavaScript at all, so a shared link to a
 * specific house shares a link called "Property details". And the canonical URL
 * in the served HTML points at property.html with no id, which is the one case
 * where telling a crawler two things about the same content is actively harmful.
 *
 * GitHub Pages serves files and nothing else, so the only way to give each
 * listing a real page is to write those files. That is what this does.
 *
 * What it produces, and why it is not a fork of property.html
 *
 * The generated page is the same markup app.js would have produced, written into
 * the same shell. That means:
 *
 *   - one H1, the title, a description, a canonical, Open Graph and JSON-LD, all
 *     in the raw HTML, readable without executing anything
 *   - the same class names, so the page looks identical the moment it loads
 *   - the same JavaScript, so clicking around still works
 *
 * It is generated rather than hand-maintained, and re-run whenever the content
 * changes - for the same reason the sitemap is. Fourteen files kept in step with
 * data.json by hand would be fourteen chances to be wrong.
 *
 * The URL scheme is property/<id>.html, and the published canonical points at it.
 * property.html?id= keeps working for every old link: app.js rewrites its
 * canonical to the pre-rendered twin, so the two never compete.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(site, 'property');

export const ORIGIN = 'https://megapulse11-dot.github.io/friendly-fiesta/';

/** The canonical address of a listing's pre-rendered page. */
export const propertyPath = (id) => `property/${id}.html`;
export const propertyUrl = (id) => `${ORIGIN}${propertyPath(id)}`;

const read = (name) => readFileSync(join(site, name), 'utf8');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const numberFormat = new Intl.NumberFormat('en-US');
const money = (amount, currency) => new Intl.NumberFormat('en', {
  style: 'currency', currency, maximumFractionDigits: 0
}).format(amount);
const listed = (value) => new Date(`${value}T00:00:00`)
  .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const LAND_TYPES = ['Virgin land', 'Residential land', 'Agricultural land', 'Commercial land',
  'Industrial land', 'Beachfront land', 'Ranch land', 'Orchard land', 'Mixed-use land', 'Plot'];
const isLand = (listing) => Boolean(listing.land) || LAND_TYPES.includes(listing.type);

/**
 * Move a same-directory reference out one level.
 *
 * The generated pages live in property/, so `styles.css` has to become
 * `../styles.css`.
 *
 * This runs on the template only, before any page-specific body is written into
 * it. Running it afterwards would prefix the paths the body already wrote
 * correctly - `../index.html` became `../../index.html`, which resolves above the
 * site root and 404s.
 *
 * The closing quote has to be captured rather than assumed. Several tags here
 * are self-closing - `<link ... />`, and `<script src="..." />` - and a pattern
 * that matched up to the next double quote swallowed the slash and produced
 * `<script src="../theme.js></script>` and `href="../styles.css />`, which is
 * broken markup that still passes a substring check for the right filename. The
 * attribute value is taken as everything up to the next quote, slash or space.
 *
 * Only href and src are touched, and the negative lookahead keeps anything
 * already absolute, rooted or non-navigational out of it - so the canonical, the
 * og:url and the JSON-LD URLs stay exactly as written.
 */
const toParent = (html) => html.replace(
  /(\s(?:href|src)=")(?!https?:|mailto:|tel:|#|\/|\.\.\/)([^"\s/]+)/g,
  (match, prefix, path) => `${prefix}../${path}`
);

/**
/* ---- the head -------------------------------------------------------------- */

/** The description a crawler and a link preview will read. */
const describe = (listing, currency) =>
  `${listing.title} — ${listing.beds} bed ${listing.type.toLowerCase()} in ${listing.city}. `
  + `${money(listing.price, currency)}`;

/**
 * The <head> for one listing: title, description, canonical, Open Graph, and the
 * structured data describing the house itself.
 *
 * The listing JSON-LD is the same shape app.js builds at runtime, moved here so
 * it is in the served HTML rather than arriving after JavaScript. Both remain:
 * app.js rewrites these on a pre-rendered page too, and the values agree, so
 * nothing flickers.
 *
 * Every replacement is pattern-matched against one specific tag. Rewriting the
 * head by anything looser - matching on the attribute name alone, say - would
 * hit every meta description on the page rather than the one being replaced.
 */
function buildHead(listing, currency, template) {
  const url = propertyUrl(listing.id);
  const description = describe(listing, currency);
  const title = `${listing.title} — Northwind Realty`;
  const image = `${ORIGIN}${listing.image}`;

  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['Product', 'Residence'],
        '@id': `${url}#listing`,
        name: listing.title,
        description: listing.description,
        url,
        image: listing.images.map((file) => `${ORIGIN}${file}`),
        sku: listing.id,
        category: listing.type,
        address: {
          '@type': 'PostalAddress',
          streetAddress: listing.address,
          addressLocality: listing.city,
          addressCountry: 'US'
        },
        ...(isLand(listing) ? {} : { numberOfRooms: listing.beds, floorSize: { '@type': 'QuantitativeValue', value: listing.area, unitCode: 'FTK' } }),
        offers: {
          '@type': 'Offer',
          price: listing.price,
          priceCurrency: currency,
          availability: listing.status === 'Sold'
            ? 'https://schema.org/SoldOut'
            : 'https://schema.org/InStock',
          url,
          seller: { '@type': 'RealEstateAgent', name: 'Northwind Realty' }
        }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN },
          { '@type': 'ListItem', position: 2, name: 'Properties', item: `${ORIGIN}properties.html` },
          { '@type': 'ListItem', position: 3, name: listing.title, item: url }
        ]
      }
    ]
  };

  /*
   * Each entry is the whole tag, not a prefix.
   *
   * The first version rebuilt these from an opening fragment plus a trailing
   * quote, which worked for the self-closing <meta> and <link> tags and quietly
   * dropped the </title> from the other one - leaving an unclosed <title> in every
   * generated page. A page whose <head> is malformed still renders in a browser,
   * so nothing would have said so.
   */
  const replacements = [
    [/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`],
    [/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${escapeHtml(description)}" />`],
    [/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${escapeHtml(url)}" />`],
    [/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${escapeHtml(title)}" />`],
    [/<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${escapeHtml(description)}" />`],
    [/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${escapeHtml(url)}" />`],
    [/<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${escapeHtml(image)}" />`],
    [/<meta property="og:type" content="[^"]*"\s*\/?>/, '<meta property="og:type" content="article" />']
  ];

  let head = template;
  const missed = [];
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(head)) {
      // A tag that is not there cannot be rewritten, and a listing page whose
      // canonical silently stayed on the generic one would be the exact problem
      // this generator exists to solve. Said out loud rather than swallowed.
      missed.push(pattern.source.slice(0, 40));
      continue;
    }
    head = head.replace(pattern, replacement);
  }
  if (missed.length) {
    console.warn(`build-property-pages: template is missing ${missed.join('; ')}`);
  }

  const block = `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n    </script>`;
  // Appended to the head, which the structured-data generator marks - so this
  // runs after it and adds a second, listing-specific block beside the agency one.
  return head.replace('</head>', `    ${block}\n  </head>`);
}

/* ---- the body -------------------------------------------------------------- */

/**
 * The listing, as HTML, for a crawler and for anyone whose JavaScript has not
 * run yet.
 *
 * This is deliberately the smaller half of the page. The full detail view -
 * gallery, rates table, agent card, viewing dialog, similar homes - is rendered
 * by app.js and replaced the moment it runs. What lives here is the part a
 * crawler has to believe: one H1, the address, the price, the headline figures,
 * the description and the features, in the same class names, so the page looks
 * the same either way and there is no visible flash of an unstyled shell.
 *
 * The price is the base currency, unconverted. A currency picker needs
 * JavaScript, and a description is read before anyone has chosen anything.
 */
function buildBody(listing, currency) {
  const price = money(listing.price, currency);
  const perMonth = listing.status === 'For rent' ? ' per month' : '';

  const specs = isLand(listing)
    ? [['Plot', listing.lot || '-'], ['Status', listing.status], ['Listed on', listed(listing.listed)]]
    : [
      ['Bedrooms', String(listing.beds)],
      ['Bathrooms', String(listing.baths)],
      ['Floor area', `${numberFormat.format(listing.area)} ft²`],
      ['Plot', listing.lot && listing.lot !== '-' ? listing.lot : '-'],
      ['Year built', String(listing.year)],
      ['Listed on', listed(listing.listed)]
    ];

  return `
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href="../index.html">Home</a>
      <a href="../properties.html">Properties</a>
      <span>${escapeHtml(listing.title)}</span>
    </nav>
    <div class="detail-layout">
      <div>
        <div class="gallery">
          <div class="gallery-main">
            <img src="../${escapeHtml(listing.image)}" alt="${escapeHtml(listing.title)}" width="1200" height="750" />
          </div>
        </div>
        <div class="detail-title">
          <div>
            <h1>${escapeHtml(listing.title)}</h1>
            <p class="card-address">${escapeHtml(listing.address)}, ${escapeHtml(listing.city)}</p>
            <p class="detail-price">${escapeHtml(price)}${escapeHtml(perMonth)}</p>
          </div>
        </div>
        <dl class="spec-grid">
          ${specs.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('\n          ')}
        </dl>
        <section class="detail-section">
          <h2>${isLand(listing) ? 'About this plot' : 'About this home'}</h2>
          <p class="prose prose--spaced">${escapeHtml(listing.description)}</p>
        </section>
        <section class="detail-section">
          <h2>What you get</h2>
          <ul class="feature-grid">
            ${listing.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join('\n            ')}
          </ul>
        </section>
      </div>
      <aside class="agent-card--sticky">
        <h2 class="detail-subhead">Ask about this property</h2>
        <p>Call <a href="tel:+15550142200">+1 (555) 014-2200</a> or
          <a href="../contact.html">send a message</a>.</p>
        <a class="button button--primary button--block" href="../contact.html">Ask a question</a>
      </aside>
    </div>`;
}

/* ---- writing them ---------------------------------------------------------- */

/** Build the complete page for one listing. */
export function buildPage(listing, currency, template) {
  // toParent first: it rewrites the template's own references, and the body
  // written below already uses ../ itself.
  const shell = toParent(template);
  const withHead = buildHead(listing, currency, shell);
  return withHead.replace(
    /<div class="container section" id="property-detail">[\s\S]*?<\/div>/,
    `<div class="container section" id="property-detail">${buildBody(listing, currency)}</div>`
  );
}

const invokedDirectly = Boolean(process.argv[1])
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check');
  const data = JSON.parse(read('data.json'));
  const { site: info = {}, listings = [] } = data;
  const currency = /^[A-Z]{3}$/i.test(String(info.currency || '')) ? String(info.currency).toUpperCase() : 'USD';
  const template = read('property.html');

  const wanted = new Map(listings.map((listing) => [`${listing.id}.html`, listing]));
  const stale = [];

  for (const [name, listing] of wanted) {
    const built = buildPage(listing, currency, template);
    const path = join(OUT, name);
    if (existsSync(path) && readFileSync(path, 'utf8') === built) continue;
    stale.push(name);
    if (!checkOnly) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path, built, 'utf8');
    }
  }

  /*
   * Remove pages for listings that are no longer there.
   *
   * Deleting a listing has to delete its page, or the file stays published and
   * keeps answering with a house that has been withdrawn. Nothing else in the
   * build would notice: the sitemap is generated, so it would simply stop
   * listing the URL while the file itself sat there.
   */
  const removed = [];
  if (existsSync(OUT)) {
    for (const name of readdirSync(OUT)) {
      if (!name.endsWith('.html') || wanted.has(name)) continue;
      removed.push(name);
      if (!checkOnly) rmSync(join(OUT, name));
    }
  }

  if (checkOnly && (stale.length || removed.length)) {
    if (stale.length) console.error(`property pages out of date: ${stale.join(', ')}`);
    if (removed.length) console.error(`property pages for removed listings still present: ${removed.join(', ')}`);
    console.error('Run: node scripts/build-property-pages.mjs');
    process.exit(1);
  }

  console.log(checkOnly
    ? `${wanted.size} property pages are up to date.`
    : `${stale.length} written, ${removed.length} removed, ${wanted.size} total.`);
}

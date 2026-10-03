#!/usr/bin/env node
/**
 * Write the JSON-LD blocks into the pages, from data.json.
 *
 *   node scripts/build-structured-data.mjs          rewrite the blocks
 *   node scripts/build-structured-data.mjs --check  fail if any block is stale
 *
 * Why this is generated rather than hand-written
 *
 * The obvious version of this is a <script type="application/ld+json"> block
 * typed into each page. It works until somebody adds an agent in the admin
 * panel: the block still names the old one, still claims to describe the
 * business, and nothing complains - because nothing checks it. That is the same
 * failure mode as the hand-maintained sitemap this repository already had, and
 * it is worse here. Structured data that disagrees with the page is a
 * misrepresentation, not just a stale convenience, and the FAQ case is sharper
 * still: the questions live in contact.html's markup, so a hand-written FAQPage
 * would drift from the answers a visitor can actually read.
 *
 * So every block is built from the same data the page renders, and the FAQ is
 * read out of the contact page's own markup rather than retyped.
 *
 * Where the block goes, and why it is marked
 *
 * Each block is written between two HTML comments. That makes the generator
 * idempotent - it replaces what it previously wrote rather than appending a
 * second block - and it makes the block obviously generated to anyone reading
 * the source. Without the markers a second run would leave two identical blocks
 * on the page, which is at best untidy and at worst ambiguous to a consumer
 * reading the document.
 *
 * Why a data block and not a script
 *
 * `type="application/ld+json"` is data. The browser parses nothing and executes
 * nothing, so the pages keep a CSP with script-src 'self' and no 'unsafe-inline'
 * - which is the whole reason app.js and theme.js are separate files.
 * check-csp.mjs knows the difference and asserts it in both directions.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');

const ORIGIN = 'https://megapulse11-dot.github.io/friendly-fiesta/';
const SITE_ID = `${ORIGIN}#agency`;

/*
 * Markers carry no indentation of their own. injectBlock indents the whole
 * block when writing it, and blockIsCurrent strips the indentation before
 * comparing, so a marker defined with leading spaces would be found one line's
 * indentation short on the next run and the comparison would never settle -
 * the generator would rewrite an already-correct page for ever.
 */
const START = '<!-- structured data: start - generated from data.json, do not edit by hand -->';
const END = '<!-- structured data: end -->';

/** One level of indentation, used to sit the block inside the head. */
const INDENT = '    ';

const readData = () => JSON.parse(readFileSync(join(site, 'data.json'), 'utf8'));
const readPage = (name) => readFileSync(join(site, name), 'utf8');

/** An absolute URL, from a site-relative one. */
const absolute = (path) => `${ORIGIN}${path.replace(/^\//, '')}`;

/**
 * Strip a tag's attributes and return its text.
 *
 * The FAQ is read out of contact.html, so this has to cope with the inline
 * <svg> that sits inside every <summary> - the question text and the icon are
 * in the same element.
 */
const textOf = (html) => html
  .replace(/<svg[\s\S]*?<\/svg>/g, '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

const postalAddress = (street, city) => ({
  '@type': 'PostalAddress',
  streetAddress: street,
  addressLocality: city,
  addressCountry: 'US'
});
/* ---- the blocks ------------------------------------------------------------ */

/** Home: the business itself, its people, and the website that carries them. */
function homeBlock(data) {
  const { site: info = {}, agents = [], offices = [] } = data;
  const hero = 'assets/homes/property_04_harbour_villa_twilight.jpg';

  const agency = {
    '@type': 'RealEstateAgency',
    '@id': SITE_ID,
    name: info.name,
    url: ORIGIN,
    logo: absolute('favicon.svg'),
    image: absolute(hero),
    description: info.footerNote,
    foundingDate: '1998',
    address: offices.length ? postalAddress(offices[0].address, offices[0].city) : undefined,
    areaServed: offices.map((office) => ({ '@type': 'City', name: office.city })),
    employee: agents.map((agent) => ({
      '@type': 'RealEstateAgent',
      name: agent.name,
      jobTitle: agent.role,
      telephone: agent.phone,
      email: agent.email,
      worksFor: { '@id': SITE_ID }
    })),
    location: offices.map((office) => ({
      '@type': 'RealEstateAgent',
      name: `${info.name} — ${office.city}`,
      telephone: office.phone,
      address: postalAddress(office.address, office.city)
    }))
  };
  if (info.email) agency.email = info.email;
  if (info.phone) agency.telephone = info.phone;

  const website = {
    '@type': 'WebSite',
    '@id': `${ORIGIN}#website`,
    url: ORIGIN,
    name: info.name,
    publisher: { '@id': SITE_ID },
    inLanguage: 'en'
  };

  return { '@context': 'https://schema.org', '@graph': [agency, website] };
}

/**
 * The breadcrumb trail for a page below the home page.
 *
 * The header renders these links visually; without the matching structured data
 * a search result shows the page title alone, with no indication of where in the
 * site the visitor landed.
 */
function breadcrumbs(data, trail) {
  const { site: info = {} } = data;
  const items = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN },
    ...trail.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 2,
      name: step.name,
      item: absolute(step.path)
    }))
  ];
  return trail.length ? items : items.concat([{ name: info.name }]);
}

function breadcrumbBlock(data, trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs(data, trail)
  };
}

/**
 * The results page: a collection of what is on the market, listed explicitly.
 *
 * The cards themselves are rendered by JavaScript, so a crawler sees this list
 * rather than the grid. That is the point - the ItemList is the version of the
 * page that exists without running anything.
 *
 * Sold listings are left out, matching sitemap.xml and the cards themselves. A
 * sold house keeps its detail page, but advertising it in the index of what is
 * available is the thing that would be wrong.
 */
function propertiesBlock(data) {
  const live = data.listings.filter((listing) => listing.status !== 'Sold');
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: 'Properties for sale and to rent',
        url: absolute('properties.html'),
        isPartOf: { '@id': `${ORIGIN}#website` },
        breadcrumb: breadcrumbs(data, [{ name: 'Properties', path: 'properties.html' }])
      },
      {
        '@type': 'ItemList',
        name: 'Homes and land for sale and to rent',
        numberOfItems: live.length,
        // The pre-rendered addresses, matching the sitemap. Listing the ?id= URLs
        // here would point structured data at the one form of each page that a
        // crawler reads least of.
        itemListElement: live.map((listing, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          url: `${ORIGIN}property/${encodeURIComponent(listing.id)}.html`,
          name: listing.title
        }))
      }
    ]
  };
}

/**
 * The contact page: how to reach the business, and the questions it answers.
 *
 * The FAQ is read out of the page's own <details> blocks. That is the only way
 * to keep it honest - a FAQPage whose answers have drifted from the visible ones
 * is describing content that is not there, which is precisely the thing
 * structured data is not for.
 */
function contactBlock(data, html) {
  const { site: info = {}, offices = [] } = data;
  const faq = [...html.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/gi)]
    .map((match) => ({ question: textOf(match[1]), answer: textOf(match[2]) }))
    .filter((item) => item.question && item.answer);

  const page = {
    '@type': 'ContactPage',
    name: 'Contact Northwind Realty',
    url: absolute('contact.html'),
    isPartOf: { '@id': `${ORIGIN}#website` },
    breadcrumb: breadcrumbs(data, [{ name: 'Contact', path: 'contact.html' }]),
    mainEntity: {
      '@type': 'RealEstateAgency',
      '@id': SITE_ID,
      name: info.name,
      email: info.email,
      telephone: info.phone,
      contactPoint: offices.map((office) => ({
        '@type': 'ContactPoint',
        telephone: office.phone,
        contactType: 'sales',
        areaServed: office.city,
        address: postalAddress(office.address, office.city)
      }))
    }
  };

  const graph = [page];
  if (faq.length) {
    graph.push({
      '@type': 'FAQPage',
      mainEntity: faq.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer }
      }))
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** The agent sign-in gate. It is noindex, so this is for completeness only. */
function agentBlock(data) {
  return {
    ...breadcrumbBlock(data, [{ name: 'Agent sign in', path: 'agent.html' }]),
    name: 'Agent sign in',
    url: absolute('agent.html'),
    isPartOf: { '@id': `${ORIGIN}#website` }
  };
}

/** Every page this generator owns, and the block it carries. */
function blocksFor(data) {
  return [
    { page: 'index.html', build: () => homeBlock(data) },
    { page: 'properties.html', build: () => propertiesBlock(data) },
    // The FAQ is read from the page on disk, so contact.html is built from the
    // version currently committed rather than from its own output - otherwise
    // the FAQ would be parsed out of the JSON-LD block on a second run.
    { page: 'contact.html', build: () => contactBlock(data, readPage('contact.html')) },
    { page: 'agent.html', build: () => agentBlock(data) }
  ];
}

/** The block on its own, without any indentation, for writing and for comparing. */
function blockFor(json) {
  return `${START}\n<script type="application/ld+json">\n`
    + JSON.stringify(json, null, 2)
    + `\n</script>\n${END}`;
}

/** Indent a block to sit inside the head. */
function indent(text) {
  return text.split('\n').map((line) => `${INDENT}${line}`).join('\n');
}

/**
 * Remove exactly one level of indentation - no more, no less.
 *
 * This is deliberately not `trimStart()` on every line. The JSON inside the
 * block is indented too, and stripping all leading whitespace flattened it,
 * so the comparison never matched a block the generator had just written and
 * every page was rewritten on every run. Removing one known level cancels the
 * one indent() added and leaves the JSON's own shape intact.
 */
function dedent(text) {
  return text.split('\n').map((line) => line.replace(new RegExp(`^${INDENT}`), '')).join('\n');
}

/**
 * Replace the marked region of a page with a freshly built block, or - if the
 * markers are absent - insert the block just before </head>.
 *
 * Written by hand rather than with a DOM library: the site ships no build step
 * and no dependencies, and a whole-document parse would reformat the page it is
 * meant to leave alone.
 */
export function injectBlock(html, json) {
  const block = indent(blockFor(json));

  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from !== -1 && to !== -1 && to > from) {
    return html.slice(0, from) + block + html.slice(to + END.length);
  }
  // No markers: a page that has never had a block. Put it at the end of the head,
  // after the metadata it describes and before the stylesheet it belongs with.
  return html.replace('</head>', `  ${block}\n  </head>`);
}

/** Whether a page's marked region already holds exactly this block. */
export function blockIsCurrent(html, json) {
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from === -1 || to === -1 || to < from) return false;
  return dedent(html.slice(from, to + END.length)) === blockFor(json);
}

const invokedDirectly = Boolean(process.argv[1])
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check');
  const data = readData();
  const stale = [];

  for (const { page, build } of blocksFor(data)) {
    const html = readPage(page);
    if (blockIsCurrent(html, build())) {
      continue;
    }
    stale.push(page);
    if (!checkOnly) writeFileSync(join(site, page), injectBlock(html, build()), 'utf8');
  }

  if (checkOnly && stale.length) {
    console.error(`structured data is out of date: ${stale.join(', ')}. Run: node scripts/build-structured-data.mjs`);
    process.exit(1);
  }
  console.log(checkOnly
    ? 'structured data is up to date.'
    : `structured data written to ${stale.length ? stale.join(', ') : 'no pages (all current)'}.`);
}

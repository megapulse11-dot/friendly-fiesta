#!/usr/bin/env node
/**
 * Build sitemap.xml from data.json.
 *
 *   node scripts/build-sitemap.mjs          regenerate sitemap.xml
 *   node scripts/build-sitemap.mjs --check  fail if it is out of date, write nothing
 *
 * Why this exists at all: the sitemap was a hand-maintained file, and the admin
 * panel has no idea it exists. Approving a listing rewrote data.json, data.js and
 * the mobile app's copy, but not the sitemap - so a new house would sit
 * unadvertised to crawlers until somebody remembered. Generating it here and
 * calling it from the same place as the other generators removes the memory step.
 *
 * Two policy decisions are made here, and both are deliberate:
 *
 *   Sold listings are EXCLUDED. A sold house keeps its page so a buyer who found
 *   it in a search result still gets a real answer, but it must not be advertised
 *   as available inventory - that is the one thing a sitemap is for. A withdrawn
 *   listing (removed from data.json entirely) disappears with no trace, which is
 *   the point of generating rather than maintaining.
 *
 *   `lastmod` is the day this file was generated, not each listing's own date.
 *   Every save bumps `site.contentVersion` and rebuilds this file, so the build
 *   date genuinely is when the content last changed. The one overstatement is
 *   that editing one listing also stamps the others - acceptable for a site this
 *   size, and better than the alternative, which is a date frozen at whatever day
 *   somebody last edited the file by hand.
 *
 * The origin is the published GitHub Pages address and must agree with:
 *   - SITE_ORIGIN in app.js (drives the canonical URL on every property page)
 *   - the Sitemap: line in robots.txt
 * If the site ever moves to a domain of its own, change it here first.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ORIGIN = 'https://megapulse11-dot.github.io/friendly-fiesta/';

/**
 * How a listing is reached.
 *
 * Each listing has a pre-rendered page at property/<id>.html with its own title,
 * description, canonical, Open Graph and JSON-LD already in the served HTML -
 * written by scripts/build-property-pages.mjs. That file is the canonical address
 * and the one the sitemap lists.
 *
 * property.html?id=<id> still works for any link that uses it, and app.js points
 * its canonical at the pre-rendered page, so the two never compete for the same
 * house. See updateListingMeta in app.js.
 *
 * This is the single constant to change if that scheme ever moves.
 */
export const propertyUrl = (id) => `${ORIGIN}property/${encodeURIComponent(id)}.html`;

/** Pages that exist regardless of what is listed. Order is priority order. */
const STATIC_PAGES = [
  { path: 'index.html', changefreq: 'daily', priority: '1.0' },
  { path: 'properties.html', changefreq: 'daily', priority: '0.9' },
  { path: 'contact.html', changefreq: 'monthly', priority: '0.6' },
  { path: 'agent.html', changefreq: 'monthly', priority: '0.4' }
];

/**
 * The XML-escaping a <loc> needs. A query string is the only reason this is not
 * a formality: an ampersand in a URL is legal but invalid inside XML, and one
 * unescaped ampersand makes the whole document unparseable - which search
 * engines treat as no sitemap at all.
 */
const xml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const urlEntry = (loc, lastmod, changefreq, priority) =>
  `  <url>\n    <loc>${xml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n` +
  `    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>\n`;
/**
 * Everything in the document except the date it was generated.
 *
 * This is what `--check` compares, and the reason it exists is subtle enough to
 * be worth stating. The generator stamps `lastmod` with the day it runs, so a
 * byte-for-byte comparison against the committed file would fail on every day
 * after it was written - including in CI, on the first push that did not happen
 * to regenerate it. That turns the guard into a build that breaks on a timer and
 * nobody can reproduce.
 *
 * What actually needs checking is the content: that every live listing is listed,
 * no sold one is, and the changefreq and priority are right. The date is a
 * function of when the file was built, not of whether it is correct - so it is
 * the one part deliberately excluded from the comparison.
 */
export function sitemapContent(document) {
  return String(document)
    .replace(/<lastmod>[^<]*<\/lastmod>/g, '<lastmod/>')
    .replace(/\r\n/g, '\n')
    .trim();
}

/** Build the whole document. Exported so a check can compare without running this. */
export function buildSitemap(data, today) {
  const entries = STATIC_PAGES.map((page) => urlEntry(`${ORIGIN}${page.path}`, today, page.changefreq, page.priority));

  // Sorted by id so the file does not reshuffle every time an unrelated listing is
  // edited - a sitemap that changes on every save is a sitemap nobody reviews.
  const live = data.listings
    .filter((listing) => listing.status !== 'Sold')
    .sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));

  for (const listing of live) {
    entries.push(urlEntry(propertyUrl(listing.id), today, 'weekly', '0.8'));
  }

  const header =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!-- Generated from data.json by scripts/build-sitemap.mjs - do not edit by hand.\n' +
    '     Sold listings are deliberately excluded: their page stays reachable so an\n' +
    '     old search result still answers honestly, but they are not advertised as\n' +
    '     available inventory. Run `node scripts/build-sitemap.mjs` after any change. -->\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  return header + entries.join('') + '</urlset>\n';
}

/** Today as YYYY-MM-DD in UTC, so the stamp does not move with the machine's timezone. */
const today = () => new Date().toISOString().slice(0, 10);

/*
 * Only run when executed directly, so a check can import the builder instead.
 *
 * Both sides are compared with the separators flattened, because Node reports
 * argv[1] with backslashes on Windows while fileURLToPath also produces
 * backslashes but import.meta.url is a file:// URL - and comparing those raw
 * left this file silently doing nothing when run by hand.
 */
const invokedDirectly = Boolean(process.argv[1])
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check');
  const data = JSON.parse(readFileSync(join(site, 'data.json'), 'utf8'));
  const built = buildSitemap(data, today());
  const target = join(site, 'sitemap.xml');

  if (checkOnly) {
    if (!existsSync(target)) {
      console.error('sitemap.xml does not exist. Run: node scripts/build-sitemap.mjs');
      process.exit(1);
    }
    // Compared without the date - see sitemapContent for why a byte-for-byte
    // comparison here would fail on a timer rather than on a real drift.
    if (sitemapContent(readFileSync(target, 'utf8')) !== sitemapContent(built)) {
      console.error('sitemap.xml is out of date with data.json. Run: node scripts/build-sitemap.mjs');
      process.exit(1);
    }
    console.log('sitemap.xml is up to date with data.json.');
    process.exit(0);
  }

  // LF, UTF-8, no BOM - the same convention the rest of the published site uses.
  writeFileSync(target, built, 'utf8');
  const live = data.listings.filter((listing) => listing.status !== 'Sold').length;
  console.log(`sitemap.xml written: ${STATIC_PAGES.length} pages + ${live} live listings.`);
}
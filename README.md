# Northwind Realty

A modern, responsive website template for a real estate agency — four pages, semantic HTML, hand-written CSS and vanilla JavaScript. No build step, no framework and no third-party runtime dependencies.

> **Agents upload their own listings** — see [AGENTS.md](AGENTS.md). Agents sign in
> at `/agent.html`, upload homes and land, and edit or delete their own uploads.
> Nothing reaches the public site until you approve it in the admin panel.

The site makes no remote requests for its own content. It makes **one** for exchange rates, and only if you turn on the currency picker: see [Currency](#currency) below. Without that, it works with no network at all.

## Run it

Open `index.html` directly, or serve the folder for the most browser-compatible experience:

```bash
python -m http.server 8000
```

Then visit [http://localhost:8000](http://localhost:8000).

## What's included

- **Home** — hero with a buy/rent/land search panel, featured listings, live statistics, services, team, testimonials and a call to action
- **Properties** — filter by keyword, category (homes or land), listing type, property type, bedrooms and budget; sort by price, date or size; removable filter chips; grid/list toggle; "show more" paging; an empty state
- **Property detail** — gallery with thumbnails, specification grid, features, sticky agent card, similar homes, share button and a "book a viewing" dialog
- **Contact** — validated enquiry form, three offices rendered from the same dataset, and an FAQ accordion
- **Cross-cutting** — saved homes (heart buttons) persisted in `localStorage`, filters mirrored into the URL so results are shareable, a currency picker that converts every price, toast notifications, mobile navigation drawer, semantic landmarks, visible focus states, `prefers-reduced-motion` support

## Land

Land is a category of its own, not just another property type, because a parcel
of ground has none of the figures a house is described by. It carries:

| | Houses | Land |
|---|---|---|
| Headline figure | Floor area (`area`) | Plot size (`land.plotAcres`, read in `land.plotUnit`) |
| Also shown | Bedrooms, bathrooms, year built, parking | Zoning, title, access, landmarks, utilities |
| Bedroom filter | Applies | Hidden — there are none |

**Land types:** Virgin land, Residential land, Agricultural land, Commercial
land, Industrial land, Beachfront land, Ranch land, Orchard land, Mixed-use
land, Plot. They live in `LAND_TYPES` in `app.js`, mirrored by the panel in
`admin/admin.js` and the app in `src/lib/filters.ts`.

A listing is treated as land when its `type` is one of those, **or** when it
carries a `land` block — so a parcel saved before the plot fields existed still
renders as land, falling back to the free-text `lot` for its size.

```jsonc
{
  "type": "Virgin land",
  "lot": "20 acres",          // kept in step with plotAcres by the panel
  "beds": 0, "baths": 0,      // a parcel has no rooms, so these are zero
  "area": 0, "year": 0,
  "land": {
    "plotAcres": 20,          // numeric, so filters and sorting can compare it
    "plotUnit": "acres",      // 'acres' | 'hectares' | 'sq m'
    "zoning": "Agricultural",
    "titleDeed": "Freehold",
    "access": "Graded dirt road",
    "landmarks": "Ridge line with valley views to the south",
    "utilities": "Grid power at the boundary"
  }
}
```

Filtering by `kind=land` on the results page drops the bedroom control and trims
the type list to land, and land gets its own budget bands because a parcel is
priced on its size and paperwork rather than its rooms.

## Currency

Prices are stored once, in a single **base currency**, and shown in whichever
currency the visitor picks. The base is set in the admin panel under **Site
settings → Base currency**; it is also what the panel itself shows you, so an
editor is always typing the number that will be saved.

The picker in the header converts using live rates from
[frankfurter.app](https://frankfurter.app), a free service that needs no account
or API key and republishes the European Central Bank's daily reference rates.
The rate date is printed under the picker whenever a conversion is on screen, so
the number is never explained. The choice is remembered in `localStorage`.

The ECB publishes reference rates for 30 currencies, which is not every currency
a property site might be read in. Anything outside that set — the Kenyan shilling
(`KES`) among them — is converted using [open.er-api.com](https://www.exchangerate-api.com),
which is also key-less and covers around 160 currencies. It is only consulted for
codes the ECB set cannot quote, and a non-USD base currency is reached by crossing
two of its dollar rates. The date printed under the picker always belongs to the
service the displayed number actually came from.

Two things worth knowing:

- **Filtering is unaffected.** Budget bands, sorting and shared URLs all work in
  base-currency numbers, so a link means the same thing in every currency. Only
  the wording changes.
- **If the rates cannot be fetched the site stays honest.** Prices fall back to
  the base currency rather than showing an unconverted number with a foreign
  symbol, the picker says which currency it fell back to, and the confirmation
  names the currency the reader is actually looking at. Each request is wrapped in
  a 7-second timeout, and any of them failing leaves the rest of the page working.

To use a different rate source, or to self-host one, point `RATES_URL` and
`CURRENCY_NAMES_URL` at the top of the currency block in `app.js` at something
returning `{ base, date, rates: { CODE: number } }`. The second source is
`SUPPLEMENT_RATES_URL`, and expects `{ result: "success", time_last_update_unix,
rates: { CODE: number } }` quoted against USD; set it to an empty string to turn
that fallback off.

ECB rates are published on working days only, so a rate shown at the weekend is
the most recent working day's.

## Project structure

```text
index.html         Home page
properties.html    Search and results
property.html      Listing detail (reads ?id=)
contact.html       Enquiry form, offices and FAQ
styles.css         Design tokens, components and responsive rules
data.js            All sample content: listings, agents, offices
app.js             Shared behaviour, one guarded block per page
assets/homes/      Placeholder property images (SVG)
favicon.svg        Browser icon
scripts/           Build-time generators (sitemap, structured data, listing pages)
property/          The pre-rendered listing pages - generated, do not edit
robots.txt         Crawler rules and the sitemap location
sitemap.xml        Generated from data.json - do not edit by hand
```

## Listing pages, robots.txt and sitemap.xml

**Every listing has its own HTML file**, at `property/<id>.html`, carrying its own
title, description, canonical URL, Open Graph tags, `<h1>` and JSON-LD — all in
the raw HTML, readable without running any JavaScript. That is what a crawler
sees and what a link preview in Slack or Facebook is given.

`property.html?id=<id>` still works for any link that uses it, and `app.js` points
its canonical at the pre-rendered page, so the two never compete for the same
house.

Four things in this repository are **generated from `data.json`** rather than
maintained by hand, and you normally never need to run them:

```powershell
node scripts/build-sitemap.mjs           # sitemap.xml
node scripts/build-structured-data.mjs   # the JSON-LD blocks in the page heads
node scripts/build-property-pages.mjs    # the files in property/
node scripts/build-sitemap.mjs --check   # fail if out of date, write nothing
```

The admin panel rebuilds all of them on every save and on every start, and the
Pages workflow runs `--check` so a hand-edited `data.json` fails the build rather
than publishing something stale. They matter if you edit `data.json` by hand —
that is exactly the case the checks exist to catch.

**Sold listings are excluded from the sitemap on purpose.** A sold house keeps its
detail page, so somebody who followed an old link still gets an honest answer
rather than a 404, but it is not advertised as available inventory. Withdrawn
listings disappear from the sitemap *and* their pre-rendered page is deleted, so
a withdrawn house does not stay published as a file nothing links to.

The origin in those scripts must stay in step with `SITE_ORIGIN` in `app.js` and
the `Sitemap:` line in `robots.txt`. If you move the site to a domain of your
own, change all three.

## Make it yours

1. **Content** — everything rendered comes from `data.js`. Replace the arrays with your listings, or point the same shape at a real estate API/CRM.
2. **Photography** — drop real photos into `assets/homes/` and update the `image` and `images` fields. The layout expects a 4:3 frame for cards and 16:10 for the detail gallery.
3. **Branding** — recolour the site by editing the eight tokens at the top of `styles.css` (`--brand`, `--brand-dark`, `--brand-soft`, `--accent`, …). The logo is a small CSS shape, so no image editing is needed.
4. **Forms** — `contact.html` and the viewing dialog post to the admin server,
   which files them in `enquiries.json`; read them under the **Enquiries** tab. To
   send them somewhere else as well (a mail handler, CRM, webhook), hook the
   `POST /api/enquiry` route in `admin/server.ps1`.

5. **Forms on the published site** — GitHub Pages has no server, so `postEnquiry`
   in `app.js` picks a destination by hostname: on `localhost` it uses the admin
   server, anywhere else it posts to a form service. There are two ways to supply
   one.

   **A Cloudflare Worker** (in `worker/`) keeps enquiries in storage and hands
   them to your local admin panel, so the public site and the panel share a
   single **Enquiries** inbox. This is the one that matches how the rest of the
   site works. Follow `worker/README.md` — a free Cloudflare account, a KV
   namespace and one secret is the whole setup.

   **Web3Forms** is the alternative if you would rather have enquiries by email
   and accept that they will not appear in the panel: type your email into
   <https://web3forms.com> and it shows an access key immediately, with no
   account to create. Paste the key into `ENQUIRY_KEY` in `app.js`. Formspree
   also works — put the whole `https://formspree.io/f/xxxxxxxx` URL in
   `ENQUIRY_ENDPOINT` instead.

   Either way: commit and push, and GitHub Pages rebuilds in about a minute.
   Until something is set the public form says it is not connected rather than
   pretending to have sent. Both forms carry a hidden `botcheck` field, so a bot
   that completes every field is dropped.

6. **Copy** — the words are realistic but fictional; swap them for your own, including the testimonials.

## Notes

The template ships with placeholder images drawn as SVG so the design reads correctly with no network access. `localStorage` is used for saved homes and the grid/list preference, and both are wrapped so the site still works in private-browsing modes where storage is unavailable.

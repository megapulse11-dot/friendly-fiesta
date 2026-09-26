# Northwind Realty

A modern, responsive website template for a real estate agency — four pages, semantic HTML, hand-written CSS and vanilla JavaScript. No build step, no framework, no third-party runtime dependencies, and no remote requests.

## Run it

Open `index.html` directly, or serve the folder for the most browser-compatible experience:

```bash
python -m http.server 8000
```

Then visit [http://localhost:8000](http://localhost:8000).

## What's included

- **Home** — hero with a buy/rent search panel, featured listings, live statistics, services, team, testimonials and a call to action
- **Properties** — filter by keyword, listing type, property type, bedrooms and budget; sort by price, date or size; removable filter chips; grid/list toggle; "show more" paging; an empty state
- **Property detail** — gallery with thumbnails, specification grid, features, sticky agent card, similar homes, share button and a "book a viewing" dialog
- **Contact** — validated enquiry form, three offices rendered from the same dataset, and an FAQ accordion
- **Cross-cutting** — saved homes (heart buttons) persisted in `localStorage`, filters mirrored into the URL so results are shareable, toast notifications, mobile navigation drawer, semantic landmarks, visible focus states, `prefers-reduced-motion` support

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
```

## Make it yours

1. **Content** — everything rendered comes from `data.js`. Replace the arrays with your listings, or point the same shape at a real estate API/CRM.
2. **Photography** — drop real photos into `assets/homes/` and update the `image` and `images` fields. The layout expects a 4:3 frame for cards and 16:10 for the detail gallery.
3. **Branding** — recolour the site by editing the eight tokens at the top of `styles.css` (`--brand`, `--brand-dark`, `--brand-soft`, `--accent`, …). The logo is a small CSS shape, so no image editing is needed.
4. **Forms** — `contact.html` and the viewing dialog post to the admin server,
   which files them in `enquiries.json`; read them under the **Enquiries** tab. To
   send them somewhere else as well (a mail handler, CRM, webhook), hook the
   `POST /api/enquiry` route in `admin/server.ps1`.
5. **Copy** — the words are realistic but fictional; swap them for your own, including the testimonials.

## Notes

The template ships with placeholder images drawn as SVG so the design reads correctly with no network access. `localStorage` is used for saved homes and the grid/list preference, and both are wrapped so the site still works in private-browsing modes where storage is unavailable.

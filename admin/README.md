# Admin panel

A small editing tool for the website. It runs on your own machine and needs nothing
installed beyond Windows PowerShell.

## Start it

Double-click `start-admin.cmd` in the parent folder, or from a terminal:

```powershell
.\start-admin.cmd my-secret-password
```

Run it with no argument and it prompts for the password instead, without echoing
what you type. Then open:

- **Website** — <http://localhost:8001/>
- **Admin** — <http://localhost:8001/admin>

Stop the server with `Ctrl+C` in the same window.

## There is no default password

The server **will not start** without one. An earlier version fell back to
`northwind`, which meant the admin password was published in this repository and
in every copy of the template — a default like that is not a convenience, it is a
published secret.

Supply it one of three ways:

```powershell
.\start-admin.cmd my-secret
$env:NW_ADMIN_PASSWORD = 'my-secret'; .\admin\server.ps1
.\admin\server.ps1 -Password (Read-Host 'Admin password' -AsSecureString)
```

`$env:NW_ADMIN_PASSWORD` is the friendliest of the three: set it once in your
user environment and every later run picks it up without being typed again.

The password is kept as a `SecureString`, compared byte by byte so its length
cannot be inferred from how long a sign-in attempt takes, and never printed to
the console or the sign-in page.

## What you can change

| Tab | What it edits |
|---|---|
| Listings | Every property: price, status, beds/baths/area, description, features, photos |
| Enquiries | Messages and viewing requests sent from the website, with read, archive and delete |
| Agents | Names, roles, contact details and bios shown on the home page and listings |
| Offices | Addresses, phone numbers and opening hours for the footer and contact page |
| Site settings | Company name, home page headline and intro, brand and accent colours, base currency, contact email and phone, footer text |

## Saving and the mobile app

A save here also refreshes the app in `../northwind-mobile`, so a price, a photo or
the base currency you change appears on the phone without any extra step. The
server runs the app's own `scripts/sync-data.mjs` after it writes `data.json`.

Two things worth knowing:

- The app reads its content at **build** time, not at runtime, so this is a copy.
  With Metro running the edit hot-reloads straight away. A released build has the
  old numbers baked in and needs a rebuild to pick them up.
- The sync is best-effort. If Node is missing, the app folder has moved, or the
  script fails, the save still succeeds and the server prints a warning — it never
  fails a save that is already safely on disk. Pass `-AppRoot` if the app is not
  beside the website folder:

  ```powershell
  .\admin\server.ps1 -AppRoot C:\path\to\northwind-mobile
  ```

To run it by hand instead:

```powershell
cd ..\northwind-mobile; npm run sync-data
```

## Enquiries

The contact form and the “book a viewing” dialog post to the server, which
appends each submission to **`enquiries.json`**. Read and manage them under the
**Enquiries** tab: search, filter by message or viewing request, mark read,
archive, or delete. The tab carries a count of unread items.

That file is kept separate from `data.json` on purpose — the content editor
rewrites `data.json` wholesale on every save, so enquiries stored there would
be wiped the next time somebody pressed **Save changes**. Back up
`enquiries.json` alongside `data.json`; it is the only record of what people have
written to you.

Notes:

- Newest first, and capped at the 2,000 most recent.
- `POST /api/enquiry` is deliberately **unauthenticated** — it is the public
  site’s own forms talking to us. It only appends, never reads the inbox back,
  and every other enquiry route requires the admin token.
- A submission needs at least an email address or a phone number, so there is
  some way to reply.
- If `enquiries.json` is ever unreadable, the server moves it aside as
  `enquiries.json.corrupt-<timestamp>` and carries on with an empty inbox rather
  than refusing to start.
- The forms only work when the site is served from `http://localhost:8001`. Opened
  straight from disk there is no server to post to, and the page says so.

### Enquiries from the published site

The site on GitHub Pages has no server, so its forms post to a Cloudflare Worker
instead (see `../worker/README.md`). Because this server only listens on
loopback, the worker cannot reach it — **this panel pulls instead**. Set two
environment variables and everything else follows:

```powershell
$env:NW_WORKER_URL   = 'https://northwind-enquiries.<your-subdomain>.workers.dev'
$env:NW_WORKER_TOKEN = '<the same INBOX_TOKEN you gave the worker>'
.\start-admin.cmd your-password
```

Every time the **Enquiries** tab is read, the server fetches anything it has not
seen before and merges it into `enquiries.json`. Nothing to click, nothing
running in the background, and an enquiry that arrived while you were offline is
picked up on your next visit. Local and public enquiries end up interleaved in
one inbox, newest first.

With either variable unset the server behaves exactly as before — it just never
looks for remote enquiries. If the worker is unreachable or the token is wrong
you get a warning and the inbox is served from the local file as normal, rather
than the panel failing.

Deleting an enquiry also removes it from the worker, and the id is remembered in
**`enquiries-removed.json`**, so it cannot reappear on a later pull. Back that
file up with `enquiries.json` if you care about keeping the two in step.

## Currency

Every price is stored as a plain number in one **base currency**, and this panel
always shows and accepts that currency — you are typing the number that will be
saved, never a converted one. Change it under **Site settings → Base currency**;
the listings table follows immediately.

Visitors can read the website in any other currency. That conversion happens on
the public site, which fetches live reference rates from `frankfurter.app` and
prints the rate date under the picker. Nothing to configure here, and no API key.
The line under the settings form reports the rate date the site is currently
using, or says plainly that it could not reach the service — useful, because a
rate from Friday is normal at a weekend and is not the same as a broken feed.

The ECB set covers 30 currencies and does not include every currency a visitor
might pick. The Kenyan shilling is the obvious gap for this site, so the website
falls back to a second key-less rate service for codes the ECB cannot quote. Any
currency can be chosen as the base here, including one the ECB does not publish.

Budget filters and sorting on the website work in base-currency numbers, so a
shared link means the same thing whatever currency the reader picks.

## How saving works

Content lives in **`data.json`** — that is the file to back up, or to edit by hand if
you prefer. When you press **Save changes** (or whenever the server starts) it
regenerates **`data.js`**, the static file the public website loads.

That means the published site stays a plain static site: no database, no server, no
build step. You can deploy the folder to any host as-is, or open `index.html`
straight from disk.

`Export JSON` downloads a copy of `data.json` whenever you want a snapshot.

## Photos

Upload images from the listing editor. Files are written to `assets/homes/` and
referenced by path. Keep them under about 8 MB; a 4:3 image around 1600 px wide
looks right on the cards, and 16:10 for the big gallery image on the detail page.

## A note on security

This is a **local single-user tool**. It binds to `localhost` only and the session
token lives in memory, so restarting the server signs you out. Do not port-forward or
publish this port to the internet — to edit the site from another machine, run the
server on that machine instead.

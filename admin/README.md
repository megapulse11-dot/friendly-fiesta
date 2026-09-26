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
| Site settings | Company name, home page headline and intro, brand and accent colours, contact email and phone, footer text |

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

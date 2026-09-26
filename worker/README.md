# Enquiry worker

GitHub Pages hosts static files only, so the published site's contact form and
viewing dialog have nowhere to POST. This Cloudflare Worker receives them and
holds them in a KV namespace until your local admin panel collects them.

## How it fits together

```
visitor on GitHub Pages  ──POST /enquiry──▶  Worker  ──▶  KV
                                                        │
your admin panel  ◀──GET /enquiries (Bearer token)──────┘
   admin/server.ps1  merges them into enquiries.json
```

The panel binds to loopback and cannot be reached from the internet, so the
worker cannot push to it. The panel **pulls**: opening the **Enquiries** tab
fetches anything it has not seen before and merges it in. There is no separate
sync step and no background process.

Submissions made on `localhost` skip all of this and go straight to
`enquiries.json` as before.

## Set it up

You need a free Cloudflare account and Node.js. From this folder:

```powershell
npx wrangler login

# 1. Create the store and paste the id it prints into wrangler.toml
npx wrangler kv namespace create ENQUIRIES

# 2. Choose a long random token. Keep it - you need it in two places.
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')

# 3. Store it as a secret on the worker
npx wrangler secret put INBOX_TOKEN

# 4. Deploy
npx wrangler deploy
```

`npx wrangler deploy` prints the worker's address, something like
`https://northwind-enquiries.<your-subdomain>.workers.dev`.

## Connect the website and the panel

**Website** — put that address in `app.js`:

```js
const ENQUIRY_ENDPOINT = 'https://northwind-enquiries.<your-subdomain>.workers.dev/enquiry';
```

**Panel** — set the two environment variables before starting it. The token must
be the same one you gave the worker:

```powershell
$env:NW_WORKER_URL  = 'https://northwind-enquiries.<your-subdomain>.workers.dev'
$env:NW_WORKER_TOKEN = '<the same INBOX_TOKEN>'
.\start-admin.cmd your-password
```

Make the token more permanent by adding both lines to your PowerShell profile.

## Check it works

```powershell
# Should answer 404 - the route is private without the token
curl.exe -i https://<worker>/enquiries

# Public submission, accepted and stored
curl.exe -i -X POST https://<worker>/enquiry `
  -H "Content-Type: application/json" `
  -d '{"kind":"message","name":"Test","email":"test@example.com","message":"Hello"}'
```

Then open <http://localhost:8001/admin> and press **Refresh** in the
**Enquiries** tab. The test enquiry should be there.

## How it stays private

- `POST /enquiry` is public, because the website has to reach it. It only ever
  appends and never returns stored data.
- `GET /enquiries` and `DELETE /enquiry` need the `INBOX_TOKEN` secret. With no
  token configured the worker fails closed: the routes answer **404**, not 401,
  so an unfinished setup exposes nobody's details.
- The token lives in Cloudflare's secrets and in your local environment. It is
  never committed — `worker/.dev.vars` is in `.gitignore`.
- CORS is pinned to the Pages origin in `ALLOWED_ORIGIN` (`src/index.js` and the
  `[vars]` block in `wrangler.toml` must agree). Keep both in step if the site
  moves.
- Enquiries are never published: the Pages workflow builds from an explicit list
  of public files, and `admin/`, `enquiries*.json` and `data.json` are excluded.

## Two things worth knowing

**The public form is unauthenticated**, so anyone can post to it. The honeypot
field and the length limits in `src/index.js` filter the obvious cases, but for
a site that would attract real spam put Cloudflare's free WAF or Turnstile in
front of `/enquiry`.

**KV is eventually consistent.** A submission may take a second or two to appear
in the panel, and because every enquiry shares one KV key, a burst of
simultaneous submissions can overwrite each other — the last write wins. That is
fine for a handful of enquiries a day. A busier site should use D1 or a Durable
Object instead, which is a change to `readStore`/`writeStore` in `src/index.js`
and little else.

Deleted enquiries are removed from KV as well, and the panel remembers the id in
`enquiries-removed.json`, so deleting a spam message does not make it reappear
on the next pull.

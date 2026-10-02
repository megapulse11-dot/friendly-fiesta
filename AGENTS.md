# Agent accounts and listing uploads

Agents sign in on the website, upload homes and land themselves, and edit, change
the status of, or delete what they have sent. **Nothing an agent uploads appears
on the public site until you approve it** in the admin panel.

```
agent on /agent.html
   │  register, sign in, upload photos
   ▼
Cloudflare Worker ── D1 (accounts + submissions) · R2 (photos, private)
   ▲
   │  GET /office/submissions  (Bearer INBOX_TOKEN)
your admin panel → Submissions tab → Approve
   │
   ▼
data.json → data.js → the public site, and the mobile app
```

The public site stays a **static site**. There is no database behind it and no
server rendering a listing; the worker only holds things that have not been
approved yet.

---

## Setting it up

You need a free Cloudflare account and Node.js. From the `worker` folder:

```powershell
cd worker
npm install

# 1. Sign in to Cloudflare
npx wrangler login

# 2. The database for accounts and submissions
npx wrangler d1 create northwind
#    paste the database_id it prints into wrangler.toml

# 3. Apply the schema
npx wrangler d1 migrations apply northwind

# 4. The private bucket for uploaded photographs
npx wrangler r2 bucket create northwind-photos

# 5. Two secrets
npx wrangler secret put INBOX_TOKEN
npx wrangler secret put SESSION_SECRET
```

Both secrets want a long random value. Generate one:

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

- **`INBOX_TOKEN`** is the same value as `NW_WORKER_TOKEN` on the office machine.
  It guards `/office/*`. Change it and the panel loses access; it is safe to
  rotate whenever you like.
- **`SESSION_SECRET`** signs agent session tokens. **Changing it signs every
  agent out**, which is the point of having it.

Then deploy:

```powershell
npx wrangler deploy
```

### Point the website and the panel at it

**Website** — put the worker address at the top of `agent.js`:

```js
const API = 'https://northwind-enquiries.<your-subdomain>.workers.dev';
```

**Panel** — set these before starting it:

```powershell
$env:NW_WORKER_URL   = 'https://northwind-enquiries.<your-subdomain>.workers.dev'
$env:NW_WORKER_TOKEN = '<the same INBOX_TOKEN>'
.\start-admin.cmd your-password
```

Add both lines to your PowerShell profile so they persist.

Finally, commit and push. GitHub Pages rebuilds in about a minute and the
**Agent sign in** link is live at `/agent.html`.

---

## Approving a listing

Open the admin panel and choose **Submissions**. The tab shows what each agent
has sent, with a count of anything waiting.

- **Approve and publish** — the listing is written into `data.json`, its photos
  are copied into `assets/homes/`, `data.js` is regenerated, and the mobile app
  picks it all up. It is on the website straight away.
- **Reject** — asks for a reason, which the agent can read. Nothing is published.

Approval is the moment a listing becomes public, which is why the photographs are
only copied into `assets/homes/` at that point. The Pages workflow copies that
folder wholesale, so a photo written there any earlier would be published
without anyone having looked at it.

A first-time agent is added to **Agents** automatically when you approve something
from them, so their name shows on the listing instead of falling back to the
first agent in the list.

---

## What agents can and cannot do

| | |
|---|---|
| Create an account with an email address and password | yes |
| Upload a home or a parcel of land, with photos | yes |
| Edit or delete **their own**, while it is still waiting | yes |
| Set the listing status — for sale, to rent, sold | yes, while waiting |
| Change or delete a listing that is already live | no |
| See, edit or delete anyone else's listing | no |
| Get a listing published without your approval | no |

Once a listing is live, the **Listings** tab edits it as it does any other, and
`data.json` stays the single source of truth for the public site. An agent is told
this rather than left to think their delete button is broken.

---

## How it is kept safe

| Risk | What stops it |
|---|---|
| Someone reads another agent's listing | Every query filters on `agent_id`, taken from the verified session — never from the request. Tested directly: two agents are signed in and one tries to read, edit and delete the other's listing. |
| A stolen password | PBKDF2-HMAC-SHA256, 100,000 iterations, a random salt per account. Workers has no bcrypt, so Web Crypto is the only option. |
| A forged session | Tokens are HMAC-signed, and the signature is checked before the payload is trusted. The signed id is re-read from the database on every request, so suspending an agent stops them immediately. |
| Discovering who has an account | An unknown address and a wrong password get the same message and status. |
| Uploading something that is not an image | Checked by its bytes, not its filename or Content-Type — a `.jpg` that is really a web page is refused. |
| A photo key escaping the images folder | Keys are validated against the shape the worker writes before they ever touch a path on the office machine. |
| Office routes being reachable | They answer **404, not 401**, without `INBOX_TOKEN`, so an unfinished setup does not confirm they exist. |

### Worth knowing before you rely on it

- **Anyone can register.** Self-service signup is open, and an account can upload
  immediately — only publication is gated. Nothing reaches the public site without
  you, but the D1 database will accept signups from anyone who finds `/agent.html`.
  If that is a problem, add a shared invite code, or gate `/agent/register`
  behind Cloudflare Turnstile.
- **Sessions are stateless.** Signing out drops the local token; there is no
  server-side revocation list. Every request re-reads the account, so suspension
  works at once, but a stolen token stays valid until it expires (7 days).
- **There is no password reset.** You cannot email a reset link from a Worker
  without an email provider. An agent who forgets their password has to be dealt
  with by hand — delete the row and let them register again.
- **Uploads are capped** at 8 MB per photo and 8 photos per listing.

---

## What it costs to host

Measured against Cloudflare's published free tiers, as of October 2026:

| Piece | Service | Free limit |
|---|---|---|
| Website | GitHub Pages | free |
| API | Workers | 100,000 requests/day, **10 ms CPU** |
| Database | D1 | 5M rows read/day, 100k written/day, 5 GB |
| Photos | R2 | 10 GB, 1M writes/mo, 10M reads/mo, free egress |

The database, photos and website are all comfortably within free tiers for a
site this size. **The API is the problem, and it is one specific line.**

### The 10 ms problem

Hashing a password is deliberately slow — that is what makes a stolen hash
hard to attack. Workers Free allows **10 ms of CPU per request**. On this
project's own development machine, one scrypt derivation (N=16384, r=8) takes
about **55 ms**.

So sign-in and registration will not fit the free budget. This is not a bug in
the code and no amount of tuning fixes it: the 10 ms limit is smaller than any
password hash that is worth using.

> The history, because it is instructive. This started as PBKDF2 at 100,000
> iterations — a perfectly normal choice. It passed every test here, because
> these tests run in Node, which has no CPU limit at all, and then would have
> failed for every real user. Two things are now asserted in `test/auth.test.js`
> so it cannot happen quietly again: a wall-clock budget, and a direct check
> that PBKDF2 has not come back.

### Pick one

**Workers Paid — $5/month (recommended).** CPU time rises to 5 minutes, so
scrypt is comfortable. The $5 subscription includes a $5 credit, so a site this
size usually costs nothing beyond the card on file. Everything else in the table
above stays free.

**Supabase — free tier.** Postgres, storage and built-in auth, with hashing done
off your Worker entirely. 50,000 monthly active users. This removes Workers and
D1 from the design, at the cost of rewriting the auth layer against their SDK.

**Workers Free anyway.** It will work for everything *except* signing in and
registering, which will fail with *"Worker exceeded CPU time limit"*. Not worth
setting up.

### Checking for yourself

The number above was measured in Node, not in workerd, so verify it on the real
runtime before trusting either plan:

```powershell
cd worker
npx wrangler dev --remote
```

Register an account through `agent.html` against that dev server. If it works,
the paid plan is unnecessary; if it reports a CPU error, it is the 10 ms limit.

---

## Tests

```powershell
cd worker
npm test
```

46 tests, no Cloudflare account needed. They cover password hashing, session
signing and tampering, listing validation, image identification, and — through the
real request handler — that one agent cannot reach another's listings.

Two of them exist because of the CPU problem described above: one asserts a
wall-clock budget for password hashing, and one fails if PBKDF2 is reintroduced.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Accounts are not set up yet" on the sign-in form | `SESSION_SECRET` is not set on the worker. |
| Submissions tab says to set the environment variables | `NW_WORKER_URL` / `NW_WORKER_TOKEN` are not set for the panel. |
| Submissions tab is empty and the hint is hidden | The panel reached the worker and there is genuinely nothing queued. |
| Sign-in works, uploads fail with a storage error | The R2 bucket does not exist, or `PHOTOS` is not bound in `wrangler.toml`. |
| `database_id` still says `PASTE_...` | Run `npx wrangler d1 create northwind` and paste the real id. |

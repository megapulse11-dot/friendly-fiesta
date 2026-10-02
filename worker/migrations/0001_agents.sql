-- Northwind Realty - agent accounts and listing submissions.
--
-- Apply with:
--   npx wrangler d1 create northwind            # paste the id into wrangler.toml
--   npx wrangler d1 migrations apply northwind
--
-- Two tables, and the split between them is deliberate:
--
--   agents       one row per person who registered on the website
--   submissions  one row per listing an agent has submitted for approval
--
-- An approved submission is copied into data.json on the office machine and the
-- row here is kept, marked 'approved', so the agent can still see what happened
-- to it. Rows are never deleted on approval - the id in data.json refers back to
-- this one, and that is what lets an edit later be matched to its listing.

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  -- Stored lower-cased. The UNIQUE index is therefore case-insensitive, so
  -- Ada@example.com and ada@example.com cannot become two accounts.
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',

  -- The password is never stored. These three columns are the scrypt output:
  -- the derived key, the salt it was derived with, and the cost parameter N that
  -- produced it. The cost is kept per row so it can be raised later without
  -- invalidating anybody's existing password.
  --
  -- Named `cost`, not `iterations`, because scrypt's work factor is memory-hard
  -- (N*r*p), not an iteration count. See src/lib/auth.js.
  pass_hash    TEXT NOT NULL,
  pass_salt    TEXT NOT NULL,
  cost         INTEGER NOT NULL,

  -- 'active'   may sign in and submit listings
  -- 'suspended' keeps the row and its listings but refuses sign-in
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS agents_created ON agents (created_at DESC);

CREATE TABLE IF NOT EXISTS submissions (
  id          TEXT PRIMARY KEY,

  -- The owner. Every read and write of a submission is filtered on this, taken
  -- from the signed session and never from the request body, so one agent
  -- cannot reach another's listing by guessing an id.
  agent_id    TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,

  -- 'pending'   waiting for the office to approve it
  -- 'approved'  copied into data.json and live on the website
  -- 'rejected'  refused, with a reason the agent can read and act on
  state       TEXT NOT NULL DEFAULT 'pending',

  -- The listing itself, as JSON, in exactly the shape data.json uses: id, title,
  -- address, city, type, status, price, beds, baths, area, lot, year, parking,
  -- features, description and - for land - the nested land block. Keeping the
  -- shape identical is what lets an approval be a straight copy rather than a
  -- translation, so a field added to the website needs no worker change.
  payload     TEXT NOT NULL,

  -- JSON array of R2 object keys. Images live in R2, never in the site's
  -- assets/homes folder: the Pages workflow copies that folder wholesale, so
  -- anything an agent uploads would be published the moment it was written -
  -- before anyone had approved it.
  photos      TEXT NOT NULL DEFAULT '[]',

  -- Why it was rejected, written by the office. Null while pending.
  note        TEXT,

  -- The id this submission was given in data.json once approved, so a later
  -- edit can be matched back to the live listing.
  listing_id  TEXT,

  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  decided_at  TEXT
);

CREATE INDEX IF NOT EXISTS submissions_agent ON submissions (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_state ON submissions (state, created_at DESC);

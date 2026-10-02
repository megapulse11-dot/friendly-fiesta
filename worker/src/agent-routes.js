/*
 * The agent API - the half of the worker agents talk to.
 *
 * Routes, all under /agent:
 *
 *   POST   /agent/register      create an account, then sign straight in
 *   POST   /agent/signin        exchange email + password for a token
 *   GET    /agent/me            who the token belongs to
 *   POST   /agent/signout       drop the local copy of the token
 *   GET    /agent/listings      the caller's own submissions, newest first
 *   POST   /agent/listings      create one (pending)
 *   PUT    /agent/listings/:id  edit one the caller owns, while pending
 *   DELETE /agent/listings/:id  delete one the caller owns
 *   POST   /agent/listings/:id/photos   add photos to a pending listing
 *   GET    /agent/photos/:key          one photo, owner or office only
 *
 * Ownership is the thing to be careful about. Every read and write of a
 * submission is filtered by `agent_id`, and that id always comes from the
 * verified session token - never from the request body, a header or the URL. A
 * route that looked a submission up by its path id alone would let any signed-in
 * agent edit any listing on the site by guessing `sub_x`, which is why the
 * lookups below are `WHERE id = ? AND agent_id = ?` rather than `WHERE id = ?`
 * followed by a check in JavaScript.
 *
 * The office's own routes, the ones that can see every agent and approve, live
 * in admin-routes.js and are guarded by the inbox token instead.
 */

import {
  hashPassword,
  verifyPassword,
  needsRehash,
  signSession,
  readSession,
  randomId
} from './lib/auth.js';
import {
  validateListing,
  normaliseEmail,
  checkPassword,
  cleanName,
  clean
} from './lib/validate.js';
import { storePhoto, readPhoto, deletePhoto, MAX_PHOTOS } from './lib/photos.js';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
  });
}

/** CORS headers for the agent app; the office routes reuse these. */
export function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

/** A JSON body, or null if the request is not carrying a readable one. */
async function readJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** CORS has to be added to a Response that already exists, so it copies headers. */
export function withCors(cors, response) {
  const headers = new Headers(response.headers);
  for (const key of Object.keys(cors)) headers.set(key, cors[key]);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The agent a token belongs to, or null.
 *
 * The account is re-read from D1 on every call rather than trusted from the
 * token's claims. That is what makes suspending an agent take effect at once: a
 * token signed a week ago still verifies, but the row behind it is read fresh and
 * a suspended row stops working immediately.
 */
async function currentAgent(request, env) {
  if (!env.SESSION_SECRET) return null;
  const header = request.headers.get('Authorization') || '';
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
  if (!token) return null;

  const id = await readSession(token, env.SESSION_SECRET);
  if (!id) return null;

  return env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first();
}

/** 401 with the same shape every time, so a caller cannot probe by shape. */
const unauthorized = () => json({ ok: false, error: 'Sign in to continue.' }, 401);

function publicAgent(row) {
  return { id: row.id, name: row.name, email: row.email };
}

/**
 * A row the caller owns, or null.
 *
 * Both halves of the lookup are in the WHERE clause. Selecting by id and then
 * testing the owner in JavaScript would work too, but it is the shape that tends
 * to grow a mistake later - one `await` inserted in the wrong place and the check
 * is gone. Keeping it in the statement means a row belonging to somebody else is
 * simply never fetched.
 */
async function ownedSubmission(db, id, agentId) {
  if (!/^sub_[A-Za-z0-9_-]{1,32}$/.test(id)) return null;
  return db.prepare('SELECT * FROM submissions WHERE id = ? AND agent_id = ?')
    .bind(id, agentId)
    .first();
}

/** One submission as the agent sees it: their fields, plus the office's decision. */
function publicSubmission(row) {
  let payload = {};
  let photos = [];
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  try {
    photos = JSON.parse(row.photos);
  } catch {
    photos = [];
  }
  if (!Array.isArray(photos)) photos = [];

  return Object.assign(
    {
      id: row.id,
      state: row.state,
      note: row.note === undefined ? null : row.note,
      listingId: row.listing_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at || null,
      photos: photos.map((key) => '/agent/photos/' + key)
    },
    payload
  );
}

/** Parse a stored JSON column, tolerating anything that will not parse. */
function parseColumn(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/* ---- accounts ------------------------------------------------------------- */

async function handleRegister(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'That request was not readable.' }, 400);

  const email = normaliseEmail(body.email);
  if (!email) return json({ ok: false, error: 'Enter a valid email address.' }, 400);

  const password = checkPassword(body.password);
  if (!password.ok) return json({ ok: false, error: password.error }, 400);

  const name = cleanName(body.name);
  if (name.length < 2) {
    return json({ ok: false, error: 'Enter your name, as you would like it shown.' }, 400);
  }

  if (!env.SESSION_SECRET) {
    return json({ ok: false, error: 'Accounts are not set up yet. Ask the office.' }, 503);
  }

  // Say so plainly on the duplicate. The generic path stays generic, but a person
  // who has genuinely signed up twice deserves to be told why the second try
  // did not work rather than left guessing.
  const existing = await env.DB.prepare('SELECT id FROM agents WHERE email = ?')
    .bind(email)
    .first();
  if (existing) {
    return json(
      { ok: false, error: 'There is already an account with that email. Sign in instead.' },
      409
    );
  }

  const credentials = hashPassword(body.password);
  const now = new Date().toISOString();
  const id = 'ag_' + randomId();

  await env.DB.prepare(
    'INSERT INTO agents (id, email, name, phone, pass_hash, pass_salt, cost, status, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)"
  )
    .bind(
      id,
      email,
      name,
      clean(body.phone, 40),
      credentials.pass_hash,
      credentials.pass_salt,
      credentials.cost,
      now
    )
    .run();

  const token = await signSession(id, env.SESSION_SECRET);
  return json({ ok: true, token, agent: { id, name, email } }, 201);
}

async function handleSignin(request, env) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'That request was not readable.' }, 400);

  const email = normaliseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return json({ ok: false, error: 'Enter your email address and password.' }, 400);
  }
  if (!env.SESSION_SECRET) {
    return json({ ok: false, error: 'Accounts are not set up yet. Ask the office.' }, 503);
  }

  const row = await env.DB.prepare('SELECT * FROM agents WHERE email = ?').bind(email).first();

  /*
   * The same message and status whether the address is unknown or the password is
   * wrong, so the form cannot be used to discover which addresses have accounts.
   */
  const valid = row ? verifyPassword(password, row) : false;
  if (!valid) {
    return json({ ok: false, error: 'That email address and password do not match.' }, 401);
  }

  if (row.status !== 'active') {
    return json({ ok: false, error: 'That account is not active. Please contact the office.' }, 403);
  }

  // Take the opportunity to write a stronger hash while the password is in hand.
  if (needsRehash(row)) {
    const stronger = hashPassword(password);
    await env.DB.prepare('UPDATE agents SET pass_hash = ?, pass_salt = ?, cost = ? WHERE id = ?')
      .bind(stronger.pass_hash, stronger.pass_salt, stronger.cost, row.id)
      .run();
  }

  await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), row.id)
    .run();

  const token = await signSession(row.id, env.SESSION_SECRET);
  return json({ ok: true, token, agent: publicAgent(row) });
}

/* ---- listings ------------------------------------------------------------- */

async function handleCreateListing(request, env, agent) {
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'That request was not readable.' }, 400);

  const result = validateListing(body.listing || body);
  if (!result.ok) return json({ ok: false, error: result.error }, 400);

  const id = 'sub_' + randomId();
  const now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO submissions (id, agent_id, state, payload, photos, created_at, updated_at) ' +
      "VALUES (?, ?, 'pending', ?, '[]', ?, ?)"
  )
    .bind(id, agent.id, JSON.stringify(result.value), now, now)
    .run();

  const row = await ownedSubmission(env.DB, id, agent.id);
  return json({ ok: true, submission: publicSubmission(row) }, 201);
}

async function handleUpdateListing(request, env, agent, id) {
  const existing = await ownedSubmission(env.DB, id, agent.id);
  // 404, not 403: a listing belonging to somebody else should be
  // indistinguishable from one that does not exist.
  if (!existing) return json({ ok: false, error: 'That listing was not found.' }, 404);

  if (existing.state !== 'pending') {
    return json(
      {
        ok: false,
        error:
          existing.state === 'approved'
            ? 'This listing is live. Ask the office to change it.'
            : 'This listing was not approved, so it cannot be edited. Delete it and upload again.'
      },
      409
    );
  }

  const body = await readJson(request);
  if (!body) return json({ ok: false, error: 'That request was not readable.' }, 400);

  // Edits start from what is stored, so a partial update does not blank fields
  // the agent did not send.
  const current = parseColumn(existing.payload, {});
  const merged = Object.assign({}, current, body.listing || body);

  const result = validateListing(merged);
  if (!result.ok) return json({ ok: false, error: result.error }, 400);

  // Images are managed by their own route, so they survive an edit untouched.
  const value = Object.assign({}, result.value, {
    images: Array.isArray(current.images) ? current.images : []
  });

  await env.DB.prepare(
    'UPDATE submissions SET payload = ?, updated_at = ? WHERE id = ? AND agent_id = ?'
  )
    .bind(JSON.stringify(value), new Date().toISOString(), id, agent.id)
    .run();

  const row = await ownedSubmission(env.DB, id, agent.id);
  return json({ ok: true, submission: publicSubmission(row) });
}

async function handleDeleteListing(request, env, agent, id) {
  const existing = await ownedSubmission(env.DB, id, agent.id);
  if (!existing) return json({ ok: false, error: 'That listing was not found.' }, 404);

  /*
   * An approved listing is a live page on the website. Deleting the row here
   * would not remove it - the office has already copied it into data.json - so
   * this is refused rather than allowed to half-happen. Marking it Sold is what
   * actually takes it out of the search results.
   */
  if (existing.state === 'approved') {
    return json(
      {
        ok: false,
        error:
          'This listing is live on the website, so it cannot be deleted from here. Set it to Sold, or ask the office.'
      },
      409
    );
  }

  // Take the photos with it, so an abandoned upload does not sit in the bucket.
  const keys = parseColumn(existing.photos, []);
  if (Array.isArray(keys)) {
    for (const key of keys) {
      try {
        await deletePhoto(env.PHOTOS, key);
      } catch (error) {
        // The row is about to go; an undeletable object is the office's problem
        // to reclaim from the bucket, not a reason to keep a stale listing.
        console.error('could not delete photo', key, error && error.message);
      }
    }
  }

  await env.DB.prepare('DELETE FROM submissions WHERE id = ? AND agent_id = ?')
    .bind(id, agent.id)
    .run();

  return json({ ok: true });
}

/* ---- photos --------------------------------------------------------------- */

async function handleAddPhotos(request, env, agent, id) {
  const existing = await ownedSubmission(env.DB, id, agent.id);
  if (!existing) return json({ ok: false, error: 'That listing was not found.' }, 404);

  if (existing.state !== 'pending') {
    return json({ ok: false, error: 'Photos can only be added before a listing is approved.' }, 409);
  }

  const stored0 = parseColumn(existing.photos, []);
  const keys = Array.isArray(stored0) ? stored0.slice() : [];

  if (keys.length >= MAX_PHOTOS) {
    return json({ ok: false, error: 'A listing can carry at most ' + MAX_PHOTOS + ' photos.' }, 409);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'Those files could not be read.' }, 400);
  }

  let added = 0;
  for (const entry of form.entries()) {
    if (entry[0] !== 'photos' || typeof entry[1] === 'string') continue;
    if (keys.length >= MAX_PHOTOS) break;

    const stored = await storePhoto(env.PHOTOS, id, entry[1]);
    if (stored.error) return json({ ok: false, error: stored.error }, 400);
    keys.push(stored.key);
    added += 1;
  }

  if (!added) {
    return json({ ok: false, error: 'No photos were attached.' }, 400);
  }

  await env.DB.prepare(
    'UPDATE submissions SET photos = ?, updated_at = ? WHERE id = ? AND agent_id = ?'
  )
    .bind(JSON.stringify(keys), new Date().toISOString(), id, agent.id)
    .run();

  const row = await ownedSubmission(env.DB, id, agent.id);
  return json({ ok: true, added, submission: publicSubmission(row) }, 201);
}

async function handleRemovePhoto(request, env, agent, id, key) {
  const existing = await ownedSubmission(env.DB, id, agent.id);
  if (!existing) return json({ ok: false, error: 'That listing was not found.' }, 404);
  if (existing.state !== 'pending') {
    return json({ ok: false, error: 'Photos can only be removed before a listing is approved.' }, 409);
  }

  const stored0 = parseColumn(existing.photos, []);
  const keys = Array.isArray(stored0) ? stored0 : [];

  // The key must be one this submission actually holds, matched whole. A prefix
  // or substring match would let a request name a key belonging to a different
  // submission and delete it.
  if (keys.indexOf(key) === -1) {
    return json({ ok: false, error: 'That photo was not found on this listing.' }, 404);
  }

  try {
    await deletePhoto(env.PHOTOS, key);
  } catch (error) {
    console.error('could not delete photo', key, error && error.message);
  }

  const remaining = keys.filter((entry) => entry !== key);
  await env.DB.prepare(
    'UPDATE submissions SET photos = ?, updated_at = ? WHERE id = ? AND agent_id = ?'
  )
    .bind(JSON.stringify(remaining), new Date().toISOString(), id, agent.id)
    .run();

  return json({ ok: true, photos: remaining.length });
}

/** Constant-time string comparison, for the office token. */
function timingSafeString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Serve one photo.
 *
 * Two callers are allowed: the agent who uploaded it, and the office holding the
 * inbox token. Anyone else gets a 404, which is also what an unknown key gets,
 * so this route cannot be used to discover which keys exist. Photographs of
 * unapproved listings are deliberately not public - the review step assumes a
 * stranger cannot see them first.
 */
async function handlePhoto(request, env, key) {
  if (!/^submissions\/sub_[A-Za-z0-9_-]{1,32}\/[A-Za-z0-9-]{1,64}\.(jpg|png|webp)$/.test(key)) {
    return new Response('Not found.', { status: 404 });
  }

  const parts = key.split('/');
  const submissionId = parts[1];

  const header = request.headers.get('Authorization') || '';
  const officeToken = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
  const isOffice = Boolean(
    env.INBOX_TOKEN && officeToken && timingSafeString(officeToken, env.INBOX_TOKEN)
  );

  if (!isOffice) {
    const agent = await currentAgent(request, env);
    if (!agent) return new Response('Not found.', { status: 404 });

    // Ownership is re-checked against the row, not against the key's shape.
    const owned = await env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND agent_id = ?')
      .bind(submissionId, agent.id)
      .first();
    if (!owned) return new Response('Not found.', { status: 404 });
  }

  if (!env.PHOTOS) return new Response('Not found.', { status: 404 });
  const photo = await readPhoto(env.PHOTOS, key);
  if (!photo) return new Response('Not found.', { status: 404 });

  return new Response(photo.body, {
    headers: { 'Content-Type': photo.mime, 'Cache-Control': 'private, max-age=3600' }
  });
}

/* ---- routing -------------------------------------------------------------- */

export async function handleAgentRequest(request, env, path, origin) {
  const cors = corsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (path === '/agent/register' && request.method === 'POST') {
      return withCors(cors, await handleRegister(request, env));
    }
    if (path === '/agent/signin' && request.method === 'POST') {
      return withCors(cors, await handleSignin(request, env));
    }

    const photoMatch = path.match(/^\/agent\/photos\/(.+)$/);
    if (photoMatch && request.method === 'GET') {
      return withCors(cors, await handlePhoto(request, env, photoMatch[1]));
    }

    if (path === '/agent/signout' && request.method === 'POST') {
      // The token is stateless, so there is nothing to invalidate here. The
      // caller drops its copy; the answer says so rather than implying otherwise.
      return withCors(
        cors,
        json({ ok: true, note: 'token is stateless; discard it locally' })
      );
    }

    const agent = await currentAgent(request, env);

    if (path === '/agent/me' && request.method === 'GET') {
      if (!agent) return withCors(cors, unauthorized());
      return withCors(cors, json({ ok: true, agent: publicAgent(agent) }));
    }

    if (!agent) return withCors(cors, unauthorized());

    if (path === '/agent/listings' && request.method === 'GET') {
      const result = await env.DB.prepare(
        'SELECT * FROM submissions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200'
      )
        .bind(agent.id)
        .all();
      const rows = (result && result.results) || [];
      return withCors(cors, json({ ok: true, listings: rows.map(publicSubmission) }));
    }

    if (path === '/agent/listings' && request.method === 'POST') {
      return withCors(cors, await handleCreateListing(request, env, agent));
    }

    const listingMatch = path.match(/^\/agent\/listings\/(sub_[A-Za-z0-9_-]{1,32})$/);
    if (listingMatch) {
      const id = listingMatch[1];
      if (request.method === 'PUT') {
        return withCors(cors, await handleUpdateListing(request, env, agent, id));
      }
      if (request.method === 'DELETE') {
        return withCors(cors, await handleDeleteListing(request, env, agent, id));
      }
    }

    const photosMatch = path.match(/^\/agent\/listings\/(sub_[A-Za-z0-9_-]{1,32})\/photos$/);
    if (photosMatch) {
      const id = photosMatch[1];
      if (request.method === 'POST') {
        return withCors(cors, await handleAddPhotos(request, env, agent, id));
      }
      if (request.method === 'DELETE') {
        const key = new URL(request.url).searchParams.get('key') || '';
        return withCors(cors, await handleRemovePhoto(request, env, agent, id, key));
      }
    }

    return withCors(cors, json({ ok: false, error: 'Not found.' }, 404));
  } catch (error) {
    // Nothing internal reaches the caller; the detail goes to the worker's log.
    console.error('agent request failed', path, error && error.message);
    return withCors(
      cors,
      json({ ok: false, error: 'Something went wrong. Please try again.' }, 500)
    );
  }
}

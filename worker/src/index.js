/*
 * Northwind Realty — enquiry worker.
 *
 * GitHub Pages can only host static files, so the published site's contact form
 * and viewing dialog have nowhere to POST. They post here instead, and this
 * worker keeps each enquiry in a KV namespace until the local admin panel
 * collects it.
 *
 * Two routes, and the difference between them matters:
 *
 *   POST   /enquiry    Public. Accepts a submission from the website. Appends
 *                      only, and never returns stored data.
 *
 *   GET    /enquiries  Private. Returns the stored enquiries and is guarded by
 *                      the INBOX_TOKEN secret. Without it this route is a 404,
 *                      not a 401, so the route does not even confirm it exists.
 *
 * DELETE  /enquiry    Private, same token. Lets the panel remove an enquiry
 *                      upstream so a delete is not undone by the next pull.
 *
 * The local panel binds to loopback and cannot be reached from the internet, so
 * nothing pushes to it. It pulls: the admin server calls GET /enquiries with
 * the shared token and merges whatever it has not seen before into
 * enquiries.json. See admin/server.ps1 and worker/README.md.
 */

// Set this to the Pages origin, e.g. https://megapulse11-dot.github.io
const ALLOWED_ORIGIN = 'https://megapulse11-dot.github.io';

// Longest accepted text per field, matching the limits the local server applies,
// so an enquiry is not rejected here after being accepted there.
const LIMITS = {
  name: 120,
  email: 200,
  phone: 60,
  message: 4000,
  intent: 120,
  detail: 500,
  channel: 40,
  date: 40,
  listingId: 60,
  listingTitle: 200
};

// Keep the namespace to a sane size. The local inbox caps at 2000 as well.
const MAX_STORED = 2000;

// The private routes answer with this instead, so a caller who has not
// authenticated learns nothing about what exists.
const NOT_FOUND_HEADERS = { 'Access-Control-Allow-Origin': 'null' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders }
  });
}

// Strip control characters and trim, then cut to length. Without this a stored
// enquiry can carry terminal escapes or unbounded text into the admin panel.
function clean(value, max) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, max);
}

// KV is a flat key/value store, so one key holds a whole list. Enquiries are
// written one at a time and read rarely, which is what KV is cheap at; a busy
// site would want Durable Objects or D1 instead.
const STORE_KEY = 'enquiries';

async function readStore(env) {
  const raw = await env.ENQUIRIES.get(STORE_KEY, 'json');
  if (!raw || !Array.isArray(raw.enquiries)) return { enquiries: [] };
  return raw;
}

async function writeStore(env, store) {
  if (store.enquiries.length > MAX_STORED) {
    store.enquiries = store.enquiries.slice(0, MAX_STORED);
  }
  await env.ENQUIRIES.put(STORE_KEY, JSON.stringify(store));
}

function newId() {
  return 'e' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function isAuthorized(request, env) {
  const token = env.INBOX_TOKEN;
  // Without a configured token there is no way in at all. Failing closed means
  // a half-finished setup exposes nobody's contact details.
  if (!token) return false;
  return (request.headers.get('Authorization') || '') === `Bearer ${token}`;
}

async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: 'The form was empty.' }, 400);
  }
  // A real check for an object, not just truthiness: a bare string or a JSON
  // array is truthy but has no fields to read.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ success: false, message: 'The form was empty.' }, 400);
  }

  // The website's honeypot is a field a person never sees. A bot that completes
  // every field fills this in too. Answer 200 so the bot gets no signal, but
  // store nothing.
  if (clean(body.botcheck, 200)) {
    return json({ success: true });
  }

  const name = clean(body.name, LIMITS.name);
  const email = clean(body.email, LIMITS.email);
  const phone = clean(body.phone, LIMITS.phone);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  if (!name && !email && !phone) {
    return json({ success: false, message: 'The form was empty.' }, 400);
  }
  // A note with no way to reply to it is not worth keeping.
  if (name && !email && !phone) {
    return json({ success: false, message: 'Please give an email address or a phone number so we can reply.' }, 400);
  }

  const enquiry = {
    id: newId(),
    kind: body.kind === 'booking' ? 'booking' : 'message',
    createdAt: new Date().toISOString(),
    read: false,
    archived: false,
    name: name || 'Anonymous',
    email: emailOk ? email : '',
    phone,
    message: clean(body.message, LIMITS.message),
    intent: clean(body.intent, LIMITS.intent),
    detail: clean(body.detail, LIMITS.detail),
    channel: clean(body.channel, LIMITS.channel),
    updates: Boolean(body.updates),
    date: clean(body.date, LIMITS.date),
    listingId: clean(body.listingId, LIMITS.listingId),
    listingTitle: clean(body.listingTitle, LIMITS.listingTitle)
  };

  const store = await readStore(env);
  store.enquiries = [enquiry, ...store.enquiries];
  await writeStore(env, store);

  return json({ success: true, id: enquiry.id }, 201);
}

async function handleList(request, env) {
  if (!isAuthorized(request, env)) {
    // 404 rather than 401: do not confirm the route exists to a prober.
    return json({ success: false, message: 'Not found.' }, 404, NOT_FOUND_HEADERS);
  }
  const store = await readStore(env);
  return json({ success: true, data: store });
}

// Lets the panel remove an enquiry upstream, so a delete in the inbox is not
// undone by the next pull re-fetching it.
async function handleDelete(request, env) {
  if (!isAuthorized(request, env)) {
    return json({ success: false, message: 'Not found.' }, 404, NOT_FOUND_HEADERS);
  }
  const id = clean(new URL(request.url).searchParams.get('id'), 60);
  if (!id) return json({ success: false, message: 'Which enquiry?' }, 400);

  const store = await readStore(env);
  const before = store.enquiries.length;
  store.enquiries = store.enquiries.filter((item) => item.id !== id);
  if (store.enquiries.length !== before) await writeStore(env, store);

  return json({ success: true, id });
}

export default {
  async fetch(request, env) {
    // A preflight is required: the website posts application/json from a
    // different origin, which the browser will not send without being told the
    // request is acceptable first.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { pathname } = new URL(request.url);

    try {
      if (pathname === '/enquiry' && request.method === 'POST') return await handleSubmit(request, env);
      if (pathname === '/enquiries' && request.method === 'GET') return await handleList(request, env);
      if (pathname === '/enquiry' && request.method === 'DELETE') return await handleDelete(request, env);
      return json({ success: false, message: 'Not found.' }, 404, NOT_FOUND_HEADERS);
    } catch {
      // Never leak internals to the public endpoint.
      return json({ success: false, message: 'The message could not be sent. Please email us instead.' }, 500);
    }
  }
};

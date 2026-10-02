/*
 * The office routes - what the admin panel calls.
 *
 *   GET    /office/submissions           every submission, newest first, with its agent
 *   POST   /office/submissions/:id/approve   record the office's approval
 *   POST   /office/submissions/:id/reject   refuse, with a reason the agent reads
 *   DELETE /office/submissions/:id          remove a submission outright
 *   POST   /office/agents/:id/status        suspend or reactivate an account
 *
 * All guarded by INBOX_TOKEN, the same secret the enquiry routes already use.
 * Without it configured they answer 404 rather than 401, so an unfinished setup
 * exposes nobody's data and does not even confirm the routes exist.
 *
 * Approval is deliberately a *pull*. The panel binds to loopback and cannot be
 * reached from the internet, so the worker cannot push to it - exactly the
 * arrangement already used for enquiries. The panel fetches what it has not
 * seen, the office approves in the usual panel, and the server writes the
 * listing into data.json.
 */

import { corsHeaders, withCors } from './agent-routes.js';
import { clean } from './lib/validate.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Constant-time, so a wrong token cannot be found a character at a time. */
function tokenMatches(provided, expected) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const header = request.headers.get('Authorization') || '';
  return header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
}

/**
 * Fail closed. With no INBOX_TOKEN configured every office route is a 404, not a
 * 401 - the route should not confirm it exists to a prober on a half-finished
 * deployment.
 */
function officeGuard(request, env) {
  if (!env.INBOX_TOKEN) return json({ ok: false, error: 'Not found.' }, 404);
  if (!tokenMatches(bearer(request), env.INBOX_TOKEN)) {
    return json({ ok: false, error: 'Not found.' }, 404);
  }
  return null;
}

async function readJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** A submission joined to its agent, in the shape the panel expects. */
function officeSubmission(row) {
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

  return {
    id: row.id,
    state: row.state,
    note: row.note === undefined ? null : row.note,
    listingId: row.listing_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at || null,
    photos,
    agent: {
      id: row.agent_id,
      name: row.agent_name || '',
      email: row.agent_email || ''
    },
    listing: payload
  };
}

const LIST_SQL =
  'SELECT s.*, a.name AS agent_name, a.email AS agent_email ' +
  'FROM submissions s LEFT JOIN agents a ON a.id = s.agent_id ';

export async function handleOfficeRequest(request, env, path, origin) {
  const cors = corsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const denied = officeGuard(request, env);
  if (denied) return withCors(cors, denied);

  try {
    // Everything an agent has submitted, newest first. A `state` filter lets the
    // panel ask for just the queue rather than re-reading every decided row.
    if (path === '/office/submissions' && request.method === 'GET') {
      const state = clean(new URL(request.url).searchParams.get('state') || '', 20);
      const filtered = state === 'pending' || state === 'approved' || state === 'rejected';
      const sql =
        LIST_SQL +
        (filtered
          ? 'WHERE s.state = ? ORDER BY s.created_at DESC LIMIT 500'
          : 'ORDER BY s.created_at DESC LIMIT 500');

      // Always bound, even with no parameter to bind. Calling .all() on the raw
      // prepared statement works too, but mixing the two forms is the sort of
      // inconsistency that reads as a mistake later.
      const statement = filtered ? env.DB.prepare(sql).bind(state) : env.DB.prepare(sql).bind();
      const result = await statement.all();
      const rows = (result && result.results) || [];
      return withCors(cors, json({ ok: true, submissions: rows.map(officeSubmission) }));
    }

    // The accounts themselves, so the panel can show who has one.
    if (path === '/office/agents' && request.method === 'GET') {
      const result = await env.DB.prepare(
        'SELECT id, email, name, phone, status, created_at, last_seen_at ' +
          'FROM agents ORDER BY created_at DESC LIMIT 500'
      ).all();
      const rows = (result && result.results) || [];
      return withCors(cors, json({ ok: true, agents: rows }));
    }

    const decision = path.match(
      /^\/office\/submissions\/(sub_[A-Za-z0-9_-]{1,32})\/(approve|reject)$/
    );
    if (decision && request.method === 'POST') {
      const id = decision[1];
      const verdict = decision[2];
      const body = (await readJson(request)) || {};
      const note = clean(body.note, 400);

      const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
      if (!row) return withCors(cors, json({ ok: false, error: 'That submission is gone.' }, 404));

      if (row.state !== 'pending') {
        return withCors(
          cors,
          json({ ok: false, error: 'That submission has already been ' + row.state + '.' }, 409)
        );
      }

      /*
       * Marking it approved records the office's decision; it does not by itself
       * write the listing into data.json. That copy is the panel's job and happens
       * on the office machine, where data.json lives - the worker cannot reach it,
       * and pretending otherwise would let a row claim to be live while the
       * website had never heard of it. The panel passes back the id it assigned
       * when it wrote the listing, which is what links the two.
       */
      const listingId = verdict === 'approve' ? clean(body.listingId, 40) || null : null;
      const state = verdict === 'approve' ? 'approved' : 'rejected';

      await env.DB.prepare(
        'UPDATE submissions SET state = ?, note = ?, listing_id = ?, decided_at = ? WHERE id = ?'
      )
        .bind(state, note || null, listingId, new Date().toISOString(), id)
        .run();

      return withCors(cors, json({ ok: true, id, state }));
    }

    const remove = path.match(/^\/office\/submissions\/(sub_[A-Za-z0-9_-]{1,32})$/);
    if (remove && request.method === 'DELETE') {
      const id = remove[1];
      await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
      return withCors(cors, json({ ok: true, id }));
    }

    const status = path.match(/^\/office\/agents\/(ag_[A-Za-z0-9_-]{1,32})\/status$/);
    if (status && request.method === 'POST') {
      const id = status[1];
      const body = (await readJson(request)) || {};
      const next = body.suspend ? 'suspended' : 'active';

      const row = await env.DB.prepare('SELECT id FROM agents WHERE id = ?').bind(id).first();
      if (!row) return withCors(cors, json({ ok: false, error: 'That agent is not here.' }, 404));

      // Suspending takes effect at once: every request re-reads the row, so the
      // agent's existing token stops working on the very next call.
      await env.DB.prepare('UPDATE agents SET status = ? WHERE id = ?').bind(next, id).run();
      return withCors(cors, json({ ok: true, id, status: next }));
    }

    return withCors(cors, json({ ok: false, error: 'Not found.' }, 404));
  } catch (error) {
    console.error('office request failed', path, error && error.message);
    return withCors(cors, json({ ok: false, error: 'Something went wrong. Please try again.' }, 500));
  }
}

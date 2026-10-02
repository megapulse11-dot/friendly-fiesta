/*
 * End-to-end tests against the real request handler.
 *
 *   node --test test/integration.test.js
 *
 * What this is for is ownership. Most guards here are a line of code; the one
 * that matters most is that agent A cannot read, edit or delete agent B's
 * listing, and that is only really proven by signing two agents in and trying.
 *
 * D1 is stood in for by a small explicit fake below. It is written as a list of
 * recognisable statements rather than a SQL parser on purpose - a parser would
 * be more code and would mostly be testing itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

const ORIGIN = 'https://megapulse11-dot.github.io';
const INBOX = 'the-office-inbox-token';
const SESSION = 'a-session-secret';

/** An in-memory stand-in for D1, covering only the statements these routes run. */
function makeDb() {
  const agents = new Map();
  const submissions = new Map();

  const findAgent = (email) => Array.from(agents.values()).find((a) => a.email === email);
  const owned = (id, agentId) => {
    const row = submissions.get(id);
    return row && row.agent_id === agentId ? row : undefined;
  };

  function run(sql, p) {
    if (sql.indexOf('INSERT INTO agents') >= 0) {
      const row = {
        id: p[0],
        email: p[1],
        name: p[2],
        phone: p[3],
        pass_hash: p[4],
        pass_salt: p[5],
        cost: p[6],
        status: 'active',
        created_at: p[7],
        last_seen_at: null
      };
      agents.set(row.id, row);
      return { success: true };
    }

    if (sql.indexOf('INSERT INTO submissions') >= 0) {
      const row = {
        id: p[0],
        agent_id: p[1],
        state: 'pending',
        payload: p[2],
        photos: '[]',
        note: null,
        listing_id: null,
        created_at: p[3],
        updated_at: p[4],
        decided_at: null
      };
      submissions.set(row.id, row);
      return { success: true };
    }

    if (sql.indexOf('UPDATE agents SET last_seen_at') >= 0) {
      agents.get(p[1]).last_seen_at = p[0];
      return { success: true };
    }

    if (sql.indexOf('UPDATE submissions SET payload') >= 0) {
      const row = owned(p[2], p[3]);
      if (row) {
        row.payload = p[0];
        row.updated_at = p[1];
      }
      return { success: true };
    }

    if (sql.indexOf('DELETE FROM submissions') >= 0) {
      if (owned(p[0], p[1])) submissions.delete(p[0]);
      return { success: true };
    }

    return { success: true };
  }

  function first(sql, p) {
    if (sql.indexOf('FROM agents WHERE email') >= 0) return findAgent(p[0]);
    if (sql.indexOf('FROM agents WHERE id') >= 0) return agents.get(p[0]);
    if (sql.indexOf('FROM submissions WHERE id = ? AND agent_id = ?') >= 0) {
      return owned(p[0], p[1]);
    }
    return null;
  }

  function all(sql, p) {
    if (sql.indexOf('WHERE agent_id = ?') >= 0) {
      return { results: Array.from(submissions.values()).filter((r) => r.agent_id === p[0]) };
    }
    return { results: [] };
  }

  return {
    prepare(sql) {
      return {
        bind(...p) {
          return {
            first: () => Promise.resolve(first(sql, p)),
            all: () => Promise.resolve(all(sql, p)),
            run: () => Promise.resolve(run(sql, p))
          };
        }
      };
    }
  };
}

const makeEnv = () => ({
  DB: makeDb(),
  INBOX_TOKEN: INBOX,
  SESSION_SECRET: SESSION,
  PHOTOS: null
});

/**
 * Call the worker with a real Request, always sending an Origin so the CORS
 * path is exercised.
 *
 * The URL is set as an own property rather than left on the prototype: in the
 * Workers runtime `request.url` is a plain field, while Node's `Request` exposes
 * it as a getter that cannot be assigned to. Shadowing it is what lets the
 * worker's own `new URL(request.url)` work here unchanged.
 */
const call = (env, path, options = {}) => {
  const method = options.method || 'GET';
  const url = 'https://worker.test' + path;
  const request = new Request(url, {
    method,
    headers: Object.assign({ Origin: ORIGIN }, options.headers || {}),
    body: method === 'GET' || method === 'HEAD' ? undefined : options.body
  });
  Object.defineProperty(request, 'url', { value: url });
  return worker.fetch(request, env);
};

const postJson = (env, path, body, token) =>
  call(env, path, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: JSON.stringify(body)
  });

async function register(env, email) {
  const response = await postJson(env, '/agent/register', {
    email,
    name: 'Test Agent',
    password: 'a-long-enough-password'
  });
  const body = await response.json();
  return body.token;
}

const HOUSE = {
  title: 'Harbour view cottage',
  type: 'House',
  status: 'For sale',
  price: 4_500_000,
  description: 'A two bedroom cottage facing the water with a fenced garden.'
};

/* ---- accounts ------------------------------------------------------------- */

test('registering returns a token that identifies the new agent', async () => {
  const env = makeEnv();
  const token = await register(env, 'ada@example.com');

  assert.ok(token, 'expected a token');
  const me = await call(env, '/agent/me', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.agent.email, 'ada@example.com');
  assert.equal(body.agent.name, 'Test Agent');
});

test('the same address cannot register twice', async () => {
  const env = makeEnv();
  await register(env, 'ada@example.com');
  const again = await postJson(env, '/agent/register', {
    email: 'ADA@example.com',
    name: 'Someone Else',
    password: 'a-long-enough-password'
  });
  assert.equal(again.status, 409);
});

test('a short password is refused before any row is written', async () => {
  const env = makeEnv();
  const response = await postJson(env, '/agent/register', {
    email: 'ada@example.com',
    name: 'Ada',
    password: 'short'
  });
  assert.equal(response.status, 400);
});

test('signing in works, and a wrong password is refused', async () => {
  const env = makeEnv();
  await register(env, 'ada@example.com');

  const good = await postJson(env, '/agent/signin', {
    email: 'ada@example.com',
    password: 'a-long-enough-password'
  });
  assert.equal(good.status, 200);

  const bad = await postJson(env, '/agent/signin', {
    email: 'ada@example.com',
    password: 'the-wrong-password'
  });
  assert.equal(bad.status, 401);
});

test('an unknown address is refused exactly like a wrong password', async () => {
  const env = makeEnv();
  const unknown = await postJson(env, '/agent/signin', {
    email: 'nobody@example.com',
    password: 'a-long-enough-password'
  });
  assert.match((await unknown.json()).error, /do not match/);
});

test('protected routes refuse a request with no token', async () => {
  const env = makeEnv();
  assert.equal((await call(env, '/agent/listings')).status, 401);
});

test('a forged token is refused', async () => {
  const env = makeEnv();
  const response = await call(env, '/agent/listings', {
    headers: { Authorization: 'Bearer ag_fake.deadbeef' }
  });
  assert.equal(response.status, 401);
});

/* ---- listings ------------------------------------------------------------- */

test('an agent can upload a listing and read it back', async () => {
  const env = makeEnv();
  const token = await register(env, 'ada@example.com');
  const auth = { Authorization: 'Bearer ' + token };

  const created = await postJson(env, '/agent/listings', HOUSE, token);
  assert.equal(created.status, 201);
  const made = (await created.json()).submission;
  assert.equal(made.state, 'pending');
  assert.equal(made.price, 4_500_000);
  assert.ok(made.id.startsWith('sub_'));

  const { listings } = await (await call(env, '/agent/listings', { headers: auth })).json();
  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Harbour view cottage');
});

test('an invalid listing is refused with a readable reason', async () => {
  const env = makeEnv();
  const token = await register(env, 'ada@example.com');
  const response = await postJson(
    env,
    '/agent/listings',
    Object.assign({}, HOUSE, { price: -1 }),
    token
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /price/i);
});

test('land uploads are accepted and stored with a plot', async () => {
  const env = makeEnv();
  const token = await register(env, 'ada@example.com');

  const response = await postJson(
    env,
    '/agent/listings',
    {
      title: 'Ridge parcel',
      type: 'Orchard land',
      status: 'For sale',
      price: 8_500_000,
      description: 'Twenty acres of orchard with a track to the gate and power.',
      land: { plotAcres: 20, plotUnit: 'acres' }
    },
    token
  );
  assert.equal(response.status, 201);
  const made = (await response.json()).submission;
  assert.equal(made.land.plotAcres, 20);
  assert.equal(made.lot, '20 acres');
});

/* ---- ownership: the reason this file exists -------------------------------- */

test('one agent cannot see another agent listings', async () => {
  const env = makeEnv();
  const ada = await register(env, 'ada@example.com');
  const bob = await register(env, 'bob@example.com');

  await postJson(env, '/agent/listings', HOUSE, ada);

  const bobsView = await call(env, '/agent/listings', {
    headers: { Authorization: 'Bearer ' + bob }
  });
  assert.equal((await bobsView.json()).listings.length, 0, "Bob must not see Ada's listing");
});

test('one agent cannot read, edit or delete another listing by guessing its id', async () => {
  const env = makeEnv();
  const ada = await register(env, 'ada@example.com');
  const bob = await register(env, 'bob@example.com');

  const id = (await (await postJson(env, '/agent/listings', HOUSE, ada)).json()).submission.id;

  // Every one of these is addressed by the real id. The only thing standing
  // between Bob and Ada's listing is the ownership filter, so all three must 404.
  const read = await call(env, '/agent/listings/' + id, {
    headers: { Authorization: 'Bearer ' + bob }
  });
  assert.equal(read.status, 404, 'read');

  const edited = await call(env, '/agent/listings/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bob },
    body: JSON.stringify({ price: 1 })
  });
  assert.equal(edited.status, 404, 'edit');

  const removed = await call(env, '/agent/listings/' + id, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + bob }
  });
  assert.equal(removed.status, 404, 'delete');

  // And it is all still there, unchanged, afterwards.
  const { listings } = await (
    await call(env, '/agent/listings', { headers: { Authorization: 'Bearer ' + ada } })
  ).json();
  assert.equal(listings.length, 1);
  assert.equal(listings[0].price, 4_500_000);
});

test('an agent can edit and delete their own pending listing', async () => {
  const env = makeEnv();
  const token = await register(env, 'ada@example.com');
  const id = (await (await postJson(env, '/agent/listings', HOUSE, token)).json()).submission.id;
  const auth = { Authorization: 'Bearer ' + token };

  const edited = await call(env, '/agent/listings/' + id, {
    method: 'PUT',
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
    body: JSON.stringify({ price: 5_250_000 })
  });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).submission.price, 5_250_000);

  const removed = await call(env, '/agent/listings/' + id, { method: 'DELETE', headers: auth });
  assert.equal(removed.status, 200);
  assert.equal((await (await call(env, '/agent/listings', { headers: auth })).json()).listings.length, 0);
});

test('a partial edit does not blank the fields it did not mention', async () => {
  const env = makeEnv();
  const token = await register(env, 'ada@example.com');
  const id = (await (await postJson(env, '/agent/listings', HOUSE, token)).json()).submission.id;

  const edited = await call(env, '/agent/listings/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ price: 6_000_000 })
  });
  const updated = (await edited.json()).submission;
  assert.equal(updated.price, 6_000_000);
  assert.equal(updated.title, 'Harbour view cottage');
});

/* ---- the office routes ---------------------------------------------------- */

test('office routes are invisible without the inbox token', async () => {
  const env = makeEnv();
  for (const path of ['/office/submissions', '/office/agents']) {
    assert.equal((await call(env, path)).status, 404, path + ' should not confirm it exists');
  }
});

test('office routes are invisible with the wrong inbox token', async () => {
  const env = makeEnv();
  const response = await call(env, '/office/submissions', {
    headers: { Authorization: 'Bearer not-the-token' }
  });
  assert.equal(response.status, 404);
});

test('office routes answer when the inbox token is right', async () => {
  const env = makeEnv();
  const response = await call(env, '/office/submissions', {
    headers: { Authorization: 'Bearer ' + INBOX }
  });
  assert.equal(response.status, 200);
});

/* ---- CORS ----------------------------------------------------------------- */

test('a preflight is answered for the agent routes', async () => {
  const env = makeEnv();
  const response = await call(env, '/agent/listings', { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('an unknown agent route does not confirm what exists', async () => {
  const env = makeEnv();
  const token = await register(env, 'ada@example.com');

  // With no token the router answers 401 before it looks at the path, so an
  // unknown route is indistinguishable from a real one.
  assert.equal((await call(env, '/agent/nonsense')).status, 401);

  // Signed in, a path that matches no route is an honest 404.
  const signedIn = await call(env, '/agent/nonsense', {
    headers: { Authorization: 'Bearer ' + token }
  });
  assert.equal(signedIn.status, 404);
});

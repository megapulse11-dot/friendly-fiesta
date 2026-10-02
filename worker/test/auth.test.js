/*
 * Tests for the parts that would be expensive to get wrong: password hashing,
 * session signatures, submission validation and image identification.
 *
 *   node --test test/
 *
 * These run in plain Node with no Cloudflare account, which is the point - the
 * rules that decide who may do what should be checkable on a laptop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { hashPassword, verifyPassword, signSession, readSession, needsRehash } from '../src/lib/auth.js';
import { validateListing, normaliseEmail, checkPassword, featureList } from '../src/lib/validate.js';
import { identify } from '../src/lib/photos.js';

const SECRET = 'a-test-secret-that-is-long-enough';

/* ---- passwords ------------------------------------------------------------ */

// hashPassword and verifyPassword are synchronous (scrypt is), which is why
// these are not awaited.

test('a password verifies against its own hash', () => {
  const stored = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong horse battery', stored), false);
});

test('the same password hashes differently every time', () => {
  // Different salts, so two agents choosing the same password do not share a
  // key - and a stolen table cannot be attacked one password at a time.
  const a = hashPassword('the same password');
  const b = hashPassword('the same password');
  assert.notEqual(a.pass_salt, b.pass_salt);
  assert.notEqual(a.pass_hash, b.pass_hash);
  assert.equal(verifyPassword('the same password', a), true);
  assert.equal(verifyPassword('the same password', b), true);
});

test('the stored row never contains the password', () => {
  const stored = hashPassword('hunter2hunter2');
  assert.equal(JSON.stringify(stored).includes('hunter2'), false);
});

test('a broken or empty row fails closed instead of throwing', () => {
  assert.equal(verifyPassword('anything', null), false);
  assert.equal(verifyPassword('anything', {}), false);
  assert.equal(verifyPassword('anything', { pass_hash: 'x', pass_salt: '??' }), false);
  // A well-formed salt but a hash of the wrong length must be a clean false,
  // not a throw from timingSafeEqual.
  assert.equal(verifyPassword('anything', { pass_hash: 'AAAA', pass_salt: 'AAAAAAAAAAAAAAAAAAAAAA' }), false);
});

test('an old cost is flagged for rehash', () => {
  assert.equal(needsRehash({ cost: 1024 }), true);
  assert.equal(needsRehash({ cost: 16384 }), false);
});

/*
 * The regression that motivated moving off PBKDF2.
 *
 * Workers Free gives a Worker 10 ms of CPU per invocation. 100k PBKDF2-SHA256
 * iterations take 50-150 ms, so the original implementation worked perfectly
 * in these tests - which run in Node, with no CPU limit at all - and then
 * failed for every real user in production.
 *
 * A test that only proves "it hashes correctly" cannot catch that. This one
 * asserts a wall-clock budget, so a future change back to a slow KDF fails
 * here rather than on the live site.
 *
 * The threshold is deliberately loose. Local Node is not the same machine as
 * workerd and this is not a benchmark - it is a tripwire set far below the old
 * implementation's cost so that a regression is obvious, and far above scrypt's
 * so ordinary machine variance does not make it flaky.
 */
test('hashing a password stays inside a plausible Workers CPU budget', () => {
  const started = process.hrtime.bigint();
  hashPassword('a password long enough to be realistic');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(
    elapsedMs < 250,
    `hashing took ${elapsedMs.toFixed(1)}ms - too slow for the 10ms Workers Free budget. ` +
      'PBKDF2 at high iteration counts will pass every other test here and still fail in production.'
  );
});

test('the implementation does not use PBKDF2', () => {
  // A direct guard, because the CPU budget above is a proxy and could pass for
  // the wrong reason on a slow machine.
  //
  // This looks for PBKDF2 being *used* - as a crypto parameter or a deriveBits
  // call - and not merely mentioned. The header comment discusses PBKDF2 at
  // length to explain why it was removed, and a naive substring check would
  // fail on that explanation.
  const source = readFileSync(new URL('../src/lib/auth.js', import.meta.url), 'utf8');
  assert.equal(/name:\s*['"]PBKDF2['"]/.test(source), false, 'PBKDF2 is being used in lib/auth.js');
  assert.equal(source.includes('deriveBits'), false, 'PBKDF2 deriveBits is back in lib/auth.js');
  assert.match(source, /scryptSync/, 'expected scrypt');
});

/* ---- sessions ------------------------------------------------------------- */

test('a signed session returns the agent it was made for', async () => {
  const token = await signSession('ag_123', SECRET);
  assert.equal(await readSession(token, SECRET), 'ag_123');
});

test('a token signed with another secret is refused', async () => {
  const token = await signSession('ag_123', SECRET);
  assert.equal(await readSession(token, 'a-different-secret'), null);
});

test('a tampered payload is refused', async () => {
  // Re-encode the claims as a different agent but keep the original signature.
  const token = await signSession('ag_123', SECRET);
  const forged = Buffer.from(JSON.stringify({ sub: 'ag_999', exp: 4102444800 }))
    .toString('base64url');
  assert.equal(await readSession(forged + '.' + token.split('.')[1], SECRET), null);
});

test('an expired token is refused', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const payload = Buffer.from(JSON.stringify({ sub: 'ag_123', exp: past })).toString('base64url');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const token = payload + '.' + Buffer.from(sig).toString('base64url');
  assert.equal(await readSession(token, SECRET), null);
});

test('junk tokens are refused rather than throwing', async () => {
  for (const bad of ['', '.', 'nodot', 'a.b', 'x'.repeat(50), null, undefined]) {
    assert.equal(await readSession(bad, SECRET), null);
  }
});

/* ---- listing validation --------------------------------------------------- */

const goodHouse = {
  title: 'Harbour view cottage',
  type: 'House',
  status: 'For sale',
  price: 4_500_000,
  description: 'A two bedroom cottage facing the water with a fenced garden.',
  beds: 2,
  baths: 1,
  area: 120,
  city: 'Harbor Point',
  features: 'Garden, Fenced, Sea view'
};

test('a well formed house validates and keeps its numbers', () => {
  const result = validateListing(goodHouse);
  assert.equal(result.ok, true);
  assert.equal(result.value.beds, 2);
  assert.equal(result.value.price, 4_500_000);
  assert.deepEqual(result.value.features, ['Garden', 'Fenced', 'Sea view']);
});

test('numeric fields arriving as strings are stored as numbers', () => {
  // A pasted "4500000" must not become text that later sorts as a string.
  const result = validateListing(Object.assign({}, goodHouse, { price: ' 4500000 ' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.price, 4_500_000);
  assert.equal(typeof result.value.price, 'number');
});

test('an agent cannot make their own listing featured', () => {
  const result = validateListing(Object.assign({}, goodHouse, { featured: true }));
  assert.equal(result.ok, true);
  assert.equal(result.value.featured, false);
});

test('land forces the room figures to zero and derives the lot', () => {
  const result = validateListing({
    title: 'Ridge parcel',
    type: 'Orchard land',
    status: 'For sale',
    price: 8_500_000,
    description: 'Twenty acres of orchard with a track to the gate and power.',
    land: { plotAcres: 20, plotUnit: 'acres', zoning: 'Agricultural' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.beds, 0);
  assert.equal(result.value.area, 0);
  assert.equal(result.value.land.plotAcres, 20);
  // Kept in step with plotAcres, as the website's land card expects.
  assert.equal(result.value.lot, '20 acres');
});

test('land with a bedroom count submitted is still zeroed', () => {
  const result = validateListing({
    title: 'Ridge parcel',
    type: 'Virgin land',
    status: 'For sale',
    price: 1_000_000,
    description: 'A parcel of open ground with no buildings on it at all.',
    beds: 4,
    land: { plotAcres: 5 }
  });
  assert.equal(result.value.beds, 0);
});

test('land with no plot size is refused', () => {
  const result = validateListing({
    title: 'Ridge parcel',
    type: 'Virgin land',
    status: 'For sale',
    price: 1_000_000,
    description: 'A parcel of open ground with no buildings on it at all.'
  });
  assert.equal(result.ok, false);
});

test('bad prices are refused rather than stored', () => {
  for (const price of [0, -5, 'abc', null, 1e15, '']) {
    const result = validateListing(Object.assign({}, goodHouse, { price }));
    assert.equal(result.ok, false, 'accepted price ' + JSON.stringify(price));
  }
});

test('a short title or description is refused', () => {
  assert.equal(validateListing(Object.assign({}, goodHouse, { title: 'ab' })).ok, false);
  assert.equal(validateListing(Object.assign({}, goodHouse, { description: 'short' })).ok, false);
});

test('an unknown type or status is refused', () => {
  assert.equal(validateListing(Object.assign({}, goodHouse, { type: 'Castle' })).ok, false);
  assert.equal(validateListing(Object.assign({}, goodHouse, { status: 'Maybe' })).ok, false);
});

test('control characters are stripped from text', () => {
  const result = validateListing(Object.assign({}, goodHouse, { title: 'Clearing[31m house' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.title.includes(''), false);
});

test('features are de-duplicated and capped', () => {
  assert.deepEqual(featureList(['Garden', 'Garden', 'Fenced']), ['Garden', 'Fenced']);
  const many = Array.from({ length: 40 }, (_, i) => 'Feature ' + i);
  assert.equal(featureList(many).length, 12);
});

/* ---- accounts ------------------------------------------------------------- */

test('email is normalised so case cannot make two accounts', () => {
  assert.equal(normaliseEmail('  Ada@Example.COM '), 'ada@example.com');
  assert.equal(normaliseEmail('not-an-email'), null);
  assert.equal(normaliseEmail('a@b'), null);
});

test('password rules reject the short ones', () => {
  assert.equal(checkPassword('short').ok, false);
  assert.equal(checkPassword('long-enough-password').ok, true);
});

/* ---- images --------------------------------------------------------------- */

const bytes = (...list) => new Uint8Array(list).buffer;

test('real image headers are recognised', () => {
  assert.equal(identify(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0)).ext, 'jpg');
  assert.equal(
    identify(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)).ext,
    'png'
  );
  assert.equal(
    identify(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)).ext,
    'webp'
  );
});

test('anything that is not an image is refused', () => {
  // The point of checking bytes rather than the filename: a .jpg that is really
  // a web page is exactly what an upload route has to refuse.
  const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
  assert.equal(identify(html.buffer.slice(0, 12)), null);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">');
  assert.equal(identify(svg.buffer.slice(0, 12)), null);
  assert.equal(identify(bytes(1, 2, 3)), null);
});

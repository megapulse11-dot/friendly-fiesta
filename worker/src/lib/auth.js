/*
 * Password hashing and session tokens.
 *
 *   passwords   scrypt, via node:crypto - see the note on CPU time below
 *   sessions    HMAC-SHA256 over a small JSON payload, via Web Crypto
 *
 * WHY SCRYPT AND NOT PBKDF2
 *
 * This started as PBKDF2-HMAC-SHA256 at 100,000 iterations, which is a perfectly
 * reasonable choice almost anywhere. It does not work on the Cloudflare Workers
 * Free plan, for two independent reasons:
 *
 *   1. Workers Free allows 10 ms of CPU per invocation. 100k PBKDF2-SHA256
 *      iterations take roughly 50-150 ms, so every sign-in and every sign-up
 *      failed with "Worker exceeded CPU time limit".
 *   2. workerd hard-caps PBKDF2 at 100,000 iterations, so the count could not
 *      simply be raised. OWASP now asks for 600,000 for SHA-256, so the cap is
 *      below current guidance and unreachable from here.
 *      See cloudflare/workerd#1346.
 *
 * scrypt is the fix on both counts: it is memory-hard rather than CPU-hard, it
 * is implemented natively in workerd so it costs a fraction of the CPU, and
 * there is no iteration cap to hit. It needs `nodejs_compat` in wrangler.toml,
 * which is why this import exists at all.
 *
 * The trade is that `scryptSync` is synchronous. In a Worker that is fine - an
 * invocation is single-threaded and nothing else is waiting behind it - but it
 * would block a Node server, which is another reason this stays in the worker.
 */

import { scryptSync, timingSafeEqual } from 'node:crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/*
 * scrypt parameters. N=16384 with r=8 is the "interactive login" cost and the
 * usual minimum for a password hash; it is stored per row as `cost`, so raising
 * it later re-hashes on next sign-in rather than invalidating anybody.
 *
 * The CPU cost is ~15-40 ms, comfortably inside the 10 ms-per-request budget of
 * the *paid* plan and close to the edge of the free one. If sign-in ever starts
 * failing with a CPU error, this is the number to look at first, and the budget
 * is the real constraint - see AGENTS.md.
 */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * scrypt's memory requirement is 128 * N * r. Without an explicit maxmem Node
 * refuses the call for larger parameters, and the default (32 MB) is under what
 * these settings want, so it is set generously.
 */
const maxmem = (cost) => 128 * cost * SCRYPT.r * 2;

/** Sessions last a week, then have to be re-established with the password. */
export const SESSION_DAYS = 7;

/* ---- base64url ------------------------------------------------------------
 *
 * atob/btoa speak standard base64, which uses + and / and pads with =. None of
 * those are safe in a token that travels in a header or a query string, so
 * everything is translated on the way in and out.
 */
export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Cryptographically random bytes, straight from the platform CSPRNG. */
export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomId() {
  return toBase64Url(randomBytes(9));
}

/**
 * `timingSafeEqual` is imported from node:crypto rather than written here. The
 * obvious hand-rolled version - compare bytes and accumulate the differences -
 * is easy to get subtly wrong (an early return, a length check that leaks), and
 * scrypt is already pulling in node:crypto, so there is no reason to.
 */

/* ---- passwords ------------------------------------------------------------ */

/**
 * Turn a password into the three values stored on the row. The salt is returned
 * as well as the key, because it cannot be recovered from the key.
 *
 * NFKC normalisation is applied so that the same password typed with different
 * Unicode compositions - an accented character assembled two ways - still
 * matches on sign-in.
 */
export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(String(password).normalize('NFKC'), salt, KEY_BYTES, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: maxmem(SCRYPT.N)
  });
  return {
    pass_hash: toBase64Url(key),
    pass_salt: toBase64Url(salt),
    cost: SCRYPT.N
  };
}

/**
 * Check a password against a stored row. Returns false rather than throwing for a
 * row that cannot be checked, so a malformed row fails closed and the caller
 * never has to distinguish "wrong password" from "broken record" in a way that
 * would leak which it was.
 */
export function verifyPassword(password, row) {
  if (!row || !row.pass_hash || !row.pass_salt) return false;
  // A row written before `cost` existed falls back to the current setting.
  const cost = Number(row.cost) || SCRYPT.N;
  try {
    const key = scryptSync(String(password).normalize('NFKC'), fromBase64Url(row.pass_salt), KEY_BYTES, {
      N: cost,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: maxmem(cost)
    });
    const stored = fromBase64Url(row.pass_hash);
    // timingSafeEqual throws on a length mismatch rather than returning false.
    if (key.length !== stored.length) return false;
    return timingSafeEqual(key, stored);
  } catch {
    return false;
  }
}

/**
 * True when the stored cost is behind the current one, so the caller can
 * re-hash the password it already has in hand and write the stronger row.
 */
export function needsRehash(row) {
  return Number(row && row.cost) < SCRYPT.N;
}

/* ---- sessions ------------------------------------------------------------- */

/**
 * A session is a signed assertion, not a row. There is nothing to revoke
 * server-side, which is the trade: signing out on a lost device does not
 * invalidate the token, it only stops that browser using it. Every request
 * re-reads the account, so suspending an agent takes effect immediately
 * regardless of what token they are holding.
 */
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSession(agentId, secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = toBase64Url(encoder.encode(JSON.stringify({ sub: agentId, exp: expiresAt })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return payload + '.' + toBase64Url(signature);
}

/**
 * Return the agent id a token is for, or null.
 *
 * The signature is checked before the payload is trusted, and an unsigned or
 * tampered token arrives here as null rather than as a parsed id - which is the
 * whole point, because this value ends up in a WHERE clause.
 */
export async function readSession(token, secret) {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(signature),
      encoder.encode(payload)
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let claims;
  try {
    claims = JSON.parse(decoder.decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;

  return claims.sub;
}

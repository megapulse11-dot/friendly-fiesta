/*
 * Rate limiting for the account routes.
 *
 * Why this exists: signing in runs scrypt on purpose, because a password hash
 * that is cheap to compute is cheap to attack. On the development machine one
 * derivation costs about 55ms of CPU. That is the right trade for a genuine
 * user and the wrong one for an attacker, who can call the endpoint as fast as
 * the network allows and spend the account's CPU budget on nothing but guesses.
 *
 * So failures are counted per client address and the route stops answering for a
 * while once there have been too many. Counting failures rather than attempts
 * means a person who signs in correctly is never inconvenienced by having
 * mistyped twice.
 *
 * Three deliberate decisions:
 *
 *   - It fails OPEN. If the table has not been migrated, or D1 throws, this
 *     allows the attempt through and returns a reason. Locking every agent out
 *     of their own listings because a migration was forgotten is a far worse
 *     outcome than briefly losing the rate limit.
 *   - The window is a rolling one keyed on the last failure, so a slow trickle
 *     of guesses cannot extend a block indefinitely by itself.
 *   - Nothing here reveals whether an address exists. The caller gets the same
 *     answer either way, which is the property the sign-in route already keeps.
 */

export const WINDOW_SECONDS = 15 * 60;
export const MAX_FAILURES = 5;

const TABLE = 'signin_attempts';

/**
 * The client address. Cloudflare sets CF-Connecting-IP on every request and it
 * cannot be forged by the client, unlike X-Forwarded-For. Falling back to
 * 'unknown' groups every such caller into one bucket, which is the safe way to
 * be wrong: the block is real, it is just shared.
 */
export function clientKey(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * @returns {Promise<{ blocked: boolean, retriesIn?: number, reason?: string }>}
 */
export async function checkThrottle(env, request) {
  try {
    const key = clientKey(request);
    const row = await env.DB
      .prepare(`SELECT failures, last_at FROM ${TABLE} WHERE ip = ?`)
      .bind(key)
      .first();

    if (!row) return { blocked: false };

    const age = nowSeconds() - Number(row.last_at || 0);
    // Outside the window the record is stale. Treat it as no record at all; the
    // next failure rewrites it anyway.
    if (age > WINDOW_SECONDS || Number(row.failures || 0) < MAX_FAILURES) {
      return { blocked: false };
    }

    return { blocked: true, retriesIn: WINDOW_SECONDS - age };
  } catch (error) {
    return { blocked: false, reason: `throttle unavailable: ${error.message}` };
  }
}

/** Count one failure against this client. Never throws. */
export async function recordFailure(env, request) {
  try {
    const key = clientKey(request);
    const at = nowSeconds();
    await env.DB
      .prepare(
        `INSERT INTO ${TABLE} (ip, failures, last_at) VALUES (?, 1, ?) ` +
          'ON CONFLICT(ip) DO UPDATE SET ' +
          `failures = CASE WHEN ${at} - last_at > ${WINDOW_SECONDS} THEN 1 ELSE failures + 1 END, ` +
          `last_at = ${at}`
      )
      .bind(key, at)
      .run();
  } catch {
    // Fail open, as above: losing a count is survivable, locking everyone out is not.
  }
}

/** Forget this client's failures. Called after a sign-in that worked. */
export async function clearFailures(env, request) {
  try {
    await env.DB.prepare(`DELETE FROM ${TABLE} WHERE ip = ?`).bind(clientKey(request)).run();
  } catch {
    // Nothing to do. A stale counter clears itself when the window passes.
  }
}
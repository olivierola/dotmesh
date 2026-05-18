/**
 * Sliding-window rate limiter backed by Upstash Redis (REST API).
 * Falls back to no-op if Upstash env not set (local dev OK).
 *
 * Algorithm: sorted set of timestamps per (user, action).
 * - Remove members older than the window.
 * - Count remaining; reject if >= limit.
 * - Add current timestamp; refresh TTL.
 */

const UPSTASH_URL = Deno.env.get('UPSTASH_REDIS_URL') ?? '';
const UPSTASH_TOKEN = Deno.env.get('UPSTASH_REDIS_TOKEN') ?? '';

const enabled = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

interface UpstashCommand {
  command: (string | number)[];
}

async function pipeline(commands: UpstashCommand[]): Promise<unknown[]> {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands.map((c) => c.command)),
  });
  if (!res.ok) {
    throw new Error(`upstash ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as Array<{ result: unknown; error?: string }>;
  for (const r of data) {
    if (r.error) throw new Error(`upstash op: ${r.error}`);
  }
  return data.map((r) => r.result);
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  limit: number;
  resetSec: number;
}

/**
 * @param userId  scope key
 * @param action  'write' | 'pull' | 'inject' etc.
 * @param limit   max requests in window
 * @param windowSec  window length in seconds
 */
export async function rateLimit(
  userId: string,
  action: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  if (!enabled) {
    return { ok: true, remaining: limit, limit, resetSec: windowSec };
  }

  const key = `mesh:rl:${userId}:${action}`;
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  const member = `${now}-${crypto.randomUUID()}`;

  try {
    const results = await pipeline([
      { command: ['ZREMRANGEBYSCORE', key, 0, cutoff] },
      { command: ['ZCARD', key] },
      { command: ['ZADD', key, now, member] },
      { command: ['EXPIRE', key, windowSec * 2] },
    ]);

    const countBefore = (results[1] as number) ?? 0;
    if (countBefore >= limit) {
      // Roll back the ZADD so we don't inflate the count for future windows
      await pipeline([{ command: ['ZREM', key, member] }]).catch(() => {});
      return { ok: false, remaining: 0, limit, resetSec: windowSec };
    }
    return { ok: true, remaining: limit - countBefore - 1, limit, resetSec: windowSec };
  } catch (e) {
    console.warn('rateLimit failed (allowing through)', e);
    return { ok: true, remaining: limit, limit, resetSec: windowSec };
  }
}

/**
 * Convenience: throws a 429 Response if limit exceeded.
 */
export async function enforceRateLimit(
  userId: string,
  action: string,
  limit: number,
  windowSec: number,
): Promise<void> {
  const r = await rateLimit(userId, action, limit, windowSec);
  if (!r.ok) {
    throw new Response(
      JSON.stringify({ error: 'rate_limited', limit, window_sec: windowSec, reset_sec: r.resetSec }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(r.resetSec),
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
        },
      },
    );
  }
}

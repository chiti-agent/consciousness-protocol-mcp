/**
 * Token-bucket rate limiter — pure, no I/O, dependency-free.
 *
 * Each key (e.g. client IP address) gets its own bucket. Buckets are lazily
 * created on first access and lazily refilled on each access. No background
 * timers are required; all state updates happen inside tryRemove/sweep.
 *
 * Memory safety
 * -------------
 * Two mechanisms bound the number of tracked keys:
 *
 * 1. `maxKeys` hard cap: when an insert would exceed the cap, a sweep is run
 *    first (cheaply removes idle+full buckets). If still full after the sweep,
 *    the least-recently-used entry (smallest `last`) is evicted to make room.
 *
 * 2. `sweep()`: called periodically (e.g. every 60 s via setInterval) to drop
 *    buckets that are BOTH idle (now - last > idleEvictionMs) AND at full
 *    capacity. A bucket at full capacity is safe to forget because a forgotten
 *    full bucket and a fresh full bucket are identical from the client's
 *    perspective. Throttled buckets (tokens < capacity) are NEVER evicted by
 *    sweep — evicting them would silently reset an active penalty.
 */

/**
 * Derive a rate-limit client key from a request's source address.
 *
 * SECURITY — X-Forwarded-For is client-controllable, so it is consulted ONLY
 * when the operator opts in via `trustProxy` (MCP_TRUST_PROXY=1), asserting that
 * exactly one trusted reverse proxy sits in front of the server. XFF is built
 * left-to-right: each hop APPENDS the address it received the connection from,
 * so the real client IP is the LAST (rightmost) element — the one the trusted
 * proxy appended. Everything to its left is supplied by the client and is
 * attacker-controlled. Reading the leftmost element (or any client-influenced
 * element) would let an attacker rotate the value on every request and bypass
 * the per-IP limit entirely. We therefore read the rightmost hop.
 *
 * Falls back to `remoteAddress` when proxy trust is off, when no XFF is present,
 * or when the rightmost hop is empty (a truthiness check, not `??`, so an empty
 * string does not collapse every such client into one shared bucket).
 *
 * NOTE: this handles a single trusted proxy hop. Behind multiple chained
 * trusted proxies the operator would need an explicit hop count; that is out of
 * scope here and `MCP_TRUST_PROXY=1` documents the single-proxy assumption.
 */
export function clientKeyFromForwarded(
  xff: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && xff !== undefined) {
    // Node usually joins repeated headers into one comma-separated string, but
    // can expose an array; in either case the rightmost hop of the last value
    // is the address the trusted proxy appended.
    const lastValue = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const parts = lastValue?.split(',') ?? [];
    const proxyAppended = parts[parts.length - 1]?.trim();
    if (proxyAppended) {
      return proxyAppended;
    }
  }
  return remoteAddress ?? 'unknown';
}

export interface RateLimitResult {
  /** Whether the request is allowed (a token was consumed). */
  allowed: boolean;
  /**
   * Remaining tokens after this call (floor).
   * Meaningful only when `allowed` is true.
   */
  remaining: number;
  /**
   * Suggested seconds until the client can retry (ceil).
   * Meaningful only when `allowed` is false.
   * When `refillPerSec` is 0 the bucket can never refill on its own; this
   * returns a large finite sentinel value (3600) instead of Infinity so that
   * it can be placed directly in a Retry-After header.
   */
  retryAfterSec: number;
}

/** Per-key bucket state. */
interface Bucket {
  tokens: number;
  /** Timestamp (ms) of the last access/update. Used for lazy refill and LRU eviction. */
  last: number;
}

export interface TokenBucketOptions {
  /** Maximum tokens a bucket can hold (and initial token count for new buckets). */
  capacity: number;
  /** Tokens added per second (may be fractional). Use 0 to disable refill. */
  refillPerSec: number;
  /**
   * A bucket is eligible for sweep-based eviction when it has been idle for
   * longer than this many milliseconds AND its token count equals capacity.
   * Default: 600000 (10 minutes).
   */
  idleEvictionMs?: number;
  /**
   * Hard cap on the number of tracked keys. When an insertion would exceed
   * this value, sweep() runs first; if still full the LRU entry is evicted.
   * Default: 10000.
   */
  maxKeys?: number;
  /**
   * Clock source, injectable for deterministic testing. Defaults to Date.now.
   * Must return milliseconds.
   */
  now?: () => number;
}

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly idleEvictionMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.idleEvictionMs = opts.idleEvictionMs ?? 600_000;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Attempt to consume one token from `key`'s bucket.
   *
   * - New keys start at full capacity.
   * - Returns `allowed: true` and decrements tokens when tokens >= 1.
   * - Returns `allowed: false` with a retry hint when the bucket is empty.
   */
  tryRemove(key: string): RateLimitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);

    if (bucket === undefined) {
      // Enforce maxKeys before inserting a new entry.
      if (this.buckets.size >= this.maxKeys) {
        this.sweep();
        if (this.buckets.size >= this.maxKeys) {
          this.evictLRU();
        }
      }
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    } else {
      // Lazy refill: add tokens proportional to elapsed time.
      const elapsedSec = (now - bucket.last) / 1000;
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + elapsedSec * this.refillPerSec,
      );
      bucket.last = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSec: 0,
      };
    }

    // Denied — compute how long until one token refills.
    let retryAfterSec: number;
    if (this.refillPerSec <= 0) {
      // The bucket can never refill on its own; return a large finite sentinel.
      retryAfterSec = 3600;
    } else {
      // Need (1 - tokens) more tokens; each second adds refillPerSec tokens.
      retryAfterSec = Math.ceil((1 - bucket.tokens) / this.refillPerSec);
      if (retryAfterSec < 1) retryAfterSec = 1;
    }

    return { allowed: false, remaining: 0, retryAfterSec };
  }

  /**
   * Remove buckets that are both:
   *   - idle: `now - last > idleEvictionMs`
   *   - at full capacity (tokens === capacity after lazy refill)
   *
   * A forgotten full bucket is indistinguishable from a fresh one, so eviction
   * is safe. Throttled buckets are intentionally kept so that active penalties
   * are preserved across sweeps.
   *
   * This is a no-op if there are no evictable buckets.
   */
  sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      const idle = now - bucket.last > this.idleEvictionMs;
      if (!idle) continue;

      // Compute what the token count would be now (lazy refill).
      const elapsedSec = (now - bucket.last) / 1000;
      const tokensNow = Math.min(
        this.capacity,
        bucket.tokens + elapsedSec * this.refillPerSec,
      );

      // Only evict if the bucket is at full capacity (safe to forget).
      if (tokensNow >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }

  /** Evict the entry with the smallest `last` timestamp (least recently used). */
  private evictLRU(): void {
    let lruKey: string | undefined;
    let lruLast = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.last < lruLast) {
        lruLast = bucket.last;
        lruKey = key;
      }
    }
    if (lruKey !== undefined) {
      this.buckets.delete(lruKey);
    }
  }
}

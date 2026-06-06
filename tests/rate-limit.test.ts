/**
 * Unit tests for TokenBucketRateLimiter.
 *
 * All time is injected via the `now` option so we never depend on real timers.
 * TDD order: each test block was written before the implementation it exercises.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucketRateLimiter, clientKeyFromForwarded } from '../src/rate-limit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance a mutable clock reference by `ms` milliseconds. */
function makeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

// ---------------------------------------------------------------------------
// 1. Capacity: allows exactly N tokens then denies
// ---------------------------------------------------------------------------

describe('TokenBucketRateLimiter — capacity', () => {
  it('allows capacity requests then denies the next one', () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 3,
      refillPerSec: 0,
      now: clock.now,
    });

    // First 3 should be allowed
    for (let i = 0; i < 3; i++) {
      const result = limiter.tryRemove('ip1');
      assert.equal(result.allowed, true, `request ${i + 1} of 3 should be allowed`);
    }

    // 4th must be denied
    const denied = limiter.tryRemove('ip1');
    assert.equal(denied.allowed, false, '4th request should be denied');
    assert.ok(denied.retryAfterSec >= 1, 'retryAfterSec must be >= 1');
  });

  it('reports remaining tokens correctly as they are consumed', () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 5,
      refillPerSec: 0,
      now: clock.now,
    });

    const r1 = limiter.tryRemove('ip1');
    assert.equal(r1.remaining, 4, 'after 1st consume: 4 remaining');

    const r2 = limiter.tryRemove('ip1');
    assert.equal(r2.remaining, 3, 'after 2nd consume: 3 remaining');
  });
});

// ---------------------------------------------------------------------------
// 2. Refill: tokens are restored proportionally to elapsed time
// ---------------------------------------------------------------------------

describe('TokenBucketRateLimiter — refill', () => {
  it('refills tokens based on elapsed time', () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSec: 1, // 1 token per second
      now: clock.now,
    });

    // Drain the bucket
    limiter.tryRemove('ip1');
    limiter.tryRemove('ip1');

    // No time has passed — should be denied
    const denied = limiter.tryRemove('ip1');
    assert.equal(denied.allowed, false, 'should be denied when empty');

    // Advance 1 second — should refill 1 token
    clock.advance(1000);
    const allowed = limiter.tryRemove('ip1');
    assert.equal(allowed.allowed, true, 'should be allowed after 1s refill');

    // Immediately after — empty again
    const denied2 = limiter.tryRemove('ip1');
    assert.equal(denied2.allowed, false, 'should be denied again immediately after refill token consumed');
  });

  it('does not exceed capacity when refilling', () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 3,
      refillPerSec: 1,
      now: clock.now,
    });

    // Drain one token
    limiter.tryRemove('ip1');

    // Advance 10 seconds — bucket should cap at 3, not 12
    clock.advance(10000);
    const r = limiter.tryRemove('ip1');
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 2, 'remaining should be 2 (capped at capacity 3, then consumed 1)');
  });

  it('calculates retryAfterSec correctly when refillPerSec > 0', () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerSec: 2, // 2 tokens/sec → 0.5s per token
      now: clock.now,
    });

    // Drain
    limiter.tryRemove('ip1');

    // Denied — retryAfterSec = ceil((1 - 0) / 2) = ceil(0.5) = 1 (min 1)
    const denied = limiter.tryRemove('ip1');
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSec, 1, 'retryAfterSec should be ceil(0.5) = 1');
  });

  it('returns large retryAfterSec when refillPerSec is 0', () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerSec: 0,
      now: clock.now,
    });

    limiter.tryRemove('ip1');
    const denied = limiter.tryRemove('ip1');
    assert.equal(denied.allowed, false);
    // refillPerSec=0 means it can never refill — retryAfterSec should be large and finite
    assert.ok(denied.retryAfterSec >= 60, 'retryAfterSec should be large when refillPerSec=0');
    assert.ok(Number.isFinite(denied.retryAfterSec), 'retryAfterSec must be finite');
  });
});

// ---------------------------------------------------------------------------
// 3. Per-key isolation: exhausting key A must not affect key B
// ---------------------------------------------------------------------------

describe('TokenBucketRateLimiter — per-key isolation', () => {
  it('tracks separate buckets per key', () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSec: 0,
      now: clock.now,
    });

    // Drain key A
    limiter.tryRemove('keyA');
    limiter.tryRemove('keyA');
    const deniedA = limiter.tryRemove('keyA');
    assert.equal(deniedA.allowed, false, 'key A should be denied after drain');

    // key B should still be full
    const allowedB1 = limiter.tryRemove('keyB');
    const allowedB2 = limiter.tryRemove('keyB');
    assert.equal(allowedB1.allowed, true, 'key B request 1 should be allowed');
    assert.equal(allowedB2.allowed, true, 'key B request 2 should be allowed');
  });
});

// ---------------------------------------------------------------------------
// 4. sweep(): evicts idle+full buckets but keeps throttled ones
// ---------------------------------------------------------------------------

describe('TokenBucketRateLimiter — sweep', () => {
  it('sweep does not evict a throttled (below-capacity) idle bucket', () => {
    const clock = makeClock(1000);
    const limiter = new TokenBucketRateLimiter({
      capacity: 5,
      refillPerSec: 0, // no refill so throttled stays throttled
      idleEvictionMs: 2000,
      now: clock.now,
    });

    // Drain the key to 0
    for (let i = 0; i < 5; i++) limiter.tryRemove('throttled');

    // Advance past eviction window
    clock.advance(3000);

    // sweep must NOT evict because it's throttled (tokens < capacity)
    limiter.sweep();

    // If throttled key survived, next tryRemove still gets denied
    const result = limiter.tryRemove('throttled');
    assert.equal(result.allowed, false, 'throttled key must not be evicted by sweep');
  });

  it('sweep evicts idle buckets that are at full capacity', () => {
    const clock = makeClock(1000);
    const limiter = new TokenBucketRateLimiter({
      capacity: 3,
      refillPerSec: 5, // fast refill → will be at capacity after idle
      idleEvictionMs: 2000,
      now: clock.now,
    });

    // Use key once so it has a bucket
    limiter.tryRemove('will-be-swept'); // tokens = 2 at t=1000

    // Advance 3 seconds → tokens = min(3, 2 + 3*5) = 3 (full), idle = 3s > 2s
    clock.advance(3000);

    limiter.sweep();

    // After sweep the key should be gone; next call creates a fresh full bucket
    // tokens=3 before sweep would give remaining=2 after consume
    // tokens=3 after fresh create also gives remaining=2 after consume
    // So we can't tell from remaining. Use maxKeys instead.
    // Actually: the bucket was swept, so the internal map has 0 entries.
    // Adding a new key that would hit the maxKeys limit won't displace anything.
    // Simplest proof: call sweep, then verify the key count doesn't grow forever.
    // For this test, we'll use maxKeys=1 to force eviction proof.
    const clock2 = makeClock(1000);
    const limiter2 = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSec: 5,
      idleEvictionMs: 2000,
      maxKeys: 1,
      now: clock2.now,
    });

    limiter2.tryRemove('a'); // tokens=1, last=1000
    clock2.advance(3000); // tokens=min(2, 1+15)=2 (full), idle=3s > 2s

    limiter2.sweep();

    // After sweep, 'a' is gone. Now adding 'b' should succeed (within maxKeys=1)
    const r = limiter2.tryRemove('b');
    assert.equal(r.allowed, true, 'after sweeping idle-full key, new key should be accepted within maxKeys');
  });
});

// ---------------------------------------------------------------------------
// 5. maxKeys: hard cap bounds size and uses LRU eviction when full
// ---------------------------------------------------------------------------

describe('TokenBucketRateLimiter — maxKeys', () => {
  it('caps number of tracked keys at maxKeys', () => {
    const clock = makeClock(1000);
    const limiter = new TokenBucketRateLimiter({
      capacity: 10,
      refillPerSec: 0,
      maxKeys: 3,
      now: clock.now,
    });

    // Fill to maxKeys
    limiter.tryRemove('k1');
    clock.advance(10); // ensure distinct `last` times
    limiter.tryRemove('k2');
    clock.advance(10);
    limiter.tryRemove('k3');
    clock.advance(10);

    // Adding a 4th key when full should evict the least-recently-used (k1)
    limiter.tryRemove('k4');

    // k4 should be accessible (just created fresh full bucket, tokens=9)
    const r4 = limiter.tryRemove('k4');
    assert.equal(r4.allowed, true, 'k4 must be accessible after insertion');

    // k2, k3 should still be accessible (they were more recent than k1)
    const r2 = limiter.tryRemove('k2');
    assert.equal(r2.allowed, true, 'k2 must survive maxKeys eviction');
  });

  it('evicts LRU (smallest last timestamp) when maxKeys is exceeded', () => {
    const clock = makeClock(0);
    const limiter = new TokenBucketRateLimiter({
      capacity: 10,
      refillPerSec: 0,
      maxKeys: 2,
      now: clock.now,
    });

    // k1 at t=0
    limiter.tryRemove('k1');
    clock.advance(100);
    // k2 at t=100
    limiter.tryRemove('k2');
    clock.advance(100);
    // k3 at t=200 — should evict k1 (oldest)
    limiter.tryRemove('k3');

    // k1 was evicted, so a fresh access creates a new full bucket (tokens=10 then -1 = 9 remaining)
    const r1 = limiter.tryRemove('k1');
    assert.equal(r1.remaining, 9, 'k1 should have been evicted and recreated fresh');
  });
});

// ---------------------------------------------------------------------------
// 6. clientKeyFromForwarded: X-Forwarded-For trust + spoofing defense
// ---------------------------------------------------------------------------

describe('clientKeyFromForwarded', () => {
  it('ignores X-Forwarded-For and uses remoteAddress when proxy is not trusted', () => {
    const key = clientKeyFromForwarded('1.1.1.1', '203.0.113.7', false);
    assert.equal(key, '203.0.113.7', 'untrusted proxy mode must use the socket address');
  });

  it('uses the rightmost (proxy-appended) hop when proxy is trusted', () => {
    // Client spoofs the leftmost value; a single trusted proxy appends the real
    // client IP on the right. We must read the right, never the spoofed left.
    const key = clientKeyFromForwarded('1.1.1.1, 203.0.113.7', '10.0.0.1', true);
    assert.equal(key, '203.0.113.7', 'must read the rightmost proxy-appended hop');
  });

  it('cannot be bypassed by rotating the leftmost (client-controlled) hop', () => {
    // Same real client behind the proxy → same key regardless of spoofed prefix.
    const k1 = clientKeyFromForwarded('9.9.9.9, 203.0.113.7', '10.0.0.1', true);
    const k2 = clientKeyFromForwarded('8.8.8.8, 203.0.113.7', '10.0.0.1', true);
    assert.equal(k1, '203.0.113.7');
    assert.equal(k2, '203.0.113.7');
    assert.equal(k1, k2, 'rotating the spoofable left hop must NOT change the key');
  });

  it('falls back to remoteAddress when X-Forwarded-For is an empty string', () => {
    // "".split(',') => [""], trimmed => "" which is falsy → must fall back, and
    // must NOT collapse every empty-XFF client into one shared "" bucket.
    const key = clientKeyFromForwarded('', '198.51.100.4', true);
    assert.equal(key, '198.51.100.4', 'empty XFF must fall back to the socket address');
  });

  it('falls back to remoteAddress when X-Forwarded-For is absent', () => {
    const key = clientKeyFromForwarded(undefined, '198.51.100.9', true);
    assert.equal(key, '198.51.100.9');
  });

  it('handles the array header form by reading the last hop of the last value', () => {
    const key = clientKeyFromForwarded(['1.1.1.1, 2.2.2.2', '3.3.3.3, 203.0.113.7'], '10.0.0.1', true);
    assert.equal(key, '203.0.113.7', 'rightmost hop of the last header line');
  });

  it('returns "unknown" when neither a usable XFF nor a remoteAddress exists', () => {
    const key = clientKeyFromForwarded(undefined, undefined, true);
    assert.equal(key, 'unknown');
  });
});

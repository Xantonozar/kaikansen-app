import { ChatRateLimiter, PartnerIdsCache } from './chat-rate-limit';

/**
 * The socket rate limiter + presence partner cache: pure logic,
 * driven with explicit timestamps.
 */

describe('ChatRateLimiter', () => {
  it('allows up to the limit inside the window, then drops', () => {
    const limiter = new ChatRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.allow('u1', t0)).toBe(true);
    expect(limiter.allow('u1', t0 + 1)).toBe(true);
    expect(limiter.allow('u1', t0 + 2)).toBe(true);
    expect(limiter.allow('u1', t0 + 3)).toBe(false);
    // A different key has its own budget.
    expect(limiter.allow('u2', t0 + 3)).toBe(true);
  });

  it('the window slides: old hits expire', () => {
    const limiter = new ChatRateLimiter(2, 60_000);
    const t0 = 1_000_000;
    expect(limiter.allow('u1', t0)).toBe(true);
    expect(limiter.allow('u1', t0 + 30_000)).toBe(true);
    expect(limiter.allow('u1', t0 + 30_001)).toBe(false);
    // First hit is 61s old now → room again.
    expect(limiter.allow('u1', t0 + 61_000)).toBe(true);
  });
});

describe('PartnerIdsCache', () => {
  it('serves within the TTL and misses after it', () => {
    const cache = new PartnerIdsCache(30_000);
    cache.set('u1', ['a', 'b'], 1_000);
    expect(cache.get('u1', 1_000 + 29_999)).toEqual(['a', 'b']);
    expect(cache.get('u1', 1_000 + 30_001)).toBeNull();
    expect(cache.get('nobody', 1_000)).toBeNull();
  });

  it('invalidate + clear drop entries', () => {
    const cache = new PartnerIdsCache(30_000);
    cache.set('u1', ['a'], 0);
    cache.invalidate('u1');
    expect(cache.get('u1', 0)).toBeNull();
    cache.set('u2', ['b'], 0);
    cache.clear();
    expect(cache.get('u2', 0)).toBeNull();
  });
});

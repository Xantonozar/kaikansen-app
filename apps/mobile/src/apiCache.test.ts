import { describe, expect, it, jest } from '@jest/globals';
import {
  CACHE_TTL_MS,
  ResponseCache,
  cacheKey,
  wasCacheServed,
} from './apiCache';
import { setSessionUserId } from './session';

/**
 * Response cache (src/apiCache.ts) — perf problem 5's core
 * contract: per-class freshness windows, stale-while-revalidate,
 * in-flight dedupe, per-scope keying, and the mutation-time
 * invalidation primitives (the api.ts table's success/failure
 * behaviour is covered in api.test.ts).
 */

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('CACHE_TTL_MS windows', () => {
  it('matches the spec: FEED 2m, USER 5m, CATALOGUE 15m', () => {
    expect(CACHE_TTL_MS.FEED).toBe(2 * 60_000);
    expect(CACHE_TTL_MS.USER).toBe(5 * 60_000);
    expect(CACHE_TTL_MS.CATALOGUE).toBe(15 * 60_000);
  });
});

describe('cacheKey', () => {
  it('is method + path + scope; a blank scope is the anon scope', () => {
    expect(cacheKey('GET', '/home', 'user-1')).toBe('GET /home @user-1');
    expect(cacheKey('GET', '/home', '')).toBe('GET /home @anon');
    expect(cacheKey('GET', '/home', 'user-1')).not.toBe(
      cacheKey('GET', '/home', 'user-2'),
    );
  });
});

describe('freshness windows per class', () => {
  it('fresh → no fetch at all; stale → background fetch + swap', async () => {
    const clock = fakeClock();
    const cache = new ResponseCache(clock.now);
    const key = cacheKey('GET', '/home', 'u1');
    let calls = 0;
    const load = async () => ({ n: ++calls });

    // Miss → one network load.
    await expect(cache.read(key, 'FEED', load)).resolves.toEqual({ n: 1 });
    expect(calls).toBe(1);

    // Inside the 2-minute FEED window: served, marked, NO fetch.
    clock.advance(CACHE_TTL_MS.FEED - 1);
    const fresh = await cache.read(key, 'FEED', load);
    expect(fresh).toEqual({ n: 1 });
    expect(wasCacheServed(fresh)).toBe(true);
    expect(calls).toBe(1);

    // Past the window: the stale value is served immediately AND
    // one background revalidation runs; its landing notifies
    // subscribers (the screen's silent swap).
    const swapped: unknown[] = [];
    cache.subscribe(key, (v) => swapped.push(v));
    clock.advance(2);
    const stale = await cache.read(key, 'FEED', load);
    expect(stale).toEqual({ n: 1 });
    expect(wasCacheServed(stale)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(swapped).toEqual([{ n: 2 }]);
    expect(cache.peek(key)).toEqual({ n: 2 });
  });

  it('the USER window (5m) outlives the FEED window (2m)', async () => {
    const clock = fakeClock();
    const cache = new ResponseCache(clock.now);
    const key = cacheKey('GET', '/library/history', 'u1');
    let calls = 0;
    const load = async () => ({ n: ++calls });
    await cache.read(key, 'USER', load);
    clock.advance(3 * 60_000); // past FEED, inside USER
    const served = await cache.read(key, 'USER', load);
    expect(served).toEqual({ n: 1 });
    expect(calls).toBe(1);
    clock.advance(CACHE_TTL_MS.USER); // past USER too
    await cache.read(key, 'USER', load);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  it('the CATALOGUE window (15m) outlives the USER window (5m)', async () => {
    const clock = fakeClock();
    const cache = new ResponseCache(clock.now);
    const key = cacheKey('GET', '/season?season=FALL&year=2026&page=1', 'u1');
    let calls = 0;
    const load = async () => ({ n: ++calls });
    await cache.read(key, 'CATALOGUE', load);
    clock.advance(10 * 60_000); // past USER, inside CATALOGUE
    await cache.read(key, 'CATALOGUE', load);
    expect(calls).toBe(1);
    clock.advance(CACHE_TTL_MS.CATALOGUE); // past CATALOGUE too
    await cache.read(key, 'CATALOGUE', load);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });

  it('a failed background revalidation keeps the stale entry', async () => {
    const clock = fakeClock();
    const cache = new ResponseCache(clock.now);
    const key = cacheKey('GET', '/home', 'u1');
    await cache.read(key, 'FEED', async () => ({ n: 1 }));
    clock.advance(CACHE_TTL_MS.FEED + 1);
    const served = await cache.read(key, 'FEED', async () => {
      throw new Error('offline');
    });
    expect(served).toEqual({ n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.peek(key)).toEqual({ n: 1 });
  });

  it('a failed miss load rejects and stores nothing', async () => {
    const cache = new ResponseCache(fakeClock().now);
    const key = cacheKey('GET', '/home', 'u1');
    await expect(
      cache.read(key, 'FEED', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(cache.peek(key)).toBeUndefined();
  });
});

describe('force (pull-to-refresh)', () => {
  it('always refetches, even inside the window', async () => {
    const cache = new ResponseCache(fakeClock().now);
    const key = cacheKey('GET', '/home', 'u1');
    let calls = 0;
    const load = async () => ({ n: ++calls });
    await cache.read(key, 'FEED', load);
    const forced = await cache.read(key, 'FEED', load, { force: true });
    expect(forced).toEqual({ n: 2 });
    expect(wasCacheServed(forced)).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('in-flight dedupe', () => {
  it('two simultaneous gets share one network call', async () => {
    const cache = new ResponseCache(fakeClock().now);
    const key = cacheKey('GET', '/home', 'u1');
    let calls = 0;
    let release!: (v: { n: number }) => void;
    const load = () => {
      calls += 1;
      return new Promise<{ n: number }>((resolve) => {
        release = resolve;
      });
    };
    const a = cache.read(key, 'FEED', load);
    const b = cache.read(key, 'FEED', load);
    expect(calls).toBe(1);
    release({ n: 7 });
    await expect(a).resolves.toEqual({ n: 7 });
    await expect(b).resolves.toEqual({ n: 7 });
    expect(calls).toBe(1);
  });

  it('dedupe() shares a promise and frees the slot on settle', async () => {
    const cache = new ResponseCache(fakeClock().now);
    let calls = 0;
    const run = async () => ++calls;
    const [a, b] = await Promise.all([
      cache.dedupe('k', run),
      cache.dedupe('k', run),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    // After settle the slot is free: the next call runs again.
    await expect(cache.dedupe('k', run)).resolves.toBe(2);
  });
});

describe('per-user isolation + clear', () => {
  it('the same path under two scopes never collides', async () => {
    const cache = new ResponseCache(fakeClock().now);
    const loadFor = (who: string) => async () => ({ who });
    const a = await cache.read(
      cacheKey('GET', '/library/history', 'user-a'),
      'USER',
      loadFor('a'),
    );
    const b = await cache.read(
      cacheKey('GET', '/library/history', 'user-b'),
      'USER',
      loadFor('b'),
    );
    expect(a).toEqual({ who: 'a' });
    expect(b).toEqual({ who: 'b' });
  });

  it('clear() empties everything (the logout path)', async () => {
    const cache = new ResponseCache(fakeClock().now);
    const key = cacheKey('GET', '/home', 'u1');
    let calls = 0;
    const load = async () => ({ n: ++calls });
    await cache.read(key, 'FEED', load);
    cache.clear();
    await cache.read(key, 'FEED', load);
    expect(calls).toBe(2);
  });

  it('invalidateMatching drops a fragment across scopes only', async () => {
    const cache = new ResponseCache(fakeClock().now);
    cache.set(cacheKey('GET', '/library/history', 'u1'), { n: 1 });
    cache.set(cacheKey('GET', '/library/history', 'u2'), { n: 2 });
    cache.set(cacheKey('GET', '/home', 'u1'), { n: 3 });
    cache.invalidateMatching('/library/history');
    expect(cache.peek(cacheKey('GET', '/library/history', 'u1'))).toBeUndefined();
    expect(cache.peek(cacheKey('GET', '/library/history', 'u2'))).toBeUndefined();
    expect(cache.peek(cacheKey('GET', '/home', 'u1'))).toEqual({ n: 3 });
  });
});

describe('session scope registration', () => {
  it('setSessionUserId is idempotent for the same id', async () => {
    const { getSessionScope, registerUserScopeListener } = await import(
      './session'
    );
    const seen: (string | null)[] = [];
    registerUserScopeListener((id) => seen.push(id));
    setSessionUserId('scope-test-user');
    setSessionUserId('scope-test-user');
    expect(seen).toEqual(['scope-test-user']);
    expect(getSessionScope()).toBe('scope-test-user');
    setSessionUserId(null);
    expect(seen).toEqual(['scope-test-user', null]);
    expect(getSessionScope()).toBe('anon');
    registerUserScopeListener(null);
  });
});

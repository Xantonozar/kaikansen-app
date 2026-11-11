import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * apiJson's cache wiring (perf problem 5) against a scripted
 * global fetch: cached reads route through src/apiCache.ts by
 * path class (fresh → no fetch; stale → background refetch),
 * concurrent identical reads dedupe to one call, uncached reads
 * (the friends-activity SOCIAL EXEMPTION, search) stay uncached
 * but dedupe, and apiJson mutations invalidate centrally — on
 * SUCCESS only; a failed mutation invalidates nothing.
 *
 * EXPO_PUBLIC_API_URL is unset under Jest, so api.ts computes
 * fixtureMode=true — but apiJson itself never branches on it (its
 * callers do), which is exactly what lets this suite exercise the
 * live wiring against the fetch stub.
 */

// api.ts imports the fixture bundle; stub it so the suite stays
// hermetic (no 20-theme payload in the module graph).
jest.mock('./fixtures/popularThemes', () => ({ popularThemesFixture: [] }));

// api.ts also pulls the first-paint snapshot store (speed batch),
// whose IO layer is storage.ts: its secure grade imports the real
// expo-secure-store (an ESM native module this Jest setup cannot
// parse) and its Platform comes from react-native. Stub both the
// way the other storage suites do — the snapshot only ever uses
// the plain grade, which rides the config's AsyncStorage stub.
jest.mock('expo-secure-store', () => ({
  setItemAsync: async () => undefined,
  getItemAsync: async () => null,
  deleteItemAsync: async () => undefined,
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { apiJson, invalidateAfterMutation } from './api';
import { appCache } from './apiCache';
import { setAccessToken, setSessionUserId } from './session';

type FetchFn = (url: string, init?: unknown) => Promise<unknown>;

const fetchMock = jest.fn<FetchFn>();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A fetch that answers per-path payloads and counts calls. */
function scriptFetch(payloads: Record<string, unknown>, status = 200) {
  const counts = new Map<string, number>();
  fetchMock.mockImplementation(async (url: string) => {
    // apiUrl is undefined under Jest (no EXPO_PUBLIC_API_URL), so
    // apiFetch builds `undefined<path>` URLs — strip up to the
    // first '/' to recover the request path.
    const path = url.slice(url.indexOf('/'));
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const body = payloads[path];
    if (body === undefined) return jsonResponse({ message: 'nope' }, 404);
    return jsonResponse(
      typeof body === 'function'
        ? (body as (n: number) => unknown)(counts.get(path)!)
        : body,
      status,
    );
  });
  return counts;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  fetchMock.mockReset();
  appCache.clear();
  setAccessToken('test-token');
  setSessionUserId('cache-test-user');
});

describe('cached reads through apiJson', () => {
  it('a fresh cached read makes no second fetch', async () => {
    const counts = scriptFetch({
      '/home': (n: number) => ({ n }),
    });
    await expect(apiJson('/home')).resolves.toEqual({ n: 1 });
    // Fresh (FEED window 2m): served from the cache, no network.
    // (Stale ageing + the background swap are covered against the
    // injectable clock in apiCache.test.ts.)
    await expect(apiJson('/home')).resolves.toEqual({ n: 1 });
    expect(counts.get('/home')).toBe(1);
  });

  it('two simultaneous identical reads share one network call', async () => {
    const counts = scriptFetch({ '/library/history': { entries: [] } });
    const [a, b] = await Promise.all([
      apiJson('/library/history'),
      apiJson('/library/history'),
    ]);
    expect(a).toEqual({ entries: [] });
    expect(b).toEqual({ entries: [] });
    expect(counts.get('/library/history')).toBe(1);
  });

  it('per-user isolation: another scope refetches', async () => {
    const counts = scriptFetch({
      '/library/history': (n: number) => ({ n }),
    });
    await expect(apiJson('/library/history')).resolves.toEqual({ n: 1 });
    setSessionUserId('someone-else');
    await expect(apiJson('/library/history')).resolves.toEqual({ n: 2 });
    expect(counts.get('/library/history')).toBe(2);
    setSessionUserId('cache-test-user');
  });
});

describe('the friends-activity SOCIAL EXEMPTION', () => {
  it('never serves from cache (refetch on focus) but dedupes', async () => {
    const counts = scriptFetch({
      '/social/friends-activity?limit=30': (n: number) => ({ n }),
    });
    await expect(
      apiJson('/social/friends-activity?limit=30'),
    ).resolves.toEqual({ n: 1 });
    // A focus refetch hits the network again — no freshness window.
    await expect(
      apiJson('/social/friends-activity?limit=30'),
    ).resolves.toEqual({ n: 2 });
    expect(counts.get('/social/friends-activity?limit=30')).toBe(2);
    // …but two SIMULTANEOUS focus reads (Home + Social mounting)
    // still collapse into one call.
    const [a, b] = await Promise.all([
      apiJson('/social/friends-activity?limit=30'),
      apiJson('/social/friends-activity?limit=30'),
    ]);
    expect(a).toEqual({ n: 3 });
    expect(b).toEqual({ n: 3 });
    expect(counts.get('/social/friends-activity?limit=30')).toBe(3);
  });
});

describe('mutation invalidation (central, success-only)', () => {
  it('a successful follow drops the feed + user reads', async () => {
    const counts = scriptFetch({
      '/social/friends-activity?limit=30': (n: number) => ({ n }),
      '/users/bob/network': { following: [], followers: [] },
      '/users/bob/follow': { username: 'bob', isFollowing: true },
    });
    await apiJson('/social/friends-activity?limit=30'); // exempt: uncached
    await apiJson('/users/bob/network'); // USER-cached
    await apiJson('/users/bob/network');
    expect(counts.get('/users/bob/network')).toBe(1);
    await apiJson('/users/bob/follow', { method: 'POST' });
    // The network read was invalidated by the successful follow.
    await apiJson('/users/bob/network');
    expect(counts.get('/users/bob/network')).toBe(2);
  });

  it('a FAILED mutation invalidates nothing', async () => {
    const counts = scriptFetch({
      '/users/bob/network': { following: [], followers: [] },
    });
    fetchMock.mockImplementation(async (url: string) => {
      const path = url.slice(url.indexOf('/'));
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === '/users/bob/follow') {
        return jsonResponse({ message: 'nope' }, 500);
      }
      return jsonResponse({ following: [], followers: [] });
    });
    await apiJson('/users/bob/network');
    await expect(
      apiJson('/users/bob/follow', { method: 'POST' }),
    ).rejects.toThrow();
    await apiJson('/users/bob/network');
    expect(counts.get('/users/bob/network')).toBe(1); // still cached
  });

  it('a successful playlist create drops playlist + user reads only', async () => {
    const counts = scriptFetch({
      // NOTE: '/playlists' is counted for BOTH the GET reads and
      // the POST create (the mock keys on path alone) — so the
      // expected total is 3: two GETs + the mutation itself.
      '/playlists': (n: number) => ({ playlists: [], n }),
      '/users/bob/playlists': (n: number) => ({ playlists: [], n }),
      '/home': (n: number) => ({ n }),
    });
    await apiJson('/playlists');
    await apiJson('/users/bob/playlists');
    await apiJson('/home');
    await apiJson('/playlists', { method: 'POST', body: { name: 'x' } });
    await apiJson('/playlists');
    await apiJson('/users/bob/playlists');
    await apiJson('/home'); // FEED untouched by a playlist mutation
    expect(counts.get('/playlists')).toBe(3); // 2 GETs + the POST
    expect(counts.get('/users/bob/playlists')).toBe(2);
    expect(counts.get('/home')).toBe(1);
  });

  it('invalidateAfterMutation ignores reads and unknown mutations', async () => {
    const counts = scriptFetch({ '/home': (n: number) => ({ n }) });
    await apiJson('/home');
    invalidateAfterMutation('GET', '/home');
    invalidateAfterMutation('POST', '/quiz/solo/games');
    await apiJson('/home');
    expect(counts.get('/home')).toBe(1);
  });
});

describe('pull-to-refresh force through apiJson', () => {
  it('cache.force refetches inside the window', async () => {
    const counts = scriptFetch({ '/home': (n: number) => ({ n }) });
    await expect(apiJson('/home')).resolves.toEqual({ n: 1 });
    await expect(
      apiJson('/home', { cache: { force: true } }),
    ).resolves.toEqual({ n: 2 });
    expect(counts.get('/home')).toBe(2);
  });
});

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { HomeResponse, UserProfile } from '@kaikansen/contracts';

/**
 * First-paint snapshot (speed batch): Home + own-profile payloads
 * persisted on disk so a cold start hydrates them into the
 * response cache as STALE entries. The record contract under
 * test: serialize/parse round-trip, corrupt payloads rejected,
 * scope mismatch never served, a scope switch replaces (never
 * merges), logout clear, and — with the apiCache wiring — a
 * hydrated entry reads stale so the background revalidate runs.
 * AsyncStorage is the package's official in-memory Jest mock
 * (the profileStatsCache.test.ts pattern).
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// storage.ts (the snapshot's IO layer) also imports
// expo-secure-store and react-native (Platform) — native modules
// this Jest setup cannot load. The snapshot only uses the plain
// grade, so both are stubbed.
jest.mock('expo-secure-store', () => ({
  setItemAsync: async () => undefined,
  getItemAsync: async () => null,
  deleteItemAsync: async () => undefined,
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearFirstPaintSnapshot,
  parseFirstPaintSnapshot,
  readFirstPaintSnapshot,
  serializeFirstPaintSnapshot,
  snapshotForScope,
  withServedPayload,
  writeFirstPaintSnapshot,
  type FirstPaintSnapshot,
} from './firstPaintCache';
import { ResponseCache, cacheKey } from './apiCache';

const HOME: HomeResponse = {
  season: { season: 'FALL', year: 2026 },
  seasonRail: [],
  popular: [],
};

const PROFILE = {
  id: 'user-1',
  username: 'zadid',
  displayName: 'Zadid',
  email: 'zadid@example.com',
  avatarUrl: null,
  bio: '',
  totalRatings: 0,
  totalFollowers: 0,
  totalFollowing: 0,
  isPublic: true,
  anilist: null,
} as UserProfile;

function snapshot(overrides?: Partial<FirstPaintSnapshot>): FirstPaintSnapshot {
  return {
    scope: 'user-1',
    home: { value: HOME, fetchedAt: 1_700_000_000_000 },
    profile: { value: PROFILE, fetchedAt: 1_700_000_000_000 },
    ...overrides,
  };
}

describe('serialize / parse round-trip', () => {
  it('a serialized snapshot parses back to the same record', () => {
    const original = snapshot();
    expect(parseFirstPaintSnapshot(serializeFirstPaintSnapshot(original)))
      .toEqual(original);
  });

  it('a home-only and a profile-only record both round-trip', () => {
    const homeOnly = snapshot({ profile: undefined });
    expect(parseFirstPaintSnapshot(serializeFirstPaintSnapshot(homeOnly)))
      .toEqual(homeOnly);
    const profileOnly = snapshot({ home: undefined });
    expect(parseFirstPaintSnapshot(serializeFirstPaintSnapshot(profileOnly)))
      .toEqual(profileOnly);
  });
});

describe('corrupt payloads are rejected, never thrown', () => {
  it('non-JSON, non-records and scopeless records resolve to null', () => {
    expect(parseFirstPaintSnapshot(null)).toBeNull();
    expect(parseFirstPaintSnapshot('')).toBeNull();
    expect(parseFirstPaintSnapshot('not json {')).toBeNull();
    expect(parseFirstPaintSnapshot('[1,2]')).toBeNull();
    expect(parseFirstPaintSnapshot('{"home":{}}')).toBeNull();
    expect(parseFirstPaintSnapshot('{"scope":""}')).toBeNull();
    expect(parseFirstPaintSnapshot('{"scope":42}')).toBeNull();
  });

  it('wrong-shaped slots are dropped; an all-bad record is null', () => {
    const raw = JSON.stringify({
      scope: 'user-1',
      home: { value: { seasonRail: 'nope' }, fetchedAt: 5 },
      profile: { value: { id: 7 }, fetchedAt: 5 },
    });
    expect(parseFirstPaintSnapshot(raw)).toBeNull();
  });

  it('one bad slot does not poison the good one', () => {
    const raw = JSON.stringify({
      scope: 'user-1',
      home: { value: HOME, fetchedAt: 5 },
      profile: { value: { nope: true }, fetchedAt: 5 },
    });
    const parsed = parseFirstPaintSnapshot(raw);
    expect(parsed?.home?.value).toEqual(HOME);
    expect(parsed?.profile).toBeUndefined();
  });
});

describe('scope decision', () => {
  it('the capturing scope is served both payloads', () => {
    const out = snapshotForScope(snapshot(), 'user-1');
    expect(out?.home?.value).toEqual(HOME);
    expect(out?.profile?.value).toEqual(PROFILE);
  });

  it('a different scope is served NOTHING (never another account)', () => {
    expect(snapshotForScope(snapshot(), 'user-2')).toBeNull();
    expect(snapshotForScope(snapshot(), 'anon')).toBeNull();
    expect(snapshotForScope(snapshot({ scope: 'anon' }), 'user-1')).toBeNull();
  });

  it('the anon snapshot serves the anon scope; blank scope is anon', () => {
    const anon = snapshot({ scope: 'anon', profile: undefined });
    expect(snapshotForScope(anon, 'anon')?.home?.value).toEqual(HOME);
    expect(snapshotForScope(anon, '')?.home?.value).toEqual(HOME);
  });

  it('no snapshot hydrates nothing', () => {
    expect(snapshotForScope(null, 'user-1')).toBeNull();
  });
});

describe('withServedPayload (the persist merge)', () => {
  it('merges a fresh payload into the same scope, keeping the other', () => {
    const next = withServedPayload(snapshot(), 'user-1', {
      home: { value: { ...HOME, popular: [] }, fetchedAt: 9 },
    });
    expect(next.scope).toBe('user-1');
    expect(next.home?.fetchedAt).toBe(9);
    expect(next.profile?.value).toEqual(PROFILE);
  });

  it('a scope switch REPLACES the record — old payloads never merge', () => {
    const next = withServedPayload(snapshot(), 'user-2', {
      home: { value: HOME, fetchedAt: 9 },
    });
    expect(next.scope).toBe('user-2');
    expect(next.home?.fetchedAt).toBe(9);
    expect(next.profile).toBeUndefined();
  });

  it('starts a record from nothing under the serving scope', () => {
    const next = withServedPayload(null, 'anon', {
      home: { value: HOME, fetchedAt: 3 },
    });
    expect(next).toEqual({
      scope: 'anon',
      home: { value: HOME, fetchedAt: 3 },
    });
  });
});

describe('storage IO + logout clear', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('write → read round-trips through storage', async () => {
    await writeFirstPaintSnapshot(snapshot());
    await expect(readFirstPaintSnapshot()).resolves.toEqual(snapshot());
  });

  it('a corrupt stored value reads as no snapshot', async () => {
    await AsyncStorage.setItem('kaikansen.firstPaint.v1', 'garbage{');
    await expect(readFirstPaintSnapshot()).resolves.toBeNull();
  });

  it('clear (the logout path) removes the record', async () => {
    await writeFirstPaintSnapshot(snapshot());
    await clearFirstPaintSnapshot();
    await expect(readFirstPaintSnapshot()).resolves.toBeNull();
    expect(await AsyncStorage.getItem('kaikansen.firstPaint.v1')).toBeNull();
  });
});

describe('hydration lands STALE in the response cache', () => {
  it('a seeded entry serves instantly AND triggers the revalidation swap', async () => {
    // The api.ts hydration arithmetic: backdate past the widest
    // TTL so the entry is stale under every class window.
    const cache = new ResponseCache();
    const key = cacheKey('GET', '/home', 'user-1');
    const fetchedAt = Date.now() - 16 * 60_000;
    cache.seedStale(key, HOME, fetchedAt);
    expect(cache.snapshot(key, 2 * 60_000)?.state).toBe('stale');

    let calls = 0;
    const swapped: unknown[] = [];
    cache.subscribe(key, (v) => swapped.push(v));
    const served = await cache.read(key, 'FEED', async () => {
      calls += 1;
      return { ...HOME, popular: [] };
    });
    // The hydrated value is what paints…
    expect(served).toEqual(HOME);
    // …and the background refresh still runs and swaps silently.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(swapped).toEqual([{ ...HOME, popular: [] }]);
  });

  it('seedStale never overwrites an entry memory already holds', () => {
    const cache = new ResponseCache();
    const key = cacheKey('GET', '/home', 'user-1');
    const fresher = { ...HOME, season: { season: 'WINTER', year: 2027 } as const };
    cache.set(key, fresher);
    cache.seedStale(key, HOME, 1);
    expect(cache.peek(key)).toEqual(fresher);
  });
});

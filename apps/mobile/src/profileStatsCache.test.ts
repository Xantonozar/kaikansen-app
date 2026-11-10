import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ProfileStats } from '@kaikansen/contracts';

/**
 * The profile-stats instant-display cache (perf problem 4):
 * per-username records in plain storage — paint from cache, swap
 * on refresh (a fresh write replaces the record), dirty marking
 * after the app's own listen/rate actions, and strict isolation
 * between usernames. AsyncStorage is the package's official
 * in-memory Jest mock; the pure record logic is asserted
 * directly too.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// storage.ts (the cache's IO layer) also imports expo-secure-store
// and react-native (Platform) — native modules this Jest setup
// cannot load. The cache only ever uses the plain grade, so both
// are stubbed: the secure grade inert, Platform pinned to a
// non-web OS.
jest.mock('expo-secure-store', () => ({
  setItemAsync: async () => undefined,
  getItemAsync: async () => null,
  deleteItemAsync: async () => undefined,
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  dirtyProfileStatsEntry,
  getSessionUsername,
  hasPaintableStats,
  isDirtyEntry,
  markOwnProfileStatsDirty,
  markProfileStatsDirty,
  paintableNumbers,
  parseProfileStatsEntry,
  profileStatsCacheKey,
  readProfileStatsCache,
  serializeProfileStatsEntry,
  setSessionUsername,
  writeProfileStatsCache,
  type ProfileStatsCacheEntry,
} from './profileStatsCache';

function stats(overrides: Partial<ProfileStats> = {}): ProfileStats {
  return {
    meanRating: 8.5,
    themesListened: 12,
    totalListenedSeconds: 5400,
    followersCount: 3,
    followingCount: 5,
    ...overrides,
  };
}

const CLEAN_ENTRY: ProfileStatsCacheEntry = {
  meanRating: 8.5,
  themesListened: 12,
  totalListenedSeconds: 5400,
  followersCount: 3,
  followingCount: 5,
  savedAt: 1000,
};

describe('profileStatsCache — record logic', () => {
  it('keys records per username, case-insensitively', () => {
    expect(profileStatsCacheKey('Zadid')).toBe(profileStatsCacheKey('zadid'));
    expect(profileStatsCacheKey('zadid')).not.toBe(
      profileStatsCacheKey('other'),
    );
  });

  it('round-trips a served payload through serialize + parse', () => {
    const raw = serializeProfileStatsEntry(stats(), 1234);
    expect(parseProfileStatsEntry(raw)).toEqual({
      meanRating: 8.5,
      themesListened: 12,
      totalListenedSeconds: 5400,
      followersCount: 3,
      followingCount: 5,
      savedAt: 1234,
    });
    // The null mean (no ratings yet) round-trips too.
    const rawNull = serializeProfileStatsEntry(
      stats({ meanRating: null }),
      99,
    );
    const nullParsed = parseProfileStatsEntry(rawNull);
    expect(
      nullParsed && !isDirtyEntry(nullParsed) && nullParsed.meanRating,
    ).toBeNull();
  });

  it('treats corrupt or shapeless records as a miss, never a throw', () => {
    expect(parseProfileStatsEntry(null)).toBeNull();
    expect(parseProfileStatsEntry('')).toBeNull();
    expect(parseProfileStatsEntry('{not json')).toBeNull();
    expect(parseProfileStatsEntry('"a string"')).toBeNull();
    expect(parseProfileStatsEntry('{"savedAt":1}')).toBeNull();
    expect(
      parseProfileStatsEntry(
        JSON.stringify({ ...CLEAN_ENTRY, meanRating: 'high' }),
      ),
    ).toBeNull();
  });

  it('dirty marking drops the stats but keeps the follow counts', () => {
    const dirty = dirtyProfileStatsEntry(CLEAN_ENTRY, 2000);
    expect(dirty).toEqual({
      dirty: true,
      followersCount: 3,
      followingCount: 5,
      savedAt: 2000,
    });
    expect(isDirtyEntry(dirty)).toBe(true);
    expect(isDirtyEntry(CLEAN_ENTRY)).toBe(false);
    // A dirty entry paints ONLY the counts — the stats are
    // known-stale and must not paint.
    expect(paintableNumbers(dirty)).toEqual({
      meanRating: null,
      themesListened: 0,
      totalListenedSeconds: 0,
      followersCount: 3,
      followingCount: 5,
    });
    expect(hasPaintableStats(dirty)).toBe(false);
    // The dirty record itself round-trips through storage JSON.
    expect(parseProfileStatsEntry(JSON.stringify(dirty))).toEqual(dirty);
  });

  it('a clean entry paints its full stats; a miss paints nothing', () => {
    expect(paintableNumbers(CLEAN_ENTRY)).toEqual({
      meanRating: 8.5,
      themesListened: 12,
      totalListenedSeconds: 5400,
      followersCount: 3,
      followingCount: 5,
    });
    expect(hasPaintableStats(CLEAN_ENTRY)).toBe(true);
    expect(paintableNumbers(null)).toBeNull();
    expect(hasPaintableStats(null)).toBe(false);
  });
});

describe('profileStatsCache — storage behaviour', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('paints from cache: a written record reads back per username', async () => {
    await writeProfileStatsCache('zadid', stats());
    const entry = await readProfileStatsCache('zadid');
    expect(entry).not.toBeNull();
    expect(hasPaintableStats(entry)).toBe(true);
    expect(paintableNumbers(entry)).toMatchObject({
      meanRating: 8.5,
      themesListened: 12,
      totalListenedSeconds: 5400,
    });
    // Case-insensitive: the same record under any casing.
    expect(await readProfileStatsCache('ZADID')).toEqual(entry);
  });

  it('swaps on refresh: a fresh write replaces the saved numbers', async () => {
    await writeProfileStatsCache('zadid', stats());
    await writeProfileStatsCache(
      'zadid',
      stats({ meanRating: 9.1, themesListened: 13, totalListenedSeconds: 5490 }),
    );
    const entry = await readProfileStatsCache('zadid');
    expect(paintableNumbers(entry)).toMatchObject({
      meanRating: 9.1,
      themesListened: 13,
      totalListenedSeconds: 5490,
    });
  });

  it('marks dirty after own actions; the next fresh write cleans it', async () => {
    await writeProfileStatsCache('zadid', stats());
    await markProfileStatsDirty('zadid');
    const dirty = await readProfileStatsCache('zadid');
    expect(dirty && isDirtyEntry(dirty)).toBe(true);
    expect(paintableNumbers(dirty)).toMatchObject({
      followersCount: 3,
      followingCount: 5,
    });
    expect(hasPaintableStats(dirty)).toBe(false);

    await writeProfileStatsCache('zadid', stats({ themesListened: 13 }));
    const clean = await readProfileStatsCache('zadid');
    expect(clean && isDirtyEntry(clean)).toBe(false);
    expect(hasPaintableStats(clean)).toBe(true);
  });

  it('dirty marking a user with no record is a no-op (still a miss)', async () => {
    await markProfileStatsDirty('ghost');
    expect(await readProfileStatsCache('ghost')).toBeNull();
  });

  it('isolates records per username', async () => {
    await writeProfileStatsCache('alice', stats({ themesListened: 1 }));
    await writeProfileStatsCache('bob', stats({ themesListened: 2 }));
    await markProfileStatsDirty('alice');
    const alice = await readProfileStatsCache('alice');
    const bob = await readProfileStatsCache('bob');
    expect(alice && isDirtyEntry(alice)).toBe(true);
    expect(bob && isDirtyEntry(bob)).toBe(false);
    expect(paintableNumbers(bob)?.themesListened).toBe(2);
  });

  it('own-action dirty marking resolves the account from the session hint', async () => {
    // Signed out: no hint, nothing is marked.
    await writeProfileStatsCache('zadid', stats());
    await markOwnProfileStatsDirty();
    expect(
      hasPaintableStats(await readProfileStatsCache('zadid')),
    ).toBe(true);

    // Signed in as zadid: the own-action entry point dirties
    // zadid's record — and only zadid's.
    await setSessionUsername('zadid');
    expect(await getSessionUsername()).toBe('zadid');
    await writeProfileStatsCache('other', stats());
    await markOwnProfileStatsDirty();
    const zadid = await readProfileStatsCache('zadid');
    expect(zadid && isDirtyEntry(zadid)).toBe(true);
    expect(hasPaintableStats(await readProfileStatsCache('other'))).toBe(
      true,
    );

    // Sign-out clears the hint again.
    await setSessionUsername(null);
    expect(await getSessionUsername()).toBeNull();
  });
});

import {
  computeProfileStats,
  readStoredProfileStats,
  resolvePlaySeconds,
} from './profile-stats';

/**
 * computeProfileStats unit tests — in-memory fakes implementing
 * the small filter surface the routine uses (equality + $in),
 * so the aggregate definitions are asserted for real: the mean
 * over the ratings the user GAVE, distinct-theme counting, and
 * the played-entry duration resolution the history write path
 * uses (atEntryId match → first entry → 90; a gone theme adds
 * no seconds but still counts as a listened theme).
 */

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return String(a) === String(b);
  }
  return false;
}

function matches(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (
      condition !== null &&
      typeof condition === 'object' &&
      '$in' in (condition as Record<string, unknown>)
    ) {
      return ((condition as { $in: unknown[] }).$in ?? []).some((v) =>
        valueEquals(doc[key], v),
      );
    }
    return valueEquals(doc[key], condition);
  });
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

const USER = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390b2';
const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';
const THEME_C = '507f1f77bcf86cd799439013';
const THEME_GONE = '507f1f77bcf86cd799439099';

function makeModels() {
  const ratings: Record<string, unknown>[] = [
    { userId: USER, themeId: THEME_A, score: 8 },
    { userId: USER, themeId: THEME_B, score: 9 },
    { userId: USER, themeId: THEME_C, score: 10 },
    // Another user's rating — never counted.
    { userId: OTHER, themeId: THEME_A, score: 1 },
  ];
  const themes: Record<string, unknown>[] = [
    {
      _id: THEME_A,
      entries: [
        { atEntryId: 11, duration: 100 },
        { atEntryId: 12, duration: 200 },
      ],
    },
    {
      // Entry without a stored duration → the 90s default.
      _id: THEME_B,
      entries: [{ atEntryId: 21, duration: null }],
    },
    {
      // No entries at all → the 90s default.
      _id: THEME_C,
      entries: [],
    },
    // THEME_GONE is deliberately absent from the catalogue.
  ];
  const history: Record<string, unknown>[] = [
    { userId: USER, themeId: THEME_A, atEntryId: 11 }, // 100 (entry match)
    { userId: USER, themeId: THEME_A, atEntryId: 12 }, // 200 (entry match)
    { userId: USER, themeId: THEME_A, atEntryId: 99 }, // 100 (no match → first entry)
    { userId: USER, themeId: THEME_B, atEntryId: 21 }, // 90 (null duration)
    { userId: USER, themeId: THEME_C, atEntryId: null }, // 90 (no entries)
    { userId: USER, themeId: THEME_GONE, atEntryId: 1 }, // 0 (theme gone)
    // Another user's play — never counted.
    { userId: OTHER, themeId: THEME_A, atEntryId: 11 },
  ];
  const follows: Record<string, unknown>[] = [
    { followerId: OTHER, followeeId: USER },
    { followerId: '507f1f77bcf86cd7994390c4', followeeId: USER },
    { followerId: USER, followeeId: OTHER },
    { followerId: USER, followeeId: '507f1f77bcf86cd7994390c4' },
    { followerId: USER, followeeId: '507f1f77bcf86cd7994390c5' },
    // Someone else's follow — never counted for USER.
    { followerId: OTHER, followeeId: '507f1f77bcf86cd7994390c4' },
  ];
  const modelOf = (docs: Record<string, unknown>[]) => ({
    docs,
    find: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter)).length),
  });
  return {
    ratings: modelOf(ratings),
    history: modelOf(history),
    themes: modelOf(themes),
    follows: modelOf(follows),
  };
}

const user = { _id: USER };

describe('computeProfileStats', () => {
  it('computes the exact aggregates for a seeded user', async () => {
    const models = makeModels();
    const stats = await computeProfileStats(models as never, user);
    expect(stats).toEqual({
      meanRating: 9, // (8 + 9 + 10) / 3
      themesListened: 4, // A, B, C and the gone theme — distinct
      totalListenedSeconds: 100 + 200 + 100 + 90 + 90 + 0,
      followersCount: 2, // counted from the follows rows
      followingCount: 3,
    });
  });

  it('ignores drifted stored counters — the follows rows are the truth (audit S3)', async () => {
    const models = makeModels();
    const drifted = { _id: USER, totalFollowers: 999, totalFollowing: 888 };
    const stats = await computeProfileStats(models as never, drifted);
    expect(stats.followersCount).toBe(2);
    expect(stats.followingCount).toBe(3);
  });

  it('rounds the mean to 1 decimal', async () => {
    const models = makeModels();
    models.ratings.docs.splice(0, models.ratings.docs.length,
      { userId: USER, themeId: THEME_A, score: 7 },
      { userId: USER, themeId: THEME_B, score: 8 },
      { userId: USER, themeId: THEME_C, score: 8 },
    );
    const stats = await computeProfileStats(models as never, user);
    expect(stats.meanRating).toBe(7.7); // 23 / 3 = 7.666…
  });

  it('answers the zero state for a user with no ratings or history', async () => {
    const models = makeModels();
    models.ratings.docs.splice(0);
    models.history.docs.splice(0);
    models.follows.docs.splice(0);
    const stats = await computeProfileStats(models as never, {
      _id: USER,
    });
    expect(stats).toEqual({
      meanRating: null,
      themesListened: 0,
      totalListenedSeconds: 0,
      followersCount: 0,
      followingCount: 0,
    });
  });
});

/**
 * resolvePlaySeconds — the shared duration rule extracted for
 * perf problem 4: the write paths (totalTime + stored stats)
 * and this recompute must resolve a play's seconds identically.
 */
describe('resolvePlaySeconds', () => {
  const theme = {
    entries: [
      { atEntryId: 11, duration: 100 },
      { atEntryId: 12, duration: 200 },
    ],
  };

  it('resolves the entry whose atEntryId matches', () => {
    expect(resolvePlaySeconds(theme, 12)).toBe(200);
    expect(resolvePlaySeconds(theme, 11)).toBe(100);
  });

  it('falls back to the first entry when nothing matches', () => {
    expect(resolvePlaySeconds(theme, 99)).toBe(100);
    expect(resolvePlaySeconds(theme, null)).toBe(100);
  });

  it('defaults to 90 when no entry resolves a duration', () => {
    expect(resolvePlaySeconds({ entries: [] }, 1)).toBe(90);
    expect(resolvePlaySeconds({ entries: [{ atEntryId: 1, duration: null }] }, 1)).toBe(90);
    expect(resolvePlaySeconds({}, 1)).toBe(90);
    expect(resolvePlaySeconds({ entries: null }, 1)).toBe(90);
  });

  it('contributes 0 for a theme gone from the catalogue', () => {
    expect(resolvePlaySeconds(null, 1)).toBe(0);
    expect(resolvePlaySeconds(undefined, 1)).toBe(0);
  });
});

/**
 * readStoredProfileStats — the stored-fields serve reader (perf
 * problem 4): the three aggregates come off the user record, the
 * mean is re-derived from the stored sum/count (1-decimal,
 * identical rounding to computeProfileStats), and the follow
 * counts pass through LIVE. An absent statsRatingCount is the
 * not-maintained marker → null, so the serve falls back.
 */
describe('readStoredProfileStats', () => {
  it('serves the stored aggregates with the live follow counts', () => {
    const stats = readStoredProfileStats(
      {
        statsListenedThemes: 4,
        statsListenedSeconds: 580,
        statsRatingSum: 27,
        statsRatingCount: 3,
      },
      2,
      3,
    );
    expect(stats).toEqual({
      meanRating: 9,
      themesListened: 4,
      totalListenedSeconds: 580,
      followersCount: 2,
      followingCount: 3,
    });
  });

  it('rounds the stored mean to 1 decimal like the recompute', () => {
    const stats = readStoredProfileStats(
      { statsRatingSum: 23, statsRatingCount: 3 },
      0,
      0,
    );
    expect(stats?.meanRating).toBe(7.7);
  });

  it('answers a null mean for a maintained user with no ratings', () => {
    const stats = readStoredProfileStats(
      {
        statsListenedThemes: 2,
        statsListenedSeconds: 300,
        statsRatingSum: 0,
        statsRatingCount: 0,
      },
      1,
      1,
    );
    expect(stats).toEqual({
      meanRating: null,
      themesListened: 2,
      totalListenedSeconds: 300,
      followersCount: 1,
      followingCount: 1,
    });
  });

  it('returns null for a document that was never maintained', () => {
    expect(readStoredProfileStats({}, 5, 6)).toBeNull();
    expect(
      readStoredProfileStats({ statsRatingCount: null }, 5, 6),
    ).toBeNull();
    // Even with the other fields present, no count = no trust:
    // the document predates maintenance and the serve must fall
    // back to the recompute rather than show partial numbers.
    expect(
      readStoredProfileStats(
        { statsListenedThemes: 9, statsListenedSeconds: 9 },
        5,
        6,
      ),
    ).toBeNull();
  });
});

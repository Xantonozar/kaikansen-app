import { computeProfileStats } from './profile-stats';

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

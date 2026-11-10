import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CountersService } from './counters.service';

/**
 * CountersService unit tests (audit S3 repair path): seeded
 * drifted counters are recomputed from the sources of truth
 * (follows / ratings / history-duration resolution) and only
 * the disagreeing users are rewritten; a second run is a no-op.
 * In-memory fakes implement the small filter surface used
 * (equality + $in), same pattern as profile-stats.spec.
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

function makeModels() {
  const users: Record<string, unknown>[] = [
    {
      _id: USER,
      username: 'drifty',
      // Every counter drifted away from the rows below.
      totalFollowers: 99,
      totalFollowing: 98,
      totalRatings: 42,
      totalTime: 7,
      // The perf-problem-4 stored stats drifted too.
      statsListenedThemes: 12,
      statsListenedSeconds: 7,
      statsRatingSum: 1,
      statsRatingCount: 9,
    },
    {
      _id: OTHER,
      username: 'clean',
      totalFollowers: 1,
      totalFollowing: 1,
      totalRatings: 0,
      totalTime: 0,
      statsListenedThemes: 0,
      statsListenedSeconds: 0,
      statsRatingSum: 0,
      statsRatingCount: 0,
    },
  ];
  const follows: Record<string, unknown>[] = [
    { followerId: OTHER, followeeId: USER },
    { followerId: '507f1f77bcf86cd7994390c4', followeeId: USER },
    { followerId: USER, followeeId: OTHER },
  ];
  const ratings: Record<string, unknown>[] = [
    { userId: USER, themeId: THEME_A, score: 8 },
    { userId: USER, themeId: THEME_A, score: 9 },
    { userId: USER, themeId: THEME_A, score: 10 },
  ];
  const history: Record<string, unknown>[] = [
    { userId: USER, themeId: THEME_A, atEntryId: 11 },
  ];
  const themes: Record<string, unknown>[] = [
    { _id: THEME_A, entries: [{ atEntryId: 11, duration: 100 }] },
  ];

  const modelOf = (docs: Record<string, unknown>[]) => ({
    docs,
    find: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter)).length),
  });

  const userModel = {
    docs: users,
    find: (filter: Record<string, unknown>) =>
      queryOf(users.filter((u) => matches(u, filter))),
    findById: (id: unknown) =>
      queryOf(users.find((u) => valueEquals(u._id, id)) ?? null),
    findByIdAndUpdate: (
      id: unknown,
      update: { $set: Record<string, unknown> },
    ) => {
      const doc = users.find((u) => valueEquals(u._id, id)) ?? null;
      if (doc) Object.assign(doc, update.$set);
      return queryOf(doc);
    },
  };

  return {
    userModel,
    followModel: modelOf(follows),
    ratingModel: modelOf(ratings),
    historyModel: modelOf(history),
    themeModel: modelOf(themes),
  };
}

function makeService() {
  const models = makeModels();
  const service = new CountersService(
    models.userModel as never,
    models.followModel as never,
    models.ratingModel as never,
    models.historyModel as never,
    models.themeModel as never,
  );
  return { service, models };
}

describe('CountersService — recountCounters', () => {
  it('repairs every drifted counter from the sources of truth', async () => {
    const { service, models } = makeService();
    const report = await service.recountCounters();
    expect(report.checked).toBe(2);
    expect(report.corrected).toBe(1);
    expect(report.corrections).toEqual([
      { userId: USER, username: 'drifty', field: 'totalFollowers', from: 99, to: 2 },
      { userId: USER, username: 'drifty', field: 'totalFollowing', from: 98, to: 1 },
      { userId: USER, username: 'drifty', field: 'totalRatings', from: 42, to: 3 },
      { userId: USER, username: 'drifty', field: 'totalTime', from: 7, to: 100 },
      // Perf problem 4: the stored stats are part of the repair
      // set — drifty's rows say 1 distinct theme, 100 seconds,
      // and ratings 8+9+10 (sum 27 over 3).
      { userId: USER, username: 'drifty', field: 'statsListenedThemes', from: 12, to: 1 },
      { userId: USER, username: 'drifty', field: 'statsListenedSeconds', from: 7, to: 100 },
      { userId: USER, username: 'drifty', field: 'statsRatingSum', from: 1, to: 27 },
      { userId: USER, username: 'drifty', field: 'statsRatingCount', from: 9, to: 3 },
    ]);
    const stored = models.userModel.docs[0];
    expect(stored.totalFollowers).toBe(2);
    expect(stored.totalFollowing).toBe(1);
    expect(stored.totalRatings).toBe(3);
    expect(stored.totalTime).toBe(100);
    expect(stored.statsListenedThemes).toBe(1);
    expect(stored.statsListenedSeconds).toBe(100);
    expect(stored.statsRatingSum).toBe(27);
    expect(stored.statsRatingCount).toBe(3);
  });

  it('backfills a user whose document predates the stored stats (perf problem 4)', async () => {
    const { service, models } = makeService();
    // Strip the stats fields: the pre-backfill state. The legacy
    // counters are left TRUE so the report isolates the backfill.
    const legacy = models.userModel.docs[0];
    delete legacy.statsListenedThemes;
    delete legacy.statsListenedSeconds;
    delete legacy.statsRatingSum;
    delete legacy.statsRatingCount;
    legacy.totalFollowers = 2;
    legacy.totalFollowing = 1;
    legacy.totalRatings = 3;
    legacy.totalTime = 100;
    const report = await service.recountCounters(USER);
    expect(report.corrected).toBe(1);
    expect(report.corrections).toEqual([
      { userId: USER, username: 'drifty', field: 'statsListenedThemes', from: 0, to: 1 },
      { userId: USER, username: 'drifty', field: 'statsListenedSeconds', from: 0, to: 100 },
      { userId: USER, username: 'drifty', field: 'statsRatingSum', from: 0, to: 27 },
      { userId: USER, username: 'drifty', field: 'statsRatingCount', from: 0, to: 3 },
    ]);
    expect(models.userModel.docs[0].statsRatingCount).toBe(3);
  });

  it('is a no-op once the counters are true', async () => {
    const { service } = makeService();
    await service.recountCounters();
    const second = await service.recountCounters();
    expect(second.corrected).toBe(0);
    expect(second.corrections).toEqual([]);
  });

  it('recounts a single user by id and 404s an unknown id', async () => {
    const { service, models } = makeService();
    const report = await service.recountCounters(USER);
    expect(report.checked).toBe(1);
    expect(report.corrected).toBe(1);
    expect(models.userModel.docs[0].totalFollowers).toBe(2);
    await expect(
      service.recountCounters('507f1f77bcf86cd7994390ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 503 when booted without models', async () => {
    const service = new CountersService();
    await expect(service.recountCounters()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

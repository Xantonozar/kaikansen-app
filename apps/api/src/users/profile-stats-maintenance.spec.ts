import { ProfileStatsMaintenance } from './profile-stats-maintenance';
import { computeProfileStats } from './profile-stats';

/**
 * ProfileStatsMaintenance unit tests (perf problem 4): the
 * stored-stats write-path maintenance, over in-memory fakes that
 * implement the small surface it uses — countDocuments, find
 * (lean), findById (lean), findOneAndUpdate with the
 * `statsRatingCount: { $exists: true }` marker filter and $inc /
 * $set application. The fake findOneAndUpdate returns the
 * PRE-update document like Mongoose's default.
 *
 * The centrepiece is the EQUALITY suite: after listen/rate/delete
 * sequences, the stored fields equal computeProfileStats run
 * over the same fixture rows — the stored values are the
 * recompute, maintained incrementally.
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
      '$exists' in (condition as Record<string, unknown>)
    ) {
      const want = (condition as { $exists: boolean }).$exists;
      return (doc[key] !== undefined) === want;
    }
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

function applyUpdate(
  doc: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(update)) {
    if (key === '$inc') {
      const incs = value as Record<string, number>;
      for (const [field, delta] of Object.entries(incs)) {
        doc[field] = ((doc[field] as number) ?? 0) + delta;
      }
    } else if (key === '$set') {
      Object.assign(doc, value as Record<string, unknown>);
    } else {
      doc[key] = value;
    }
  }
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

const USER = 'user-m';
const OTHER = 'user-o';
const THEME_A = { _id: 'theme-a', entries: [{ atEntryId: 11, duration: 100 }, { atEntryId: 12, duration: 200 }] };
const THEME_B = { _id: 'theme-b', entries: [{ atEntryId: 21, duration: null }] };
const THEME_C = { _id: 'theme-c', entries: [] as { atEntryId: number; duration: number }[] };

function makeWorld() {
  const users: Record<string, unknown>[] = [
    // Maintained (backfilled) user: starts at the truth for zero rows.
    {
      _id: USER,
      username: 'maintained',
      totalTime: 0,
      statsListenedThemes: 0,
      statsListenedSeconds: 0,
      statsRatingSum: 0,
      statsRatingCount: 0,
    },
  ];
  const ratings: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const follows: Record<string, unknown>[] = [];
  const themes: Record<string, unknown>[] = [THEME_A, THEME_B, THEME_C];

  const rowModel = (docs: Record<string, unknown>[]) => ({
    docs,
    find: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter)).length),
  });

  const userModel = {
    docs: users,
    findById: (id: unknown) =>
      queryOf(users.find((u) => valueEquals(u._id, id)) ?? null),
    findOneAndUpdate: jest.fn(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const doc = users.find((u) => matches(u, filter)) ?? null;
        const before = doc ? { ...doc } : null;
        if (doc) applyUpdate(doc, update);
        return queryOf(before);
      },
    ),
    findByIdAndUpdate: jest.fn(
      (id: unknown, update: Record<string, unknown>) => {
        const doc = users.find((u) => valueEquals(u._id, id)) ?? null;
        const before = doc ? { ...doc } : null;
        if (doc) applyUpdate(doc, update);
        return queryOf(before);
      },
    ),
  };

  return {
    users,
    ratings,
    history,
    follows,
    themes,
    userModel,
    ratingModel: rowModel(ratings),
    historyModel: rowModel(history),
    followModel: rowModel(follows),
    themeModel: rowModel(themes),
  };
}

type World = ReturnType<typeof makeWorld>;

function makeMaintenance(world: World) {
  return new ProfileStatsMaintenance(
    world.userModel as never,
    world.historyModel as never,
    world.ratingModel as never,
  );
}

/** Record a play exactly as the write path does: row first, then the delta. */
async function play(
  world: World,
  maintenance: ProfileStatsMaintenance,
  theme: typeof THEME_A,
  atEntryId: number | null,
) {
  world.history.push({ userId: USER, themeId: theme._id, atEntryId });
  await maintenance.applyWatchDelta({ userId: USER, theme, atEntryId });
}

async function assertStoredEqualsComputed(world: World) {
  const computed = await computeProfileStats(
    {
      ratings: world.ratingModel as never,
      history: world.historyModel as never,
      themes: world.themeModel as never,
      follows: world.followModel as never,
    },
    { _id: USER },
  );
  const user = world.users[0];
  expect(user.statsListenedThemes).toBe(computed.themesListened);
  expect(user.statsListenedSeconds).toBe(computed.totalListenedSeconds);
  const ratingRows = world.ratings.filter((r) => r.userId === USER);
  expect(user.statsRatingCount).toBe(ratingRows.length);
  expect(user.statsRatingSum).toBe(
    ratingRows.reduce((sum, r) => sum + (r.score as number), 0),
  );
  const mean =
    (user.statsRatingCount as number) > 0
      ? Math.round(
          ((user.statsRatingSum as number) /
            (user.statsRatingCount as number)) *
            10,
        ) / 10
      : null;
  expect(mean).toBe(computed.meanRating);
  return computed;
}

describe('ProfileStatsMaintenance.nextAfterPlay (pure core)', () => {
  it('returns null for an unmaintained document — nothing may be minted', () => {
    expect(
      ProfileStatsMaintenance.nextAfterPlay(null, THEME_A, 11, true),
    ).toBeNull();
    expect(
      ProfileStatsMaintenance.nextAfterPlay({}, THEME_A, 11, true),
    ).toBeNull();
    expect(
      ProfileStatsMaintenance.nextAfterPlay(
        { statsRatingCount: null },
        THEME_A,
        11,
        true,
      ),
    ).toBeNull();
  });

  it('adds the resolved seconds and +1 only on a first play of the theme', () => {
    const stored = {
      statsListenedThemes: 2,
      statsListenedSeconds: 500,
      statsRatingCount: 1,
    };
    expect(
      ProfileStatsMaintenance.nextAfterPlay(stored, THEME_A, 12, true),
    ).toEqual({ statsListenedThemes: 3, statsListenedSeconds: 700 });
    expect(
      ProfileStatsMaintenance.nextAfterPlay(stored, THEME_A, 12, false),
    ).toEqual({ statsListenedThemes: 2, statsListenedSeconds: 700 });
  });

  it('resolves the duration edges through the shared rule', () => {
    const stored = {
      statsListenedThemes: 0,
      statsListenedSeconds: 0,
      statsRatingCount: 0,
    };
    // Null-duration entry → 90.
    expect(
      ProfileStatsMaintenance.nextAfterPlay(stored, THEME_B, 21, true)
        ?.statsListenedSeconds,
    ).toBe(90);
    // No entries at all → 90.
    expect(
      ProfileStatsMaintenance.nextAfterPlay(stored, THEME_C, null, true)
        ?.statsListenedSeconds,
    ).toBe(90);
    // Theme gone → 0 seconds, but the distinct count still moves.
    expect(
      ProfileStatsMaintenance.nextAfterPlay(stored, null, 1, true),
    ).toEqual({ statsListenedThemes: 1, statsListenedSeconds: 0 });
  });
});

describe('ProfileStatsMaintenance — stored vs computed equality', () => {
  it('tracks plays: distinct themes, replays, and every duration edge', async () => {
    const world = makeWorld();
    const maintenance = makeMaintenance(world);

    await play(world, maintenance, THEME_A, 11); // 100, first A
    await play(world, maintenance, THEME_A, 12); // 200, replay — no +1
    await play(world, maintenance, THEME_A, 99); // first entry 100, replay
    await play(world, maintenance, THEME_B, 21); // 90 (null duration), first B
    await play(world, maintenance, THEME_C, null); // 90 (no entries), first C
    // A play whose theme has since left the catalogue: the row
    // exists, but there is no theme document to resolve a
    // duration from — computeProfileStats contributes 0 for it.
    // (The write path can never hit this exact case — it 404s
    // unknown themes before recording — but a theme deleted
    // AFTER the play leaves the same row shape behind, so the
    // maintenance must resolve it to 0 exactly like the
    // recompute does.)
    world.history.push({ userId: USER, themeId: 'theme-gone', atEntryId: 1 });
    await maintenance.applyWatchDelta({
      userId: USER,
      theme: null as never,
      atEntryId: 1,
    });

    const computed = await assertStoredEqualsComputed(world);
    expect(computed.themesListened).toBe(4);
    expect(computed.totalListenedSeconds).toBe(100 + 200 + 100 + 90 + 90 + 0);
    expect(world.users[0].statsListenedThemes).toBe(4);
  });

  it('tracks rating create / update / delete sequences', async () => {
    const world = makeWorld();
    const maintenance = makeMaintenance(world);

    world.ratings.push({ userId: USER, themeId: 'theme-a', score: 8 });
    await maintenance.refreshRatingStats(USER);
    world.ratings.push({ userId: USER, themeId: 'theme-b', score: 9 });
    await maintenance.refreshRatingStats(USER);
    // Update: same row, new score.
    world.ratings[0].score = 10;
    await maintenance.refreshRatingStats(USER);
    // Another user's rating never leaks in.
    world.ratings.push({ userId: OTHER, themeId: 'theme-a', score: 1 });
    await maintenance.refreshRatingStats(USER);
    await assertStoredEqualsComputed(world);
    expect(world.users[0].statsRatingSum).toBe(19);
    expect(world.users[0].statsRatingCount).toBe(2);

    // Delete: the row goes, the refresh follows.
    world.ratings.splice(0, 1);
    await maintenance.refreshRatingStats(USER);
    await assertStoredEqualsComputed(world);
    expect(world.users[0].statsRatingSum).toBe(9);
    expect(world.users[0].statsRatingCount).toBe(1);

    // Delete the last one: count 0, mean null — still maintained.
    world.ratings.splice(0, world.ratings.length);
    await maintenance.refreshRatingStats(USER);
    const computed = await assertStoredEqualsComputed(world);
    expect(computed.meanRating).toBeNull();
    expect(world.users[0].statsRatingCount).toBe(0);
  });

  it('interleaved plays and ratings stay equal throughout', async () => {
    const world = makeWorld();
    const maintenance = makeMaintenance(world);
    await play(world, maintenance, THEME_A, 11);
    world.ratings.push({ userId: USER, themeId: 'theme-a', score: 7 });
    await maintenance.refreshRatingStats(USER);
    await play(world, maintenance, THEME_B, 21);
    world.ratings.push({ userId: USER, themeId: 'theme-b', score: 8 });
    await maintenance.refreshRatingStats(USER);
    await play(world, maintenance, THEME_A, 11);
    const computed = await assertStoredEqualsComputed(world);
    expect(computed).toMatchObject({
      meanRating: 7.5,
      themesListened: 2,
      totalListenedSeconds: 100 + 90 + 100,
    });
  });
});

describe('ProfileStatsMaintenance — the unmaintained document', () => {
  function unmaintainedWorld() {
    const world = makeWorld();
    world.users[0] = { _id: USER, username: 'legacy', totalTime: 0 };
    return world;
  }

  it('a watch delta never mints stats on an unmaintained document', async () => {
    const world = unmaintainedWorld();
    const maintenance = makeMaintenance(world);
    await play(world, maintenance, THEME_A, 11);
    expect(world.users[0].statsRatingCount).toBeUndefined();
    expect(world.users[0].statsListenedSeconds).toBeUndefined();
    expect(world.users[0].statsListenedThemes).toBeUndefined();
  });

  it('a rating initialises an unmaintained user whose history side is provably empty', async () => {
    const world = unmaintainedWorld();
    const maintenance = makeMaintenance(world);
    world.ratings.push({ userId: USER, themeId: 'theme-a', score: 8 });
    await maintenance.refreshRatingStats(USER);
    expect(world.users[0]).toMatchObject({
      statsListenedThemes: 0,
      statsListenedSeconds: 0,
      statsRatingSum: 8,
      statsRatingCount: 1,
    });
    // From here the user IS maintained: plays maintain normally.
    await play(world, maintenance, THEME_A, 11);
    await assertStoredEqualsComputed(world);
  });

  it('a rating never initialises a user who already has plays (no fabricated zeros)', async () => {
    const world = unmaintainedWorld();
    const maintenance = makeMaintenance(world);
    // Pre-existing plays from before the stored-stats era.
    world.history.push({ userId: USER, themeId: 'theme-a', atEntryId: 11 });
    world.users[0].totalTime = 100;
    world.ratings.push({ userId: USER, themeId: 'theme-a', score: 8 });
    await maintenance.refreshRatingStats(USER);
    expect(world.users[0].statsRatingCount).toBeUndefined();
    expect(world.users[0].statsListenedThemes).toBeUndefined();
  });
});

describe('ProfileStatsMaintenance — failure tolerance', () => {
  it('swallows store failures on both paths (the write never fails)', async () => {
    const world = makeWorld();
    const maintenance = makeMaintenance(world);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    world.historyModel.countDocuments = () => {
      throw new Error('boom');
    };
    await expect(
      maintenance.applyWatchDelta({ userId: USER, theme: THEME_A as never, atEntryId: 11 }),
    ).resolves.toBeUndefined();
    world.ratingModel.find = () => {
      throw new Error('boom');
    };
    await expect(maintenance.refreshRatingStats(USER)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('is a no-op when constructed without models', async () => {
    const maintenance = new ProfileStatsMaintenance();
    await expect(
      maintenance.applyWatchDelta({ userId: USER, theme: THEME_A as never, atEntryId: 11 }),
    ).resolves.toBeUndefined();
    await expect(maintenance.refreshRatingStats(USER)).resolves.toBeUndefined();
  });
});

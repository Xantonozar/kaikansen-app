import { ServiceUnavailableException } from '@nestjs/common';
import { RankReadService } from './rank-read.service';

/**
 * RankReadService unit tests (Slice S6) — the web's rank reads:
 * getUserRank (find-or-create) and the /api/leaderboard port
 * (fresh snapshot vs live aggregation). All three models are
 * in-memory fakes; the filter support is equality + $in, which is
 * all the service uses.
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

function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, unknown> = {};
  q.sort = (spec: Record<string, number>) => {
    const keys = Object.entries(spec);
    result.sort((a, b) => {
      for (const [key, dir] of keys) {
        const av = a[key] as never;
        const bv = b[key] as never;
        if (av < bv) return -dir;
        if (av > bv) return dir;
      }
      return 0;
    });
    return q;
  };
  q.limit = (n: number) => {
    result = result.slice(0, n);
    return q;
  };
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const T0 = Date.parse('2026-11-07T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function rankDoc(userId: string, rp: number, extra: Record<string, unknown> = {}) {
  return {
    _id: `rank-${userId}`,
    userId,
    rp,
    tier: rp >= 400 ? 'genin' : 'academy',
    division: rp >= 400 ? 3 : null,
    tierFloor: rp >= 400 ? 400 : 0,
    currentWinStreak: 1,
    longestWinStreak: 4,
    stats: {
      totalGames: 10,
      wins: 6,
      losses: 3,
      draws: 1,
      winRate: 0.6,
      peakRP: rp,
      peakTier: rp >= 400 ? 'genin' : 'academy',
    },
    season: {
      seasonId: 'all-time',
      seasonRP: rp,
      seasonWins: 6,
      seasonLosses: 3,
      seasonPlacement: null,
    },
    createdAt: at(0),
    updatedAt: at(10),
    ...extra,
  };
}

function makeWorld() {
  const ranks: Record<string, unknown>[] = [
    rankDoc('507f1f77bcf86cd7994390a1', 900),
    rankDoc('507f1f77bcf86cd7994390a2', 500),
    rankDoc('507f1f77bcf86cd7994390a3', 450), // no user document — the live $unwind drop
    rankDoc('507f1f77bcf86cd7994390a4', 100),
  ];
  const users: Record<string, unknown>[] = [
    { _id: '507f1f77bcf86cd7994390a1', username: 'alice', displayName: 'Alice A', avatarUrl: 'https://example.com/alice.png' },
    { _id: '507f1f77bcf86cd7994390a2', username: 'bob', displayName: 'Bob B', avatarUrl: null },
    { _id: '507f1f77bcf86cd7994390a4', username: 'carol', displayName: 'Carol C', avatarUrl: null },
  ];
  const snapshots: Record<string, unknown>[] = [];
  let createCalls = 0;

  const userRankModel = {
    docs: ranks,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(ranks.find((r) => matches(r, filter)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(ranks.filter((r) => matches(r, filter))),
    create: async (data: Record<string, unknown>) => {
      createCalls++;
      const now = new Date();
      const doc = {
        _id: `rank-${String(data.userId)}`,
        rp: 0,
        tier: 'academy',
        division: null,
        tierFloor: 0,
        currentWinStreak: 0,
        longestWinStreak: 0,
        stats: {
          totalGames: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          winRate: 0,
          peakRP: 0,
          peakTier: 'academy',
        },
        season: {
          seasonId: 'all-time',
          seasonRP: 0,
          seasonWins: 0,
          seasonLosses: 0,
          seasonPlacement: null,
        },
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      ranks.push(doc);
      return doc;
    },
  };
  const snapshotModel = {
    findOne: (filter: Record<string, unknown>) =>
      queryOf(snapshots.find((s) => matches(s, filter)) ?? null),
  };
  const userModel = {
    find: (filter: Record<string, unknown>) => {
      // Mongoose casts an _id $in against ObjectId: one malformed
      // value fails the WHOLE query with a CastError (the Bug 3
      // production failure). The fake models that faithfully.
      const inList = (
        filter._id as { $in?: unknown[] } | undefined
      )?.$in;
      if (
        Array.isArray(inList) &&
        inList.some((v) => !/^[0-9a-fA-F]{24}$/.test(String(v)))
      ) {
        throw Object.assign(
          new Error('Cast to ObjectId failed for value in $in'),
          { name: 'CastError' },
        );
      }
      return chain(users.filter((u) => matches(u, filter)));
    },
  };

  return {
    ranks,
    users,
    snapshots,
    userRankModel,
    snapshotModel,
    userModel,
    createCalls: () => createCalls,
  };
}

function makeService(world: ReturnType<typeof makeWorld>) {
  return new RankReadService(
    world.userRankModel as never,
    world.snapshotModel as never,
    world.userModel as never,
  );
}

/* ------------------------------------------------------------------ */
/* getRank — the web's getUserRank (find-or-create)                    */
/* ------------------------------------------------------------------ */

describe('RankReadService.getRank', () => {
  it('projects an existing rank document without creating anything', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const profile = await service.getRank('507f1f77bcf86cd7994390a1');
    expect(world.createCalls()).toBe(0);
    expect(profile).toEqual({
      id: 'rank-507f1f77bcf86cd7994390a1',
      userId: '507f1f77bcf86cd7994390a1',
      rp: 900,
      tier: 'genin',
      division: 3,
      tierFloor: 400,
      currentWinStreak: 1,
      longestWinStreak: 4,
      stats: {
        totalGames: 10,
        wins: 6,
        losses: 3,
        draws: 1,
        winRate: 0.6,
        peakRP: 900,
        peakTier: 'genin',
      },
      season: {
        seasonId: 'all-time',
        seasonRP: 900,
        seasonWins: 6,
        seasonLosses: 3,
        seasonPlacement: null,
      },
      createdAt: at(0).toISOString(),
      updatedAt: at(10).toISOString(),
    });
  });

  it('CREATES the default rank document when none exists (the web’s getUserRank write)', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const profile = await service.getRank('new-player');
    expect(world.createCalls()).toBe(1);
    expect(world.ranks.some((r) => r.userId === 'new-player')).toBe(true);
    expect(profile).toMatchObject({
      userId: 'new-player',
      rp: 0,
      tier: 'academy',
      division: null,
      tierFloor: 0,
      currentWinStreak: 0,
      longestWinStreak: 0,
    });
    expect(profile.stats).toEqual({
      totalGames: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      winRate: 0,
      peakRP: 0,
      peakTier: 'academy',
    });
    // A second read finds the created document — no second create.
    await service.getRank('new-player');
    expect(world.createCalls()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* getPlayerRanks — the app-only batched read (never creates)          */
/* ------------------------------------------------------------------ */

describe('RankReadService.getPlayerRanks', () => {
  it('returns tier + RP for ranked players, in request order', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const res = await service.getPlayerRanks(['507f1f77bcf86cd7994390a4', '507f1f77bcf86cd7994390a1']);
    expect(res.players).toEqual([
      { userId: '507f1f77bcf86cd7994390a4', tier: 'academy', rp: 100 },
      { userId: '507f1f77bcf86cd7994390a1', tier: 'genin', rp: 900 },
    ]);
    expect(world.createCalls()).toBe(0);
  });

  it('reports the materialised defaults for a player with no rank document — and creates NOTHING', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const res = await service.getPlayerRanks(['507f1f77bcf86cd7994390a1', 'new-player']);
    expect(res.players).toEqual([
      { userId: '507f1f77bcf86cd7994390a1', tier: 'genin', rp: 900 },
      { userId: 'new-player', tier: 'academy', rp: 0 },
    ]);
    // The whole point of the endpoint: unlike getRank, no write.
    expect(world.createCalls()).toBe(0);
    expect(world.ranks.some((r) => r.userId === 'new-player')).toBe(false);
  });

  it('dedupes repeated ids and answers an empty list for no ids', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const res = await service.getPlayerRanks(['507f1f77bcf86cd7994390a2', '507f1f77bcf86cd7994390a2', '']);
    expect(res.players).toEqual([
      { userId: '507f1f77bcf86cd7994390a2', tier: 'genin', rp: 500 },
    ]);
    await expect(service.getPlayerRanks([])).resolves.toEqual({
      players: [],
    });
  });
});

/* ------------------------------------------------------------------ */
/* getLeaderboard                                                      */
/* ------------------------------------------------------------------ */

describe('RankReadService.getLeaderboard', () => {
  it('serves a fresh snapshot, with the web’s username-as-displayName quirk', async () => {
    const world = makeWorld();
    world.snapshots.push({
      _id: 'snap-1',
      scope: 'global',
      seasonId: 'all-time',
      computedAt: new Date(Date.now() - 60_000), // 1 minute old — fresh
      entries: [
        {
          rank: 1,
          userId: '507f1f77bcf86cd7994390a1',
          username: 'alice',
          avatar: 'https://example.com/alice.png',
          tier: 'genin',
          division: 3,
          rp: 900,
          wins: 6,
          winRate: 0.6,
          currentWinStreak: 1,
        },
      ],
    });
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.meta.source).toBe('snapshot');
    expect(res.meta.computedAt).not.toBeNull();
    expect(res.leaderboard).toEqual([
      {
        userId: '507f1f77bcf86cd7994390a1',
        username: 'alice',
        displayName: 'alice', // NOT 'Alice A' — the web serves the username here
        avatarUrl: 'https://example.com/alice.png',
        rp: 900,
        tier: 'genin',
        division: 3,
        wins: 6,
        winRate: 0.6,
      },
    ]);
  });

  it('ignores a snapshot older than 15 minutes and aggregates live', async () => {
    const world = makeWorld();
    world.snapshots.push({
      _id: 'snap-old',
      scope: 'global',
      seasonId: 'all-time',
      computedAt: new Date(Date.now() - 16 * 60_000),
      entries: [
        {
          rank: 1,
          userId: 'stale-id',
          username: 'stale',
          avatar: null,
          tier: 'kage',
          division: null,
          rp: 9999,
          wins: 99,
          winRate: 1,
          currentWinStreak: 9,
        },
      ],
    });
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.meta).toEqual({ source: 'live', computedAt: null });
    expect(res.leaderboard.map((e) => e.userId)).not.toContain('stale-id');
  });

  it('ignores a fresh snapshot with no entries', async () => {
    const world = makeWorld();
    world.snapshots.push({
      _id: 'snap-empty',
      scope: 'global',
      seasonId: 'all-time',
      computedAt: new Date(),
      entries: [],
    });
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.meta.source).toBe('live');
  });

  it('live path: RP order, real display names, and the gone-user row dropped', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.meta).toEqual({ source: 'live', computedAt: null });
    expect(res.leaderboard.map((e) => e.userId)).toEqual([
      '507f1f77bcf86cd7994390a1',
      '507f1f77bcf86cd7994390a2',
      '507f1f77bcf86cd7994390a4',
    ]); // 507f1f77bcf86cd7994390a3 (450 RP) dropped by the join
    expect(res.leaderboard[0]).toEqual({
      userId: '507f1f77bcf86cd7994390a1',
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
      rp: 900,
      tier: 'genin',
      division: 3,
      wins: 6,
      winRate: 0.6,
    });
  });

  it('live path applies the 100 cap BEFORE dropping gone users (the web’s $limit order)', async () => {
    const world = makeWorld();
    // 101 rank rows: #100 (by RP) belongs to a gone user, #101 has a user.
    world.ranks.length = 0;
    world.users.length = 0;
    const uid = (i: number) => String(i).padStart(24, '0');
    for (let i = 0; i < 99; i++) {
      world.ranks.push(rankDoc(uid(i), 1000 - i));
      world.users.push({
        _id: uid(i),
        username: `user${i}`,
        displayName: `User ${i}`,
        avatarUrl: null,
      });
    }
    world.ranks.push(rankDoc('507f1f77bcf86cd7994390e0', 901)); // position 100, no user doc
    world.ranks.push(rankDoc('507f1f77bcf86cd7994390e1', 900)); // position 101, has a user doc
    world.users.push({
      _id: '507f1f77bcf86cd7994390e1',
      username: 'last',
      displayName: 'Last',
      avatarUrl: null,
    });
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.leaderboard).toHaveLength(99);
    expect(res.leaderboard.map((e) => e.userId)).not.toContain('507f1f77bcf86cd7994390e1');
  });

  it('Bug 3: a legacy rank row with a non-ObjectId userId cannot 500 the live path', async () => {
    const world = makeWorld();
    // The shared-DB failure: userId is a plain String on the rank
    // schema, and a legacy row carries junk. It outranks everyone
    // (950 RP), so pre-fix it poisoned the users $in cast and the
    // endpoint 500ed for every caller (the fake's find throws the
    // same CastError real Mongoose does).
    world.ranks.push(rankDoc('not-an-object-id', 950));
    world.users.push({
      _id: 'not-an-object-id',
      username: 'legacy',
      displayName: 'Legacy',
      avatarUrl: null,
    });
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.meta.source).toBe('live');
    expect(res.leaderboard.map((e) => e.userId)).toEqual([
      '507f1f77bcf86cd7994390a1',
      '507f1f77bcf86cd7994390a2',
      '507f1f77bcf86cd7994390a4',
    ]);
  });

  it('Bug 3: malformed entries inside a fresh snapshot are skipped, not fatal', async () => {
    const world = makeWorld();
    world.snapshots.push({
      _id: 'snap-broken',
      scope: 'global',
      seasonId: 'all-time',
      computedAt: new Date(),
      entries: [
        null,
        { userId: 42, username: 'wrong-typed' },
        {
          rank: 1,
          userId: '507f1f77bcf86cd7994390a1',
          username: 'alice',
          avatar: 'https://example.com/alice.png',
          tier: 'genin',
          division: 3,
          rp: 900,
          wins: 6,
          winRate: 0.6,
          currentWinStreak: 1,
        },
      ],
    });
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.meta.source).toBe('snapshot');
    expect(res.leaderboard).toHaveLength(1);
    expect(res.leaderboard[0].userId).toBe('507f1f77bcf86cd7994390a1');
  });
});

/* ------------------------------------------------------------------ */
/* No database                                                         */
/* ------------------------------------------------------------------ */

describe('RankReadService without models', () => {
  it('answers 503 from every method', async () => {
    const service = new RankReadService();
    await expect(service.getRank('507f1f77bcf86cd7994390a1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getLeaderboard()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getPlayerRanks(['507f1f77bcf86cd7994390a1'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

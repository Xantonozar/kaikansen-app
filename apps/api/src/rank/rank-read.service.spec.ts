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
    rankDoc('alice-id', 900),
    rankDoc('bob-id', 500),
    rankDoc('gone-id', 450), // no user document — the live $unwind drop
    rankDoc('carol-id', 100),
  ];
  const users: Record<string, unknown>[] = [
    { _id: 'alice-id', username: 'alice', displayName: 'Alice A', avatarUrl: 'https://example.com/alice.png' },
    { _id: 'bob-id', username: 'bob', displayName: 'Bob B', avatarUrl: null },
    { _id: 'carol-id', username: 'carol', displayName: 'Carol C', avatarUrl: null },
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
    find: (filter: Record<string, unknown>) =>
      chain(users.filter((u) => matches(u, filter))),
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
    const profile = await service.getRank('alice-id');
    expect(world.createCalls()).toBe(0);
    expect(profile).toEqual({
      id: 'rank-alice-id',
      userId: 'alice-id',
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
    const res = await service.getPlayerRanks(['carol-id', 'alice-id']);
    expect(res.players).toEqual([
      { userId: 'carol-id', tier: 'academy', rp: 100 },
      { userId: 'alice-id', tier: 'genin', rp: 900 },
    ]);
    expect(world.createCalls()).toBe(0);
  });

  it('reports the materialised defaults for a player with no rank document — and creates NOTHING', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const res = await service.getPlayerRanks(['alice-id', 'new-player']);
    expect(res.players).toEqual([
      { userId: 'alice-id', tier: 'genin', rp: 900 },
      { userId: 'new-player', tier: 'academy', rp: 0 },
    ]);
    // The whole point of the endpoint: unlike getRank, no write.
    expect(world.createCalls()).toBe(0);
    expect(world.ranks.some((r) => r.userId === 'new-player')).toBe(false);
  });

  it('dedupes repeated ids and answers an empty list for no ids', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const res = await service.getPlayerRanks(['bob-id', 'bob-id', '']);
    expect(res.players).toEqual([
      { userId: 'bob-id', tier: 'genin', rp: 500 },
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
          userId: 'alice-id',
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
        userId: 'alice-id',
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
      'alice-id',
      'bob-id',
      'carol-id',
    ]); // gone-id (450 RP) dropped by the join
    expect(res.leaderboard[0]).toEqual({
      userId: 'alice-id',
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
    for (let i = 0; i < 99; i++) {
      world.ranks.push(rankDoc(`u${i}`, 1000 - i));
      world.users.push({
        _id: `u${i}`,
        username: `user${i}`,
        displayName: `User ${i}`,
        avatarUrl: null,
      });
    }
    world.ranks.push(rankDoc('ghost', 901)); // position 100, no user doc
    world.ranks.push(rankDoc('u-last', 900)); // position 101, has a user doc
    world.users.push({
      _id: 'u-last',
      username: 'last',
      displayName: 'Last',
      avatarUrl: null,
    });
    const service = makeService(world);
    const res = await service.getLeaderboard();
    expect(res.leaderboard).toHaveLength(99);
    expect(res.leaderboard.map((e) => e.userId)).not.toContain('u-last');
  });
});

/* ------------------------------------------------------------------ */
/* No database                                                         */
/* ------------------------------------------------------------------ */

describe('RankReadService without models', () => {
  it('answers 503 from every method', async () => {
    const service = new RankReadService();
    await expect(service.getRank('alice-id')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getLeaderboard()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getPlayerRanks(['alice-id'])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

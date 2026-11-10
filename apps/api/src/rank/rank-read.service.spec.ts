import { ServiceUnavailableException } from '@nestjs/common';
import { RankReadService } from './rank-read.service';
import { weekStartDhaka } from '../quiz/ladder-standing';

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
  const history: Record<string, unknown>[] = [];
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
  /**
   * RankHistory fake — supports exactly the weekly pipeline the
   * service runs: $match on playedAt >= since, $group by userId
   * summing rpChange, $sort (weeklyRp desc, _id asc), $limit.
   */
  const rankHistoryModel = {
    docs: history,
    aggregate: (pipeline: Record<string, unknown>[]) => ({
      exec: async () => {
        let rows: Record<string, unknown>[] = [...history];
        for (const stage of pipeline) {
          if ('$match' in stage) {
            const since = (
              stage.$match as { playedAt: { $gte: Date } }
            ).playedAt.$gte;
            rows = rows.filter(
              (r) => (r.playedAt as Date).getTime() >= since.getTime(),
            );
          } else if ('$group' in stage) {
            const byUser = new Map<string, number>();
            for (const r of rows) {
              const id = String(r.userId);
              byUser.set(id, (byUser.get(id) ?? 0) + (r.rpChange as number));
            }
            rows = [...byUser.entries()].map(([id, weeklyRp]) => ({
              _id: id,
              weeklyRp,
            }));
          } else if ('$sort' in stage) {
            const spec = stage.$sort as Record<string, number>;
            rows.sort((a, b) => {
              for (const [key, dir] of Object.entries(spec)) {
                const av = a[key] as never;
                const bv = b[key] as never;
                if (av < bv) return -dir;
                if (av > bv) return dir;
              }
              return 0;
            });
          } else if ('$limit' in stage) {
            rows = rows.slice(0, stage.$limit as number);
          }
        }
        return rows;
      },
    }),
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
    history,
    userRankModel,
    snapshotModel,
    userModel,
    rankHistoryModel,
    createCalls: () => createCalls,
  };
}

function makeService(world: ReturnType<typeof makeWorld>) {
  return new RankReadService(
    world.userRankModel as never,
    world.snapshotModel as never,
    world.userModel as never,
    world.rankHistoryModel as never,
  );
}

/* The additive ladder standings the reads derive (ladderForRp).   */
/* Target = the NEXT rank (spec RANK-RP-PLAN-2026-11-11.md).       */
const LADDER_0 = {
  rank: 'academy-student',
  index: 0,
  nextRank: 'scout',
  toNext: 100,
  fraction: 0,
} as const;
const LADDER_100 = {
  rank: 'scout',
  index: 1,
  nextRank: 'mizunoto',
  toNext: 150,
  fraction: 0,
} as const;
const LADDER_500 = {
  rank: 'genin',
  index: 3,
  nextRank: 'chunin',
  toNext: 200,
  fraction: 50 / 250,
} as const;
const LADDER_900 = {
  rank: 'chunin',
  index: 4,
  nextRank: 'shinobi',
  toNext: 200,
  fraction: 200 / 400,
} as const;

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
      ladder: { ...LADDER_900, peakRank: 'chunin' },
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
        peakLadderRank: 'chunin',
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

  it('serves the standing from CURRENT RP — a fallen player demotes, the peak stays a labelled fact (floor drop, spec RANK-RP-PLAN-2026-11-11)', async () => {
    const world = makeWorld();
    // A document whose RP has FALLEN to 690 while its peak
    // still records the 900 high-water mark. Under a peak-fed
    // standing this profile would still read Chunin; with the
    // floor dropped (2026-11-11) the standing derives from the
    // 690 the document carries NOW — Genin — while peakRank /
    // peakLadderRank keep reporting the historical Chunin.
    world.ranks.push(
      rankDoc('507f1f77bcf86cd7994390a5', 690, {
        stats: {
          totalGames: 12,
          wins: 6,
          losses: 5,
          draws: 1,
          winRate: 0.5,
          peakRP: 900,
          peakTier: 'genin',
        },
      }),
    );
    const service = makeService(world);
    const profile = await service.getRank('507f1f77bcf86cd7994390a5');
    expect(profile.rp).toBe(690);
    expect(profile.ladder).toEqual({
      rank: 'genin',
      index: 3,
      nextRank: 'chunin',
      toNext: 10,
      fraction: 240 / 250,
      peakRank: 'chunin',
    });
    expect(profile.stats.peakRP).toBe(900);
    expect(profile.stats.peakLadderRank).toBe('chunin');
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
      peakLadderRank: 'academy-student',
    });
    expect(profile.ladder).toEqual({
      ...LADDER_0,
      peakRank: 'academy-student',
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
      {
        userId: '507f1f77bcf86cd7994390a4',
        tier: 'academy',
        rp: 100,
        ladder: LADDER_100,
      },
      {
        userId: '507f1f77bcf86cd7994390a1',
        tier: 'genin',
        rp: 900,
        ladder: LADDER_900,
      },
    ]);
    expect(world.createCalls()).toBe(0);
  });

  it('reports the materialised defaults for a player with no rank document — and creates NOTHING', async () => {
    const world = makeWorld();
    const service = makeService(world);
    const res = await service.getPlayerRanks(['507f1f77bcf86cd7994390a1', 'new-player']);
    expect(res.players).toEqual([
      {
        userId: '507f1f77bcf86cd7994390a1',
        tier: 'genin',
        rp: 900,
        ladder: LADDER_900,
      },
      { userId: 'new-player', tier: 'academy', rp: 0, ladder: LADDER_0 },
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
      {
        userId: '507f1f77bcf86cd7994390a2',
        tier: 'genin',
        rp: 500,
        ladder: LADDER_500,
      },
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
        ladder: LADDER_900,
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
      ladder: LADDER_900,
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
/* getLeaderboard('weekly') — the weekly board (fix batch 2026-11-11)  */
/* ------------------------------------------------------------------ */

describe('RankReadService.getLeaderboard — weekly scope', () => {
  const A1 = '507f1f77bcf86cd7994390a1';
  const A2 = '507f1f77bcf86cd7994390a2';
  const A3 = '507f1f77bcf86cd7994390a3'; // rank doc, NO user doc
  const A4 = '507f1f77bcf86cd7994390a4';

  function seedHistory(world: ReturnType<typeof makeWorld>) {
    // "Now" for these fixtures is wherever the real clock sits;
    // this-week rows are stamped relative to the live week start
    // so the suite is clock-independent (weekStartDhaka is pinned
    // separately against fixed instants in ladder-standing.spec).
    const start = weekStartDhaka(new Date());
    const inWeek = (h: number) => new Date(start.getTime() + h * 3_600_000);
    const before = new Date(start.getTime() - 60_000);
    world.history.push(
      { userId: A1, rpChange: 30, playedAt: inWeek(1) },
      { userId: A1, rpChange: 25, playedAt: inWeek(5) }, // A1: +55
      { userId: A2, rpChange: -10, playedAt: inWeek(2) }, // A2: −10 (net-negative week)
      { userId: A3, rpChange: 999, playedAt: inWeek(1) }, // gone user → dropped
      { userId: A4, rpChange: 40, playedAt: before }, // last week — excluded
      { userId: 'ghost-no-rank', rpChange: 70, playedAt: inWeek(3) }, // no user doc → dropped
    );
    return start;
  }

  it('sums this week’s rpChange per user, newest week only, negatives ranked below gainers', async () => {
    const world = makeWorld();
    seedHistory(world);
    const service = makeService(world);
    const res = await service.getLeaderboard('weekly');
    expect(res.meta).toEqual({ source: 'live', computedAt: null });
    expect(res.leaderboard.map((e) => [e.userId, e.rp])).toEqual([
      [A1, 55],
      [A2, -10],
    ]);
  });

  it('dresses rows from the LIFETIME rank doc — the figure is the week, the ladder is lifetime', async () => {
    const world = makeWorld();
    seedHistory(world);
    const service = makeService(world);
    const res = await service.getLeaderboard('weekly');
    // A1's lifetime is 900 RP (Chunin, LADDER_900) though the
    // week's figure is only 55 — the ladder must NOT derive
    // from 55 (that would read Scout).
    expect(res.leaderboard[0]).toEqual({
      userId: A1,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
      rp: 55,
      tier: 'genin',
      division: 3,
      ladder: LADDER_900,
      wins: 6,
      winRate: 0.6,
    });
  });

  it('an unknown scope value is the all-time board (default preserved)', async () => {
    const world = makeWorld();
    seedHistory(world);
    const service = makeService(world);
    const weekly = await service.getLeaderboard('weekly');
    const monthly = await service.getLeaderboard('monthly');
    expect(monthly.leaderboard).not.toEqual(weekly.leaderboard);
    expect(monthly.leaderboard.map((e) => e.rp)).toEqual([900, 500, 100]);
  });

  it('an empty week is an honest empty board', async () => {
    const world = makeWorld();
    const service = makeService(world);
    await expect(service.getLeaderboard('weekly')).resolves.toEqual({
      leaderboard: [],
      meta: { source: 'live', computedAt: null },
    });
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

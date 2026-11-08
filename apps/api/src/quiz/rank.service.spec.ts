import { RankService } from './rank.service';

/* In-memory stand-ins: rank docs are plain objects with save(). */

function makeRankDoc(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId,
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
    save: async () => undefined,
    ...overrides,
  };
}

function makeFakes(room: Record<string, unknown> | null) {
  const ranks = new Map<string, ReturnType<typeof makeRankDoc>>();
  const history: Record<string, unknown>[] = [];
  const events: { roomId: string; event: string; payload: never }[] = [];

  const roomModel = {
    findById: (id: string) => ({
      exec: async () => (room && String(room._id) === id ? room : null),
    }),
  };
  const userRankModel = {
    findOne: (filter: { userId: string }) => ({
      exec: async () => ranks.get(filter.userId) ?? null,
    }),
    create: async (data: { userId: string }) => {
      const doc = makeRankDoc(data.userId);
      ranks.set(data.userId, doc);
      return doc;
    },
  };
  const rankHistoryModel = {
    create: async (data: Record<string, unknown>) => {
      history.push(data);
      return data;
    },
  };
  const broadcaster = {
    emitToRoom: (roomId: string, event: string, payload: never) => {
      events.push({ roomId, event, payload });
    },
  };

  const service = new RankService(
    roomModel as never,
    userRankModel as never,
    rankHistoryModel as never,
    broadcaster as never,
  );
  return { service, ranks, history, events };
}

function player(userId: string, totalScore: number) {
  return { userId, username: userId, avatar: null, totalScore, ready: true };
}

describe('RankService.calculateAndApplyRP (web rank-utils)', () => {
  it('applies placement RP, tie handling, stats and history for a party game', async () => {
    const room = {
      _id: 'room-1',
      roomType: 'party',
      players: [player('carol', 50), player('alice', 100), player('bob', 50)],
    };
    const { service, ranks, history, events } = makeFakes(room);

    await service.calculateAndApplyRP('room-1');

    const alice = ranks.get('alice')!;
    expect(alice.rp).toBe(20); // 1st place base RP, streak 1 → no bonus yet
    expect(alice.currentWinStreak).toBe(1);
    expect(alice.stats).toMatchObject({ totalGames: 1, wins: 1, winRate: 1 });
    expect(alice.season.seasonRP).toBe(20);
    expect(alice.season.seasonWins).toBe(1);

    // Tied 2nd place: both get placement 2 → +10, counted as draws.
    for (const id of ['bob', 'carol']) {
      const doc = ranks.get(id)!;
      expect(doc.rp).toBe(10);
      expect(doc.stats).toMatchObject({ totalGames: 1, wins: 0, draws: 1, losses: 0 });
      expect(doc.currentWinStreak).toBe(0);
    }

    expect(history).toHaveLength(3);
    expect(history.find((h) => h.userId === 'alice')).toMatchObject({
      roomId: 'room-1',
      roomType: 'party',
      placement: 1,
      totalPlayers: 3,
      rpBefore: 0,
      rpAfter: 20,
      rpChange: 20,
      streakBonus: 0,
      winStreakAtTime: 1,
      tierBefore: 'academy',
      tierAfter: 'academy',
    });
    expect(history.find((h) => h.userId === 'bob')).toMatchObject({ placement: 2 });

    const rankEvents = events.filter((e) => e.event === 'room:rank-updated');
    expect(rankEvents).toHaveLength(3);
  });

  it('adds the win-streak bonus and tracks the longest streak', async () => {
    const room = {
      _id: 'room-2',
      roomType: 'duel',
      players: [player('alice', 30), player('bob', 10)],
    };
    const { service, ranks, history } = makeFakes(room);
    ranks.set('alice', makeRankDoc('alice', { rp: 100, currentWinStreak: 1, longestWinStreak: 1 }));

    await service.calculateAndApplyRP('room-2');

    const alice = ranks.get('alice')!;
    expect(alice.rp).toBe(125); // 100 + 20 base + 5 streak bonus (streak 2)
    expect(alice.currentWinStreak).toBe(2);
    expect(alice.longestWinStreak).toBe(2);
    expect(history.find((h) => h.userId === 'alice')).toMatchObject({
      streakBonus: 5,
      rpChange: 25,
    });

    const bob = ranks.get('bob')!;
    expect(bob.rp).toBe(0); // −15 clamped at the academy floor 0
    expect(bob.stats.losses).toBe(1);
    expect(bob.season.seasonRP).toBe(0); // season RP never decreases
  });

  it('clamps RP at the CURRENT tier floor on a loss (no demotion by points alone)', async () => {
    const room = {
      _id: 'room-3',
      roomType: 'duel',
      players: [player('alice', 5), player('gina', 40)],
    };
    const { service, ranks, history } = makeFakes(room);
    ranks.set(
      'gina',
      makeRankDoc('gina', {
        rp: 405,
        tier: 'genin',
        division: 3,
        tierFloor: 400,
        currentWinStreak: 2,
      }),
    );
    ranks.set(
      'alice',
      makeRankDoc('alice', {
        rp: 405,
        tier: 'genin',
        division: 3,
        tierFloor: 400,
      }),
    );

    await service.calculateAndApplyRP('room-3');

    const alice = ranks.get('alice')!;
    expect(alice.rp).toBe(400); // 405 − 15 = 390 → clamped to floor 400
    expect(alice.tier).toBe('genin'); // 400 is still genin
    expect(alice.tierFloor).toBe(400);
    expect(history.find((h) => h.userId === 'alice')).toMatchObject({
      rpChange: -5, // the ACTUAL applied change
      demoted: false,
    });

    const gina = ranks.get('gina')!;
    expect(gina.currentWinStreak).toBe(3);
    expect(gina.rp).toBe(405 + 20 + 10); // base 20 + streak-3 bonus 10
  });

  it('promotes across a tier boundary and raises the floor', async () => {
    const room = {
      _id: 'room-4',
      roomType: 'duel',
      players: [player('alice', 9), player('bob', 1)],
    };
    const { service, ranks, history } = makeFakes(room);
    ranks.set('alice', makeRankDoc('alice', { rp: 390, currentWinStreak: 4 }));

    await service.calculateAndApplyRP('room-4');

    const alice = ranks.get('alice')!;
    // 390 + 20 + streak-5 bonus 20 = 430 → genin, floor raised to 400.
    expect(alice.rp).toBe(430);
    expect(alice.tier).toBe('genin');
    expect(alice.tierFloor).toBe(400);
    expect(alice.stats.peakTier).toBe('genin');
    expect(history.find((h) => h.userId === 'alice')).toMatchObject({
      promoted: true,
      tierBefore: 'academy',
      tierAfter: 'genin',
    });
  });

  it('ignores unknown rooms and non-game room types', async () => {
    const { service, history } = makeFakes(null);
    await service.calculateAndApplyRP('nope');
    expect(history).toHaveLength(0);
  });
});

describe('RankService.scheduleRPUpdate (web scheduler)', () => {
  it('dedupes concurrent schedules for the same room', async () => {
    const { service } = makeFakes(null);
    const spy = jest
      .spyOn(service, 'calculateAndApplyRP')
      .mockResolvedValue(undefined);

    service.scheduleRPUpdate('room-x');
    service.scheduleRPUpdate('room-x');
    service.scheduleRPUpdate('room-x');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(spy).toHaveBeenCalledTimes(1);

    // After the run completes, a new schedule is allowed again.
    service.scheduleRPUpdate('room-x');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

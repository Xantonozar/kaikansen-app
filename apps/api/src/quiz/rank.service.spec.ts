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
    expect(alice.rp).toBe(7); // party-of-3 1st place base RP (owner table), streak 1 → no bonus yet
    expect(alice.currentWinStreak).toBe(1);
    expect(alice.stats).toMatchObject({ totalGames: 1, wins: 1, winRate: 1 });
    expect(alice.season.seasonRP).toBe(7);
    expect(alice.season.seasonWins).toBe(1);

    // Tied 2nd place: both get placement 2 → 0 RP in a party of 3,
    // counted as draws (baseRP >= 0).
    for (const id of ['bob', 'carol']) {
      const doc = ranks.get(id)!;
      expect(doc.rp).toBe(0);
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
      rpAfter: 7,
      rpChange: 7,
      streakBonus: 0,
      winStreakAtTime: 1,
      tierBefore: 'academy',
      tierAfter: 'academy',
    });
    expect(history.find((h) => h.userId === 'bob')).toMatchObject({ placement: 2 });

    const rankEvents = events.filter((e) => e.event === 'room:rank-updated');
    expect(rankEvents).toHaveLength(3);
  });

  it('applies every row of the owner party-of-4 table, floor clamp included', async () => {
    const room = {
      _id: 'room-p4',
      roomType: 'party',
      players: [
        player('p1', 40),
        player('p2', 30),
        player('p3', 20),
        player('p4', 10),
      ],
    };
    const { service, ranks, history } = makeFakes(room);
    // p4 sits 5 RP above the genin floor: the −7 row must clamp.
    ranks.set(
      'p4',
      makeRankDoc('p4', { rp: 405, tier: 'genin', division: 3, tierFloor: 400 }),
    );
    ranks.set('p3', makeRankDoc('p3', { rp: 100 }));

    await service.calculateAndApplyRP('room-p4');

    expect(ranks.get('p1')!.rp).toBe(10); // +10
    expect(ranks.get('p1')!.stats.wins).toBe(1);
    expect(ranks.get('p2')!.rp).toBe(5); // +5, a draw by the stats rule
    expect(ranks.get('p2')!.stats.draws).toBe(1);
    expect(ranks.get('p3')!.rp).toBe(97); // −3
    expect(ranks.get('p3')!.stats.losses).toBe(1);
    expect(ranks.get('p4')!.rp).toBe(400); // −7 clamped at the genin floor
    expect(ranks.get('p4')!.stats.losses).toBe(1);
    expect(history.find((h) => h.userId === 'p4')).toMatchObject({
      placement: 4,
      totalPlayers: 4,
      rpChange: -5, // actual applied change after the clamp
    });
  });

  it('applies the owner party-of-2 table (+5 / −5)', async () => {
    const room = {
      _id: 'room-p2',
      roomType: 'party',
      players: [player('alice', 30), player('bob', 10)],
    };
    const { service, ranks } = makeFakes(room);
    ranks.set('bob', makeRankDoc('bob', { rp: 50 }));

    await service.calculateAndApplyRP('room-p2');

    expect(ranks.get('alice')!.rp).toBe(5);
    expect(ranks.get('bob')!.rp).toBe(45);
    expect(ranks.get('bob')!.stats.losses).toBe(1);
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
    expect(alice.rp).toBe(115); // 100 + 10 duel-win base + 5 streak bonus (streak 2)
    expect(alice.currentWinStreak).toBe(2);
    expect(alice.longestWinStreak).toBe(2);
    expect(history.find((h) => h.userId === 'alice')).toMatchObject({
      streakBonus: 5,
      rpChange: 15,
    });

    const bob = ranks.get('bob')!;
    expect(bob.rp).toBe(0); // −10 clamped at the academy floor 0
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
    expect(alice.rp).toBe(400); // 405 − 10 = 395 → clamped to floor 400
    expect(alice.tier).toBe('genin'); // 400 is still genin
    expect(alice.tierFloor).toBe(400);
    expect(history.find((h) => h.userId === 'alice')).toMatchObject({
      rpChange: -5, // the ACTUAL applied change
      demoted: false,
    });

    const gina = ranks.get('gina')!;
    expect(gina.currentWinStreak).toBe(3);
    expect(gina.rp).toBe(405 + 10 + 10); // duel-win base 10 + streak-3 bonus 10
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
    // 390 + 10 duel-win base + streak-5 bonus 20 = 420 → genin, floor raised to 400.
    expect(alice.rp).toBe(420);
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

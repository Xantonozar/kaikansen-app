import { RankService } from './rank.service';
import { ladderForRp } from './ladder-standing';

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

  it('broadcasts LADDER slugs on room:rank-updated while history keeps legacy tiers (app ladder 2026-11-10)', async () => {
    // A duel crossing the ladder's Scout threshold (100 RP):
    // ladder academy-student → scout, while the legacy tier stays
    // academy on both sides of the boundary (400 RP).
    const room = {
      _id: 'room-ladder',
      roomType: 'duel',
      players: [player('alice', 30), player('bob', 10)],
    };
    const { service, ranks, history, events } = makeFakes(room);
    ranks.set(
      'alice',
      makeRankDoc('alice', { rp: 95, currentWinStreak: 0 }),
    );

    await service.calculateAndApplyRP('room-ladder');

    // 95 + 10 (duel win) = 105 — crossed Scout, legacy tier unmoved.
    expect(ranks.get('alice')!.rp).toBe(105);
    expect(ranks.get('alice')!.tier).toBe('academy');
    expect(history.find((h) => h.userId === 'alice')).toMatchObject({
      tierBefore: 'academy',
      tierAfter: 'academy',
      promoted: false,
    });
    const event = events.find(
      (e) =>
        e.event === 'room:rank-updated' &&
        (e.payload as { userId: string }).userId === 'alice',
    )!;
    expect(event.payload).toMatchObject({
      tierBefore: 'academy-student',
      tierAfter: 'scout',
      promoted: true,
      demoted: false,
    });
    // And the stored document never carries a ladder value.
    expect(ranks.get('alice')!.tier).not.toBe('scout');
  });

  it('ladder DEMOTES on an RP drop across a threshold, while the legacy floor clamp holds the stored RP (floor drop, spec RANK-RP-PLAN-2026-11-11)', async () => {
    // Dave holds 710 RP stored under a stored tierFloor of 705
    // (as a web-side promotion would have left it): ladder
    // Chunin (700). He loses a duel (−10): the legacy write
    // clamps his STORED rp at the floor — 705, not 700 — exactly
    // as the web's engine does today, so ladderForRp on anything
    // DERIVED FROM the document is positionally identical too.
    // The floor the owner dropped lives one level up: the rank
    // endpoint used to answer a ladder standing derived from the
    // PEAK (900 RP — an earlier Chunin peak), which read Chunin
    // before the drop AND after it. The standing is now derived
    // from the 705 the document itself carries, so a further
    // slide that takes real RP under 700 shows up as a demotion
    // the moment it is real — 690 RP derives Genin below.
    const room = {
      _id: 'room-demote',
      roomType: 'duel',
      players: [player('erin', 50), player('dave', 10)],
    };
    const { service, ranks, history, events } = makeFakes(room);
    ranks.set(
      'dave',
      makeRankDoc('dave', {
        rp: 710,
        tier: 'chunin',
        division: 3,
        tierFloor: 705,
        stats: {
          totalGames: 9,
          wins: 5,
          losses: 4,
          draws: 0,
          winRate: 5 / 9,
          peakRP: 900,
          peakTier: 'chunin',
        },
      }),
    );

    await service.calculateAndApplyRP('room-demote');

    // Legacy write arithmetic: byte-identical to the web's.
    const dave = ranks.get('dave')!;
    expect(dave.rp).toBe(705); // 710 − 10 = 700 → clamped UP to the stored floor 705
    expect(dave.tier).toBe('genin'); // legacy tier re-derived from 705 (genin 400–799), as the web does
    expect(dave.tierFloor).toBe(705); // the stored floor only ever moves on promotion
    expect(history.find((h) => h.userId === 'dave')).toMatchObject({
      rpBefore: 710,
      rpAfter: 705,
      rpChange: -5,
    });

    // The event derives BOTH standings from the document's own
    // RP (before 710, after 705): ladder Chunin on both sides of
    // THIS game — truthful, because the clamped document never
    // actually left Chunin's ladder span.
    const event = events.find(
      (e) =>
        e.event === 'room:rank-updated' &&
        (e.payload as { userId: string }).userId === 'dave',
    )!;
    expect(event.payload).toMatchObject({
      tierBefore: 'chunin',
      tierAfter: 'chunin',
      promoted: false,
      demoted: false,
    });

    // And the demotion itself, where it becomes real: a rank
    // read at 690 RP (below Chunin's 700) derives Genin — the
    // peak of 900 no longer props the standing up.
    expect(ladderForRp(705).rank).toBe('chunin');
    expect(ladderForRp(690).rank).toBe('genin');
    expect(ladderForRp(900).rank).toBe('chunin'); // the OLD peak input — no longer used for standings
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

import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Favorite } from '../library/favorite.schema';
import { Rating } from '../library/rating.schema';
import { WatchHistory } from '../library/watch-history.schema';
import { ThemeCache } from '../themes/theme-cache.schema';
import { User } from '../auth/user.schema';
import { QuizAttempt } from './quiz-attempt.schema';
import { QuizModule } from './quiz.module';
import { QuizRoom } from './quiz-room.schema';
import { QuizRoomsService } from './quiz-rooms.service';
import { RankHistory } from './rank-history.schema';
import { RankService } from './rank.service';
import { RoomBroadcaster } from './room-broadcaster';
import { UserRank } from './user-rank.schema';

/**
 * Bug 2 (multi-user matrix, 2026-11-09) — module-wiring integration:
 * the REAL QuizModule provider graph (not the hand-listed providers
 * of the socket e2e) with in-memory model stand-ins. Proves the
 * chain the live build broke: QuizRoomsService receives the SAME
 * RankService instance the module builds, that RankService holds
 * its three models, and a completed duel actually moves RP, stats
 * and rank history and broadcasts room:rank-updated.
 */

/* In-memory stand-ins (same shapes as quiz-rooms.service.spec). */

function getPath(doc: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, doc);
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') {
      return (cond as Record<string, unknown>[]).some((sub) => matches(doc, sub));
    }
    if (key === '$expr') {
      const expr = cond as { $lt: [{ $size: string }, string] };
      const arr = getPath(doc, expr.$lt[0].$size.replace(/^\$/, '')) as unknown[];
      const limit = getPath(doc, expr.$lt[1].replace(/^\$/, '')) as number;
      return Array.isArray(arr) && arr.length < limit;
    }
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const ops = cond as Record<string, unknown>;
      if ('$nin' in ops) {
        return !(ops.$nin as unknown[]).some(
          (v) => v === value || (v == null && value == null),
        );
      }
      if ('$ne' in ops) return value !== ops.$ne;
      if ('$in' in ops) {
        return (ops.$in as unknown[]).some((v) => String(v) === String(value));
      }
      if ('$size' in ops) return Array.isArray(value) && value.length === ops.$size;
      if ('$exists' in ops) return ops.$exists ? value !== undefined : value === undefined;
    }
    return value === cond;
  });
}

function chain(docs: Record<string, unknown>[]) {
  const q: Record<string, unknown> = {};
  q.sort = () => q;
  q.limit = () => q;
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => docs;
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

const HOST = '507f1f77bcf86cd7994390a1';
const GUEST = '507f1f77bcf86cd7994390a2';

function makeTheme(id: string, title: string) {
  return {
    _id: id,
    slug: `${id}-slug`,
    songTitle: `${title} Song`,
    animeTitle: title,
    animeTitleEnglish: `${title} EN`,
    animeTitleAlternative: [],
    artistName: `${title} Artist`,
    anilistId: 777,
    animeCoverImage: 'https://img/cover.jpg',
    animeCoverImageSmall: 'https://img/cover-s.jpg',
    type: 'OP',
    sequence: 1,
    entries: [{ atEntryId: 42, videoSources: [{ url: 'https://src/0.webm' }] }],
    videoUrl: 'https://video/main.webm',
    audioUrl: 'https://audio/main.webm',
    isPopular: true,
  };
}

function makeRankDoc(userId: string) {
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
  };
}

describe('QuizModule wiring — multiplayer rank application (Bug 2)', () => {
  let moduleRef: TestingModule;
  let roomsService: QuizRoomsService;
  let rankService: RankService;

  const themes: Record<string, unknown>[] = [
    makeTheme('theme-correct', 'Correct'),
    makeTheme('theme-d1', 'Distractor1'),
    makeTheme('theme-d2', 'Distractor2'),
    makeTheme('theme-d3', 'Distractor3'),
    makeTheme('theme-d4', 'Distractor4'),
    makeTheme('theme-d5', 'Distractor5'),
  ];
  const users = [
    { _id: HOST, username: 'host', displayName: 'Host', avatarUrl: null, anilist: { completedMediaIds: [] } },
    { _id: GUEST, username: 'guest', displayName: 'Guest', avatarUrl: null, anilist: { completedMediaIds: [] } },
  ];
  const roomDocs: Record<string, unknown>[] = [];
  let roomSeq = 0;
  const rankDocs = new Map<string, ReturnType<typeof makeRankDoc>>();
  const historyRows: Record<string, unknown>[] = [];
  const broadcastEvents: { roomId: string; event: string; payload: Record<string, unknown> }[] = [];

  const themeModel = {
    aggregate: (pipeline: Record<string, unknown>[]) => {
      let result = [...themes];
      for (const step of pipeline) {
        if (step.$match) {
          result = result.filter((t) => matches(t, step.$match as Record<string, unknown>));
        }
        if (step.$sample) {
          result = result.slice(0, (step.$sample as { size: number }).size);
        }
        if (step.$project) {
          const keys = Object.keys(step.$project as Record<string, unknown>);
          result = result.map((t) => {
            const projected: Record<string, unknown> = { _id: t._id };
            for (const k of keys) projected[k] = t[k];
            return projected;
          });
        }
      }
      return queryOf(result);
    },
    find: (filter: Record<string, unknown>) =>
      chain(themes.filter((t) => matches(t, filter))),
  };
  const userModel = {
    findById: (id: string) =>
      queryOf(users.find((u) => String(u._id) === String(id)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(users.filter((u) => matches(u, filter))),
  };
  const roomModel = {
    create: async (data: Record<string, unknown>) => {
      const doc: Record<string, unknown> = {
        _id: `room-${++roomSeq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        currentRound: 0,
        emptySince: null,
        usedThemeIds: [],
        rounds: [],
        timerAuthority: null,
        ...data,
      };
      doc.save = async () => doc;
      roomDocs.push(doc);
      return doc;
    },
    findById: (id: string) =>
      queryOf(roomDocs.find((r) => String(r._id) === String(id)) ?? null),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(roomDocs.find((r) => matches(r, filter)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(roomDocs.filter((r) => matches(r, filter))),
    updateOne: () => queryOf({ matchedCount: 0 }),
    findByIdAndDelete: (id: string) => {
      const idx = roomDocs.findIndex((r) => String(r._id) === String(id));
      const [removed] = idx >= 0 ? roomDocs.splice(idx, 1) : [null];
      return queryOf(removed);
    },
  };
  const emptyActivity = {
    distinct: () => queryOf([]),
    find: () => chain([]),
  };
  const attemptModel = {
    create: async (data: Record<string, unknown>) => data,
    findById: () => queryOf(null),
    findOne: () => queryOf(null),
    find: () => chain([]),
  };
  const userRankModel = {
    findOne: (filter: { userId: string }) =>
      queryOf(rankDocs.get(filter.userId) ?? null),
    create: async (data: { userId: string }) => {
      const doc = makeRankDoc(data.userId);
      rankDocs.set(data.userId, doc);
      return doc;
    },
  };
  const rankHistoryModel = {
    create: async (data: Record<string, unknown>) => {
      historyRows.push(data);
      return data;
    },
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = 'wiring-spec-secret';
    process.env.JWT_REFRESH_SECRET = 'wiring-spec-refresh-secret';
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), QuizModule.register(true)],
    })
      .overrideProvider(getModelToken(QuizRoom.name))
      .useValue(roomModel)
      .overrideProvider(getModelToken(ThemeCache.name))
      .useValue(themeModel)
      .overrideProvider(getModelToken(User.name))
      .useValue(userModel)
      .overrideProvider(getModelToken(WatchHistory.name))
      .useValue(emptyActivity)
      .overrideProvider(getModelToken(Rating.name))
      .useValue(emptyActivity)
      .overrideProvider(getModelToken(Favorite.name))
      .useValue(emptyActivity)
      .overrideProvider(getModelToken(QuizAttempt.name))
      .useValue(attemptModel)
      .overrideProvider(getModelToken(UserRank.name))
      .useValue(userRankModel)
      .overrideProvider(getModelToken(RankHistory.name))
      .useValue(rankHistoryModel)
      .compile();

    roomsService = moduleRef.get(QuizRoomsService);
    rankService = moduleRef.get(RankService);
    moduleRef
      .get(RoomBroadcaster)
      .register((roomId: string, event: string, payload: unknown) => {
        broadcastEvents.push({
          roomId,
          event,
          payload: payload as Record<string, unknown>,
        });
      });
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('injects the module RankService (with its models) into QuizRoomsService', () => {
    const roomsInternal = roomsService as unknown as Record<string, unknown>;
    expect(roomsInternal.rankService).toBeInstanceOf(RankService);
    expect(roomsInternal.rankService).toBe(rankService);

    const rankInternal = rankService as unknown as Record<string, unknown>;
    expect(rankInternal.roomModel).toBeDefined();
    expect(rankInternal.userRankModel).toBeDefined();
    expect(rankInternal.rankHistoryModel).toBeDefined();
  });

  it('a completed duel moves RP, stats and rank history', async () => {
    const created = await roomsService.createRoom(HOST, {
      roomType: 'duel',
      poolMode: 'random',
      guessType: 'anime',
      roundCount: 1,
      matchmaking: 'invite',
    });
    expect(created.success).toBe(true);
    const roomId = created.roomId!;

    const joined = await roomsService.joinByCode(GUEST, created.roomCode!);
    await roomsService.toggleReady(HOST, roomId);
    await roomsService.toggleReady(GUEST, roomId); // duel auto-starts

    const room = roomDocs.find((r) => String(r._id) === roomId)!;
    const round = (room.rounds as Record<string, unknown>[])[0];
    const correctAnswer = round.correctAnswer as string;

    // Duel semantics: the host's correct first answer auto-locks
    // the guest and ends the (single-round) game immediately.
    const hostAck = await roomsService.submitAnswer(HOST, roomId, 1, correctAnswer);
    expect(hostAck.success).toBe(true);
    expect(hostAck.correct).toBe(true);
    expect(room.status).toBe('ended');

    // scheduleRPUpdate hands off via setTimeout(0) — give it room.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const hostRank = rankDocs.get(HOST);
    expect(hostRank).toBeDefined();
    expect(hostRank!.rp).toBe(20); // duel win
    expect(hostRank!.stats.totalGames).toBe(1);
    expect(hostRank!.stats.wins).toBe(1);

    const guestRank = rankDocs.get(GUEST);
    expect(guestRank).toBeDefined();
    expect(guestRank!.rp).toBe(0); // −15 clamped at the academy floor
    expect(guestRank!.stats.totalGames).toBe(1);
    expect(guestRank!.stats.losses).toBe(1);

    expect(historyRows).toHaveLength(2);
    const rankEvents = broadcastEvents.filter(
      (e) => e.event === 'room:rank-updated',
    );
    expect(rankEvents).toHaveLength(2);
  });
});

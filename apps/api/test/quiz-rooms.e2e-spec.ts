import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import { io, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthService } from './../src/auth/auth.service';
import { User } from './../src/auth/user.schema';
import { Favorite } from './../src/library/favorite.schema';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { QuizGateway } from './../src/quiz/quiz.gateway';
import { QuizRoom } from './../src/quiz/quiz-room.schema';
import { QuizRoomsService } from './../src/quiz/quiz-rooms.service';
import { RankHistory } from './../src/quiz/rank-history.schema';
import { RankService } from './../src/quiz/rank.service';
import { RoomBroadcaster } from './../src/quiz/room-broadcaster';
import { UserRank } from './../src/quiz/user-rank.schema';

/**
 * Socket.IO integration (e2e): the REAL gateway + services over a
 * real HTTP server, driven by two real socket.io clients, against
 * in-memory model stand-ins. Covers the full multiplayer loop —
 * handshake auth, create → join → ready → start → answer →
 * round-ended → rank-updated — plus the server-owned round timer.
 */

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

function makeFakeModels() {
  const themes: Record<string, unknown>[] = [
    {
      _id: 'theme-correct',
      slug: 'correct-slug',
      songTitle: 'Correct Song',
      animeTitle: 'Correct',
      animeTitleEnglish: 'Correct EN',
      animeTitleAlternative: [],
      artistName: 'Correct Artist',
      anilistId: 777,
      animeCoverImage: 'https://img/cover.jpg',
      animeCoverImageSmall: null,
      type: 'OP',
      sequence: 1,
      entries: [{ atEntryId: 42, videoSources: [{ url: 'https://src/0.webm' }] }],
      videoUrl: 'https://video/main.webm',
      audioUrl: 'https://audio/main.webm',
      isPopular: true,
    },
    ...[1, 2, 3, 4, 5].map((i) => ({
      _id: `theme-d${i}`,
      slug: `d${i}-slug`,
      songTitle: `Distractor${i} Song`,
      animeTitle: `Distractor${i}`,
      animeTitleEnglish: `Distractor${i} EN`,
      animeTitleAlternative: [],
      artistName: `Distractor${i} Artist`,
      anilistId: 800 + i,
      animeCoverImage: null,
      animeCoverImageSmall: null,
      type: 'OP',
      sequence: 1,
      entries: [{ atEntryId: 50 + i, videoSources: [] }],
      videoUrl: `https://video/d${i}.webm`,
      audioUrl: null,
      isPopular: true,
    })),
  ];
  const users: Record<string, unknown>[] = [
    { _id: HOST, username: 'host', displayName: 'Host', avatarUrl: null, anilist: { completedMediaIds: [] } },
    { _id: GUEST, username: 'guest', displayName: 'Guest', avatarUrl: null, anilist: { completedMediaIds: [] } },
  ];
  const rooms: Record<string, unknown>[] = [];
  let roomSeq = 0;
  const ranks = new Map<string, Record<string, unknown>>();
  const historyRows: Record<string, unknown>[] = [];

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
    docs: rooms,
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
      rooms.push(doc);
      return doc;
    },
    findById: (id: string) =>
      queryOf(rooms.find((r) => String(r._id) === String(id)) ?? null),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(rooms.find((r) => matches(r, filter)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(rooms.filter((r) => matches(r, filter))),
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const room = rooms.find((r) => String(r._id) === String(filter._id));
      const player = room?.players
        ? (room.players as Record<string, unknown>[]).find(
            (p) => p.userId === (filter['players.userId'] as string),
          )
        : undefined;
      if (!room || !player) return queryOf({ matchedCount: 0 });
      player.lastSeenAt = (update.$set as Record<string, unknown>)['players.$.lastSeenAt'];
      return queryOf({ matchedCount: 1 });
    },
    findByIdAndDelete: (id: string) => {
      const idx = rooms.findIndex((r) => String(r._id) === String(id));
      const [removed] = idx >= 0 ? rooms.splice(idx, 1) : [null];
      return queryOf(removed);
    },
  };

  const emptyActivity = {
    distinct: () => queryOf([]),
    find: () => chain([]),
  };

  const userRankModel = {
    findOne: (filter: { userId: string }) =>
      queryOf(ranks.get(filter.userId) ?? null),
    create: async (data: { userId: string }) => {
      const doc: Record<string, unknown> = {
        userId: data.userId,
        rp: 0,
        tier: 'academy',
        division: null,
        tierFloor: 0,
        currentWinStreak: 0,
        longestWinStreak: 0,
        stats: { totalGames: 0, wins: 0, losses: 0, draws: 0, winRate: 0, peakRP: 0, peakTier: 'academy' },
        season: { seasonId: 'all-time', seasonRP: 0, seasonWins: 0, seasonLosses: 0, seasonPlacement: null },
        save: async () => doc,
      };
      ranks.set(data.userId, doc);
      return doc;
    },
  };
  const rankHistoryModel = {
    create: async (data: Record<string, unknown>) => {
      historyRows.push(data);
      return data;
    },
  };

  return {
    themeModel,
    userModel,
    roomModel,
    emptyActivity,
    userRankModel,
    rankHistoryModel,
    rooms,
    ranks,
    historyRows,
  };
}

const E2E_SECRET = ['e2e', 'quiz', 'rooms', 'secret'].join('-');
const E2E_REFRESH_SECRET = ['e2e', 'quiz', 'rooms', 'refresh'].join('-');

function tokenFor(userId: string, username: string) {
  return jwt.sign(
    { userId, username, email: `${username}@example.com`, tokenType: 'access' },
    E2E_SECRET,
    { expiresIn: '15m' },
  );
}

function emitAck(
  socket: Socket,
  event: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
    socket.emit(event, payload, (ack: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

function waitFor(
  socket: Socket,
  event: string,
  predicate: (payload: never) => boolean = () => true,
  timeoutMs = 6000,
): Promise<never> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`event timeout: ${event}`));
    }, timeoutMs);
    const handler = (payload: never) => {
      if (predicate(payload)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(payload);
      }
    };
    socket.on(event, handler);
  });
}

describe('Quiz rooms over Socket.IO (e2e)', () => {
  let app: INestApplication;
  let port: number;
  const models = makeFakeModels();
  const clients: Socket[] = [];

  function connect(token: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = E2E_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        QuizGateway,
        QuizRoomsService,
        RankService,
        RoomBroadcaster,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(QuizRoom.name), useValue: models.roomModel },
        { provide: getModelToken(ThemeCache.name), useValue: models.themeModel },
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(WatchHistory.name), useValue: models.emptyActivity },
        { provide: getModelToken(Rating.name), useValue: models.emptyActivity },
        { provide: getModelToken(Favorite.name), useValue: models.emptyActivity },
        { provide: getModelToken(UserRank.name), useValue: models.userRankModel },
        { provide: getModelToken(RankHistory.name), useValue: models.rankHistoryModel },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 30000);

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('disconnects a socket whose handshake token does not verify', async () => {
    const bad = io(`http://127.0.0.1:${port}`, {
      auth: { token: 'not-a-real-token' },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(bad);
    const reason = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 4000);
      const done = (value: string) => {
        clearTimeout(timer);
        resolve(value);
      };
      bad.on('disconnect', (r) => done(r));
      bad.on('connect_error', () => done('connect_error'));
    });
    expect(['io server disconnect', 'connect_error']).toContain(reason);
  }, 10000);

  it('plays a full game: create → join → ready → start → answer → ended → rank-updated', async () => {
    const host = await connect(tokenFor(HOST, 'host'));
    const guest = await connect(tokenFor(GUEST, 'guest'));

    const joinedPromise = waitFor(host, 'room:player-joined');
    const created = await emitAck(host, 'room:create', {
      roomType: 'party',
      poolMode: 'random',
      guessType: 'anime',
      roundCount: 1,
      matchmaking: 'invite',
    });
    expect(created.success).toBe(true);
    const roomId = created.roomId as string;
    const roomCode = created.roomCode as string;

    const joined = await emitAck(guest, 'room:join', { roomCode });
    expect(joined.success).toBe(true);
    expect((joined.room as Record<string, unknown>).players).toHaveLength(2);
    await joinedPromise; // host saw the join broadcast

    await emitAck(host, 'room:ready', { roomId });
    await emitAck(guest, 'room:ready', { roomId });

    // Only the host may start.
    const guestStart = await emitAck(guest, 'room:start', { roomId });
    expect(guestStart).toMatchObject({
      success: false,
      error: 'Only the host can start the room',
    });

    const hostRoundStarted = waitFor(host, 'room:round-started');
    const guestRoundStarted = waitFor(guest, 'room:round-started');
    const started = await emitAck(host, 'room:start', { roomId });
    expect(started.success).toBe(true);

    const startPayload = (await guestRoundStarted) as unknown as Record<string, unknown>;
    await hostRoundStarted;
    expect(startPayload.round).toBe(1);
    const theme = startPayload.theme as Record<string, unknown>;
    expect(theme.videoUrl).toBe('https://video/main.webm');
    expect(theme.options).toContain('Correct EN');
    expect(JSON.stringify(startPayload)).not.toContain('correctAnswer');

    // Guest answers correctly and instantly; the host (last
    // remaining player in a party) is auto-locked and the game ends.
    const guestEnded = waitFor(guest, 'room:round-ended');
    // rank-updated is broadcast per player to the whole room —
    // each socket sees both, so wait for the matching userId.
    const hostRank = waitFor(
      host,
      'room:rank-updated',
      (p: never) => (p as Record<string, unknown>).userId === HOST,
    );
    const guestRank = waitFor(
      guest,
      'room:rank-updated',
      (p: never) => (p as Record<string, unknown>).userId === GUEST,
    );
    const answerAck = await emitAck(guest, 'room:answer', {
      roomId,
      roundNumber: 1,
      submittedAnswer: 'Correct EN',
    });
    expect(answerAck.success).toBe(true);
    expect(answerAck.correct).toBe(true);
    expect(answerAck.bonusScore).toBe(20); // first correct, 10 × 2 players
    expect(answerAck.baseScore as number).toBeGreaterThanOrEqual(28);

    const ended = (await guestEnded) as unknown as Record<string, unknown>;
    expect(ended.gameOver).toBe(true);
    expect(ended.correctAnswer).toBe('Correct EN');
    const answers = ended.answers as Record<string, unknown>[];
    expect(answers.find((a) => a.userId === HOST)).toMatchObject({ autoLocked: true });

    // Rank maintenance ran and broadcast per player.
    const guestRankPayload = (await guestRank) as unknown as Record<string, unknown>;
    expect(guestRankPayload).toMatchObject({ userId: GUEST, rpAfter: 20, rpChange: 20 });
    const hostRankPayload = (await hostRank) as unknown as Record<string, unknown>;
    expect(hostRankPayload).toMatchObject({ userId: HOST, rpAfter: 10 }); // party 2nd place
    expect(models.historyRows).toHaveLength(2);
  }, 20000);

  it('server timer ends an unanswered round on its own', async () => {
    const host = await connect(tokenFor(HOST, 'host'));
    const guest = await connect(tokenFor(GUEST, 'guest'));

    const created = await emitAck(host, 'room:create', {
      roomType: 'party',
      poolMode: 'random',
      guessType: 'anime',
      roundCount: 1,
      matchmaking: 'invite',
    });
    const roomId = created.roomId as string;
    await emitAck(guest, 'room:join', { roomCode: created.roomCode });

    const settings = await emitAck(host, 'room:update-settings', {
      roomId,
      settings: { timeLimitSeconds: 1 },
    });
    expect(settings.success).toBe(true);
    expect((settings.settings as Record<string, unknown>).timeLimitSeconds).toBe(1);

    await emitAck(host, 'room:ready', { roomId });
    await emitAck(guest, 'room:ready', { roomId });

    const endedPromise = waitFor(guest, 'room:round-ended', () => true, 8000);
    const started = await emitAck(host, 'room:start', { roomId });
    expect(started.success).toBe(true);

    const ended = (await endedPromise) as unknown as Record<string, unknown>;
    expect(ended.gameOver).toBe(true);
    const answers = ended.answers as Record<string, unknown>[];
    expect(answers).toHaveLength(2);
    expect(answers.every((a) => a.autoLocked === true)).toBe(true);
  }, 20000);
});

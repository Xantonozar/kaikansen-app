import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthService } from './../src/auth/auth.service';
import { User } from './../src/auth/user.schema';
import { UserRank } from './../src/quiz/user-rank.schema';
import { LeaderboardSnapshot } from './../src/rank/leaderboard-snapshot.schema';
import { RankController } from './../src/rank/rank.controller';
import { RankReadService } from './../src/rank/rank-read.service';

/**
 * Suite 1 — the real AppModule with NO MONGODB_URI: the rank reads
 * answer 503, and /rank/me rejects tokenless requests with 401
 * first (the guard needs no database).
 */
describe('Rank without a database (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const validToken = () =>
    jwt.sign(
      {
        userId: 'ghost-user',
        username: 'ghost',
        email: 'ghost@example.com',
        tokenType: 'access',
      },
      'fallback-secret-change-me',
      { expiresIn: '15m' },
    );

  it('answers 503 on the public rank reads', async () => {
    const http = request(app.getHttpServer());
    await http.get('/rank/leaderboard').expect(503);
    await http.get('/rank/some-user-id').expect(503);
  });

  it('rejects tokenless /rank/me with 401, then 503s with a token', async () => {
    const http = request(app.getHttpServer());
    await http.get('/rank/me').expect(401);
    await http
      .get('/rank/me')
      .set('Authorization', `Bearer ${validToken()}`)
      .expect(503);
  });
});

/* ------------------------------------------------------------------ */

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

const T0 = Date.parse('2026-11-07T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function makeFakeModels() {
  const ranks: Record<string, unknown>[] = [
    {
      _id: 'rank-alice-id',
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
      createdAt: at(0),
      updatedAt: at(10),
    },
    {
      _id: 'rank-bob-id',
      userId: 'bob-id',
      rp: 100,
      tier: 'academy',
      division: null,
      tierFloor: 0,
      currentWinStreak: 0,
      longestWinStreak: 2,
      stats: {
        totalGames: 4,
        wins: 1,
        losses: 3,
        draws: 0,
        winRate: 0.25,
        peakRP: 100,
        peakTier: 'academy',
      },
      season: {
        seasonId: 'all-time',
        seasonRP: 100,
        seasonWins: 1,
        seasonLosses: 3,
        seasonPlacement: null,
      },
      createdAt: at(0),
      updatedAt: at(10),
    },
  ];
  const users: Record<string, unknown>[] = [
    {
      _id: 'alice-id',
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
    },
    { _id: 'bob-id', username: 'bob', displayName: 'Bob B', avatarUrl: null },
  ];
  const snapshots: Record<string, unknown>[] = [];

  return {
    ranks,
    snapshots,
    userRankModel: {
      findOne: (filter: Record<string, unknown>) =>
        queryOf(ranks.find((r) => matches(r, filter)) ?? null),
      find: (filter: Record<string, unknown>) =>
        chain(ranks.filter((r) => matches(r, filter))),
      create: async (data: Record<string, unknown>) => {
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
    },
    snapshotModel: {
      findOne: (filter: Record<string, unknown>) =>
        queryOf(snapshots.find((s) => matches(s, filter)) ?? null),
    },
    userModel: {
      find: (filter: Record<string, unknown>) =>
        chain(users.filter((u) => matches(u, filter))),
    },
  };
}

/**
 * Suite 2 — the rank controller wired to mocked models, over real
 * HTTP: the public rank read (incl. the web's find-or-create), the
 * guarded /rank/me, and the leaderboard on both its paths.
 */
describe('Rank with mocked models (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();
  const E2E_SECRET = 's6-rank-e2e-secret';

  const tokenFor = (userId: string) =>
    jwt.sign(
      { userId, username: userId, email: `${userId}@example.com`, tokenType: 'access' },
      E2E_SECRET,
      { expiresIn: '15m' },
    );

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = 's6-rank-e2e-refresh-secret';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [RankController],
      providers: [
        RankReadService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        {
          provide: getModelToken(UserRank.name),
          useValue: models.userRankModel,
        },
        {
          provide: getModelToken(LeaderboardSnapshot.name),
          useValue: models.snapshotModel,
        },
        { provide: getModelToken(User.name), useValue: models.userModel },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('serves an existing rank publicly, in the projected shape', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/rank/alice-id').expect(200);
    expect(res.body).toEqual({
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

  it('creates the default rank for an unseen userId (the web’s getUserRank write)', async () => {
    const http = request(app.getHttpServer());
    const before = models.ranks.length;
    const res = await http.get('/rank/brand-new-id').expect(200);
    expect(res.body).toMatchObject({
      userId: 'brand-new-id',
      rp: 0,
      tier: 'academy',
      division: null,
    });
    expect(models.ranks).toHaveLength(before + 1);
    // And it persists: the leaderboard live path now includes the row
    // only if its user existed — it does not, so the board is unchanged.
    const board = await http.get('/rank/leaderboard').expect(200);
    expect(board.body.leaderboard.map((e: { userId: string }) => e.userId)).toEqual([
      'alice-id',
      'bob-id',
    ]);
  });

  it('serves /rank/me only to the bearer of a token, for the caller’s own id', async () => {
    const http = request(app.getHttpServer());
    await http.get('/rank/me').expect(401);
    const res = await http
      .get('/rank/me')
      .set('Authorization', `Bearer ${tokenFor('bob-id')}`)
      .expect(200);
    expect(res.body.userId).toBe('bob-id');
    expect(res.body.rp).toBe(100);
  });

  it('serves the leaderboard live, and /rank/leaderboard is not swallowed by :userId', async () => {
    const http = request(app.getHttpServer());
    const res = await http.get('/rank/leaderboard').expect(200);
    expect(res.body.meta).toEqual({ source: 'live', computedAt: null });
    expect(res.body.leaderboard[0]).toEqual({
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

  it('prefers a fresh snapshot over the live aggregation', async () => {
    const http = request(app.getHttpServer());
    models.snapshots.push({
      _id: 'snap-1',
      scope: 'global',
      seasonId: 'all-time',
      computedAt: new Date(),
      entries: [
        {
          rank: 1,
          userId: 'alice-id',
          username: 'alice',
          avatar: 'https://example.com/alice.png',
          tier: 'genin',
          division: 3,
          rp: 950,
          wins: 7,
          winRate: 0.7,
          currentWinStreak: 2,
        },
      ],
    });
    const res = await http.get('/rank/leaderboard').expect(200);
    expect(res.body.meta.source).toBe('snapshot');
    expect(res.body.meta.computedAt).not.toBeNull();
    expect(res.body.leaderboard).toEqual([
      {
        userId: 'alice-id',
        username: 'alice',
        displayName: 'alice',
        avatarUrl: 'https://example.com/alice.png',
        rp: 950,
        tier: 'genin',
        division: 3,
        wins: 7,
        winRate: 0.7,
      },
    ]);
  });
});

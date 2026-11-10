import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { User } from './../src/auth/user.schema';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { Follow } from './../src/social/follow.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { CountersController } from './../src/users/counters.controller';
import { CountersService } from './../src/users/counters.service';

/**
 * POST /internal/users/recount-counters over real HTTP (audit
 * S3 repair path): the SyncSecretGuard gate (wrong/missing
 * secret → 401) and a drifted user's counters corrected in the
 * store. In-memory fakes; the guard's ConfigService is stubbed
 * with the test secret.
 */

const SECRET = 'counters-e2e-secret';
const USER = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390b2';

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
  return Object.entries(filter).every(([key, condition]) =>
    valueEquals(doc[key], condition),
  );
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

function makeFakeModels() {
  const users: Record<string, unknown>[] = [
    {
      _id: USER,
      username: 'drifty',
      totalFollowers: 99,
      totalFollowing: 98,
      totalRatings: 42,
      totalTime: 7,
    },
  ];
  const follows: Record<string, unknown>[] = [
    { followerId: OTHER, followeeId: USER },
    { followerId: USER, followeeId: OTHER },
  ];
  const ratings: Record<string, unknown>[] = [
    { userId: USER, themeId: '507f1f77bcf86cd799439011', score: 9 },
  ];
  const history: Record<string, unknown>[] = [];
  const themes: Record<string, unknown>[] = [];

  const modelOf = (docs: Record<string, unknown>[]) => ({
    docs,
    find: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(docs.filter((d) => matches(d, filter)).length),
  });

  const userModel = {
    docs: users,
    find: (filter: Record<string, unknown>) =>
      queryOf(users.filter((u) => matches(u, filter))),
    findById: (id: unknown) =>
      queryOf(users.find((u) => valueEquals(u._id, id)) ?? null),
    findByIdAndUpdate: (
      id: unknown,
      update: { $set: Record<string, unknown> },
    ) => {
      const doc = users.find((u) => valueEquals(u._id, id)) ?? null;
      if (doc) Object.assign(doc, update.$set);
      return queryOf(doc);
    },
  };

  return {
    userModel,
    followModel: modelOf(follows),
    ratingModel: modelOf(ratings),
    historyModel: modelOf(history),
    themeModel: modelOf(themes),
  };
}

describe('POST /internal/users/recount-counters (e2e)', () => {
  let app: INestApplication;
  const models = makeFakeModels();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CountersController],
      providers: [
        CountersService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'SYNC_SECRET' ? SECRET : undefined),
          },
        },
        { provide: getModelToken(User.name), useValue: models.userModel },
        { provide: getModelToken(Follow.name), useValue: models.followModel },
        { provide: getModelToken(Rating.name), useValue: models.ratingModel },
        {
          provide: getModelToken(WatchHistory.name),
          useValue: models.historyModel,
        },
        {
          provide: getModelToken(ThemeCache.name),
          useValue: models.themeModel,
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a missing or wrong sync secret with 401', async () => {
    const http = request(app.getHttpServer());
    await http.post('/internal/users/recount-counters').send({}).expect(401);
    await http
      .post('/internal/users/recount-counters')
      .set('x-sync-secret', 'wrong')
      .send({})
      .expect(401);
  });

  it('recounts and corrects the drifted counters', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/users/recount-counters')
      .set('x-sync-secret', SECRET)
      .send({})
      .expect(200);
    expect(res.body.checked).toBe(1);
    expect(res.body.corrected).toBe(1);
    expect(res.body.corrections).toHaveLength(4);
    const stored = models.userModel.docs[0];
    expect(stored.totalFollowers).toBe(1);
    expect(stored.totalFollowing).toBe(1);
    expect(stored.totalRatings).toBe(1);
    expect(stored.totalTime).toBe(0);
  });
});

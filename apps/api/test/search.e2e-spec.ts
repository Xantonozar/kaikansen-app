import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { User } from './../src/auth/user.schema';
import { AnimeCache } from './../src/sync/anime-cache.schema';
import { ArtistCache } from './../src/sync/artist-cache.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { ThemesController } from './../src/themes/themes.controller';
import { ThemesService } from './../src/themes/themes.service';

/**
 * GET /search's users group over real HTTP (owner order
 * 2026-11-10): the controller wired to a filter-applying fake
 * user model and an empty catalogue. The group must behave like
 * the people search it mirrors — public accounts only, every
 * word a substring of the username or the display name — carry
 * only the public projection, cap at the groups' 5, and stay
 * empty under an OP/ED modifier and past page 1.
 */

/* Chainable Mongoose-query stand-in over a fixed result. */
function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.sort = () => q;
  q.skip = () => q;
  q.limit = () => q;
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

/* The small slice of Mongo matching the users-group filter uses:
   equality, $and/$or, and RegExp conditions. */
function matchesValue(docValue: unknown, condition: unknown): boolean {
  if (condition instanceof RegExp) {
    return condition.test(String(docValue ?? ''));
  }
  return docValue === condition;
}

function matches(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') {
      return (condition as Record<string, unknown>[]).every((f) =>
        matches(doc, f),
      );
    }
    if (key === '$or') {
      return (condition as Record<string, unknown>[]).some((f) =>
        matches(doc, f),
      );
    }
    return matchesValue(doc[key], condition);
  });
}

function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, unknown> = {};
  q.sort = () => q;
  q.skip = (n: number) => {
    result = result.slice(n);
    return q;
  };
  q.limit = (n: number) => {
    result = result.slice(0, n);
    return q;
  };
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

const PUBLIC_FIELDS = {
  email: 'someone@example.com',
  passwordHash: 'never-served',
  anilist: { accessToken: 'anilist-secret-token' },
};

const userDocs: Record<string, unknown>[] = [
  {
    _id: '507f1f77bcf86cd7994390a1',
    username: 'alice',
    displayName: 'Alice A',
    avatarUrl: 'https://example.com/alice.png',
    bio: 'Alice bio',
    isPublic: true,
    ...PUBLIC_FIELDS,
  },
  {
    _id: '507f1f77bcf86cd7994390b2',
    username: 'bob',
    displayName: 'Robert Singer',
    avatarUrl: null,
    bio: '',
    isPublic: true,
    ...PUBLIC_FIELDS,
  },
  {
    _id: '507f1f77bcf86cd7994390c3',
    username: 'carol',
    displayName: 'Carol C',
    avatarUrl: null,
    bio: 'Carol bio',
    isPublic: false,
    ...PUBLIC_FIELDS,
  },
  // Seven public "fan" accounts: one more than the group cap + 2,
  // so the cap test sees the slice, not the whole match set.
  ...Array.from({ length: 7 }, (_, i) => ({
    _id: `507f1f77bcf86cd7994390f${i + 1}`,
    username: `fan${i + 1}`,
    displayName: `Fan Number ${i + 1}`,
    avatarUrl: null,
    bio: '',
    isPublic: true,
    ...PUBLIC_FIELDS,
  })),
];

describe('GET /search — users group (e2e)', () => {
  let app: INestApplication;

  const themeModel = {
    find: () => queryOf([]),
    countDocuments: () => queryOf(0),
  };
  const userModel = {
    find: (filter: Record<string, unknown>) =>
      chain(userDocs.filter((u) => matches(u, filter))),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ThemesController],
      providers: [
        ThemesService,
        { provide: getModelToken(ThemeCache.name), useValue: themeModel },
        {
          provide: getModelToken(AnimeCache.name),
          useValue: { find: () => queryOf([]) },
        },
        {
          provide: getModelToken(ArtistCache.name),
          useValue: { find: () => queryOf([]) },
        },
        { provide: getModelToken(User.name), useValue: userModel },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('matches by username and serves only the public projection', async () => {
    const res = await request(app.getHttpServer())
      .get('/search?q=ali')
      .expect(200);
    expect(res.body.users).toEqual([
      {
        id: '507f1f77bcf86cd7994390a1',
        username: 'alice',
        displayName: 'Alice A',
        avatarUrl: 'https://example.com/alice.png',
        bio: 'Alice bio',
      },
    ]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('someone@example.com');
    expect(raw).not.toContain('never-served');
    expect(raw).not.toContain('anilist-secret-token');
  });

  it('matches by display name, not only by username', async () => {
    const res = await request(app.getHttpServer())
      .get('/search?q=robert')
      .expect(200);
    expect(
      res.body.users.map((u: { username: string }) => u.username),
    ).toEqual(['bob']);
  });

  it('never lists private accounts', async () => {
    const res = await request(app.getHttpServer())
      .get('/search?q=carol')
      .expect(200);
    expect(res.body.users).toEqual([]);
  });

  it('caps the group at 5, like the other groups', async () => {
    const res = await request(app.getHttpServer())
      .get('/search?q=fan')
      .expect(200);
    expect(res.body.users).toHaveLength(5);
    expect(res.body.users[0].username).toBe('fan1');
  });

  it('stays empty under an OP/ED modifier and past page 1', async () => {
    const http = request(app.getHttpServer());
    const modified = await http.get('/search?q=op%209%20ali').expect(200);
    expect(modified.body.users).toEqual([]);
    const page2 = await http.get('/search?q=ali&page=2').expect(200);
    expect(page2.body.users).toEqual([]);
  });
});

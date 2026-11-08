import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  UserHistoryResponse,
  UserMergedHistoryResponse,
} from '@kaikansen/contracts';
import type { AuthService } from '../auth/auth.service';
import type { AnilistHistoryClient } from './anilist-history.client';
import { UsersService } from './users.service';

/**
 * UsersService unit tests — per-user history + ratings (Slice S6).
 * All four models are in-memory fakes implementing the filter
 * operators the service uses (equality, $in, $ne, $or), and the
 * AniList history client is a stub — no test touches the network.
 */

/* ------------------------------------------------------------------ */
/* Filter matching — the subset of Mongo semantics the service uses.   */
/* ------------------------------------------------------------------ */

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (typeof a === 'object' || typeof b === 'object') {
    return String(a) === String(b);
  }
  return false;
}

function fieldMatches(docValue: unknown, condition: unknown): boolean {
  if (
    condition !== null &&
    typeof condition === 'object' &&
    !(condition instanceof Date)
  ) {
    const c = condition as Record<string, unknown>;
    if ('$in' in c) {
      return (c.$in as unknown[]).some((v) => valueEquals(docValue, v));
    }
    if ('$ne' in c) {
      return !valueEquals(docValue, c.$ne);
    }
    return valueEquals(docValue, condition);
  }
  return valueEquals(docValue, condition);
}

function matches(
  doc: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') {
      return (condition as Record<string, unknown>[]).some((f) =>
        matches(doc, f),
      );
    }
    return fieldMatches(doc[key], condition);
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

const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390b2';
const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';
const THEME_C = '507f1f77bcf86cd799439013';
const GONE_THEME = '507f1f77bcf86cd799439099';

const T0 = Date.parse('2026-11-07T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function themeDoc(
  id: string,
  slug: string,
  songTitle: string,
  animeTitle: string,
  anilistId: number | null,
  audioUrl: string | null,
) {
  return {
    _id: id,
    slug,
    songTitle,
    animeTitle,
    animeTitleEnglish: `${animeTitle} EN`,
    artistName: 'Artist',
    allArtists: ['Artist'],
    type: 'OP',
    sequence: 1,
    animeSeason: 'SPRING',
    animeSeasonYear: 2026,
    animeCoverImage: `https://example.com/${slug}.jpg`,
    animeCoverImageSmall: `https://example.com/${slug}-small.jpg`,
    anilistId,
    audioUrl,
    avgRating: 8,
    totalRatings: 3,
    totalWatches: 10,
    totalListens: 4,
    isPopular: false,
    popularRank: null,
  };
}

function makeWorld() {
  const users: Record<string, unknown>[] = [
    {
      _id: ALICE,
      username: 'alice',
      displayName: 'Alice A',
      anilist: {
        accessToken: 'alice-anilist-token',
        userId: 42,
        username: 'AliceAni',
        completedMediaIds: [777],
      },
    },
    { _id: BOB, username: 'bob', displayName: 'Bob B' },
  ];
  const themes: Record<string, unknown>[] = [
    themeDoc(THEME_A, 'anime_a-op1-1', 'Song A', 'Anime A', 21, 'a.mp3'),
    themeDoc(THEME_B, 'anime_b-op1-2', 'Song B', 'Anime B', 22, 'b.mp3'),
    themeDoc(THEME_C, 'anime_c-op1-3', 'Song C', 'Anime C', 777, 'c.mp3'),
    themeDoc('507f1f77bcf86cd799439014', 'anime_d-op1-4', 'Song D', 'Anime D', 23, null),
  ];
  const ratings: Record<string, unknown>[] = [
    {
      _id: 'r1',
      userId: ALICE,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      score: 9,
      mode: 'watch',
      createdAt: at(100),
      updatedAt: at(100),
    },
    {
      _id: 'r2',
      userId: ALICE,
      themeId: THEME_B,
      themeSlug: 'anime_b-op1-2',
      score: 7,
      mode: 'listen',
      createdAt: at(300),
      updatedAt: at(300),
    },
    {
      _id: 'r3',
      userId: ALICE,
      themeId: GONE_THEME,
      themeSlug: 'gone-op1-9',
      score: 5,
      mode: 'watch',
      createdAt: at(200),
      updatedAt: at(200),
    },
    {
      _id: 'r4',
      userId: BOB,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      score: 1,
      mode: 'watch',
      createdAt: at(400),
      updatedAt: at(400),
    },
  ];
  const history: Record<string, unknown>[] = [
    {
      _id: 'h1',
      userId: ALICE,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 11,
      mode: 'watch',
      viewedAt: at(100),
    },
    {
      _id: 'h2',
      userId: ALICE,
      themeId: THEME_B,
      themeSlug: 'anime_b-op1-2',
      atEntryId: null,
      mode: 'listen',
      viewedAt: at(300),
    },
    {
      _id: 'h3',
      userId: ALICE,
      themeId: GONE_THEME,
      themeSlug: 'gone-op1-9',
      atEntryId: null,
      mode: 'watch',
      viewedAt: at(200),
    },
  ];

  const userModel = {
    findOne: (filter: Record<string, unknown>) =>
      queryOf(users.find((u) => matches(u, filter)) ?? null),
  };
  const ratingModel = {
    find: (filter: Record<string, unknown>) =>
      chain(ratings.filter((r) => matches(r, filter))),
  };
  const historyModel = {
    find: (filter: Record<string, unknown>) =>
      chain(history.filter((h) => matches(h, filter))),
    distinct: (field: string, filter: Record<string, unknown>) =>
      queryOf([
        ...new Set(
          history
            .filter((h) => matches(h, filter))
            .map((h) => h[field] as unknown),
        ),
      ]),
  };
  const themeModel = {
    find: (filter: Record<string, unknown>) =>
      chain(themes.filter((t) => matches(t, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(themes.filter((t) => matches(t, filter)).length),
  };

  return { users, themes, ratings, history, userModel, ratingModel, historyModel, themeModel };
}

const authStub = {
  verifyAccessToken: (token: string) => {
    if (token === 'alice-token') return { userId: ALICE };
    if (token === 'bob-token') return { userId: BOB };
    return null;
  },
} as unknown as AuthService;

function makeService(
  world: ReturnType<typeof makeWorld>,
  anilist?: Partial<AnilistHistoryClient>,
) {
  return new UsersService(
    authStub,
    (anilist ?? {
      fetchCompletedEntries: async () => [],
    }) as AnilistHistoryClient,
    world.userModel as never,
    world.ratingModel as never,
    world.historyModel as never,
    world.themeModel as never,
  );
}

/* ------------------------------------------------------------------ */
/* Ratings                                                             */
/* ------------------------------------------------------------------ */

describe('UsersService.getRatings', () => {
  it('404s an unknown username', async () => {
    const service = makeService(makeWorld());
    await expect(service.getRatings('nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('serves the user’s ratings newest first with themes joined and a null for a gone theme', async () => {
    const service = makeService(makeWorld());
    const res = await service.getRatings('ALICE'); // web lower-cases
    expect(res.ratings.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
    expect(res.ratings[0]).toMatchObject({
      themeSlug: 'anime_b-op1-2',
      score: 7,
      mode: 'listen',
      createdAt: at(300).toISOString(),
    });
    expect(res.ratings[0].theme?.slug).toBe('anime_b-op1-2');
    expect(res.ratings[1].theme).toBeNull();
  });

  it('caps at the web’s 50 most recent', async () => {
    const world = makeWorld();
    for (let i = 0; i < 55; i++) {
      world.ratings.push({
        _id: `rx${i}`,
        userId: BOB,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        score: 6,
        mode: 'watch',
        createdAt: at(1000 + i),
        updatedAt: at(1000 + i),
      });
    }
    const service = makeService(world);
    const res = await service.getRatings('bob');
    expect(res.ratings).toHaveLength(50);
    expect(res.ratings[0].createdAt).toBe(at(1000 + 54).toISOString());
  });
});

/* ------------------------------------------------------------------ */
/* History — default mode                                              */
/* ------------------------------------------------------------------ */

describe('UsersService.getHistory (default mode)', () => {
  it('404s an unknown username in both modes', async () => {
    const service = makeService(makeWorld());
    await expect(
      service.getHistory(undefined, 'nobody'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.getHistory(undefined, 'nobody', '1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is public: anonymous callers get the rows, newest first, with the web’s meta', async () => {
    const service = makeService(makeWorld());
    const raw = await service.getHistory(undefined, 'alice');
    if (raw.meta.merged) throw new Error('expected default mode');
    const res = raw as UserHistoryResponse;
    expect(res.entries.map((e) => e.id)).toEqual(['h2', 'h3', 'h1']);
    expect(res.meta).toEqual({
      total: 3,
      localCount: 3,
      remoteCount: 0,
      merged: false,
    });
    expect(res.entries[0]).toMatchObject({
      themeSlug: 'anime_b-op1-2',
      mode: 'listen',
      atEntryId: null,
      viewedAt: at(300).toISOString(),
    });
    expect(res.entries[0].theme?.slug).toBe('anime_b-op1-2');
    expect(res.entries[1].theme).toBeNull(); // gone theme stays a row here
  });

  it('caps at the web’s 50 most recent', async () => {
    const world = makeWorld();
    for (let i = 0; i < 55; i++) {
      world.history.push({
        _id: `hx${i}`,
        userId: BOB,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        atEntryId: null,
        mode: 'watch',
        viewedAt: at(1000 + i),
      });
    }
    const service = makeService(world);
    const raw = await service.getHistory(undefined, 'bob');
    if (raw.meta.merged) throw new Error('expected default mode');
    const res = raw as UserHistoryResponse;
    expect(res.entries).toHaveLength(50);
    expect(res.entries[0].viewedAt).toBe(at(1000 + 54).toISOString());
  });
});

/* ------------------------------------------------------------------ */
/* History — merged mode                                               */
/* ------------------------------------------------------------------ */

describe('UsersService.getHistory (merged mode)', () => {
  it('for a non-owner: no remote fetch, gone-theme rows dropped from localCount, libraryTotal falls back to stored ids', async () => {
    let fetched = false;
    const service = makeService(makeWorld(), {
      fetchCompletedEntries: async () => {
        fetched = true;
        return [];
      },
    });
    const raw = await service.getHistory('Bearer bob-token', 'alice', '1');
    if (!raw.meta.merged) throw new Error('expected merged mode');
    const res = raw as UserMergedHistoryResponse;
    expect(fetched).toBe(false);
    expect(res.meta).toMatchObject({
      total: 2, // h3 dropped (theme gone), h1 + h2 remain
      localCount: 2,
      remoteCount: 0,
      merged: true,
      anilistConnected: true,
      anilistIncluded: false,
      anilistError: null,
    });
    // Local themes A + B (audio) ∪ fallback completed id 777 (theme C, audio) = 3
    expect(res.meta.libraryTotal).toBe(3);
    expect(res.entries.map((e) => e.source)).toEqual(['Local', 'Local']);
  });

  it('for the owner: fetches AniList, dedupes by anime title, local wins, meta reports the fetch', async () => {
    const service = makeService(makeWorld(), {
      fetchCompletedEntries: async (token: string, userId: number) => {
        expect(token).toBe('alice-anilist-token');
        expect(userId).toBe(42);
        return [
          {
            updatedAt: Math.floor(at(500).getTime() / 1000),
            media: {
              id: 21, // matches local theme A by anime title — must be deduped away
              title: { romaji: 'Anime A', english: 'Anime A' },
              coverImage: { large: 'https://example.com/remote-a.jpg' },
              episodes: 12,
            },
          },
          {
            updatedAt: Math.floor(at(400).getTime() / 1000),
            media: {
              id: 99,
              title: { romaji: 'Remote Show', english: 'Remote Show' },
              coverImage: { large: 'https://example.com/remote-99.jpg' },
              episodes: 24,
            },
          },
        ];
      },
    });
    const raw = await service.getHistory('Bearer alice-token', 'alice', '1');
    if (!raw.meta.merged) throw new Error('expected merged mode');
    const res = raw as UserMergedHistoryResponse;
    expect(res.meta).toMatchObject({
      localCount: 2,
      remoteCount: 2,
      anilistConnected: true,
      anilistIncluded: true,
      anilistError: null,
    });
    // Remote 99 (at 400) > local B (at 300) > local A (at 100); id 21 deduped.
    expect(res.entries.map((e) => e.id)).toEqual([99, THEME_B, THEME_A]);
    expect(res.entries[0]).toMatchObject({
      source: 'AniList',
      title: 'Remote Show',
      episodeCount: 24,
      animeTitle: null,
      slug: null,
    });
    expect(res.meta.total).toBe(3);
    // Library: local themes A + B ∪ remote media ids {21, 99} → themes A(21) + B(local) = 2
    expect(res.meta.libraryTotal).toBe(2);
  });

  it('swallows an AniList failure into meta.anilistError (the web’s message)', async () => {
    const service = makeService(makeWorld(), {
      fetchCompletedEntries: async () => {
        throw new Error('AniList request failed with status 500');
      },
    });
    const raw = await service.getHistory('Bearer alice-token', 'alice', '1');
    if (!raw.meta.merged) throw new Error('expected merged mode');
    const res = raw as UserMergedHistoryResponse;
    expect(res.meta.anilistError).toBe(
      'AniList request failed with status 500',
    );
    expect(res.meta.remoteCount).toBe(0);
    expect(res.meta.anilistIncluded).toBe(true); // the web's flag is about attempting, not succeeding
  });

  it('maps an abort to the web’s timeout message', async () => {
    const service = makeService(makeWorld(), {
      fetchCompletedEntries: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    const raw = await service.getHistory('Bearer alice-token', 'alice', '1');
    if (!raw.meta.merged) throw new Error('expected merged mode');
    const res = raw as UserMergedHistoryResponse;
    expect(res.meta.anilistError).toBe('AniList request timed out');
  });

  it('honours ?includeRemote=0 even for the owner', async () => {
    let fetched = false;
    const service = makeService(makeWorld(), {
      fetchCompletedEntries: async () => {
        fetched = true;
        return [];
      },
    });
    const raw = await service.getHistory(
      'Bearer alice-token',
      'alice',
      '1',
      '0',
    );
    if (!raw.meta.merged) throw new Error('expected merged mode');
    const res = raw as UserMergedHistoryResponse;
    expect(fetched).toBe(false);
    expect(res.meta.anilistIncluded).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* No database                                                         */
/* ------------------------------------------------------------------ */

describe('UsersService without models', () => {
  it('answers 503 from every method', async () => {
    const service = new UsersService(
      authStub,
      { fetchCompletedEntries: async () => [] } as AnilistHistoryClient,
    );
    await expect(service.getRatings('alice')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      service.getHistory(undefined, 'alice'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

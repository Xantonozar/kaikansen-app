import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { User } from './../src/auth/user.schema';
import { AnimeCache } from './../src/sync/anime-cache.schema';
import { ArtistCache } from './../src/sync/artist-cache.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { ThemesModule } from './../src/themes/themes.module';
import { ThemesService } from './../src/themes/themes.service';

/**
 * REGRESSION (production hotfix 2026-11-10 ~19:14): live /search
 * answered `searchType: 'atlas'` with ALL groups empty even
 * though NO Atlas Search indexes existed — the readiness probe
 * never engaged in production. The probe param on ThemesService
 * was typed as the SearchReadinessProbe INTERFACE: interfaces
 * have no runtime token, Nest could not resolve it, and the
 * `@Optional()` on the param swallowed the failure, so the
 * module-wired service ran probe-less (the pre-probe "attempt
 * the pipelines, degrade on error" compatibility path). A missing
 * index does not error — Atlas answers EMPTY — so nothing
 * degraded and the empty answer was labelled 'atlas'. Every
 * pre-existing suite missed it because they construct
 * ThemesService positionally (or register it as a bare class
 * provider) instead of through ThemesModule's own provider list.
 *
 * This suite wires the REAL ThemesModule.register(true) provider
 * graph — the same one AppModule imports — overriding ONLY the
 * Mongoose model tokens with fakes. The fake native collections
 * report the cluster's search-index state via listSearchIndexes:
 *
 *  - NO indexes anywhere → search must serve the web-parity
 *    regex path, with real results, labelled 'regex';
 *  - every index READY + queryable → search must serve the
 *    $search pipelines, labelled 'atlas'.
 *
 * Both directions go through Nest DI end to end (module →
 * controller → service → probe). If the probe binding is ever
 * lost again, the first case fails exactly as production did.
 */

/* ------------------------------------------------------------------ */
/* Filter-applying fakes (the slice of Mongo matching search uses).  */
/* ------------------------------------------------------------------ */

function matchesValue(docValue: unknown, condition: unknown): boolean {
  if (condition instanceof RegExp) {
    return condition.test(String(docValue ?? ''));
  }
  if (
    condition !== null &&
    typeof condition === 'object' &&
    '$in' in (condition as Record<string, unknown>)
  ) {
    const list = (condition as { $in: unknown[] }).$in;
    return Array.isArray(docValue)
      ? docValue.some((v) => list.includes(v))
      : list.includes(docValue);
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

function compareForSort(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** find/countDocuments over a doc set, plus the $search facet. */
function makeModel(
  docs: Record<string, unknown>[],
  indexDocs: Record<string, unknown>[],
) {
  const chainFor = (initial: Record<string, unknown>[]) => {
    let result = [...initial];
    const q: Record<string, unknown> = {};
    q.sort = (spec: Record<string, number>) => {
      const entries = Object.entries(spec);
      result = [...result].sort((x, y) => {
        for (const [field, dir] of entries) {
          const c = compareForSort(x[field], y[field]);
          if (c !== 0) return dir < 0 ? -c : c;
        }
        return 0;
      });
      return q;
    };
    q.skip = (n: number) => {
      result = result.slice(n);
      return q;
    };
    q.limit = (n: number) => {
      result = result.slice(0, n);
      return q;
    };
    q.select = () => q;
    q.lean = () => q;
    q.exec = async () => result;
    return q;
  };
  return {
    find: (filter: Record<string, unknown> = {}) =>
      chainFor(docs.filter((d) => matches(d, filter))),
    countDocuments: (filter: Record<string, unknown> = {}) => ({
      exec: async () => docs.filter((d) => matches(d, filter)).length,
    }),
    /**
     * The $search pipeline's observable behaviour against a fake:
     * NO index docs (or none for this index) → Atlas's real
     * answer for a missing index — an EMPTY facet, NOT an error
     * (the trap). A ready index → the matching docs, faceted.
     */
    aggregate: async (stages: Record<string, unknown>[]) => {
      const searchStage = stages[0]?.$search as
        | { index?: string }
        | undefined;
      const ready = indexDocs.some(
        (d) =>
          d.name === searchStage?.index &&
          d.queryable === true &&
          Array.isArray(d.statusHistory) &&
          (d.statusHistory as Array<{ status?: string }>).some(
            (h) => h.status === 'READY',
          ),
      );
      if (!ready) return [{ results: [], total: [] }];
      const words: string[] = [];
      const collect = (node: unknown): void => {
        if (node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        const rec = node as Record<string, unknown>;
        if (typeof rec.query === 'string') {
          words.push(...rec.query.toLowerCase().split(/\s+/));
        }
        Object.values(rec).forEach(collect);
      };
      collect(stages[0]);
      const matched = docs.filter((d) =>
        words.every((w) =>
          Object.values(d).some(
            (v) =>
              typeof v === 'string' &&
              v.toLowerCase().includes(w.toLowerCase()),
          ),
        ),
      );
      return [
        {
          results: matched,
          total: matched.length > 0 ? [{ count: matched.length }] : [],
        },
      ];
    },
    collection: {
      listSearchIndexes: () => ({ toArray: async () => indexDocs }),
      createSearchIndex: async () => {
        throw new Error('createSearchIndex is not used by this suite');
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                          */
/* ------------------------------------------------------------------ */

const themeDoc = {
  _id: '507f1f77bcf86cd7994390aa',
  slug: 'naruto-shippuuden-op16',
  songTitle: 'Silhouette',
  animeTitle: 'Naruto Shippuden',
  animeTitleEnglish: 'Naruto Shippuden',
  artistName: 'KANA-BOON',
  allArtists: ['KANA-BOON'],
  artistSlugs: ['kana-boon'],
  type: 'OP',
  sequence: 16,
  animeSeason: 'SPRING',
  animeSeasonYear: 2014,
  animeCoverImage: null,
  animeCoverImageSmall: null,
  avgRating: 9.1,
  totalRatings: 120,
  totalWatches: 5000,
  totalListens: 3000,
  duration: 89,
  isPopular: true,
  popularRank: 1,
  anilistId: 1735,
};

const animeDoc = {
  _id: '507f1f77bcf86cd7994390bb',
  anilistId: 1735,
  titleRomaji: 'Naruto Shippuuden',
  titleEnglish: 'Naruto Shippuden',
  synonyms: ['Naruto Shippuden'],
  coverImageLarge: null,
  seasonYear: 2007,
};

const artistDoc = {
  _id: '507f1f77bcf86cd7994390cc',
  slug: 'kana-boon',
  // The artist group's $search fields are name + aliases; the
  // query word must appear in one of them (the theme's artist
  // "KANA-BOON" is a different document's field).
  name: 'Naruto Theme Singers',
  aliases: ['KANA-BOON'],
  imageUrl: null,
  totalThemes: 1,
};

const readyIndex = (name: string) => ({
  name,
  queryable: true,
  statusHistory: [{ status: 'READY', date: new Date() }],
});

async function bootApp(
  indexDocsByCollection: Record<'themes' | 'anime' | 'artists', unknown[]>,
): Promise<{ app: INestApplication; moduleFixture: TestingModule }> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [ThemesModule.register(true)],
  })
    .overrideProvider(getModelToken(ThemeCache.name))
    .useValue(
      makeModel([themeDoc], indexDocsByCollection.themes as never[]),
    )
    .overrideProvider(getModelToken(AnimeCache.name))
    .useValue(
      makeModel([animeDoc], indexDocsByCollection.anime as never[]),
    )
    .overrideProvider(getModelToken(ArtistCache.name))
    .useValue(
      makeModel([artistDoc], indexDocsByCollection.artists as never[]),
    )
    .overrideProvider(getModelToken(User.name))
    .useValue(makeModel([], []))
    .compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return { app, moduleFixture };
}

/* ------------------------------------------------------------------ */

describe('GET /search through the real ThemesModule DI graph (e2e)', () => {
  describe('no Atlas Search indexes exist (the production state)', () => {
    let app: INestApplication;
    let moduleFixture: TestingModule;

    beforeAll(async () => {
      ({ app, moduleFixture } = await bootApp({
        themes: [],
        anime: [],
        artists: [],
      }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('the module-wired service HAS the readiness probe injected', () => {
      const service = moduleFixture.get(ThemesService);
      expect(
        (service as unknown as { searchIndexes?: unknown }).searchIndexes,
      ).toBeDefined();
    });

    it('serves real results via regex, honestly labelled', async () => {
      const res = await request(app.getHttpServer())
        .get('/search?q=naruto')
        .expect(200);
      expect(res.body.searchType).toBe('regex');
      expect(res.body.results.map((r: { slug: string }) => r.slug)).toEqual([
        'naruto-shippuuden-op16',
      ]);
      expect(res.body.anime).toHaveLength(1);
      expect(res.body.artists).toHaveLength(1);
    });
  });

  describe('every Atlas Search index is READY', () => {
    let app: INestApplication;

    beforeAll(async () => {
      ({ app } = await bootApp({
        themes: [readyIndex('kaikansen_themes_search')],
        anime: [readyIndex('kaikansen_anime_search')],
        artists: [readyIndex('kaikansen_artists_search')],
      }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('serves the $search pipelines, labelled atlas', async () => {
      const res = await request(app.getHttpServer())
        .get('/search?q=naruto')
        .expect(200);
      expect(res.body.searchType).toBe('atlas');
      expect(res.body.results.map((r: { slug: string }) => r.slug)).toEqual([
        'naruto-shippuuden-op16',
      ]);
      expect(res.body.anime).toHaveLength(1);
      expect(res.body.artists).toHaveLength(1);
    });
  });
});

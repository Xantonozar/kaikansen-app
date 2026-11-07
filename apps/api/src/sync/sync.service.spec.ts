import {
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AnimeThemesClient } from './animethemes.client';
import type { EnrichmentClient } from './enrichment.client';
import { EnrichmentService } from './enrichment.service';
import { parsePopularPairs } from './popular-list';
import { SyncTiming } from './sync.constants';
import { SyncService } from './sync.service';
import type { AniListMedia, AtAnime } from './sync.types';

/* ── Fakes ────────────────────────────────────────────────────────── */

/** Chainable Mongoose-query stand-in, same pattern as the other specs. */
function queryOf(result: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: Record<string, any> = {};
  q.sort = jest.fn(() => q);
  q.skip = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

interface FakeThemeDoc extends Record<string, unknown> {
  _id: string;
  songTitle: string;
  animeTitle: string;
}

/** In-memory stand-in for the ThemeCache model (upserts + popular ops). */
class FakeThemeModel {
  docs: FakeThemeDoc[] = [];
  updateOneCalls: { filter: unknown; update: unknown }[] = [];
  updateManyCalls: { filter: unknown; update: unknown }[] = [];
  findByIdAndUpdateCalls: { id: unknown; update: unknown }[] = [];
  private seq = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateOne(filter: any, update: any, options?: any) {
    this.updateOneCalls.push({ filter, update });
    const idx = this.docs.findIndex(
      (d) => d.animethemesId === filter.animethemesId,
    );
    let upsertedCount = 0;
    if (idx === -1 && options?.upsert) {
      this.docs.push({
        _id: `theme-${++this.seq}`,
        ...update.$set,
      } as FakeThemeDoc);
      upsertedCount = 1;
    } else if (idx >= 0) {
      Object.assign(this.docs[idx], update.$set);
    }
    return queryOf({ acknowledged: true, upsertedCount, matchedCount: idx >= 0 ? 1 : 0 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  find(filter: any) {
    if (filter.$text) return queryOf([]);
    if (filter.$or) {
      const rx = filter.$or[0].animeTitle.$regex as RegExp;
      const out = this.docs.filter(
        (d) =>
          rx.test((d.animeTitle as string) ?? '') ||
          rx.test((d.animeTitleEnglish as string) ?? '') ||
          ((d.animeTitleAlternative as string[]) ?? []).some((t) => rx.test(t)),
      );
      return queryOf(out);
    }
    return queryOf(this.docs);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateMany(filter: any, update: any) {
    this.updateManyCalls.push({ filter, update });
    for (const d of this.docs) Object.assign(d, update);
    return queryOf({ modifiedCount: this.docs.length });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findByIdAndUpdate(id: any, update: any) {
    this.findByIdAndUpdateCalls.push({ id, update });
    const doc = this.docs.find((d) => d._id === id);
    if (doc) Object.assign(doc, update);
    return queryOf(doc ?? null);
  }
}

/** Records updateOne calls (artist + anime cache models). */
class FakeUpsertModel {
  calls: { filter: unknown; update: Record<string, unknown> }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateOne(filter: any, update: any) {
    this.calls.push({ filter, update });
    return queryOf({ acknowledged: true, upsertedCount: 1 });
  }
}

function zeroTiming(): SyncTiming {
  const timing = new SyncTiming();
  timing.atDelayMs = 0;
  timing.anilistDelayMs = 0;
  timing.kitsuDelayMs = 0;
  timing.pageRetryDelayMs = 0;
  return timing;
}

const ANILIST_MEDIA: AniListMedia = {
  id: 777,
  idMal: 123,
  title: { romaji: 'Test Anime', english: 'Test Anime EN', native: 'テスト' },
  synonyms: [],
  season: 'FALL',
  seasonYear: 2026,
  genres: ['Action'],
  episodes: 12,
  status: 'RELEASING',
  averageScore: 81,
  coverImage: { large: 'l', medium: 'm' },
  bannerImage: 'b',
  studios: { nodes: [{ name: 'Studio A' }] },
};

function enrichmentWith(client: Partial<EnrichmentClient>) {
  const full = {
    fetchAniListByMalId: jest.fn(async () => ANILIST_MEDIA),
    fetchAniListByTitle: jest.fn(async () => null),
    fetchKitsuByTitle: jest.fn(async () => null),
    ...client,
  } as unknown as EnrichmentClient & Record<string, jest.Mock>;
  return {
    service: new EnrichmentService(full, zeroTiming()),
    client: full,
  };
}

const ARTIST = {
  id: 7,
  name: 'Artist One',
  slug: 'artist_one',
  as: 'performer',
  aliases: [],
  images: [{ link: 'https://img/artist.jpg' }],
};

function atAnimeWithThemes(): AtAnime {
  return {
    id: 42,
    slug: 'test_anime',
    name: 'Test Anime',
    season: 'fall',
    year: 2026,
    malId: 123,
    images: [{ facet: 'Large Cover', link: 'https://img/large.jpg' }],
    studios: [{ name: 'Studio A' }],
    series: [],
    animethemes: [
      {
        id: 101,
        type: 'OP',
        sequence: 1,
        song: { title: 'Song One', artists: [ARTIST] },
        animethemeentries: [
          {
            id: 1,
            version: 1,
            videos: [{ resolution: 720, link: 'https://cdn/1.webm' }],
          },
        ],
      },
      {
        id: 102,
        type: 'ED',
        sequence: 1,
        song: { title: 'Song Two', artists: [ARTIST] },
        animethemeentries: [
          {
            id: 2,
            version: 1,
            videos: [{ resolution: 720, link: 'https://cdn/2.webm' }],
          },
        ],
      },
    ],
  };
}

function makeService(parts: {
  themeModel?: FakeThemeModel;
  atClient?: Partial<AnimeThemesClient>;
  enrichment?: EnrichmentService;
}) {
  const themeModel = parts.themeModel ?? new FakeThemeModel();
  const animeModel = new FakeUpsertModel();
  const artistModel = new FakeUpsertModel();
  const service = new SyncService(
    themeModel as never,
    animeModel as never,
    artistModel as never,
    parts.atClient as never,
    parts.enrichment as never,
    zeroTiming(),
  );
  return { service, themeModel, animeModel, artistModel };
}

/* ── Themes job ───────────────────────────────────────────────────── */

describe('SyncService themes job', () => {
  it('syncs a year: parses, enriches (cached), upserts themes/artists/anime', async () => {
    const anime = atAnimeWithThemes();
    const atClient = {
      fetchAnimePage: jest.fn(async (page: number) =>
        page === 1 ? { anime: [anime] } : { anime: [] },
      ),
    };
    const { service: enrichment, client } = enrichmentWith({});
    const { service, themeModel, animeModel, artistModel } = makeService({
      atClient,
      enrichment,
    });

    const started = service.startThemesSync(2026);
    expect(started.state).toBe('running');
    expect(started.kind).toBe('themes');
    expect(started.year).toBe(2026);
    await service.currentJob;

    const status = service.getStatus();
    expect(status.state).toBe('completed');
    expect(status.pagesProcessed).toBe(1);
    expect(status.themesProcessed).toBe(2);
    expect(status.themesInserted).toBe(2);
    expect(status.errors).toBe(0);
    expect(status.finishedAt).toBeTruthy();
    expect(status.lastError).toBeNull();

    // Year filter reached the AT client, verbatim.
    expect(atClient.fetchAnimePage).toHaveBeenCalledWith(
      1,
      'filter[anime][year]=2026',
    );

    // Theme docs landed with web-shaped slugs and enriched fields.
    expect(themeModel.docs.map((d) => d.slug).sort()).toEqual([
      'test_anime-ed1-102',
      'test_anime-op1-101',
    ]);
    expect(themeModel.docs[0].anilistId).toBe(777);

    // AniList was queried ONCE for the anime despite its two themes.
    expect(client.fetchAniListByMalId).toHaveBeenCalledTimes(1);

    // Anime cache upserted once per theme, keyed by anilistId.
    expect(animeModel.calls).toHaveLength(2);
    expect(animeModel.calls[0].filter).toEqual({ anilistId: 777 });
    expect(
      (animeModel.calls[0].update.$set as Record<string, unknown>)
        .titleRomaji,
    ).toBe('Test Anime');

    // Deviation (b), insert side: artist $inc present for new themes.
    expect(artistModel.calls).toHaveLength(2);
    for (const call of artistModel.calls) {
      expect(call.update.$inc).toEqual({ totalThemes: 1 });
      expect(
        (call.update.$set as Record<string, unknown>).name,
      ).toBe('Artist One');
    }
  });

  it('re-run inserts nothing and does NOT re-increment artist totalThemes', async () => {
    const atClient = {
      fetchAnimePage: jest.fn(async (page: number) =>
        page === 1 ? { anime: [atAnimeWithThemes()] } : { anime: [] },
      ),
    };
    const { service: enrichment } = enrichmentWith({});
    const { service, artistModel } = makeService({ atClient, enrichment });

    service.startThemesSync(2026);
    await service.currentJob;
    expect(service.getStatus().themesInserted).toBe(2);
    const callsAfterRun1 = artistModel.calls.length;

    service.startThemesSync(2026);
    await service.currentJob;

    const status = service.getStatus();
    expect(status.state).toBe('completed');
    expect(status.themesProcessed).toBe(2);
    expect(status.themesInserted).toBe(0);

    const run2Calls = artistModel.calls.slice(callsAfterRun1);
    expect(run2Calls).toHaveLength(2);
    for (const call of run2Calls) {
      expect(call.update.$inc).toBeUndefined();
      // …but the artist's $set fields are still refreshed.
      expect(call.update.$set).toBeDefined();
    }
  });

  it('rejects a second job while one is running (409, both kinds)', async () => {
    let release!: (v: { anime: AtAnime[] }) => void;
    const gate = new Promise<{ anime: AtAnime[] }>((res) => {
      release = res;
    });
    const atClient = { fetchAnimePage: jest.fn(() => gate) };
    const { service: enrichment } = enrichmentWith({});
    const { service } = makeService({ atClient, enrichment });

    service.startThemesSync(2026);
    expect(service.getStatus().state).toBe('running');
    expect(() => service.startThemesSync(2026)).toThrow(ConflictException);
    expect(() => service.startPopularSync()).toThrow(ConflictException);

    release({ anime: [] });
    await service.currentJob;
    expect(service.getStatus().state).toBe('completed');

    // …and afterwards a new job may start again.
    expect(() => service.startPopularSync()).not.toThrow();
    await service.currentJob;
  });

  it('records and skips a page that fails twice, then carries on', async () => {
    const atClient = {
      fetchAnimePage: jest.fn(async (page: number) => {
        if (page === 1) throw new Error('AT down');
        if (page === 2) return { anime: [atAnimeWithThemes()] };
        return { anime: [] };
      }),
    };
    const { service: enrichment } = enrichmentWith({});
    const { service } = makeService({ atClient, enrichment });

    service.startThemesSync(2026);
    await service.currentJob;

    const status = service.getStatus();
    expect(status.state).toBe('completed');
    expect(status.errors).toBe(1); // page 1, counted once after the retry
    expect(status.pagesProcessed).toBe(1); // only page 2
    expect(status.themesProcessed).toBe(2);
    // Page 1 was attempted exactly twice (initial + one retry).
    expect(
      atClient.fetchAnimePage.mock.calls.filter((c) => c[0] === 1),
    ).toHaveLength(2);
  });

  it('fails the job after 5 consecutive dead pages instead of skipping forever', async () => {
    const atClient = {
      fetchAnimePage: jest.fn(async () => {
        throw new Error('AT down');
      }),
    };
    const { service: enrichment } = enrichmentWith({});
    const { service } = makeService({ atClient, enrichment });

    service.startThemesSync(2026);
    await service.currentJob;

    const status = service.getStatus();
    expect(status.state).toBe('failed');
    expect(status.errors).toBe(5);
    expect(status.lastError).toContain('AnimeThemes unreachable');
    expect(atClient.fetchAnimePage).toHaveBeenCalledTimes(10); // 5 pages × 2 attempts
  });

  it('counts an unparseable theme as an error and keeps going', async () => {
    const broken = atAnimeWithThemes();
    broken.animethemes = [
      ...(broken.animethemes ?? []),
      { id: 999, type: 'OP', sequence: 1, song: { title: 'No Entries' }, animethemeentries: [] },
    ];
    const atClient = {
      fetchAnimePage: jest.fn(async (page: number) =>
        page === 1 ? { anime: [broken] } : { anime: [] },
      ),
    };
    const { service: enrichment } = enrichmentWith({});
    const { service } = makeService({ atClient, enrichment });

    service.startThemesSync(2026);
    await service.currentJob;

    const status = service.getStatus();
    expect(status.state).toBe('completed');
    expect(status.themesProcessed).toBe(2);
    expect(status.errors).toBe(1);
  });

  it('answers 503 on job start when booted without a database', () => {
    const service = new SyncService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      zeroTiming(),
    );
    expect(service.getStatus().state).toBe('idle');
    expect(() => service.startThemesSync(2026)).toThrow(
      ServiceUnavailableException,
    );
    expect(() => service.startPopularSync()).toThrow(
      ServiceUnavailableException,
    );
  });

  it('status carries exactly the documented fields', () => {
    const { service } = makeService({});
    expect(Object.keys(service.getStatus()).sort()).toEqual(
      [
        'errors',
        'finishedAt',
        'kind',
        'lastError',
        'pagesProcessed',
        'startedAt',
        'state',
        'themesInserted',
        'themesProcessed',
        'year',
      ].sort(),
    );
  });
});

/* ── Popular job ──────────────────────────────────────────────────── */

describe('SyncService popular job', () => {
  it('MATCH-FIRST floor: too few matches aborts and leaves every flag untouched', async () => {
    const themeModel = new FakeThemeModel();
    themeModel.docs = [
      {
        _id: 'keep-1',
        songTitle: 'Unravel',
        animeTitle: 'Tokyo Ghoul',
        isPopular: true,
        popularRank: 2,
      } as FakeThemeDoc,
      {
        _id: 'keep-2',
        songTitle: 'Tank!',
        animeTitle: 'Cowboy Bebop',
        isPopular: true,
        popularRank: 4,
      } as FakeThemeDoc,
    ];
    const { service } = makeService({ themeModel });

    service.startPopularSync();
    await service.currentJob;

    const status = service.getStatus();
    expect(status.state).toBe('failed');
    expect(status.kind).toBe('popular');
    expect(status.lastError).toContain('match floor');
    // The reset/apply writes NEVER happened.
    expect(themeModel.updateManyCalls).toHaveLength(0);
    expect(themeModel.findByIdAndUpdateCalls).toHaveLength(0);
    expect(themeModel.docs.map((d) => d.isPopular)).toEqual([true, true]);
    expect(themeModel.docs.map((d) => d.popularRank)).toEqual([2, 4]);
  });

  it('past the floor: resets all flags, then applies matched flags with list ranks', async () => {
    const pairs = parsePopularPairs();
    const themeModel = new FakeThemeModel();
    themeModel.docs = pairs.map(
      (p, i) =>
        ({
          _id: `doc-${i}`,
          songTitle: p.song,
          animeTitle: p.anime,
          animeTitleEnglish: null,
          animeTitleAlternative: [],
          isPopular: false,
          popularRank: null,
        }) as unknown as FakeThemeDoc,
    );
    // A stale flag on a doc that matches nothing must be reset too.
    themeModel.docs.push({
      _id: 'stale',
      songTitle: 'Nothing Real',
      animeTitle: 'Nowhere Land',
      isPopular: true,
      popularRank: 999,
    } as FakeThemeDoc);

    const { service } = makeService({ themeModel });
    service.startPopularSync();
    await service.currentJob;

    const status = service.getStatus();
    expect(status.state).toBe('completed');
    expect(status.themesProcessed).toBe(pairs.length);
    expect(themeModel.updateManyCalls).toHaveLength(1);
    expect(themeModel.findByIdAndUpdateCalls.length).toBeGreaterThanOrEqual(
      100,
    );

    const unravelPair = pairs.find((p) => p.song === 'Unravel');
    const unravelDoc = themeModel.docs.find((d) => d.songTitle === 'Unravel');
    expect(unravelDoc?.isPopular).toBe(true);
    expect(unravelDoc?.popularRank).toBe(unravelPair?.rank);

    const stale = themeModel.docs.find((d) => d._id === 'stale');
    expect(stale?.isPopular).toBe(false);
    expect(stale?.popularRank).toBeNull();
  });
});

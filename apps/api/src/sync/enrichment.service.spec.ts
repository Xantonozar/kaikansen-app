import { EnrichmentClient } from './enrichment.client';
import { EnrichmentService } from './enrichment.service';
import { SyncTiming } from './sync.constants';
import { parseATTheme } from './theme-parser';
import type { AniListMedia, AtAnime, KitsuAnime } from './sync.types';

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
  synonyms: ['Test Anime Alt'],
  season: 'FALL',
  seasonYear: 2026,
  genres: ['Action'],
  episodes: 12,
  status: 'RELEASING',
  averageScore: 81,
  coverImage: {
    large: 'https://al/large.jpg',
    medium: 'https://al/medium.jpg',
  },
  bannerImage: 'https://al/banner.jpg',
  studios: { nodes: [{ name: 'Studio A' }, { name: 'Studio B' }] },
};

const KITSU_ANIME: KitsuAnime = {
  kitsuId: 'k-42',
  titleEnglish: 'Kitsu Title EN',
  titleJapanese: 'キツネ',
  season: 'SUMMER',
  seasonYear: 2025,
  posterImage: 'https://kitsu/poster.jpg',
  coverImage: 'https://kitsu/cover.jpg',
};

function makeClient(overrides: Partial<EnrichmentClient>) {
  return {
    fetchAniListByMalId: jest.fn(async () => null),
    fetchAniListByTitle: jest.fn(async () => null),
    fetchKitsuByTitle: jest.fn(async () => null),
    ...overrides,
  } as unknown as EnrichmentClient &
    Record<string, jest.Mock>;
}

const AT_ANIME: AtAnime = {
  id: 42,
  slug: 'test_anime',
  name: 'Test Anime',
  season: 'fall',
  year: 2026,
  malId: 123,
  images: [],
  studios: [{ name: 'Studio A' }],
  series: [],
};

function parsedTheme(title: string) {
  const theme = parseATTheme({
    id: Math.floor(Math.random() * 100000) + 1,
    type: 'OP',
    sequence: 1,
    song: { title, artists: [] },
    animethemeentries: [
      {
        id: 1,
        version: 1,
        videos: [{ resolution: 720, link: 'https://cdn/x.webm' }],
      },
    ],
    anime: AT_ANIME,
  });
  if (!theme) throw new Error('fixture theme failed to parse');
  return theme;
}

describe('EnrichmentService', () => {
  it('caches per anime: two themes of one anime cost ONE AniList lookup', async () => {
    const client = makeClient({
      fetchAniListByMalId: jest.fn(async () => ANILIST_MEDIA),
    });
    const service = new EnrichmentService(client, zeroTiming());
    const cache = service.createCache();

    const first = await service.enrichTheme(
      parsedTheme('Song One'),
      AT_ANIME,
      cache,
    );
    const second = await service.enrichTheme(
      parsedTheme('Song Two'),
      AT_ANIME,
      cache,
    );

    expect(client.fetchAniListByMalId).toHaveBeenCalledTimes(1);
    expect(client.fetchAniListByTitle).not.toHaveBeenCalled();
    expect(client.fetchKitsuByTitle).not.toHaveBeenCalled();
    expect(first.anilistId).toBe(777);
    expect(second.anilistId).toBe(777);
    // Per-theme derivations still run per theme (mood from the song title).
    expect(first.songTitle).toBe('Song One');
    expect(second.songTitle).toBe('Song Two');
  });

  it('a fresh cache (a new run) looks the anime up again', async () => {
    const client = makeClient({
      fetchAniListByMalId: jest.fn(async () => ANILIST_MEDIA),
    });
    const service = new EnrichmentService(client, zeroTiming());

    await service.enrichTheme(parsedTheme('S'), AT_ANIME, service.createCache());
    await service.enrichTheme(parsedTheme('S'), AT_ANIME, service.createCache());

    expect(client.fetchAniListByMalId).toHaveBeenCalledTimes(2);
  });

  it('falls back malId → title → Kitsu, in that order', async () => {
    const order: string[] = [];
    const client = makeClient({
      fetchAniListByMalId: jest.fn(async () => {
        order.push('mal');
        return null;
      }),
      fetchAniListByTitle: jest.fn(async () => {
        order.push('title');
        return null;
      }),
      fetchKitsuByTitle: jest.fn(async () => {
        order.push('kitsu');
        return KITSU_ANIME;
      }),
    });
    const service = new EnrichmentService(client, zeroTiming());

    const enriched = await service.enrichTheme(
      parsedTheme('S'),
      AT_ANIME,
      service.createCache(),
    );

    expect(order).toEqual(['mal', 'title', 'kitsu']);
    expect(enriched.anilistId).toBeNull();
    expect(enriched.kitsuId).toBe('k-42');
    expect(enriched.animeTitleEnglish).toBe('Kitsu Title EN');
  });

  it('season/year fallback: AT fields win, then AniList, then Kitsu', async () => {
    // AT has season → AniList's differing values must NOT override.
    const withAt = makeClient({
      fetchAniListByMalId: jest.fn(async () => ({
        ...ANILIST_MEDIA,
        season: 'WINTER',
        seasonYear: 1999,
      })),
    });
    const svcA = new EnrichmentService(withAt, zeroTiming());
    const a = await svcA.enrichTheme(
      parsedTheme('S'),
      AT_ANIME,
      svcA.createCache(),
    );
    expect(a.animeSeason).toBe('FALL'); // AT's, uppercased by the parser
    expect(a.animeSeasonYear).toBe(2026);

    // AT lacks season → AniList supplies it.
    const noAtSeason: AtAnime = { ...AT_ANIME, season: null, year: null };
    const themeNoSeason = parseATTheme({
      id: 5,
      type: 'ED',
      sequence: 1,
      song: { title: 'S', artists: [] },
      animethemeentries: [
        {
          id: 1,
          version: 1,
          videos: [{ resolution: 720, link: 'https://cdn/x.webm' }],
        },
      ],
      anime: noAtSeason,
    });
    if (!themeNoSeason) throw new Error('fixture failed');
    const b = await svcA.enrichTheme(
      themeNoSeason,
      noAtSeason,
      svcA.createCache(),
    );
    expect(b.animeSeason).toBe('WINTER');
    expect(b.animeSeasonYear).toBe(1999);

    // Neither AT nor AniList → Kitsu supplies it.
    const kitsuOnly = makeClient({
      fetchKitsuByTitle: jest.fn(async () => KITSU_ANIME),
    });
    const svcC = new EnrichmentService(kitsuOnly, zeroTiming());
    const c = await svcC.enrichTheme(
      themeNoSeason,
      noAtSeason,
      svcC.createCache(),
    );
    expect(c.animeSeason).toBe('SUMMER');
    expect(c.animeSeasonYear).toBe(2025);
  });

  it('merges AniList metadata: titles, synonyms, genres, studios deduped with AT', async () => {
    const client = makeClient({
      fetchAniListByMalId: jest.fn(async () => ANILIST_MEDIA),
    });
    const service = new EnrichmentService(client, zeroTiming());
    const enriched = await service.enrichTheme(
      parsedTheme('Fight Song'),
      AT_ANIME,
      service.createCache(),
    );

    expect(enriched.malId).toBe(123);
    expect(enriched.animeTitleEnglish).toBe('Test Anime EN');
    expect(enriched.titleNative).toBe('テスト');
    expect(enriched.animeTitleAlternative).toEqual(
      expect.arrayContaining(['テスト', 'Test Anime Alt']),
    );
    expect(enriched.animeTitleAlternative).not.toContain('Test Anime');
    expect(enriched.genres).toEqual(['Action']);
    expect(enriched.animeStudios).toEqual(['Studio A', 'Studio B']);
    expect(enriched.totalEpisodes).toBe(12);
    expect(enriched.animeStatus).toBe('RELEASING');
    expect(enriched.averageScore).toBe(81);
    expect(enriched.coverImageLarge).toBe('https://al/large.jpg');
    expect(enriched.mood).toContain('epic'); // Action genre rule
    expect(enriched._nullAudioCount).toBeUndefined();
  });

  it('with no enrichment found anywhere, ids stay null and mood uses no genres', async () => {
    const client = makeClient({});
    const service = new EnrichmentService(client, zeroTiming());
    const enriched = await service.enrichTheme(
      parsedTheme('Plain Song'),
      AT_ANIME,
      service.createCache(),
    );
    expect(enriched.anilistId).toBeNull();
    expect(enriched.kitsuId).toBeNull();
    expect(enriched.animeTitleEnglish).toBeNull();
    expect(enriched.genres).toEqual([]);
    // AT season still survives — fallback only fills gaps.
    expect(enriched.animeSeason).toBe('FALL');
  });
});

describe('EnrichmentClient Kitsu season derivation (month → season)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it.each([
    ['2026-01-15', 'WINTER', 2026],
    ['2026-04-01', 'SPRING', 2026],
    ['2026-08-20', 'SUMMER', 2026],
    ['2026-11-30', 'FALL', 2026],
  ])(
    'startDate %s → %s %i',
    async (startDate, season, year) => {
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'k1',
              attributes: {
                titles: { en: 'X', ja_jp: 'Y' },
                startDate,
                posterImage: { large: 'p' },
                coverImage: { large: 'c' },
              },
            },
          ],
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any;
      const client = new EnrichmentClient();
      const result = await client.fetchKitsuByTitle('X');
      expect(result?.season).toBe(season);
      expect(result?.seasonYear).toBe(year);
      expect(result?.kitsuId).toBe('k1');
    },
  );

  it('returns null on an empty Kitsu result and on HTTP failure', async () => {
    const client = new EnrichmentClient();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    await expect(client.fetchKitsuByTitle('nope')).resolves.toBeNull();

    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    await expect(client.fetchKitsuByTitle('nope')).resolves.toBeNull();
  });
});

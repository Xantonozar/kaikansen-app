import { buildVersionLabel, deriveMood, parseATTheme } from './theme-parser';
import type { AtTheme } from './sync.types';

/** One usable entry with three resolutions, deliberately unordered. */
function standardEntry() {
  return {
    id: 9001,
    episodes: '1-12',
    spoiler: false,
    nsfw: false,
    version: 1,
    videos: [
      { resolution: 480, link: 'https://cdn/480.webm', source: 'WEB' },
      { resolution: 1080, link: 'https://cdn/1080.webm', source: 'BD' },
      { resolution: 720, link: 'https://cdn/720.webm', source: 'WEB' },
    ],
  };
}

function makeTheme(overrides: Partial<AtTheme> = {}): AtTheme {
  return {
    id: 101,
    type: 'OP',
    sequence: 2,
    song: {
      title: 'Test Song',
      artists: [
        {
          id: 7,
          name: 'Artist One',
          slug: 'artist_one',
          as: 'performer',
          aliases: [],
          images: [{ link: 'https://img/artist.jpg' }],
        },
      ],
    },
    animethemeentries: [standardEntry()],
    anime: {
      id: 42,
      slug: 'test_anime',
      name: 'Test Anime',
      season: 'fall',
      year: 2026,
      malId: 123,
      images: [
        { facet: 'Large Cover', link: 'https://img/large.jpg' },
        { facet: 'Small Cover', link: 'https://img/small.jpg' },
        { facet: 'Grill', link: 'https://img/grill.jpg' },
      ],
      studios: [{ name: 'Studio A' }],
      series: [{ name: 'Test Series' }],
    },
    ...overrides,
  };
}

describe('parseATTheme', () => {
  it('builds the web slug format: <anime.slug>-<type><sequence>-<themeId>', () => {
    const doc = parseATTheme(makeTheme());
    expect(doc?.slug).toBe('test_anime-op2-101');
    expect(doc?.animethemesId).toBe(101);
    expect(doc?.type).toBe('OP');
    expect(doc?.sequence).toBe(2);
  });

  it('defaults sequence to 1 when AnimeThemes omits it', () => {
    const theme = makeTheme();
    theme.sequence = null;
    const doc = parseATTheme(theme);
    expect(doc?.slug).toBe('test_anime-op1-101');
    expect(doc?.sequence).toBe(1);
  });

  it('sorts videos by resolution desc: videoUrl is the highest, audioUrl the lowest', () => {
    const doc = parseATTheme(makeTheme());
    const entry = doc?.entries[0];
    expect(entry?.videoSources.map((v) => v.resolution)).toEqual([
      1080, 720, 480,
    ]);
    expect(entry?.videoUrl).toBe('https://cdn/1080.webm');
    expect(entry?.audioUrl).toBe('https://cdn/480.webm');
    expect(entry?.videoSources[0].mime).toBe('video/webm');
    // Theme-level urls come from the (tagless-at-first-video? no — see
    // tags test) standard entry; here the first video is BD-flagged so
    // the entry carries the BD tag and is not "standard" — with only one
    // entry it is still the fallback pick.
    expect(doc?.videoUrl).toBe('https://cdn/1080.webm');
    expect(doc?.audioUrl).toBe('https://cdn/480.webm');
  });

  it('derives entry tags from the highest-res video + version, and labels them', () => {
    const theme = makeTheme();
    theme.animethemeentries = [
      {
        id: 9002,
        version: 2,
        videos: [
          {
            resolution: 1080,
            link: 'https://cdn/nc.webm',
            nc: true,
            bd: true,
            tags: ['Lyrics', 'Piano'],
          },
          { resolution: 480, link: 'https://cdn/nc-low.webm' },
        ],
      },
    ];
    const doc = parseATTheme(theme);
    expect(doc?.entries[0].tags).toEqual(['NC', 'BD', 'Lyrics', 'Piano', 'V2']);
    expect(doc?.entries[0].version).toBe('NC+BD+LYRICS+PIANO+V2');
  });

  it('marks source === BD as a BD tag even without the bd flag', () => {
    const theme = makeTheme();
    theme.animethemeentries = [
      {
        id: 9003,
        version: 1,
        videos: [{ resolution: 720, link: 'https://cdn/x.webm', source: 'BD' }],
      },
    ];
    expect(parseATTheme(theme)?.entries[0].tags).toEqual(['BD']);
  });

  it('labels a tagless entry Standard and prefers it for the theme urls', () => {
    const theme = makeTheme();
    theme.animethemeentries = [
      {
        id: 9010,
        version: 2,
        videos: [{ resolution: 1080, link: 'https://cdn/v2.webm', nc: true }],
      },
      {
        id: 9011,
        version: 1,
        videos: [{ resolution: 720, link: 'https://cdn/plain.webm' }],
      },
    ];
    const doc = parseATTheme(theme);
    expect(doc?.entries[1].version).toBe('Standard');
    expect(doc?.videoUrl).toBe('https://cdn/plain.webm');
    expect(doc?.audioUrl).toBe('https://cdn/plain.webm');
  });

  it('takes season/year from AnimeThemes fields, uppercasing the season', () => {
    const doc = parseATTheme(makeTheme());
    expect(doc?.animeSeason).toBe('FALL');
    expect(doc?.animeSeasonYear).toBe(2026);
  });

  it('leaves season/year null when AnimeThemes lacks them (fallback runs in enrichment)', () => {
    const theme = makeTheme();
    theme.anime = { ...theme.anime, season: null, year: null };
    const doc = parseATTheme(theme);
    expect(doc?.animeSeason).toBeNull();
    expect(doc?.animeSeasonYear).toBeNull();
  });

  it('prefers Large Cover, then Cover; Grill and Small Cover by facet', () => {
    const doc = parseATTheme(makeTheme());
    expect(doc?.animeCoverImage).toBe('https://img/large.jpg');
    expect(doc?.animeCoverImageSmall).toBe('https://img/small.jpg');
    expect(doc?.animeGrillImage).toBe('https://img/grill.jpg');

    const theme = makeTheme();
    theme.anime = {
      ...theme.anime,
      images: [{ facet: 'Cover', link: 'https://img/plain-cover.jpg' }],
    };
    const fallback = parseATTheme(theme);
    expect(fallback?.animeCoverImage).toBe('https://img/plain-cover.jpg');
    expect(fallback?.animeGrillImage).toBeNull();
  });

  it('returns null when the theme has no entries', () => {
    const theme = makeTheme();
    theme.animethemeentries = [];
    expect(parseATTheme(theme)).toBeNull();
  });

  it('returns null when the theme has no anime', () => {
    const theme = makeTheme();
    delete theme.anime;
    expect(parseATTheme(theme)).toBeNull();
  });

  it('drops videoless entries, counts them, and returns null if none are usable', () => {
    const theme = makeTheme();
    theme.animethemeentries = [
      { id: 9020, version: 1, videos: [] },
      {
        id: 9021,
        version: 1,
        videos: [{ resolution: 720, link: 'https://cdn/ok.webm' }],
      },
    ];
    const doc = parseATTheme(theme);
    expect(doc?.entries).toHaveLength(1);
    expect(doc?.entries[0].atEntryId).toBe(9021);
    expect(doc?._nullAudioCount).toBe(1);

    const dead = makeTheme();
    dead.animethemeentries = [{ id: 9022, version: 1, videos: [] }];
    expect(parseATTheme(dead)).toBeNull();
  });

  it('collects artist fields: first name, all names, slugs, roles with performer default', () => {
    const theme = makeTheme();
    theme.song = {
      title: 'Duet',
      artists: [
        { id: 1, name: 'Lead', slug: 'lead', as: 'vocalist' },
        { id: 2, name: 'Guest', slug: 'guest' },
      ],
    };
    const doc = parseATTheme(theme);
    expect(doc?.artistName).toBe('Lead');
    expect(doc?.allArtists).toEqual(['Lead', 'Guest']);
    expect(doc?.artistSlugs).toEqual(['lead', 'guest']);
    expect(doc?.artistRoles).toEqual(['vocalist', 'performer']);
  });

  it('starts with embedding null, anilistId/kitsuId null and a fresh syncedAt', () => {
    const before = Date.now();
    const doc = parseATTheme(makeTheme());
    expect(doc?.embedding).toBeNull();
    expect(doc?.anilistId).toBeNull();
    expect(doc?.kitsuId).toBeNull();
    expect(doc?.syncedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('buildVersionLabel', () => {
  it('is Standard for no tags and joins uppercased tags otherwise', () => {
    expect(buildVersionLabel([])).toBe('Standard');
    expect(buildVersionLabel(['NC', 'Lyrics'])).toBe('NC+LYRICS');
  });
});

describe('deriveMood', () => {
  it('matches keywords and genre rules, deduped', () => {
    expect(deriveMood('Battle Cry', 'Calm Seas', ['Action'])).toEqual(
      expect.arrayContaining(['epic']),
    );
    expect(deriveMood('x', 'y', ['Horror', 'Horror'])).toEqual(['dark']);
    expect(deriveMood('nothing', 'here', [])).toEqual([]);
  });
});

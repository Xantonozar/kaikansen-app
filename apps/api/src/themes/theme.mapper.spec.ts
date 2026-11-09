import { toThemeDetail, toThemeSummary, type ThemeDoc } from './theme.mapper';

/**
 * Theme mapper unit tests — the ThemeSummary projection rule for
 * `duration` (Slice 3 data gap): the summary's representative
 * duration is the themecache document's OWN `duration` field, the
 * same value the detail payload serves — never an entry pick (the
 * entries carry per-version durations) and never invented (a
 * document without one projects null).
 */
function makeDoc(overrides: Record<string, unknown> = {}): ThemeDoc {
  return {
    _id: '507f1f77bcf86cd799439011',
    slug: 'anime_a-op1-1',
    animethemesId: 1,
    songTitle: 'Song A',
    artistName: 'Artist A',
    allArtists: ['Artist A'],
    artistSlugs: ['artist_a'],
    artistRoles: ['performer'],
    anilistId: 42,
    kitsuId: null,
    animeTitle: 'Anime A',
    animeTitleEnglish: 'Anime A EN',
    animeTitleAlternative: [],
    animeSeason: 'FALL',
    animeSeasonYear: 2026,
    animeCoverImage: 'https://example.com/a.jpg',
    animeCoverImageSmall: 'https://example.com/a-small.jpg',
    animeGrillImage: null,
    animeStudios: [],
    animeSeries: [],
    type: 'OP',
    sequence: 1,
    entries: [
      {
        atEntryId: 11,
        version: 'Standard',
        episodes: null,
        spoiler: false,
        nsfw: false,
        tags: [],
        videoSources: [],
        videoUrl: 'https://example.com/a.webm',
        audioUrl: null,
        duration: 61,
      },
    ],
    videoUrl: 'https://example.com/a.webm',
    audioUrl: null,
    mood: [],
    embedding: null,
    avgRating: 0,
    totalRatings: 0,
    totalWatches: 10,
    totalListens: 4,
    duration: 154,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    isPopular: false,
    popularRank: null,
    featuredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as ThemeDoc;
}

describe('toThemeSummary — duration projection', () => {
  it("carries the document's own duration field", () => {
    expect(toThemeSummary(makeDoc()).duration).toBe(154);
  });

  it('does NOT fall back to an entry duration — the document field rules', () => {
    // Entry says 61s; the representative duration is the doc's 154s.
    const summary = toThemeSummary(makeDoc());
    expect(summary.duration).toBe(154);
    expect(summary.duration).not.toBe(61);
  });

  it('projects null when the stored document carries no duration', () => {
    const doc = makeDoc();
    delete (doc as unknown as Record<string, unknown>).duration;
    expect(toThemeSummary(doc).duration).toBeNull();
  });

  it('agrees with the detail projection for the same document', () => {
    const doc = makeDoc();
    expect(toThemeSummary(doc).duration).toBe(toThemeDetail(doc).duration);
  });
});

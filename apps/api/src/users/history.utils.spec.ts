import {
  mergeWatchHistory,
  normalizeAniListEntry,
  normalizeLocalEntry,
  type NormalizedWatchEntry,
} from './history.utils';

/**
 * history.utils unit tests — the web's lib/history-utils port,
 * asserted against the web's own semantics (the web ships a
 * history-utils.test.ts; these cover the same behaviours the API
 * port relies on).
 */

describe('normalizeAniListEntry', () => {
  it('prefers the english title and converts AniList seconds to a Date', () => {
    const entry = normalizeAniListEntry({
      updatedAt: 1_700_000_000,
      media: {
        id: 21,
        title: { romaji: 'Romaji Title', english: 'English Title' },
        coverImage: { large: 'https://example.com/cover.jpg' },
        episodes: 12,
      },
    });
    expect(entry).toEqual({
      id: 21,
      title: 'English Title',
      episodeCount: 12,
      lastWatchedAt: new Date(1_700_000_000 * 1000),
      source: 'AniList',
      image: 'https://example.com/cover.jpg',
    });
  });

  it('falls back to the romaji title when english is missing', () => {
    const entry = normalizeAniListEntry({
      updatedAt: 10,
      media: {
        id: 7,
        title: { romaji: 'Romaji Only', english: null },
        coverImage: { large: 'x' },
        episodes: null,
      },
    });
    expect(entry.title).toBe('Romaji Only');
    expect(entry.episodeCount).toBeUndefined();
  });
});

describe('normalizeLocalEntry', () => {
  it('maps the joined theme, preferring the small cover', () => {
    const viewedAt = new Date('2026-11-01T00:00:00.000Z');
    const entry = normalizeLocalEntry({
      viewedAt,
      theme: {
        _id: '507f1f77bcf86cd799439011',
        songTitle: 'Song A',
        animeTitle: 'Anime A',
        animeCoverImage: 'https://example.com/big.jpg',
        animeCoverImageSmall: 'https://example.com/small.jpg',
        type: 'OP',
        slug: 'anime_a-op1-1',
      },
    });
    expect(entry).toEqual({
      id: '507f1f77bcf86cd799439011',
      title: 'Song A',
      animeTitle: 'Anime A',
      lastWatchedAt: viewedAt,
      source: 'Local',
      image: 'https://example.com/small.jpg',
      type: 'OP',
      slug: 'anime_a-op1-1',
    });
  });
});

describe('mergeWatchHistory', () => {
  const local = (
    id: string,
    title: string,
    animeTitle: string,
    at: number,
  ): NormalizedWatchEntry => ({
    id,
    title,
    animeTitle,
    lastWatchedAt: new Date(at),
    source: 'Local',
    image: 'local-img',
    type: 'OP',
    slug: `slug-${id}`,
  });
  const remote = (
    id: number,
    title: string,
    at: number,
  ): NormalizedWatchEntry => ({
    id,
    title,
    lastWatchedAt: new Date(at),
    source: 'AniList',
    image: 'remote-img',
  });

  it('sorts the merged list newest first', () => {
    const merged = mergeWatchHistory(
      [local('a', 'Song A', 'Anime A', 1000)],
      [remote(9, 'Other Anime', 3000), remote(8, 'Older Anime', 500)],
    );
    expect(merged.map((e) => e.id)).toEqual([9, 'a', 8]);
  });

  it('drops a remote entry whose title matches a local anime title — local wins', () => {
    const merged = mergeWatchHistory(
      [local('a', 'Song A', 'Anime A', 1000)],
      [remote(9, 'anime a', 5000)],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('Local');
    expect(merged[0].id).toBe('a');
  });

  it('drops a remote entry whose title matches a local song title', () => {
    const merged = mergeWatchHistory(
      [local('a', 'Song A', 'Anime A', 1000)],
      [remote(9, 'SONG A', 5000), remote(10, 'Unrelated', 4000)],
    );
    expect(merged.map((e) => e.id)).toEqual([10, 'a']);
  });

  it('keeps both when nothing matches', () => {
    const merged = mergeWatchHistory(
      [local('a', 'Song A', 'Anime A', 1000)],
      [remote(9, 'Different Show', 2000)],
    );
    expect(merged).toHaveLength(2);
  });
});

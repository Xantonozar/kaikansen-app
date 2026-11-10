import { describe, expect, it } from '@jest/globals';
import type { ThemeDetail, ThemeEntry } from '@kaikansen/contracts';
import {
  deriveAudioUrl,
  entryHasAudio,
  formatTime,
  isPlausibleUrl,
  quizAudioCandidates,
  resolveListenCandidates,
  resolvePlaybackUrl,
  resolveWatchCandidates,
} from './playback';

/**
 * Playback source resolution (src/playback.ts) — the candidate
 * chains the player, downloads and quiz questions walk. The
 * catalogue's normal shape drives the fixtures: stored audioUrl
 * is null and the audio is the derived .ogg twin of the video.
 */

const VIDEO = 'https://v.animethemes.moe/FateZero-OP1.webm';
const OGG = 'https://a.animethemes.moe/FateZero-OP1.ogg';
const VIDEO_360 = 'https://v.animethemes.moe/FateZero-OP1-360.webm';
const VIDEO_720 = 'https://v.animethemes.moe/FateZero-OP1-720.webm';
const STORED_AUDIO = 'https://cdn.example.com/fate-zero-op1.mp3';

function entry(overrides: Partial<ThemeEntry> = {}): ThemeEntry {
  return {
    atEntryId: 1,
    version: 'v1',
    episodes: '1-25',
    spoiler: false,
    nsfw: false,
    tags: [],
    videoSources: [],
    videoUrl: VIDEO,
    audioUrl: null,
    duration: 90,
    ...overrides,
  };
}

function detail(overrides: Partial<ThemeDetail> = {}): ThemeDetail {
  return {
    id: 'theme-1',
    slug: 'fate-zero-op1',
    songTitle: 'oath sign',
    animeTitle: 'Fate/Zero',
    animeTitleEnglish: 'Fate/Zero',
    artistName: 'LiSA',
    allArtists: ['LiSA'],
    type: 'OP',
    sequence: 1,
    animeSeason: 'SPRING',
    animeSeasonYear: 2012,
    animeCoverImage: null,
    animeCoverImageSmall: null,
    avgRating: 9,
    totalRatings: 10,
    totalWatches: 100,
    totalListens: 40,
    duration: 90,
    isPopular: false,
    popularRank: null,
    anilistId: 10087,
    animethemesId: 5001,
    kitsuId: null,
    animeTitleAlternative: [],
    animeGrillImage: null,
    animeStudios: [],
    animeSeries: [],
    artistSlugs: [],
    artistRoles: [],
    entries: [],
    videoUrl: VIDEO,
    audioUrl: null,
    mood: [],
    syncedAt: '2026-11-07T00:00:00.000Z',
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('deriveAudioUrl', () => {
  it('maps the AnimeThemes video host to its .ogg twin', () => {
    expect(deriveAudioUrl(VIDEO)).toBe(OGG);
  });

  it('refuses anything off-pattern', () => {
    expect(deriveAudioUrl(null)).toBeNull();
    expect(deriveAudioUrl('https://example.com/video.webm')).toBeNull();
    expect(deriveAudioUrl('https://v.animethemes.moe/clip.mp4')).toBeNull();
    expect(deriveAudioUrl('https://v.animethemes.moe/.webm')).toBeNull();
  });
});

describe('resolvePlaybackUrl', () => {
  it('watch takes the highest-resolution source', () => {
    const e = entry({
      videoSources: [
        { url: VIDEO_360, resolution: 360, source: 'animethemes', mime: 'video/webm' },
        { url: VIDEO_720, resolution: 720, source: 'animethemes', mime: 'video/webm' },
      ],
      videoUrl: null,
    });
    expect(resolvePlaybackUrl(detail(), e, 'watch')).toBe(VIDEO_720);
  });

  it('watch falls back entry videoUrl, then the theme videoUrl', () => {
    expect(resolvePlaybackUrl(detail(), entry(), 'watch')).toBe(VIDEO);
    expect(
      resolvePlaybackUrl(detail(), entry({ videoUrl: null }), 'watch'),
    ).toBe(VIDEO);
    expect(resolvePlaybackUrl(detail(), null, 'watch')).toBe(VIDEO);
  });

  it('listen prefers stored audio, then the derived .ogg', () => {
    const stored = entry({ audioUrl: STORED_AUDIO });
    expect(resolvePlaybackUrl(detail(), stored, 'listen')).toBe(STORED_AUDIO);
    expect(resolvePlaybackUrl(detail(), entry(), 'listen')).toBe(OGG);
    const themeStored = detail({ audioUrl: STORED_AUDIO });
    expect(resolvePlaybackUrl(themeStored, entry(), 'listen')).toBe(
      STORED_AUDIO,
    );
  });

  it('listen is null when nothing can be derived or stored', () => {
    const offPattern = detail({
      videoUrl: 'https://example.com/clip.mp4',
      audioUrl: null,
    });
    expect(
      resolvePlaybackUrl(offPattern, entry({ videoUrl: null }), 'listen'),
    ).toBeNull();
    expect(entryHasAudio(offPattern, entry({ videoUrl: null }))).toBe(false);
    expect(entryHasAudio(detail(), entry())).toBe(true);
  });
});

describe('resolveWatchCandidates', () => {
  it('orders by resolution desc, dedupes, drops implausible URLs', () => {
    const e = entry({
      videoSources: [
        { url: VIDEO_360, resolution: 360, source: 'animethemes', mime: 'video/webm' },
        { url: VIDEO_720, resolution: 720, source: 'animethemes', mime: 'video/webm' },
        { url: VIDEO_720, resolution: 720, source: 'animethemes', mime: 'video/webm' },
        { url: 'relative/path.webm', resolution: 1080, source: null, mime: 'video/webm' },
      ],
      videoUrl: VIDEO_360,
    });
    expect(resolveWatchCandidates(detail(), e)).toEqual([
      VIDEO_720,
      VIDEO_360,
      VIDEO,
    ]);
  });

  it('uses the theme videoUrl without an entry', () => {
    expect(resolveWatchCandidates(detail(), null)).toEqual([VIDEO]);
  });
});

describe('resolveListenCandidates', () => {
  it('walks stored → derived → the video file last', () => {
    const stored = entry({ audioUrl: STORED_AUDIO });
    expect(resolveListenCandidates(detail(), stored)).toEqual([
      STORED_AUDIO,
      OGG,
      VIDEO,
    ]);
    expect(resolveListenCandidates(detail(), entry())).toEqual([OGG, VIDEO]);
  });

  it('is empty when there is no audio source at all', () => {
    const offPattern = detail({
      videoUrl: 'https://example.com/clip.mp4',
      audioUrl: null,
    });
    expect(
      resolveListenCandidates(offPattern, entry({ videoUrl: null })),
    ).toEqual([]);
  });
});

describe('quizAudioCandidates', () => {
  it('puts the derived .ogg first and the video last (the doctrine)', () => {
    expect(quizAudioCandidates(VIDEO, [OGG, VIDEO])).toEqual([OGG, VIDEO]);
    expect(quizAudioCandidates(VIDEO, [VIDEO, OGG])).toEqual([OGG, VIDEO]);
  });

  it('keeps a stored audio slot ahead of the video', () => {
    expect(quizAudioCandidates(VIDEO, [STORED_AUDIO, VIDEO])).toEqual([
      STORED_AUDIO,
      VIDEO,
    ]);
  });

  it('dedupes and drops junk; empty when nothing is plausible', () => {
    expect(quizAudioCandidates(VIDEO, [null, 'junk', OGG, OGG, VIDEO])).toEqual(
      [OGG, VIDEO],
    );
    expect(quizAudioCandidates(VIDEO, [null, 'junk'])).toEqual([]);
    expect(quizAudioCandidates(null, [])).toEqual([]);
  });
});

describe('isPlausibleUrl + formatTime', () => {
  it('accepts http(s) only', () => {
    expect(isPlausibleUrl('https://a.b/c')).toBe(true);
    expect(isPlausibleUrl('http://a.b/c')).toBe(true);
    expect(isPlausibleUrl('ftp://a.b/c')).toBe(false);
    expect(isPlausibleUrl(null)).toBe(false);
    expect(isPlausibleUrl('')).toBe(false);
  });

  it('formats m:ss with the 0:00 floor for bad input', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(7)).toBe('0:07');
    expect(formatTime(83.9)).toBe('1:23');
    expect(formatTime(600)).toBe('10:00');
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(Number.NaN)).toBe('0:00');
  });
});

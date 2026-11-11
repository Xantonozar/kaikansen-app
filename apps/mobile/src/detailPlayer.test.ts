import { describe, expect, it } from '@jest/globals';
import type { ThemeDetail, ThemeEntry } from '@kaikansen/contracts';
import {
  detailBackendForMode,
  detailSurfaceMount,
  hiddenVideoCandidate,
  mountedDetailBackends,
  seekRatioForTap,
  splitPlaybackChannels,
  wavePlayedBars,
} from './detailPlayer';
import { stabilizeProgress, tagCandidates } from './mediaEngine';
import { resolveListenCandidates } from './playback';

/**
 * Theme Detail player-backend split (perf problem 12) — the pure
 * decisions the split components render by:
 * - exactly ONE backend mounts (the active mode's), never both;
 * - the page body's render channel (the engine's slow object)
 *   keeps its identity across progress ticks while the progress
 *   channel carries the ticks — the memo-boundary proof at the
 *   logic level (the provider performs this same split:
 *   usePlaybackSlowSession vs usePlaybackProgress);
 * - the hidden-video candidate still resolves inside the listen
 *   chain after the split (EXTENDS the playback job's chain
 *   tests in mediaEngine.test.ts / playback.test.ts — the chain
 *   itself is unchanged; this proves the split's listen claim
 *   still has its untouchable candidate for the page's single
 *   surface to serve, hidden);
 * - the single surface's visibility rule (2026-11-11 fix): the
 *   page owns ONE surface for the whole hero zone; it is visible
 *   only in watch without the W2 fallback — the mount invariant
 *   itself (heroes bind no surface) is pinned by
 *   singleSurface.test.ts.
 */

const VIDEO = 'https://v.animethemes.moe/FateZero-OP1.webm';
const OGG = 'https://a.animethemes.moe/FateZero-OP1.ogg';
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
    relatedIds: [],
    ...overrides,
  } as ThemeDetail;
}

describe('detailBackendForMode / mountedDetailBackends', () => {
  it('mounts the watch backend in watch mode, and only that one', () => {
    expect(detailBackendForMode('watch')).toBe('watch');
    expect(mountedDetailBackends('watch')).toEqual(['watch']);
  });

  it('mounts the listen backend in listen mode, and only that one', () => {
    expect(detailBackendForMode('listen')).toBe('listen');
    expect(mountedDetailBackends('listen')).toEqual(['listen']);
  });

  it('mounts NO player backend before play (null mode = artwork hero)', () => {
    expect(detailBackendForMode(null)).toBe('artwork');
    expect(mountedDetailBackends(null)).toEqual([]);
  });

  it('never mounts both backends at once, in any mode', () => {
    for (const mode of ['watch', 'listen', null] as const) {
      expect(mountedDetailBackends(mode).length).toBeLessThanOrEqual(1);
    }
  });

  it('a mode switch swaps the single mounted backend — the pair is never co-mounted', () => {
    // The engine/session lives in the provider, not in a hero,
    // so this swap is the WHOLE effect of a mode switch on the
    // backend tree: watch unmounts as listen mounts, with no
    // frame where both exist. Since the 2026-11-11 restructure
    // each backend carries its mode's surface, so the swap IS
    // the surface swap too — run under the engine's
    // pause/detach/resume-gate discipline (usePlayback), never
    // a mid-play rebind and never a style flip.
    const sequence = (['watch', 'listen', 'watch'] as const).map((m) =>
      mountedDetailBackends(m),
    );
    expect(sequence).toEqual([['watch'], ['listen'], ['watch']]);
  });
});

describe('detailSurfaceMount — per-mode surfaces (2026-11-11 restructure)', () => {
  it('watch mounts its surface born visible; listen mounts its own hidden one', () => {
    expect(detailSurfaceMount('watch')).toBe('watch-visible');
    expect(detailSurfaceMount('listen')).toBe('listen-hidden');
  });

  it('the artwork state mounts no surface (nothing claimed, nothing plays)', () => {
    expect(detailSurfaceMount('artwork')).toBeNull();
  });

  it('composes with the backend rule: exactly one surface per play mode, in its own form', () => {
    for (const mode of ['watch', 'listen', null] as const) {
      expect(detailSurfaceMount(detailBackendForMode(mode))).toBe(
        mode === 'watch'
          ? 'watch-visible'
          : mode === 'listen'
            ? 'listen-hidden'
            : null,
      );
    }
  });
});

describe('splitPlaybackChannels — the render boundary', () => {
  it('the page channel is the slow object ITSELF, by reference', () => {
    const slow = { isPlaying: true, url: OGG };
    const { page, progressChannel } = splitPlaybackChannels(
      slow,
      { current: 3, duration: 90 },
      3 / 90,
    );
    expect(page).toBe(slow);
    expect(progressChannel).toEqual({
      progress: { current: 3, duration: 90 },
      fraction: 3 / 90,
    });
  });

  it('progress ticks move only the progress channel — the page channel identity never changes', () => {
    // The engine's slow object across a playing track: ONE
    // memoised reference (problem 8). Ticks arrive as raw native
    // positions and are stabilized exactly as the engine
    // stabilizes them before they reach any channel.
    const slow = { isPlaying: true, buffering: false, url: OGG };
    let progress = { current: 0, duration: 0 };
    const pageRefs = new Set<object>();
    const progressRefs: { current: number; duration: number }[] = [];
    for (const raw of [
      { current: 0.2, duration: 90.4 },
      { current: 0.9, duration: 90.4 },
      { current: 1.1, duration: 90.4 },
      { current: 1.8, duration: 90.4 },
      { current: 2.3, duration: 90.4 },
    ]) {
      progress = stabilizeProgress(progress, raw);
      const channels = splitPlaybackChannels(
        slow,
        progress,
        progress.duration > 0 ? progress.current / progress.duration : 0,
      );
      pageRefs.add(channels.page);
      progressRefs.push(channels.progressChannel.progress);
    }
    // Every tick left the page channel on the same reference —
    // a consumer memoised on it (the page body) renders ZERO
    // extra times for these five ticks.
    expect(pageRefs.size).toBe(1);
    // The progress channel still received every real second:
    // 0 (twice, same stabilized ref), 1 (twice), 2.
    expect(progressRefs.map((p) => p.current)).toEqual([0, 0, 1, 1, 2]);
    expect(progressRefs[0]).toBe(progressRefs[1]);
    expect(progressRefs[2]).toBe(progressRefs[3]);
  });
});

describe('hiddenVideoCandidate — the untouchable listen fallback', () => {
  it('the catalogue-normal listen chain still ends in the video file, tagged hidden-video', () => {
    // Stored audioUrl null: the chain is the derived .ogg, then
    // the video file itself — the page's single surface, hidden
    // by style while listening, serves exactly this candidate.
    const d = detail();
    const e = entry();
    const chain = resolveListenCandidates(d, e);
    expect(chain).toEqual([OGG, VIDEO]);
    const tagged = tagCandidates(chain, 'listen');
    expect(hiddenVideoCandidate(tagged)).toEqual({
      url: VIDEO,
      kind: 'video',
      role: 'hidden-video',
    });
  });

  it('a stored-audio chain still carries the video as its last resort', () => {
    const d = detail({ audioUrl: STORED_AUDIO });
    const e = entry({ audioUrl: STORED_AUDIO });
    const tagged = tagCandidates(resolveListenCandidates(d, e), 'listen');
    expect(tagged.map((c) => c.url)).toEqual([STORED_AUDIO, OGG, VIDEO]);
    expect(hiddenVideoCandidate(tagged)?.url).toBe(VIDEO);
  });

  it('the W2 degradation chain keeps the same hidden-video candidate', () => {
    const tagged = tagCandidates([OGG, VIDEO], 'chain');
    expect(hiddenVideoCandidate(tagged)).toEqual({
      url: VIDEO,
      kind: 'video',
      role: 'hidden-video',
    });
  });

  it('a pure-audio chain has no hidden-video candidate (nothing to hide)', () => {
    const tagged = tagCandidates([OGG, STORED_AUDIO], 'listen');
    expect(hiddenVideoCandidate(tagged)).toBeNull();
  });

  it('a watch chain never yields a hidden-video candidate', () => {
    const tagged = tagCandidates([VIDEO], 'watch');
    expect(hiddenVideoCandidate(tagged)).toBeNull();
  });
});

describe('wavePlayedBars', () => {
  it('splits the bars at the played fraction (the original rounding)', () => {
    expect(wavePlayedBars(0, 22)).toBe(0);
    expect(wavePlayedBars(0.5, 22)).toBe(11);
    expect(wavePlayedBars(1, 22)).toBe(22);
    expect(wavePlayedBars(0.999, 22)).toBe(22);
  });

  it('clamps out-of-range fractions', () => {
    expect(wavePlayedBars(1.4, 22)).toBe(22);
    expect(wavePlayedBars(-0.2, 22)).toBe(0);
    expect(wavePlayedBars(Number.NaN, 22)).toBe(0);
    expect(wavePlayedBars(0.5, 0)).toBe(0);
  });
});

describe('seekRatioForTap', () => {
  it('is the tap x over the measured bar width', () => {
    expect(seekRatioForTap(50, 200)).toBe(0.25);
    expect(seekRatioForTap(0, 200)).toBe(0);
    expect(seekRatioForTap(200, 200)).toBe(1);
  });

  it('an unmeasured bar (width 0) seeks nowhere', () => {
    expect(seekRatioForTap(50, 0)).toBeNull();
    expect(seekRatioForTap(50, -10)).toBeNull();
  });
});

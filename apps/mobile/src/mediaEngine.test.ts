import { describe, expect, it } from '@jest/globals';
import {
  AUDIO_STALL_GRACE_MS,
  PLAYBACK_STALL_WATCHDOG_MS,
  VIDEO_STALL_GRACE_MS,
  createPreloadTicket,
  failureAttributionDecision,
  markFailureHandled,
  firstCandidateIsVideo,
  mediaKindForUrl,
  pickPreloadCandidate,
  playingResolution,
  preloadMatches,
  progressFraction,
  progressValueChanged,
  quantizeProgress,
  queuePreloadKey,
  shouldPreloadNext,
  stabilizeProgress,
  stallShouldTrip,
  videoLoadAction,
  surfaceReadinessAfterSwap,
  tagCandidates,
  watchArtworkUnderPlayer,
  watchSurfaceGateDecision,
  watchdogPollActive,
  watchdogShouldTrip,
  type WatchdogSnapshot,
} from './mediaEngine';

/**
 * Media engine routing + stall watchdog (src/mediaEngine.ts) —
 * the playback plan's pure decisions: file-type routing within
 * the chain, preload ticket matching, the watchdog trip rule
 * (incl. the multiplayer countdown-hold guard) and the
 * problem-8 progress stabilization.
 */

const VIDEO = 'https://v.animethemes.moe/FateZero-OP1.webm';
const OGG = 'https://a.animethemes.moe/FateZero-OP1.ogg';
const STORED_MP3 = 'https://cdn.example.com/fate-zero-op1.mp3';
const LOCAL_OGG = 'file:///data/downloads/fate--1--listen.ogg';
const LOCAL_WEBM = 'file:///data/downloads/fate--1--watch.webm';

describe('mediaKindForUrl', () => {
  it('routes audio extensions to the audio engine', () => {
    expect(mediaKindForUrl(OGG)).toBe('audio');
    expect(mediaKindForUrl(STORED_MP3)).toBe('audio');
    expect(mediaKindForUrl(LOCAL_OGG)).toBe('audio');
    expect(mediaKindForUrl('https://x.example/a.m4a?sig=1')).toBe('audio');
  });

  it('routes video files (and anything else) to the video engine', () => {
    expect(mediaKindForUrl(VIDEO)).toBe('video');
    expect(mediaKindForUrl(LOCAL_WEBM)).toBe('video');
    expect(mediaKindForUrl('https://x.example/stream')).toBe('video');
  });
});

describe('tagCandidates', () => {
  it('listen chain: audio candidates, then the video as hidden-video', () => {
    const tagged = tagCandidates([OGG, VIDEO], 'listen');
    expect(tagged).toEqual([
      { url: OGG, kind: 'audio', role: 'primary' },
      { url: VIDEO, kind: 'video', role: 'hidden-video' },
    ]);
  });

  it('watch chain: video candidates stay plain video, no hidden role', () => {
    const tagged = tagCandidates([VIDEO, VIDEO], 'watch');
    expect(tagged[0]).toEqual({ url: VIDEO, kind: 'video', role: 'primary' });
    expect(tagged[1].role).toBe('audio-fallback');
  });

  it('degradation chain: first audio is the fallback target, video stays hidden', () => {
    const tagged = tagCandidates([OGG, VIDEO], 'chain');
    expect(tagged[0].role).toBe('primary');
    expect(tagged[1]).toEqual({
      url: VIDEO,
      kind: 'video',
      role: 'hidden-video',
    });
  });
});

describe('preload tickets', () => {
  it('matches only the same key AND url', () => {
    const ticket = createPreloadTicket('entry:1', OGG);
    expect(ticket).toEqual({ key: 'entry:1', url: OGG, kind: 'audio', ready: false });
    expect(preloadMatches(ticket, 'entry:1', OGG)).toBe(true);
    expect(preloadMatches(ticket, 'entry:2', OGG)).toBe(false);
    expect(preloadMatches(ticket, 'entry:1', VIDEO)).toBe(false);
    expect(preloadMatches(null, 'entry:1', OGG)).toBe(false);
  });

  it('picks the first audio candidate; video-first chains keep the video hold', () => {
    const listen = tagCandidates([OGG, VIDEO], 'listen');
    expect(pickPreloadCandidate(listen)?.url).toBe(OGG);
    expect(firstCandidateIsVideo(listen)).toBe(false);
    const videoFirst = tagCandidates([VIDEO], 'listen');
    expect(pickPreloadCandidate(videoFirst)).toBeNull();
    expect(firstCandidateIsVideo(videoFirst)).toBe(true);
  });
});

describe('watchdogShouldTrip', () => {
  const base: WatchdogSnapshot = {
    now: 10_000,
    loadingSince: 10_000 - PLAYBACK_STALL_WATCHDOG_MS - 1,
    armedFrom: 0,
    hasSource: true,
    failed: false,
    disabled: false,
  };

  it('trips once loading outlasts the budget', () => {
    expect(watchdogShouldTrip(base)).toBe(true);
    expect(
      watchdogShouldTrip({
        ...base,
        loadingSince: 10_000 - PLAYBACK_STALL_WATCHDOG_MS,
      }),
    ).toBe(true);
    expect(
      watchdogShouldTrip({
        ...base,
        loadingSince: 10_000 - PLAYBACK_STALL_WATCHDOG_MS + 1,
      }),
    ).toBe(false);
  });

  it('never trips while not loading, failed, source-less or disabled', () => {
    expect(watchdogShouldTrip({ ...base, loadingSince: null })).toBe(false);
    expect(watchdogShouldTrip({ ...base, failed: true })).toBe(false);
    expect(watchdogShouldTrip({ ...base, hasSource: false })).toBe(false);
    expect(watchdogShouldTrip({ ...base, disabled: true })).toBe(false);
  });

  it('the countdown hold: time before the intended start never counts', () => {
    // Held since t=0 for a t=5000 start; at t=4999 the source has
    // "loaded" for 5s of wall time but the watchdog is not armed.
    expect(
      watchdogShouldTrip({
        now: 4_999,
        loadingSince: 0,
        armedFrom: 5_000,
        hasSource: true,
        failed: false,
        disabled: false,
      }),
    ).toBe(false);
    // Still loading a full budget AFTER the start moment: trips.
    expect(
      watchdogShouldTrip({
        now: 5_000 + PLAYBACK_STALL_WATCHDOG_MS,
        loadingSince: 0,
        armedFrom: 5_000,
        hasSource: true,
        failed: false,
        disabled: false,
      }),
    ).toBe(true);
  });

  it('the poll only runs for a live, unfailed source', () => {
    expect(
      watchdogPollActive({ active: true, hasSource: true, failed: false }),
    ).toBe(true);
    expect(
      watchdogPollActive({ active: false, hasSource: true, failed: false }),
    ).toBe(false);
    expect(
      watchdogPollActive({ active: true, hasSource: false, failed: false }),
    ).toBe(false);
    expect(
      watchdogPollActive({ active: true, hasSource: true, failed: true }),
    ).toBe(false);
  });

  it('resets when loading clears (a fresh load restarts the clock)', () => {
    // The hook feeds loadingSince=null the moment status leaves
    // 'loading', and a new source's load stamps a new since —
    // a source that recovered inside the budget never trips.
    expect(
      watchdogShouldTrip({
        now: 20_000,
        loadingSince: 19_500,
        armedFrom: 0,
        hasSource: true,
        failed: false,
        disabled: false,
      }),
    ).toBe(false);
  });
});

describe('progress stabilization (problem 8)', () => {
  it('quantizes to whole seconds', () => {
    expect(quantizeProgress({ current: 12.9, duration: 90.4 })).toEqual({
      current: 12,
      duration: 90,
    });
    expect(quantizeProgress({ current: -3, duration: Number.NaN })).toEqual({
      current: 0,
      duration: 0,
    });
  });

  it('keeps the previous reference for same-second ticks', () => {
    const prev = { current: 12, duration: 90 };
    const same = stabilizeProgress(prev, { current: 12.4, duration: 90.9 });
    expect(same).toBe(prev);
    const next = stabilizeProgress(prev, { current: 13.1, duration: 90 });
    expect(next).toEqual({ current: 13, duration: 90 });
    expect(next).not.toBe(prev);
  });

  it('fraction is clamped and 0 while the duration is unknown', () => {
    expect(progressFraction({ current: 45, duration: 90 })).toBe(0.5);
    expect(progressFraction({ current: 120, duration: 90 })).toBe(1);
    expect(progressFraction({ current: 5, duration: 0 })).toBe(0);
  });

  it('downloads fractions only count as changed on a real change', () => {
    expect(progressValueChanged(0.42, 0.42)).toBe(false);
    expect(progressValueChanged(0.42, 0.43)).toBe(true);
    expect(progressValueChanged(undefined, null)).toBe(true);
    expect(progressValueChanged(null, null)).toBe(false);
  });
});

describe('problem 3 — next-track preload gate', () => {
  const next = { slug: 'next-theme', atEntryId: 42 };
  const base = { isPlaying: true, buffering: false, next, nextOffline: false };

  it('preloads only once the current track is stably playing', () => {
    expect(shouldPreloadNext(base)).toBe(true);
    // Still buffering: the preload must never compete.
    expect(shouldPreloadNext({ ...base, buffering: true })).toBe(false);
    // Not playing yet (or paused): nothing to gate on.
    expect(shouldPreloadNext({ ...base, isPlaying: false })).toBe(false);
  });

  it('no preload without a next item, or when it is offline', () => {
    expect(shouldPreloadNext({ ...base, next: null })).toBe(false);
    expect(shouldPreloadNext({ ...base, nextOffline: true })).toBe(false);
  });

  it('ticket keys re-key on skip or version switch', () => {
    expect(queuePreloadKey(next)).toBe('queue:next-theme:42');
    expect(queuePreloadKey({ slug: 'next-theme', atEntryId: null })).toBe(
      'queue:next-theme:first',
    );
    expect(queuePreloadKey(next)).not.toBe(
      queuePreloadKey({ slug: 'next-theme', atEntryId: 7 }),
    );
  });
});

describe('problem 7 → owner ruling 2026-11-11 — fixed best quality, no switching', () => {
  const V1080 = 'https://v.animethemes.moe/FateZero-OP1-1080.webm';
  const V720 = 'https://v.animethemes.moe/FateZero-OP1-720.webm';
  const V360 = 'https://v.animethemes.moe/FateZero-OP1-360.webm';
  const sources = [
    { url: V360, resolution: 360 },
    { url: V1080, resolution: 1080 },
    { url: V720, resolution: 720 },
  ];

  it('chip resolution follows the ACTUALLY playing source, never the offer', () => {
    // Mid-chain after a failure: the 720 encode is what plays.
    expect(playingResolution(sources, V720)).toBe(720);
    expect(playingResolution(sources, V1080)).toBe(1080);
    // A fallback URL that ends up playing (the theme-level
    // fallback) matches no source, so the chip is omitted —
    // never faked at 1080p.
    expect(playingResolution(sources, VIDEO)).toBeNull();
    expect(playingResolution(sources, null)).toBeNull();
  });

  it('artwork shows under the player until frames render for the source', () => {
    expect(
      watchArtworkUnderPlayer({ hasArtwork: true, framesRendered: false }),
    ).toBe(true);
    expect(
      watchArtworkUnderPlayer({ hasArtwork: true, framesRendered: true }),
    ).toBe(false);
    expect(
      watchArtworkUnderPlayer({ hasArtwork: false, framesRendered: false }),
    ).toBe(false);
  });
});

describe('surface-readiness gate — the 2026-11-11 video fix', () => {
  it('a watch play HOLDS until the bound surface renders a frame', () => {
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'primary',
        surfaceReady: false,
      }),
    ).toBe('hold');
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'primary',
        surfaceReady: true,
      }),
    ).toBe('play');
  });

  it('sound-only video candidates NEVER wait for a frame (untouchable)', () => {
    // The listen chain's video files — the tagged hidden-video
    // last resort AND any video file the chain walks to — play
    // through the hidden surface with no frame by design.
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'hidden-video',
        surfaceReady: false,
      }),
    ).toBe('play');
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'audio-fallback',
        surfaceReady: false,
      }),
    ).toBe('play');
  });

  it('readiness is per player instance: an identity change forgets it', () => {
    // Same instance keeps its readiness.
    expect(
      surfaceReadinessAfterSwap({
        previousPlayerKey: 'p1',
        nextPlayerKey: 'p1',
        readyPlayerKey: 'p1',
      }),
    ).toEqual({ ready: true, readyPlayerKey: 'p1' });
    // A new instance starts unready even though the old one was.
    expect(
      surfaceReadinessAfterSwap({
        previousPlayerKey: 'p1',
        nextPlayerKey: 'p2',
        readyPlayerKey: 'p1',
      }),
    ).toEqual({ ready: false, readyPlayerKey: 'p1' });
    // Readiness recorded FOR the new instance counts (its first
    // frame fired as it took over).
    expect(
      surfaceReadinessAfterSwap({
        previousPlayerKey: 'p1',
        nextPlayerKey: 'p2',
        readyPlayerKey: 'p2',
      }),
    ).toEqual({ ready: true, readyPlayerKey: 'p2' });
    // No surface player at all → unready, stale key dropped.
    expect(
      surfaceReadinessAfterSwap({
        previousPlayerKey: 'p1',
        nextPlayerKey: null,
        readyPlayerKey: 'p1',
      }),
    ).toEqual({ ready: false, readyPlayerKey: null });
  });

  it('a held play still trips the stall watchdog (never hangs forever)', () => {
    // While the gate holds, the engine stays in `loading`, so the
    // ordinary watchdog snapshot trips after the stall window and
    // the chain advances through the existing failure path.
    const snap: WatchdogSnapshot = {
      now: PLAYBACK_STALL_WATCHDOG_MS + 1_000,
      loadingSince: 0,
      armedFrom: 0,
      hasSource: true,
      failed: false,
      disabled: false,
    };
    expect(watchdogShouldTrip(snap)).toBe(true);
    // Before the window: no trip — the gate gets its chance.
    expect(watchdogShouldTrip({ ...snap, now: 1_000 })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Watch-fix (2026-11-11): failure attribution, single load, the     */
/* rebuilt stall watchdog and the gate's readyToPlay release.        */
/* Diagnosis: specs/WATCH-102-FAILURE-DIAGNOSIS.md (H1 + H2).        */
/* ------------------------------------------------------------------ */

const VIDEO_B = 'https://v.animethemes.moe/ChainsawMan-OP1.webm';

describe('failureAttributionDecision (T1 — one failure, one candidate)', () => {
  it('the KICK BACK sequence: A fails by promise, advances, then A’s duplicate status error must NOT kill B', () => {
    // 1. Candidate A's load promise rejects → handled, against A.
    let handled: ReadonlySet<string> = new Set<string>();
    expect(
      failureAttributionDecision({
        channel: 'promise',
        reportUrl: VIDEO,
        currentUrl: VIDEO,
        currentLoadSettled: false,
        handledUrls: handled,
      }),
    ).toBe('handle');
    handled = markFailureHandled(handled, VIDEO);

    // 2. The chain advanced: B is now the current load, in flight.
    //    A duplicate error for A arrives on the status channel —
    //    the channel cannot name its source, so it is attributed
    //    against the CURRENT load, whose promise has not settled:
    //    the promise channel owns in-flight failures → ignore.
    expect(
      failureAttributionDecision({
        channel: 'status',
        reportUrl: VIDEO_B,
        currentUrl: VIDEO_B,
        currentLoadSettled: false,
        handledUrls: handled,
      }),
    ).toBe('ignore');
    //    …and a report that names A while B is current is stale
    //    by currency alone → ignore.
    expect(
      failureAttributionDecision({
        channel: 'status',
        reportUrl: VIDEO,
        currentUrl: VIDEO_B,
        currentLoadSettled: false,
        handledUrls: handled,
      }),
    ).toBe('ignore');

    // 3. B survives: it settles, plays, and only a failure that is
    //    genuinely B's (post-settle status error) may handle it.
    expect(
      failureAttributionDecision({
        channel: 'status',
        reportUrl: VIDEO_B,
        currentUrl: VIDEO_B,
        currentLoadSettled: true,
        handledUrls: handled,
      }),
    ).toBe('handle');
  });

  it('a second report against an already-handled URL is ignored on every channel', () => {
    const handled = markFailureHandled(new Set<string>(), VIDEO);
    for (const channel of ['promise', 'status', 'watchdog', 'sync'] as const) {
      expect(
        failureAttributionDecision({
          channel,
          reportUrl: VIDEO,
          currentUrl: VIDEO,
          currentLoadSettled: true,
          handledUrls: handled,
        }),
      ).toBe('ignore');
    }
  });

  it('reports against a superseded URL are ignored; a watchdog report against the current URL handles', () => {
    expect(
      failureAttributionDecision({
        channel: 'promise',
        reportUrl: VIDEO,
        currentUrl: VIDEO_B,
        currentLoadSettled: false,
        handledUrls: new Set<string>(),
      }),
    ).toBe('ignore');
    expect(
      failureAttributionDecision({
        channel: 'watchdog',
        reportUrl: VIDEO_B,
        currentUrl: VIDEO_B,
        currentLoadSettled: false,
        handledUrls: new Set<string>(),
      }),
    ).toBe('handle');
    expect(
      failureAttributionDecision({
        channel: 'promise',
        reportUrl: null,
        currentUrl: VIDEO_B,
        currentLoadSettled: false,
        handledUrls: new Set<string>(),
      }),
    ).toBe('ignore');
  });

  it('markFailureHandled never mutates the previous set', () => {
    const before = new Set<string>();
    const after = markFailureHandled(before, VIDEO);
    expect(before.size).toBe(0);
    expect(after.has(VIDEO)).toBe(true);
  });
});

describe('videoLoadAction (T3 — exactly one load per URL)', () => {
  it('activation over a settled preload ADOPTS it — no second load is issued', () => {
    expect(
      videoLoadAction({
        candidateUrl: VIDEO,
        issuedUrl: VIDEO,
        issuedSettled: true,
      }),
    ).toBe('adopt');
  });

  it('activation while the preload is still in flight WAITS for that same load', () => {
    expect(
      videoLoadAction({
        candidateUrl: VIDEO,
        issuedUrl: VIDEO,
        issuedSettled: false,
      }),
    ).toBe('wait');
  });

  it('a fresh candidate (or a different URL in the player) ISSUES its load', () => {
    expect(
      videoLoadAction({
        candidateUrl: VIDEO,
        issuedUrl: null,
        issuedSettled: false,
      }),
    ).toBe('issue');
    expect(
      videoLoadAction({
        candidateUrl: VIDEO_B,
        issuedUrl: VIDEO,
        issuedSettled: true,
      }),
    ).toBe('issue');
  });
});

describe('stallShouldTrip (T2 — the rebuilt watchdog, owner numbers)', () => {
  const audioBase = {
    kind: 'audio' as const,
    stallSince: 0,
    hasStarted: false,
    hasSource: true,
    failed: false,
    disabled: false,
  };

  it('uses the owner grace: 30s audio / 60s video — never the old 4s', () => {
    expect(AUDIO_STALL_GRACE_MS).toBe(30_000);
    expect(VIDEO_STALL_GRACE_MS).toBe(60_000);
    // The old 4s budget would have tripped long ago; the new one
    // must not.
    expect(stallShouldTrip({ ...audioBase, now: 4_001 })).toBe(false);
    expect(stallShouldTrip({ ...audioBase, now: 29_999 })).toBe(false);
    expect(stallShouldTrip({ ...audioBase, now: 30_000 })).toBe(true);
    const videoBase = { ...audioBase, kind: 'video' as const };
    expect(stallShouldTrip({ ...videoBase, now: 30_000 })).toBe(false);
    expect(stallShouldTrip({ ...videoBase, now: 59_999 })).toBe(false);
    expect(stallShouldTrip({ ...videoBase, now: 60_000 })).toBe(true);
  });

  it('a source that has STARTED is never killed for buffering, however long the stall', () => {
    // Playing, then a 20s mid-playback buffering episode (the
    // Dara Dara field case) — and even far beyond the grace.
    expect(
      stallShouldTrip({
        ...audioBase,
        hasStarted: true,
        stallSince: 100_000,
        now: 120_000,
      }),
    ).toBe(false);
    expect(
      stallShouldTrip({
        ...audioBase,
        kind: 'video',
        hasStarted: true,
        stallSince: 0,
        now: 600_000,
      }),
    ).toBe(false);
  });

  it('a progress blip restarts the stall clock (the episode is continuous-silence only)', () => {
    // Stalling since t=0, but progress at t=29s re-stamps the
    // episode start: at t=58.999s the CONTINUOUS silence is only
    // 29.999s → no trip; a full further second of silence trips.
    expect(stallShouldTrip({ ...audioBase, stallSince: 29_000, now: 58_999 })).toBe(
      false,
    );
    expect(stallShouldTrip({ ...audioBase, stallSince: 29_000, now: 59_000 })).toBe(
      true,
    );
  });

  it('never trips without a live, unfailed, never-started source in a stall', () => {
    expect(stallShouldTrip({ ...audioBase, stallSince: null, now: 99_000 })).toBe(false);
    expect(stallShouldTrip({ ...audioBase, hasSource: false, now: 99_000 })).toBe(false);
    expect(stallShouldTrip({ ...audioBase, failed: true, now: 99_000 })).toBe(false);
    expect(stallShouldTrip({ ...audioBase, disabled: true, now: 99_000 })).toBe(false);
  });
});

describe('watchSurfaceGateDecision — readyToPlay also releases (fix 4)', () => {
  it('a primary video play held for a frame is released when the player reports readyToPlay', () => {
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'primary',
        surfaceReady: false,
        playerReadyToPlay: true,
      }),
    ).toBe('play');
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'primary',
        surfaceReady: false,
        playerReadyToPlay: false,
      }),
    ).toBe('hold');
    // Default (argument omitted) keeps the pre-fix behaviour.
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'primary',
        surfaceReady: false,
      }),
    ).toBe('hold');
    // Non-primary roles were never gated and stay ungated.
    expect(
      watchSurfaceGateDecision({
        kind: 'video',
        role: 'hidden-video',
        surfaceReady: false,
        playerReadyToPlay: false,
      }),
    ).toBe('play');
  });
});

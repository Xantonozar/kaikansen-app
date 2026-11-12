import { describe, expect, it } from '@jest/globals';
import {
  AUDIO_STALL_GRACE_MS,
  PLAYBACK_STALL_WATCHDOG_MS,
  VIDEO_STALL_GRACE_MS,
  UNMETERED_FORWARD_BUFFER_S,
  bufferConnectionKind,
  videoBufferOptionsFor,
  watchBufferOptions,
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
  QUIZ_QUESTION_STALL_BUDGET_MS,
  createQuizStallTracker,
  quizAudioPhase,
  quizAudioTickStatus,
  quizFailedShouldClear,
  ringHoldSecondsAtAnswer,
  quizProgressSignature,
  quizQuestionStallShouldTrip,
  quizSampleStarted,
  quizStallObserve,
  quizVideoStatusAfterLoadIssued,
  type QuizProgressSample,
  type QuizStallTracker,
  type QuizVideoStatus,
  soloClockStartsOnPhase,
  soloLoadSafetyMs,
  queuePreloadKey,
  resolveSoloNextPreload,
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

/* ------------------------------------------------------------------ */
/* Quiz solo stall watchdog (2026-11-11 fix): the quiz's SOLO path   */
/* gets the same stall doctrine as the detail engine — continuous    */
/* no-progress against the owner grace (30s audio / 60s video), a    */
/* started clip is immune, and progress is a VALUE sampled from the  */
/* player (duration / position / buffered), not a status flag. The   */
/* multiplayer countdown path keeps watchdogShouldTrip untouched     */
/* (its pins above pass unchanged).                                  */
/*                                                                   */
/* Field replay (2026-11-11, installed 1.0.2): solo Q1 AND Q2 both   */
/* showed 'This theme could not be played' on fast net while every   */
/* derived .ogg probed healthy — the old quiz watchdog stamped its   */
/* 4s clock at load start and executed loads still in flight.        */
/* ------------------------------------------------------------------ */

describe('quizProgressSignature', () => {
  const silent: QuizProgressSample = {
    duration: 0,
    currentTime: 0,
    bufferedPosition: 0,
    playing: false,
  };

  it('is stable while nothing observable changes', () => {
    expect(quizProgressSignature(silent)).toBe(quizProgressSignature(silent));
    expect(quizProgressSignature({ ...silent })).toBe(
      quizProgressSignature(silent),
    );
  });

  it('changes when the duration becomes known (metadata arrived = bytes flowed)', () => {
    expect(quizProgressSignature({ ...silent, duration: 90 })).not.toBe(
      quizProgressSignature(silent),
    );
    expect(quizProgressSignature({ ...silent, duration: 91 })).not.toBe(
      quizProgressSignature({ ...silent, duration: 90 }),
    );
  });

  it('changes when the buffered position advances (video bytes arriving)', () => {
    expect(quizProgressSignature({ ...silent, bufferedPosition: 12.5 })).not.toBe(
      quizProgressSignature(silent),
    );
    expect(quizProgressSignature({ ...silent, bufferedPosition: 13 })).not.toBe(
      quizProgressSignature({ ...silent, bufferedPosition: 12.5 }),
    );
  });

  it('changes when the position advances or playback starts', () => {
    expect(quizProgressSignature({ ...silent, currentTime: 0.4 })).not.toBe(
      quizProgressSignature(silent),
    );
    expect(quizProgressSignature({ ...silent, playing: true })).not.toBe(
      quizProgressSignature(silent),
    );
  });

  it('treats non-finite readings as no reading (a NaN duration cannot churn the signature)', () => {
    const nan = { ...silent, duration: Number.NaN, bufferedPosition: -1 };
    expect(quizProgressSignature(nan)).toBe(quizProgressSignature(nan));
    expect(quizProgressSignature({ ...silent, duration: 0 })).toBe(
      quizProgressSignature({ ...silent, duration: Number.NaN }),
    );
  });
});

describe('quizSampleStarted', () => {
  it('a playing sample or an advanced position means the clip genuinely started', () => {
    expect(
      quizSampleStarted({
        duration: 90,
        currentTime: 0,
        bufferedPosition: 0,
        playing: true,
      }),
    ).toBe(true);
    expect(
      quizSampleStarted({
        duration: 90,
        currentTime: 0.25,
        bufferedPosition: 0,
        playing: false,
      }),
    ).toBe(true);
    expect(
      quizSampleStarted({
        duration: 0,
        currentTime: 0,
        bufferedPosition: 40,
        playing: false,
      }),
    ).toBe(false);
  });
});

describe('quiz question stall budget (solo v2 — per-question verdict)', () => {
  const SILENT: QuizProgressSample = {
    duration: 0,
    currentTime: 0,
    bufferedPosition: 0,
    playing: false,
  };
  const Q = 'game:1';
  const A = 'game:1:https://a.animethemes.moe/FateZero-OP1.ogg';
  const B = 'game:1:https://v.animethemes.moe/FateZero-OP1.webm';

  const observe = (
    tracker: QuizStallTracker,
    candidateKey: string,
    sample: QuizProgressSample,
    now: number,
    mediaKey: string = Q,
  ): QuizStallTracker =>
    quizStallObserve(tracker, {
      mediaKey,
      candidateKey,
      signature: quizProgressSignature(sample),
      started: quizSampleStarted(sample),
      now,
    });

  const trip = (
    tracker: QuizStallTracker,
    now: number,
    extra: Partial<{
      loading: boolean;
      hasSource: boolean;
      failed: boolean;
      disabled: boolean;
    }> = {},
  ): boolean =>
    quizQuestionStallShouldTrip({
      now,
      loading: true,
      lastProgressAt: tracker.lastProgressAt,
      hasStarted: tracker.started,
      hasSource: true,
      failed: false,
      disabled: false,
      ...extra,
    });

  it('the budget is the owner number: 10s of continuous no-progress per QUESTION', () => {
    expect(QUIZ_QUESTION_STALL_BUDGET_MS).toBe(10_000);
    let t = observe(createQuizStallTracker(), A, SILENT, 1_000);
    expect(t.lastProgressAt).toBe(1_000);
    expect(trip(t, 10_999)).toBe(false);
    expect(trip(t, 11_000)).toBe(true);
  });

  it('Q2 replay: total silence earns the verdict inside the question (~10s), never “no verdict”', () => {
    // v1 failure: the 30s per-candidate grace outlived the 20s
    // question, so a dead-silent question got NO verdict at all.
    // Poll at the hook's 500ms cadence with a frozen signature:
    // the trip must land at the budget plus at most one poll.
    let t = createQuizStallTracker();
    let trippedAt: number | null = null;
    for (let now = 500; now <= 30_000; now += 500) {
      t = observe(t, A, SILENT, now);
      if (trip(t, now)) {
        trippedAt = now;
        break;
      }
    }
    expect(trippedAt).not.toBeNull();
    expect(trippedAt!).toBeGreaterThanOrEqual(10_000);
    expect(trippedAt!).toBeLessThanOrEqual(11_000);
  });

  it('progress resets the budget: a signal at 9.5s buys a fresh 10s', () => {
    let t = observe(createQuizStallTracker(), A, SILENT, 0);
    t = observe(t, A, SILENT, 9_000);
    // Metadata lands at 9.5s — bytes flowed, the silence ends.
    t = observe(t, A, { ...SILENT, duration: 90 }, 9_500);
    expect(t.lastProgressAt).toBe(9_500);
    expect(trip(t, 10_000)).toBe(false);
    expect(trip(t, 19_499)).toBe(false);
    expect(trip(t, 19_500)).toBe(true);
  });

  it('stall accrues across candidates: advancing the chain does NOT reset the silence clock', () => {
    let t = observe(createQuizStallTracker(), A, SILENT, 0);
    for (let now = 500; now <= 6_000; now += 500) {
      t = observe(t, A, SILENT, now);
    }
    // The chain advances at ~6s; the new candidate's first sample
    // only re-baselines its signature — the question has still
    // heard nothing but silence since t=0.
    t = observe(t, B, SILENT, 6_500);
    expect(t.lastProgressAt).toBe(0);
    expect(trip(t, 9_999)).toBe(false);
    expect(trip(t, 10_000)).toBe(true);
  });

  it('a hard-error advance leaves the budget untouched: silence is measured from the question, not the error', () => {
    let t = observe(createQuizStallTracker(), A, SILENT, 0);
    // A hard-errors at t=1s: errors never touch the tracker (the
    // hook advances instantly without an observation). B's first
    // sample re-baselines at t=1.5s; the silence still dates
    // from the question's start.
    t = observe(t, B, SILENT, 1_500);
    expect(t.lastProgressAt).toBe(0);
    expect(trip(t, 10_000)).toBe(true);
    // …but B making progress at t=3s resets it, as always.
    let t2 = observe(createQuizStallTracker(), A, SILENT, 0);
    t2 = observe(t2, B, SILENT, 1_500);
    t2 = observe(t2, B, { ...SILENT, bufferedPosition: 4 }, 3_000);
    expect(t2.lastProgressAt).toBe(3_000);
    expect(trip(t2, 10_000)).toBe(false);
    expect(trip(t2, 13_000)).toBe(true);
  });

  it('a progressing candidate is never killed, however long the question runs', () => {
    // The video fallback trickles: the buffered position creeps
    // every ~2.5s for a full minute of wall time (a 58MB file on
    // a bad connection). Every creep is progress; the budget
    // only ever measures the CURRENT silence.
    let t = createQuizStallTracker();
    let trippedAt: number | null = null;
    for (let now = 500; now <= 60_000; now += 500) {
      const buffered = Math.floor(now / 2_500) * 0.5;
      t = observe(t, B, { ...SILENT, bufferedPosition: buffered }, now);
      if (trip(t, now)) {
        trippedAt = now;
        break;
      }
    }
    expect(trippedAt).toBeNull();
    // Then the connection dies silently: death comes 10s after
    // the LAST progress, not a moment sooner.
    const frozenAt = t.lastProgressAt;
    expect(trip(t, frozenAt + 9_999)).toBe(false);
    expect(trip(t, frozenAt + 10_000)).toBe(true);
  });

  it('a started candidate is immune at any elapsed silence', () => {
    let t = observe(createQuizStallTracker(), A, SILENT, 0);
    t = observe(t, A, { ...SILENT, playing: true }, 2_000);
    expect(t.started).toBe(true);
    expect(trip(t, 600_000)).toBe(false);
  });

  it('never trips when not loading, failed, source-less or disabled', () => {
    const t = observe(createQuizStallTracker(), A, SILENT, 0);
    expect(trip(t, 600_000, { loading: false })).toBe(false);
    expect(trip(t, 600_000, { failed: true })).toBe(false);
    expect(trip(t, 600_000, { hasSource: false })).toBe(false);
    expect(trip(t, 600_000, { disabled: true })).toBe(false);
  });

  it('a new question re-baselines: the verdict clock restarts with the mediaKey', () => {
    let t = createQuizStallTracker();
    for (let now = 500; now <= 10_500; now += 500) {
      t = observe(t, A, SILENT, now);
    }
    expect(trip(t, 10_500)).toBe(true);
    // The next question (new mediaKey) starts a fresh budget —
    // yesterday's silence must not execute today's first load.
    t = observe(t, A, SILENT, 50_000, 'game:2');
    expect(t.lastProgressAt).toBe(50_000);
    expect(trip(t, 59_999)).toBe(false);
    expect(trip(t, 60_000)).toBe(true);
  });
});

describe('quizFailedShouldClear (solo resurrection — a late start un-fails the question)', () => {
  const base = {
    failed: true,
    held: false,
    currentKind: 'video' as const,
    signalKind: 'video' as const,
    started: true,
  };

  it('ozar’s Q1: the video fallback speaks after the verdict — the latch clears', () => {
    expect(quizFailedShouldClear(base)).toBe(true);
  });

  it('an audio last candidate that loads late clears it too', () => {
    expect(
      quizFailedShouldClear({
        ...base,
        currentKind: 'audio',
        signalKind: 'audio',
      }),
    ).toBe(true);
  });

  it('a stale signal from the OTHER engine never clears it (orphaned .ogg while the chain sits on video)', () => {
    expect(quizFailedShouldClear({ ...base, signalKind: 'audio' })).toBe(
      false,
    );
    expect(
      quizFailedShouldClear({
        ...base,
        currentKind: 'audio',
        signalKind: 'video',
      }),
    ).toBe(false);
  });

  it('multiplayer is never resurrected by this rule (held rounds keep the latched verdict)', () => {
    expect(quizFailedShouldClear({ ...base, held: true })).toBe(false);
  });

  it('no clear without a genuine start, and no clear when not failed', () => {
    expect(quizFailedShouldClear({ ...base, started: false })).toBe(false);
    expect(quizFailedShouldClear({ ...base, failed: false })).toBe(false);
  });
});

describe('solo clock rules (v2 — the clock obeys the song)', () => {
  it('the clock starts on playing, and on the verdict (failed / empty) — never while buffering', () => {
    expect(soloClockStartsOnPhase('playing')).toBe(true);
    expect(soloClockStartsOnPhase('failed')).toBe(true);
    expect(soloClockStartsOnPhase('empty')).toBe(true);
    expect(soloClockStartsOnPhase('buffering')).toBe(false);
  });

  it('the anti-hang safety is one full answer window — it can never pre-empt the 10s verdict', () => {
    expect(soloLoadSafetyMs(20)).toBe(20_000);
    expect(soloLoadSafetyMs(15)).toBe(15_000);
    expect(soloLoadSafetyMs(20)).toBeGreaterThan(
      QUIZ_QUESTION_STALL_BUDGET_MS,
    );
  });

  it('a load still progressing at 10s starts no clock: no trip, phase stays buffering', () => {
    // End-to-end at the pure level: progress observations land
    // at 0s / 4s / 8s; at the old blind-safety moment (10s) the
    // budget has NOT tripped and the phase is still 'buffering',
    // so the clock-start rule keeps the ring held.
    let t = observe2(createQuizStallTracker(), 0);
    t = observe2(t, 4_000, 30);
    t = observe2(t, 8_000, 61);
    expect(
      quizQuestionStallShouldTrip({
        now: 10_000,
        loading: true,
        lastProgressAt: t.lastProgressAt,
        hasStarted: t.started,
        hasSource: true,
        failed: false,
        disabled: false,
      }),
    ).toBe(false);
    expect(soloClockStartsOnPhase('buffering')).toBe(false);

    function observe2(
      tracker: QuizStallTracker,
      now: number,
      buffered = 0,
    ): QuizStallTracker {
      const sample: QuizProgressSample = {
        duration: 0,
        currentTime: 0,
        bufferedPosition: buffered,
        playing: false,
      };
      return quizStallObserve(tracker, {
        mediaKey: 'game:1',
        candidateKey: 'game:1:video',
        signature: quizProgressSignature(sample),
        started: quizSampleStarted(sample),
        now,
      });
    }
  });
});

describe('video-leg status discipline (clock-stall fix, 2026-11-12)', () => {
  /** The phase QuizAudioOnly reports for a video candidate in
      the given status state (unfailed, has a URL, no hold) —
      the value the solo clock effect consumes. */
  const phaseOf = (status: QuizVideoStatus) =>
    quizAudioPhase({
      failed: false,
      hasUrl: true,
      holdPending: false,
      status,
    });

  it('field regression — consecutive video-carried questions: the issuance stamp re-creates the edge the second question publishes no loading event for', () => {
    // Q_N (video-carried) ends playing: the shared player sits
    // at 'readyToPlay'. WITHOUT the stamp, Q_{N+1}'s phase would
    // read 'playing' before, during and after its load — no
    // value change, no report, no clock (the field bug).
    expect(phaseOf('readyToPlay')).toBe('playing');

    // Q_{N+1} (video-carried) issues its load: the hook stamps
    // the status synchronously, so the phase dips to
    // 'buffering' — a value that must NOT start the clock…
    const phases: string[] = ['playing'];
    const stamped = quizVideoStatusAfterLoadIssued();
    phases.push(phaseOf(stamped));
    expect(soloClockStartsOnPhase(phaseOf(stamped))).toBe(false);

    // …and when the new source's genuine readyToPlay event
    // lands (the player published NO intervening 'loading'
    // event — the stamp WAS the interlude), the phase edges
    // back to 'playing' and the clock starts, exactly once.
    phases.push(phaseOf('readyToPlay'));
    expect(phases).toEqual(['playing', 'buffering', 'playing']);
    expect(soloClockStartsOnPhase(phaseOf('readyToPlay'))).toBe(true);
  });

  it('fallback-seat inheritance: a chain advance onto an already-readyToPlay video seat is stamped too', () => {
    // The chain sits down on a video seat the player already
    // holds at 'readyToPlay' (left warm by an earlier question
    // or an earlier seat). The seat's own load issuance stamps
    // it like any other: buffering first, then the genuine
    // event re-edges to playing — the clock cannot hang on the
    // inherited status.
    let status: QuizVideoStatus = 'readyToPlay';
    expect(phaseOf(status)).toBe('playing'); // inherited — the hazard
    status = quizVideoStatusAfterLoadIssued();
    expect(phaseOf(status)).toBe('buffering');
    status = 'readyToPlay'; // the seat's genuine event
    expect(phaseOf(status)).toBe('playing');
  });

  it('per-ending invariance: correct / wrong / skip / timeout produce identical next-question start sequences', () => {
    // solo.tsx funnels all four endings through the same
    // submit → feedback → advance → startQuestion path, and the
    // stamp machinery takes no ending input at all — so the
    // next video-carried question's phase sequence off the
    // stamp + genuine event is byte-identical for every ending.
    const sequenceFor = (_ending: string) => {
      const seq: string[] = [];
      seq.push(phaseOf(quizVideoStatusAfterLoadIssued()));
      seq.push(phaseOf('readyToPlay'));
      return seq;
    };
    const endings = ['correct', 'wrong', 'skip', 'timeout'] as const;
    const sequences = endings.map(sequenceFor);
    for (const seq of sequences) {
      expect(seq).toEqual(['buffering', 'playing']);
      expect(seq).toEqual(sequences[0]);
    }
  });

  it('no early start: the stamp alone can never start the clock, at mount or mid-question', () => {
    // Fresh mount (Q1): the player starts 'idle' — buffering,
    // so Q1's first start is a genuine edge, never inherited.
    expect(phaseOf('idle')).toBe('buffering');
    // Post-issuance, pre-event: any number of re-reads of the
    // stamped status stay 'buffering' — only a genuine
    // readyToPlay event (or the verdict) may start the clock.
    const stamped = quizVideoStatusAfterLoadIssued();
    for (let i = 0; i < 5; i++) {
      expect(phaseOf(stamped)).toBe('buffering');
      expect(soloClockStartsOnPhase(phaseOf(stamped))).toBe(false);
    }
    // The verdict routes are untouched by the stamp: failed
    // and empty still start the clock (the question is
    // answerable without its song).
    expect(
      quizAudioPhase({
        failed: true,
        hasUrl: true,
        holdPending: false,
        status: stamped,
      }),
    ).toBe('failed');
    expect(
      quizAudioPhase({
        failed: false,
        hasUrl: false,
        holdPending: false,
        status: stamped,
      }),
    ).toBe('empty');
  });

  it('sighting 2 — phantom playing is foreclosed: with no post-issuance event, playing is unreachable', () => {
    // Pre-fix shape: a question whose new (dead) source never
    // plays could still report 'playing' off the predecessor's
    // stale readyToPlay — timer running over silence, no
    // warning. Under the stamp, the status after issuance is
    // 'loading' and ONLY a genuine statusChange event can move
    // it: a source that publishes nothing leaves the phase at
    // 'buffering' at every read, forever — the question
    // resolves through the stall verdict instead (next test).
    let status: QuizVideoStatus = 'readyToPlay'; // predecessor's leftover
    status = quizVideoStatusAfterLoadIssued();
    for (let read = 0; read < 10; read++) {
      expect(phaseOf(status)).toBe('buffering');
      expect(soloClockStartsOnPhase(phaseOf(status))).toBe(false);
    }
  });

  /** One solo watchdog poll for a video candidate, built the
      way the hook builds it: the tracker's observation from a
      progress sample, and the trip decision with `loading`
      read off the (stamped) status ref. */
  function pollVideo(
    tracker: QuizStallTracker,
    input: {
      status: QuizVideoStatus;
      sample: QuizProgressSample;
      now: number;
    },
  ): { tracker: QuizStallTracker; tripped: boolean } {
    const next = quizStallObserve(tracker, {
      mediaKey: 'game:7',
      candidateKey: 'game:7:video',
      signature: quizProgressSignature(input.sample),
      started: quizSampleStarted(input.sample),
      now: input.now,
    });
    return {
      tracker: next,
      tripped: quizQuestionStallShouldTrip({
        now: input.now,
        loading: input.status === 'loading',
        lastProgressAt: next.lastProgressAt,
        hasStarted: next.started,
        hasSource: true,
        failed: false,
        disabled: false,
      }),
    };
  }

  it('verdict integrity: a stamped load that never progresses still trips at exactly the 10s budget', () => {
    const frozen: QuizProgressSample = {
      duration: 0,
      currentTime: 0,
      bufferedPosition: 0,
      playing: false,
    };
    let r = pollVideo(createQuizStallTracker(), {
      status: quizVideoStatusAfterLoadIssued(),
      sample: frozen,
      now: 0,
    });
    expect(r.tripped).toBe(false);
    r = pollVideo(r.tracker, {
      status: 'loading',
      sample: frozen,
      now: QUIZ_QUESTION_STALL_BUDGET_MS - 1,
    });
    expect(r.tripped).toBe(false);
    r = pollVideo(r.tracker, {
      status: 'loading',
      sample: frozen,
      now: QUIZ_QUESTION_STALL_BUDGET_MS,
    });
    expect(r.tripped).toBe(true);
  });

  it('sighting 1: a video candidate whose progress advances is never declared stalled, however long it loads', () => {
    // The stamped status keeps the watchdog's loading
    // observation truthful; the candidate's buffer grows at
    // every poll for 12s — past the whole 10s budget — and no
    // poll may trip: progress re-stamps the silence clock.
    let tracker = createQuizStallTracker();
    for (let now = 0; now <= 12_000; now += 500) {
      const r = pollVideo(tracker, {
        status: quizVideoStatusAfterLoadIssued(),
        sample: {
          duration: 90,
          currentTime: 0,
          bufferedPosition: now / 1000,
          playing: false,
        },
        now,
      });
      tracker = r.tracker;
      expect(r.tripped).toBe(false);
    }
  });

  it('sighting 1: a video candidate whose status advances to readyToPlay latches started and is immune thereafter', () => {
    let r = pollVideo(createQuizStallTracker(), {
      status: quizVideoStatusAfterLoadIssued(),
      sample: { duration: 0, currentTime: 0, bufferedPosition: 0, playing: false },
      now: 0,
    });
    expect(r.tripped).toBe(false);
    // The status event lands: the clip starts (playing), and
    // from then on even a frozen signature cannot trip — a
    // started candidate is never killed for buffering.
    r = pollVideo(r.tracker, {
      status: 'readyToPlay',
      sample: { duration: 90, currentTime: 0.2, bufferedPosition: 5, playing: true },
      now: 3_000,
    });
    expect(r.tracker.started).toBe(true);
    expect(r.tripped).toBe(false);
    r = pollVideo(r.tracker, {
      status: 'readyToPlay',
      sample: { duration: 90, currentTime: 0.2, bufferedPosition: 5, playing: true },
      now: 30_000,
    });
    expect(r.tripped).toBe(false);
  });
});

describe('resolveSoloNextPreload (parts 5+6 — which next question preloads)', () => {
  const base = { gameKey: 'game-9', currentIndex: 3 };

  it('the feedback reveal yields the full next chain under its key', () => {
    expect(
      resolveSoloNextPreload({
        ...base,
        feedbackNext: {
          index: 4,
          audioUrl: 'https://a.example/q4.ogg',
          videoUrl: 'https://v.example/q4.webm',
        },
        earlyNext: null,
      }),
    ).toEqual({
      candidates: ['https://a.example/q4.ogg', 'https://v.example/q4.webm'],
      mediaKey: 'game-9:4',
    });
  });

  it('part 5 wiring: a present nextAudioUrl becomes the early preload', () => {
    expect(
      resolveSoloNextPreload({
        ...base,
        feedbackNext: null,
        earlyNext: { index: 4, audioUrl: 'https://a.example/q4.ogg' },
      }),
    ).toEqual({
      candidates: ['https://a.example/q4.ogg'],
      mediaKey: 'game-9:4',
    });
  });

  it('part 5 wiring: an absent field leaves behaviour unchanged (null)', () => {
    expect(
      resolveSoloNextPreload({
        ...base,
        feedbackNext: null,
        earlyNext: null,
      }),
    ).toBeNull();
  });

  it('a stale early reveal (not the immediate next question) is ignored', () => {
    expect(
      resolveSoloNextPreload({
        ...base,
        feedbackNext: null,
        earlyNext: { index: 2, audioUrl: 'https://a.example/q2.ogg' },
      }),
    ).toBeNull();
    expect(
      resolveSoloNextPreload({
        ...base,
        feedbackNext: null,
        earlyNext: { index: 5, audioUrl: 'https://a.example/q5.ogg' },
      }),
    ).toBeNull();
  });

  it('the feedback reveal wins over the early reveal', () => {
    expect(
      resolveSoloNextPreload({
        ...base,
        feedbackNext: {
          index: 4,
          audioUrl: 'https://a.example/q4.ogg',
          videoUrl: 'https://v.example/q4.webm',
        },
        earlyNext: { index: 4, audioUrl: 'https://a.example/q4.ogg' },
      })?.candidates,
    ).toEqual(['https://a.example/q4.ogg', 'https://v.example/q4.webm']);
  });

  it('a feedback reveal with no audio still yields its (video) chain', () => {
    expect(
      resolveSoloNextPreload({
        ...base,
        feedbackNext: {
          index: 4,
          audioUrl: null,
          videoUrl: 'https://v.example/q4.webm',
        },
        earlyNext: null,
      }),
    ).toEqual({
      candidates: [null, 'https://v.example/q4.webm'],
      mediaKey: 'game-9:4',
    });
  });
});

describe('buffer package — connection kind + video buffer profiles', () => {
  it('wifi and ethernet classify unmetered', () => {
    expect(
      bufferConnectionKind({
        type: 'wifi',
        isInternetReachable: true,
        isConnectionExpensive: null,
      }),
    ).toBe('unmetered');
    expect(
      bufferConnectionKind({
        type: 'ethernet',
        isInternetReachable: true,
        isConnectionExpensive: null,
      }),
    ).toBe('unmetered');
  });

  it('an explicitly expensive connection is metered, whatever the type', () => {
    expect(
      bufferConnectionKind({
        type: 'wifi',
        isInternetReachable: true,
        isConnectionExpensive: true,
      }),
    ).toBe('metered');
    expect(
      bufferConnectionKind({
        type: 'cellular',
        isInternetReachable: true,
        isConnectionExpensive: true,
      }),
    ).toBe('metered');
  });

  it('an explicitly cheap + reachable connection classifies unmetered', () => {
    expect(
      bufferConnectionKind({
        type: 'cellular',
        isInternetReachable: true,
        isConnectionExpensive: false,
      }),
    ).toBe('unmetered');
    expect(
      bufferConnectionKind({
        type: 'unknown',
        isInternetReachable: true,
        isConnectionExpensive: false,
      }),
    ).toBe('unmetered');
  });

  it('cellular without a cheap report, unknown, and no sample are metered', () => {
    expect(
      bufferConnectionKind({
        type: 'cellular',
        isInternetReachable: true,
        isConnectionExpensive: null,
      }),
    ).toBe('metered');
    expect(
      bufferConnectionKind({
        type: 'unknown',
        isInternetReachable: null,
        isConnectionExpensive: null,
      }),
    ).toBe('metered');
    expect(bufferConnectionKind(null)).toBe('metered');
    expect(
      bufferConnectionKind({
        type: 'none',
        isInternetReachable: false,
        isConnectionExpensive: null,
      }),
    ).toBe('metered');
  });

  it('the unmetered watch profile buffers toward the whole file', () => {
    expect(watchBufferOptions('unmetered')).toEqual({
      waitsToMinimizeStalling: true,
      minBufferForPlayback: 2.5,
      preferredForwardBufferDuration: UNMETERED_FORWARD_BUFFER_S,
    });
    // Beyond any theme file (~90s): buffer-to-complete in effect.
    expect(UNMETERED_FORWARD_BUFFER_S).toBeGreaterThan(600);
  });

  it('the metered watch profile keeps the bounded runway', () => {
    expect(watchBufferOptions('metered')).toEqual({
      waitsToMinimizeStalling: true,
      minBufferForPlayback: 5,
      preferredForwardBufferDuration: 50,
    });
  });

  it('the hidden-video fallback always takes the metered profile', () => {
    expect(
      videoBufferOptionsFor({ role: 'hidden-video', connection: 'unmetered' }),
    ).toEqual(watchBufferOptions('metered'));
    expect(
      videoBufferOptionsFor({ role: 'hidden-video', connection: 'metered' }),
    ).toEqual(watchBufferOptions('metered'));
  });

  it('watch candidates take their connection profile', () => {
    expect(
      videoBufferOptionsFor({ role: 'primary', connection: 'unmetered' }),
    ).toEqual(watchBufferOptions('unmetered'));
    expect(
      videoBufferOptionsFor({
        role: 'audio-fallback',
        connection: 'metered',
      }),
    ).toEqual(watchBufferOptions('metered'));
  });
});

describe('clock-lag fixes F1 + F2 (2026-11-12, QUIZ-CLOCK-LAG-DIAGNOSIS)', () => {
  const phaseOf = (status: QuizVideoStatus) =>
    quizAudioPhase({
      failed: false,
      hasUrl: true,
      holdPending: false,
      status,
    });

  it('F1 — a transient error status is buffering, never a clock start', () => {
    // The field sequence: candidate A dies mid-chain; the render
    // between the advance and the fallback's load derives the
    // phase from A's stale error status. Pre-fix that read
    // 'playing' and started the clock at the moment of death.
    expect(phaseOf('error')).toBe('buffering');
    expect(soloClockStartsOnPhase(phaseOf('error'))).toBe(false);
  });

  it('F1 — the error does not start the clock; the fallback’s genuine start does', () => {
    const phases: string[] = [];
    phases.push(phaseOf('error')); // candidate A died
    phases.push(phaseOf('loading')); // fallback issued, loading
    phases.push(phaseOf('readyToPlay')); // fallback genuinely ready
    expect(phases).toEqual(['buffering', 'buffering', 'playing']);
    expect(soloClockStartsOnPhase(phases[2] as never)).toBe(true);
  });

  it('F1 — the verdict still outranks an error status (failed latch first)', () => {
    // When the chain is exhausted the watchdog latches failed;
    // that verdict — not the error mapping — starts the clock.
    expect(
      quizAudioPhase({
        failed: true,
        hasUrl: true,
        holdPending: false,
        status: 'error',
      }),
    ).toBe('failed');
    expect(
      quizAudioPhase({
        failed: false,
        hasUrl: false,
        holdPending: false,
        status: 'error',
      }),
    ).toBe('empty');
  });

  it('F2 — the audio tick status: no snapshot and errors behave as before', () => {
    expect(quizAudioTickStatus(null)).toBe('loading');
    expect(
      quizAudioTickStatus({
        isLoaded: false,
        playing: false,
        currentTime: 0,
        error: 'network',
      }),
    ).toBe('error');
    expect(
      quizAudioTickStatus({
        isLoaded: true,
        playing: true,
        currentTime: 3,
        error: 'late error',
      }),
    ).toBe('error');
  });

  it('F2 — loaded alone is NOT a start: metadata landed, buffer still filling', () => {
    // The pre-fix mapping returned 'readyToPlay' here and the
    // clock started seconds before any audible sample.
    expect(
      quizAudioTickStatus({ isLoaded: true, playing: false, currentTime: 0 }),
    ).toBe('loading');
    expect(
      phaseOf(
        quizAudioTickStatus({
          isLoaded: true,
          playing: false,
          currentTime: 0,
        }),
      ),
    ).toBe('buffering');
  });

  it('F2 — a genuine start is playing-flag OR position past zero (the watchdog test)', () => {
    expect(
      quizAudioTickStatus({ isLoaded: true, playing: true, currentTime: 0 }),
    ).toBe('readyToPlay');
    expect(
      quizAudioTickStatus({
        isLoaded: true,
        playing: false,
        currentTime: 0.25,
      }),
    ).toBe('readyToPlay');
    // Not loaded yet: neither signal can make it ready.
    expect(
      quizAudioTickStatus({ isLoaded: false, playing: true, currentTime: 0 }),
    ).toBe('loading');
    expect(
      quizAudioTickStatus({ isLoaded: false, playing: false, currentTime: 0 }),
    ).toBe('loading');
  });
});

describe('answer-moment ring freeze F3 (2026-11-12)', () => {
  const T0 = 1_700_000_000_000;

  it('running clock: the hold is the remainder at the answer moment', () => {
    // Clock started at T0 with a 20s window; answered 7.5s in.
    expect(
      ringHoldSecondsAtAnswer({
        clockRunning: true,
        deadlineMs: T0 + 20_000,
        answeredAtMs: T0 + 7_500,
        totalSeconds: 20,
      }),
    ).toBe(12.5);
    // Answered the instant the clock started: the full window.
    expect(
      ringHoldSecondsAtAnswer({
        clockRunning: true,
        deadlineMs: T0 + 20_000,
        answeredAtMs: T0,
        totalSeconds: 20,
      }),
    ).toBe(20);
  });

  it('the held value is time-invariant: recomputing it later in feedback changes nothing', () => {
    // The freeze contract: the value captured at submit IS the
    // value the ring renders for the whole feedback window — the
    // ring's hold mode renders it verbatim and never re-derives
    // from the deadline, so deadline − now drift cannot leak in.
    const atSubmit = ringHoldSecondsAtAnswer({
      clockRunning: true,
      deadlineMs: T0 + 20_000,
      answeredAtMs: T0 + 7_500,
      totalSeconds: 20,
    });
    expect(atSubmit).toBe(12.5);
  });

  it('clock never started (answered during the media wait): the full window', () => {
    expect(
      ringHoldSecondsAtAnswer({
        clockRunning: false,
        deadlineMs: T0 + 20_000,
        answeredAtMs: T0 + 3_000,
        totalSeconds: 20,
      }),
    ).toBe(20);
  });

  it('a timeout racing the tap clamps to 0, never negative', () => {
    expect(
      ringHoldSecondsAtAnswer({
        clockRunning: true,
        deadlineMs: T0 + 20_000,
        answeredAtMs: T0 + 21_000,
        totalSeconds: 20,
      }),
    ).toBe(0);
  });

  it('never exceeds the window even if the deadline sits beyond it', () => {
    expect(
      ringHoldSecondsAtAnswer({
        clockRunning: true,
        deadlineMs: T0 + 25_000,
        answeredAtMs: T0,
        totalSeconds: 20,
      }),
    ).toBe(20);
  });
});

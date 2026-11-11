/**
 * Media engine routing + stall watchdog (playback plan,
 * 2026-11-10): the candidate chain is routed BY FILE TYPE within
 * the same chain — real audio files play through expo-audio,
 * video files play through expo-video — and a source stuck in
 * `loading` advances the chain exactly like a hard error does.
 * This module is the PURE half of that machinery: no native
 * imports, so every decision here is unit-testable (the hooks in
 * usePlayback.ts / QuizMedia.tsx feed it live snapshots; the
 * engines themselves stay thin adapters over the two players).
 */

/**
 * The stall watchdog budget (playback plan decision 4): a source
 * that stays in `loading` for this long without reaching playing
 * is treated as failed — the chain advances through the same
 * failure path a hard error takes. As of the 2026-11-11 watch
 * fix this budget governs the quiz MULTIPLAYER countdown path
 * (whose arming is built on it, via watchdogShouldTrip below);
 * the detail/player engine uses the kind-based grace +
 * started-source immunity in the watch-fix section
 * (stallShouldTrip), and the quiz SOLO path judges stalls by
 * a per-question budget through the quiz-solo section
 * (quizStallObserve / quizQuestionStallShouldTrip) further
 * below.
 */
export const PLAYBACK_STALL_WATCHDOG_MS = 4000;

/**
 * Which native engine owns a candidate source. Audio extensions
 * route to expo-audio; everything else (extension-less or a video
 * extension) routes to expo-video. Local downloads keep their
 * file:// URIs — the extension test strips query/hash first, so
 * CDN URLs carrying signatures classify like their bare paths.
 */
export type MediaEngineKind = 'audio' | 'video';

const AUDIO_EXTENSIONS = [
  '.ogg',
  '.mp3',
  '.m4a',
  '.aac',
  '.opus',
  '.flac',
  '.wav',
  '.oga',
] as const;

export function mediaKindForUrl(url: string): MediaEngineKind {
  const path = url.split(/[?#]/)[0].toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => path.endsWith(ext))
    ? 'audio'
    : 'video';
}

/**
 * One candidate of a playback chain: where it lives, which
 * engine owns it, and the role it plays in the chain.
 *
 * Roles (the doctrine's vocabulary, unchanged by this plan):
 * - 'primary' — the chain's first candidate;
 * - 'audio-fallback' — a listen candidate beyond the first, in
 *   particular the W2 target (the .ogg) when a watch chain
 *   degrades to the listen chain;
 * - 'hidden-video' — a VIDEO file reached as an AUDIO candidate
 *   (the untouchable hidden-video fallback: played through
 *   expo-video with no visible surface, sound only).
 */
export interface MediaCandidate {
  url: string;
  kind: MediaEngineKind;
  role: 'primary' | 'audio-fallback' | 'hidden-video';
}

/**
 * Tag a chain of candidate URLs with their engine kind + role.
 *
 * `purpose` says what the chain is FOR:
 * - 'watch': every candidate is a video candidate (the watch
 *   chain); an audio file appearing here (defensive — the watch
 *   chain is built from video sources) still routes by file type,
 *   with the plain fallback role.
 * - 'listen': candidates are audio candidates in doctrine order;
 *   a VIDEO file in this chain is the hidden-video last resort —
 *   routed to expo-video, tagged so the surface keeps it hidden.
 * - 'chain' (the W2 degradation): the listen chain served in
 *   place of an exhausted watch chain; the first audio candidate
 *   is the audio-fallback target, and a video file is again the
 *   hidden-video last resort.
 */
export function tagCandidates(
  urls: readonly string[],
  purpose: 'watch' | 'listen' | 'chain',
): MediaCandidate[] {
  return urls.map((url, index) => {
    const kind = mediaKindForUrl(url);
    let role: MediaCandidate['role'] = index === 0 ? 'primary' : 'audio-fallback';
    if (kind === 'video' && purpose !== 'watch') {
      role = 'hidden-video';
    }
    return { url, kind, role };
  });
}

/**
 * The preload slot a surface keeps beside its live player
 * (playback plan: mode-matched preload on theme detail, the
 * quiz countdown preload, the solo next-question preload, and
 * the problem-3 queue next-track preload). One preload slot per
 * surface/engine family; `ready` flips when the source has
 * loaded far enough to start near-instantly on tap.
 */
export interface PreloadTicket {
  /** Identity of the intent (theme/entry/question key). */
  key: string;
  url: string;
  kind: MediaEngineKind;
  ready: boolean;
}

/** A fresh ticket for a preload that has not finished loading. */
export function createPreloadTicket(
  key: string,
  url: string,
): PreloadTicket {
  return { key, url, kind: mediaKindForUrl(url), ready: false };
}

/**
 * Whether a tap should CONSUME the preload (play from the
 * preloaded handle) rather than load fresh: the ticket must be
 * for the same intent key AND the same URL — a different entry
 * or a mode switch never reuses a stale preload.
 */
export function preloadMatches(
  ticket: PreloadTicket | null,
  key: string,
  url: string,
): boolean {
  return ticket !== null && ticket.key === key && ticket.url === url;
}

/**
 * The chain candidate a preload should target: the FIRST
 * audio-kind candidate (the doctrine's .ogg-first order means
 * it is normally candidate 0). Video candidates are never
 * preloaded by the audio preload path — a round/entry whose
 * first candidate is a video file keeps its expo-video hold
 * path instead (see `firstCandidateIsVideo`).
 */
export function pickPreloadCandidate(
  candidates: readonly MediaCandidate[],
): MediaCandidate | null {
  return candidates.find((c) => c.kind === 'audio') ?? null;
}

/** True when the chain leads with a video file (no .ogg ahead). */
export function firstCandidateIsVideo(
  candidates: readonly MediaCandidate[],
): boolean {
  return candidates.length > 0 && candidates[0].kind === 'video';
}

/** The next-question preload target the solo screen hands the
    quiz hook: candidates + the mediaKey they belong to. */
export interface SoloNextPreload {
  candidates: (string | null)[];
  mediaKey: string;
}

/**
 * Which NEXT question the solo screen preloads right now (the
 * playback plan + quiz total solution parts 5/6, 2026-11-11).
 *
 * Two reveals can name the next question:
 * - the FEEDBACK reveal: the answer response carries the whole
 *   next question, so its full chain (audio, then the video
 *   fallback) is the preload source — the original mechanism;
 * - the EARLY reveal (part 5): the playback-start signal's
 *   response carries only the next question's audio URL, known
 *   a whole question earlier.
 * The feedback reveal wins when both exist (fresher, full
 * chain). The early reveal counts only when it names the
 * question immediately after the CURRENT one — a stale early
 * reveal from an earlier question is ignored. Neither reveal →
 * no preload (the next question loads fresh, as before either
 * existed). Both reveals feed the SAME downstream mechanism
 * (the hook's next-question effect → the part-6 slice prefetch),
 * deduped there by mediaKey + URL.
 */
export function resolveSoloNextPreload(input: {
  gameKey: string;
  currentIndex: number;
  feedbackNext: {
    index: number;
    audioUrl: string | null;
    videoUrl: string | null;
  } | null;
  earlyNext: { index: number; audioUrl: string } | null;
}): SoloNextPreload | null {
  if (input.feedbackNext) {
    return {
      candidates: [input.feedbackNext.audioUrl, input.feedbackNext.videoUrl],
      mediaKey: `${input.gameKey}:${input.feedbackNext.index}`,
    };
  }
  if (input.earlyNext && input.earlyNext.index === input.currentIndex + 1) {
    return {
      candidates: [input.earlyNext.audioUrl],
      mediaKey: `${input.gameKey}:${input.earlyNext.index}`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Stall watchdog (pure decision core)                                 */
/* ------------------------------------------------------------------ */

/**
 * The watchdog snapshot the hooks build from their players each
 * status tick — deliberately tiny so the decision below stays a
 * pure function of it.
 *
 * - `loadingSince`: epoch ms when the current source entered
 *   `loading`; null when the player is not loading.
 * - `armedFrom`: epoch ms from which the watchdog may run —
 *   the intended start moment. On the multiplayer countdown the
 *   audio is intentionally HELD until the round's startedAt, so
 *   the countdown surfaces pass that moment here: a held load
 *   can never trip the watchdog before play was even meant to
 *   begin.
 * - `disabled`: a paused/idle consumer (or an engine with no
 *   source loaded) reports disabled and never trips.
 */
export interface WatchdogSnapshot {
  now: number;
  loadingSince: number | null;
  armedFrom: number;
  hasSource: boolean;
  failed: boolean;
  disabled: boolean;
}

/**
 * Should the chain advance NOW because the current source has
 * stalled? Trips only when ALL hold:
 * - a source is loaded and has not already failed;
 * - it has been in `loading` for at least the watchdog budget;
 * - the watchdog's arm moment is at least the budget in the
 *   past too (the countdown-hold guard: time spent intentionally
 *   held before the start moment never counts).
 */
export function watchdogShouldTrip(snap: WatchdogSnapshot): boolean {
  if (snap.disabled || snap.failed || !snap.hasSource) return false;
  if (snap.loadingSince === null) return false;
  if (snap.now - snap.loadingSince < PLAYBACK_STALL_WATCHDOG_MS) {
    return false;
  }
  if (snap.now - snap.armedFrom < PLAYBACK_STALL_WATCHDOG_MS) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Watch fix (2026-11-11) — failure attribution, single-load         */
/* decision, and the detail/player stall watchdog.                   */
/*                                                                   */
/* Diagnosis: WATCH-102-FAILURE-DIAGNOSIS.md (H1/H2). The QUIZ       */
/* engine keeps the watchdog above unchanged (its countdown-hold     */
/* arming depends on it); everything in this section is used ONLY    */
/* by the detail/player engine (usePlayback).                        */
/* ------------------------------------------------------------------ */

/**
 * The channels a source failure can be reported on. One physical
 * failure is typically reported TWICE — the load promise rejects
 * AND the player's status flips to 'error' — and the two reports
 * do not arrive atomically: the chain may already have advanced
 * when the second one lands.
 */
export type FailureChannel = 'promise' | 'status' | 'watchdog' | 'sync';

/**
 * May this failure report be HANDLED against the current
 * candidate? The rules that keep one failure from burning two
 * chain candidates (diagnosis §1.6/§6):
 *
 * - CURRENCY: a report naming a URL that is no longer the
 *   current load is stale and ignored (the promise channel's
 *   long-standing guard, generalised).
 * - PER-URL ATTRIBUTION: a URL whose failure was already handled
 *   can never be handled again, on any channel.
 * - STATUS-CHANNEL SUBORDINATION: the 'status' channel cannot
 *   name its source. While the current load's promise is still
 *   in flight, a status error is either that load's own (the
 *   promise rejection will handle it, correctly attributed) or
 *   a stale duplicate of the PREVIOUS candidate's failure — in
 *   both cases the promise channel owns it, so the status report
 *   is ignored. Once the current load has SETTLED (its promise
 *   resolved), a status error is a genuine post-load failure of
 *   the current source and is handled against it.
 */
export function failureAttributionDecision(args: {
  channel: FailureChannel;
  /** The URL this report is attributed to (the caller names the
      load it belongs to; the status channel names the current
      load, which the subordination rule then vets). */
  reportUrl: string | null;
  /** The URL loaded right now (loadedUrlRef). */
  currentUrl: string | null;
  /** Has the current load's promise resolved (settled)? */
  currentLoadSettled: boolean;
  /** URLs whose failure has already been handled. */
  handledUrls: ReadonlySet<string>;
}): 'handle' | 'ignore' {
  const { channel, reportUrl, currentUrl, handledUrls } = args;
  if (reportUrl === null || currentUrl === null) return 'ignore';
  if (reportUrl !== currentUrl) return 'ignore';
  if (handledUrls.has(reportUrl)) return 'ignore';
  if (channel === 'status' && !args.currentLoadSettled) return 'ignore';
  return 'handle';
}

/** Immutably record a URL's failure as handled. */
export function markFailureHandled(
  handledUrls: ReadonlySet<string>,
  url: string,
): ReadonlySet<string> {
  if (handledUrls.has(url)) return handledUrls;
  const next = new Set(handledUrls);
  next.add(url);
  return next;
}

/**
 * The single-load decision for the video player (diagnosis §1.3):
 * the engine tracks the ONE load it has issued into the player
 * (by the inactive preload or by an activation). When a claim
 * activates over a candidate, exactly one of:
 * - 'adopt' — that same URL is already loaded (settled): play
 *   from it; issuing another load would restart it from zero and
 *   interrupt it (the double-load defect);
 * - 'wait' — that same URL is still loading: its settle handler
 *   owns the play/failure; do not issue a duplicate;
 * - 'issue' — no load for this URL exists: load it now.
 */
export type VideoLoadAction = 'issue' | 'adopt' | 'wait';

export function videoLoadAction(args: {
  candidateUrl: string;
  /** The URL of the load last issued into the video player. */
  issuedUrl: string | null;
  /** Whether that issued load's promise has resolved. */
  issuedSettled: boolean;
}): VideoLoadAction {
  if (args.issuedUrl !== args.candidateUrl) return 'issue';
  return args.issuedSettled ? 'adopt' : 'wait';
}

/**
 * The detail/player stall grace, by engine kind (owner ruling
 * 2026-11-11 19:10, replacing the 4s budget for this engine):
 * a source that has never started may be declared dead only
 * after this long of CONTINUOUS no-progress silence. Users on
 * bad net stall longer than 4s without being dead.
 */
export const AUDIO_STALL_GRACE_MS = 30_000;
export const VIDEO_STALL_GRACE_MS = 60_000;

export function stallGraceMs(kind: MediaEngineKind): number {
  return kind === 'audio' ? AUDIO_STALL_GRACE_MS : VIDEO_STALL_GRACE_MS;
}

/**
 * The rebuilt stall decision for the detail/player engine. The
 * hook tracks the current continuous buffering EPISODE:
 * `stallSince` is stamped when buffering begins and re-stamped
 * by any progress (a status leaving 'loading', an advancing
 * progress tick, playing); it is null whenever the player is
 * not in a stall. Rules (owner rulings, 2026-11-11):
 * - a source that has STARTED (played, advanced past 0, or —
 *   video — rendered frames) is NEVER killed for buffering:
 *   mid-playback stalls are waited out; only real player errors
 *   advance the chain;
 * - a never-started source trips only after the full kind grace
 *   of continuous silence.
 */
export interface StallSnapshot {
  now: number;
  kind: MediaEngineKind;
  stallSince: number | null;
  hasStarted: boolean;
  hasSource: boolean;
  failed: boolean;
  disabled: boolean;
}

export function stallShouldTrip(snap: StallSnapshot): boolean {
  if (snap.disabled || snap.failed || !snap.hasSource) return false;
  if (snap.hasStarted) return false;
  if (snap.stallSince === null) return false;
  return snap.now - snap.stallSince >= stallGraceMs(snap.kind);
}

/* ------------------------------------------------------------------ */
/* Quiz SOLO stall watchdog (2026-11-11 fix; v2 question budget,     */
/* later the same night)                                               */
/*                                                                   */
/* Field failure, v1: on the installed 1.0.2, solo Q1 AND Q2 both    */
/* showed 'This theme could not be played' on fast net while every   */
/* derived .ogg probed healthy — the quiz watchdog stamped its 4s    */
/* clock at LOAD START and executed loads still in flight (the quiz  */
/* audio status is also read through a 500ms polled tick, which      */
/* trails reality further). v1 answered with the detail engine's     */
/* doctrine — judge CONTINUOUS NO-PROGRESS via a sampled progress    */
/* VALUE — but kept the detail engine's per-candidate graces         */
/* (30s audio / 60s video).                                          */
/*                                                                   */
/* Field failure, v2 (owner's Expo test of v1, same night): Q1       */
/* showed the warning, then the clip SPOKE at ~15–17s; Q2 was        */
/* silent for its whole 20s with NO warning at all. Two lessons:     */
/* a per-candidate 30s grace OUTLIVES a 20s question — a dead-       */
/* silent question can receive no verdict inside its own lifetime    */
/* — and the 'failed' latch was one-way even when the clip later     */
/* started. v2 therefore replaces the per-candidate graces with a    */
/* PER-QUESTION stall budget (owner ruling):                         */
/*                                                                   */
/* - the question may accumulate at most                               */
/*   QUIZ_QUESTION_STALL_BUDGET_MS (10s) of CONTINUOUS no-progress   */
/*   across its WHOLE chain. Progress is still the v1 signature      */
/*   (duration / position / buffered / playing changes on the        */
/*   CURRENT candidate); any progress resets the budget; switching   */
/*   candidates does NOT — a fresh candidate's first sample only     */
/*   re-baselines its signature, so silence accrues across the       */
/*   chain. Hard errors never touch the budget: they advance the     */
/*   chain instantly, exactly as before. Budget exhaustion on a      */
/*   candidate advances the chain; on the LAST candidate it is       */
/*   the question's 'failed' verdict.                                */
/* - a candidate that is MAKING progress is never killed, however    */
/*   long the question runs, and a candidate that has genuinely      */
/*   STARTED is immune, forever (v1 semantics, kept).                */
/* - the verdict is not a life sentence: quizFailedShouldClear       */
/*   (resurrection, below) lets a late genuine start un-fail the     */
/*   question.                                                       */
/*                                                                   */
/* The MULTIPLAYER countdown path does NOT use this section: it      */
/* keeps watchdogShouldTrip + PLAYBACK_STALL_WATCHDOG_MS with its    */
/* playAtMs arming, byte-for-byte. The hook selects by the ABSENCE   */
/* of a hold moment (solo never passes one).                         */
/* ------------------------------------------------------------------ */

/**
 * One progress sample of a loading quiz candidate, built by the
 * hook from the richest signals the two players actually expose:
 *
 * - expo-audio's AudioStatus carries `duration` (0 until the
 *   metadata is parsed — its arrival means bytes flowed),
 *   `currentTime` and `playing`. It exposes NO buffered position,
 *   so audio samples pass 0 there; for an .ogg the duration's
 *   arrival is the load-progress signal.
 * - expo-video's player carries `duration`, `currentTime`,
 *   `playing` AND `bufferedPosition` (seconds of media buffered
 *   ahead; -1 when indeterminate) — the buffered position
 *   advancing is a continuous byte-flow signal for the solo
 *   chain's hidden-video candidate.
 */
export interface QuizProgressSample {
  duration: number;
  currentTime: number;
  bufferedPosition: number;
  playing: boolean;
}

/**
 * The comparable form of a progress sample: two samples with the
 * same signature are observationally identical — no byte of
 * progress can be inferred between them. Any change IS progress
 * (metadata arrived, the buffer grew, the position moved,
 * playback began). Non-finite readings (a NaN duration before
 * metadata, the video player's -1 indeterminate buffer) are
 * normalised so they read as "no value" and cannot churn the
 * signature on their own.
 */
export function quizProgressSignature(sample: QuizProgressSample): string {
  const n = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
  return [
    n(sample.duration),
    n(sample.currentTime),
    n(sample.bufferedPosition),
    sample.playing ? 1 : 0,
  ].join('|');
}

/** Has this candidate genuinely started? Playing, or a position
    past zero — the same "started" test the detail engine's
    immunity uses (a merely-buffered candidate has NOT started:
    its buffered position alone never immunises it). */
export function quizSampleStarted(sample: QuizProgressSample): boolean {
  return sample.playing || sample.currentTime > 0;
}

/**
 * The per-QUESTION continuous no-progress budget for a solo quiz
 * question (v2, owner ruling 2026-11-11): the whole candidate
 * chain together may sit in unbroken silence for at most this
 * long before the current candidate is declared stalled. 10s
 * sits well inside the standard 20s question window, so a
 * dead-silent question always receives its verdict while it can
 * still be answered — the v1 per-candidate 30s audio grace
 * could outlive the question and leave it verdict-less.
 */
export const QUIZ_QUESTION_STALL_BUDGET_MS = 10_000;

/**
 * The solo stall tracker: the hook's whole memory of a
 * question's silence, advanced ONLY through quizStallObserve so
 * every transition is a pure, testable decision.
 *
 * - `mediaKey` / `candidateKey`: which question / candidate the
 *   remembered signature belongs to (the hook keys candidates by
 *   `${mediaKey}:${url}`).
 * - `signature`: the last progress signature observed for the
 *   current candidate (null before its first sample).
 * - `lastProgressAt`: epoch ms of the most recent PROGRESS —
 *   the last moment the current chain observably moved. It is
 *   stamped by a fresh question's first sample and by every
 *   signature change, and by NOTHING else: in particular not by
 *   a candidate switch and not by a hard error.
 * - `started`: latched once the CURRENT candidate has genuinely
 *   started (its immunity); resets when the candidate changes.
 */
export interface QuizStallTracker {
  mediaKey: string;
  candidateKey: string;
  signature: string | null;
  lastProgressAt: number;
  started: boolean;
}

/** A tracker that has seen nothing yet (app start / hook mount). */
export function createQuizStallTracker(): QuizStallTracker {
  return {
    mediaKey: '',
    candidateKey: '',
    signature: null,
    lastProgressAt: 0,
    started: false,
  };
}

/** One observation of the current candidate, sampled by the hook
    each poll: the progress signature + started flag of the
    candidate the chain sits on NOW, and the poll's clock. */
export interface QuizStallObservation {
  mediaKey: string;
  candidateKey: string;
  signature: string;
  started: boolean;
  now: number;
}

/**
 * Advance the tracker by one observation. The three transitions
 * ARE the v2 budget rules:
 *
 * - NEW QUESTION (mediaKey changed): everything re-baselines —
 *   the first sample is the comparison point and the silence
 *   clock starts at the observation. Yesterday's silence must
 *   never execute today's first load.
 * - CANDIDATE SWITCH (same question): the new candidate's first
 *   sample re-baselines the SIGNATURE only. `lastProgressAt` is
 *   deliberately KEPT — silence accrues across the chain, so a
 *   question that has heard nothing for 9s does not grant its
 *   fallback a fresh 10s. The started latch resets (immunity
 *   belongs to the candidate that earned it).
 * - SAME CANDIDATE: a changed signature is progress — the clock
 *   re-stamps; an unchanged signature changes nothing but the
 *   started latch, which only ever latches ON.
 */
export function quizStallObserve(
  tracker: QuizStallTracker,
  obs: QuizStallObservation,
): QuizStallTracker {
  if (obs.mediaKey !== tracker.mediaKey) {
    return {
      mediaKey: obs.mediaKey,
      candidateKey: obs.candidateKey,
      signature: obs.signature,
      lastProgressAt: obs.now,
      started: obs.started,
    };
  }
  if (obs.candidateKey !== tracker.candidateKey) {
    return {
      ...tracker,
      candidateKey: obs.candidateKey,
      signature: obs.signature,
      started: obs.started,
    };
  }
  return {
    ...tracker,
    signature: obs.signature,
    lastProgressAt:
      obs.signature !== tracker.signature ? obs.now : tracker.lastProgressAt,
    started: tracker.started || obs.started,
  };
}

/**
 * The solo stall snapshot the hook builds each poll:
 * - `loading`: the candidate is still in `loading` (the audio
 *   tick status / the video status). Outside `loading` there is
 *   no stall to judge.
 * - `lastProgressAt`: from the tracker — the question's most
 *   recent progress observation.
 * - `hasStarted`: the tracker's latch for the current candidate.
 */
export interface QuizQuestionStallSnapshot {
  now: number;
  loading: boolean;
  lastProgressAt: number;
  hasStarted: boolean;
  hasSource: boolean;
  failed: boolean;
  disabled: boolean;
}

/**
 * Should the SOLO chain advance NOW because the question's
 * continuous no-progress has exhausted its budget? Trips only
 * when ALL hold:
 * - a live, unfailed source is loaded;
 * - it has never started (a started clip is never killed for
 *   buffering — only real player errors advance it);
 * - it is still in `loading`;
 * - the question's unbroken silence has reached
 *   QUIZ_QUESTION_STALL_BUDGET_MS, measured from the last
 *   progress observation ANYWHERE in the chain.
 */
export function quizQuestionStallShouldTrip(
  snap: QuizQuestionStallSnapshot,
): boolean {
  if (snap.disabled || snap.failed || !snap.hasSource) return false;
  if (snap.hasStarted) return false;
  if (!snap.loading) return false;
  return snap.now - snap.lastProgressAt >= QUIZ_QUESTION_STALL_BUDGET_MS;
}

/**
 * Resurrection (v2): a 'failed' verdict is a statement about the
 * chain SO FAR, not a life sentence — ozar's Q1 heard its clip
 * speak seconds after the warning appeared. When the LAST
 * candidate's player later genuinely starts, the latch clears
 * and the question reports 'playing' again (the solo screen
 * derives its warning from the phase, so the warning clears
 * with it — no screen change is needed).
 *
 * The guards keep the resurrection honest:
 * - solo only (`held` false): a multiplayer round's verdict is
 *   final — rounds are server-timed and a late start must not
 *   rewrite a round the room has moved past;
 * - the signal must come from the candidate the chain SITS on:
 *   the solo hook keeps an orphaned earlier candidate's player
 *   alive (an .ogg abandoned for the video fallback), and its
 *   late load must never resurrect a question it no longer
 *   owns;
 * - the start must be genuine (the caller's per-engine "started"
 *   reading — never a mere status shuffle).
 */
export interface QuizResurrectionSignal {
  failed: boolean;
  held: boolean;
  currentKind: MediaEngineKind;
  signalKind: MediaEngineKind;
  started: boolean;
}

export function quizFailedShouldClear(sig: QuizResurrectionSignal): boolean {
  if (!sig.failed || sig.held) return false;
  if (!sig.started) return false;
  return sig.signalKind === sig.currentKind;
}

/* ------------------------------------------------------------------ */
/* Solo clock rules (v2 — the clock obeys the song)                    */
/*                                                                     */
/* Owner ruling (2026-11-11): the solo answer clock is SUPPOSED to   */
/* start when the audio starts — the question's media wait is not    */
/* part of the player's 20s. Solo already starts it from the         */
/* playback-started path (phase 'playing') and from the verdict      */
/* ('failed' / 'empty'); v2 removes the blind 10s timer start that   */
/* fired mid-load on slow connections and stole the window the       */
/* ruling protects. What remains of that timer is pure anti-hang     */
/* insurance (soloLoadSafetyMs), sized so it can only fire when      */
/* the media layer has produced NEITHER a start NOR a verdict for    */
/* a whole answer window — a state the phase machine + the 10s       */
/* verdict make unreachable for any load that ever reports, and      */
/* that only a never-reporting load (or one trickling progress       */
/* forever without ever starting) can reach.                         */
/* ------------------------------------------------------------------ */

/** Does this reported media phase start the solo answer clock?
    Playing starts it (the song is on); 'failed' and 'empty'
    start it (the verdict — the question is answerable without
    its song); 'buffering' never does (the wait is not the
    player's time). Mirrors solo.tsx's clock effect exactly. */
export function soloClockStartsOnPhase(
  phase: 'buffering' | 'playing' | 'failed' | 'empty',
): boolean {
  return phase !== 'buffering';
}

/** The solo anti-hang safety, in ms: one FULL answer window
    (the question's own time limit). Any load that plays, stalls
    or errors resolves through the phase machine long before
    this — the verdict alone bounds a true stall to ~10s — so
    the safety firing at all means the media layer never
    reported, and the question must still not hang. */
export function soloLoadSafetyMs(limitSeconds: number): number {
  return limitSeconds * 1000;
}

/* ------------------------------------------------------------------ */
/* Video-leg status discipline (clock-stall fix, 2026-11-12)           */
/*                                                                     */
/* Field bug (diagnosis QUIZ-CLOCK-STALL-DIAGNOSIS-2026-11-12): on     */
/* the video leg the solo clock never started while the song           */
/* audibly played. The audio leg cannot do this — every load builds    */
/* a fresh player and stamps the status ref synchronously, so a        */
/* 'loading' interlude always precedes the 'playing' edge the          */
/* clock's edge-triggered phase report consumes. The video player,     */
/* by contrast, is created ONCE for the hook's life and its status     */
/* is purely event-fed: nothing reset it when a new question's load    */
/* was issued, so a predecessor's 'readyToPlay' could sit across       */
/* the switch — phase 'playing' before, during and after — and no      */
/* edge ever fired.                                                    */
/*                                                                     */
/* The fix mirrors the audio bridge for video: the hook keeps the      */
/* video status in a ref fed by a statusChange listener, and STAMPS    */
/* the ref to 'loading' synchronously at load issuance (the player     */
/* IS loading at that moment, by construction). The genuine            */
/* readyToPlay event then always crosses a buffering interlude,        */
/* so the report edge — and with it the clock AND the server's         */
/* playback-start signal, one shared consumer — always fires. The      */
/* stamp never invents a start: it writes only 'loading', so the       */
/* clock still starts solely on a genuine readyToPlay (or the          */
/* failed/empty verdict), and a load that never reports still          */
/* reaches the unchanged 10s stall verdict / 20s safety. The           */
/* machinery below takes no input about how the previous question      */
/* ended — correct, wrong, skip and timeout funnel through the         */
/* same issuance stamp — so its behaviour cannot vary by ending.       */
/* The watchdog's video `loading` observation reads the same ref,      */
/* so its progress judgement is made against the stamped truth         */
/* rather than a leftover status from the previous question.           */
/* ------------------------------------------------------------------ */

/** The quiz hook's video status vocabulary — expo-video's
    VideoPlayerStatus, restated so the pure layer needs no
    native import. */
export type QuizVideoStatus = 'idle' | 'loading' | 'readyToPlay' | 'error';

/** The status of a video player the instant a new load is
    issued for it: loading, by construction — whatever the
    previous question left behind. The hook stamps its status
    ref with this synchronously in the load path, before the
    native player can publish anything about the new source. */
export function quizVideoStatusAfterLoadIssued(): QuizVideoStatus {
  return 'loading';
}

/** The solo audio phase QuizAudioOnly reports, from the hook's
    derived status — the screen's clock effect starts the clock
    on every phase but 'buffering' (soloClockStartsOnPhase):
    'failed' / 'empty' are the verdict, 'playing' a genuine
    start, and a held (countdown) or still-loading/idle source
    is 'buffering' — the wait is never the player's time. */
export function quizAudioPhase(input: {
  failed: boolean;
  hasUrl: boolean;
  holdPending: boolean;
  status: QuizVideoStatus;
}): 'buffering' | 'playing' | 'failed' | 'empty' {
  if (input.failed) return 'failed';
  if (!input.hasUrl) return 'empty';
  if (
    input.holdPending ||
    input.status === 'loading' ||
    input.status === 'idle'
  ) {
    return 'buffering';
  }
  return 'playing';
}

/* ------------------------------------------------------------------ */
/* Progress/state reference stability (problem 8)                      */
/* ------------------------------------------------------------------ */

/**
 * A progress pair worth rendering: positions arrive as floats
 * from the native players (2 ticks/sec at the current
 * timeUpdateEventInterval), and consumers label time to the
 * whole second — so progress is QUANTIZED to whole seconds
 * before it is stored. Two ticks inside the same second then
 * produce the SAME object, which is what stops the ~2×/sec tick
 * from invalidating memoised consumers: identical references
 * flow through the progress channel, and React's bail-out does
 * the rest. Duration lands on the same grid (players report it
 * in fractional seconds too).
 */
export function quantizeProgress(progress: {
  current: number;
  duration: number;
}): { current: number; duration: number } {
  const whole = (v: number): number =>
    Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  return { current: whole(progress.current), duration: whole(progress.duration) };
}

/**
 * Keep the previous reference when the next progress is equal
 * after quantization — the setter pattern the engines use so a
 * same-second tick never produces a new state object at all.
 */
export function stabilizeProgress(
  prev: { current: number; duration: number },
  next: { current: number; duration: number },
): { current: number; duration: number } {
  const q = quantizeProgress(next);
  return q.current === prev.current && q.duration === prev.duration
    ? prev
    : q;
}

/** The seek fraction (0–1) for a progress pair — clamped, and 0
    while the duration is unknown. */
export function progressFraction(progress: {
  current: number;
  duration: number;
}): number {
  return progress.duration > 0
    ? Math.min(1, Math.max(0, progress.current / progress.duration))
    : 0;
}

/**
 * The same rule for the downloads store's per-download
 * fractions: the transfer callback already gates on whole
 * percents, and this keeps the store from emitting a fresh
 * progress map for a value it already holds (a percent tick
 * must not rebuild consumers of unrelated downloads).
 */
export function progressValueChanged(
  prev: number | null | undefined,
  next: number | null,
): boolean {
  return prev !== next;
}

/* ------------------------------------------------------------------ */
/* Stall-watchdog interval decision                                    */
/* ------------------------------------------------------------------ */

/**
 * The interval the engine hooks poll the watchdog with (500ms):
 * fine enough that a trip lands within ~0.5s of the budget, cheap
 * enough to run beside the progress ticks. The DECISION of
 * whether to even arm the poll lives here: only a live consumer
 * with a source loaded should run an interval at all; everyone
 * else (inactive, failed, source-less) leaves the timer asleep.
 */
export const WATCHDOG_POLL_INTERVAL_MS = 500;

export function watchdogPollActive(args: {
  active: boolean;
  hasSource: boolean;
  failed: boolean;
}): boolean {
  return args.active && args.hasSource && !args.failed;
}

/* ------------------------------------------------------------------ */
/* Problem 3 — queue next-track preload gating                         */
/* ------------------------------------------------------------------ */

/**
 * The problem-3 gate (owner rule, 2026-11-10): the NEXT queue
 * track's .ogg preloads ONLY once the current track is no
 * longer buffering — preload traffic must never compete with a
 * still-loading current track. "No longer buffering" is the
 * conjunction below: playback is actually running AND the
 * engine no longer reports buffering.
 */
export interface NextPreloadSnapshot {
  /** The current track is playing (not paused/buffering/ended). */
  isPlaying: boolean;
  /** The engine's buffering flag for the current track. */
  buffering: boolean;
  /** The next queue item, if any. */
  next: { slug: string; atEntryId: number | null } | null;
  /** The next item is already downloaded (offline needs none). */
  nextOffline: boolean;
}

export function shouldPreloadNext(snap: NextPreloadSnapshot): boolean {
  if (!snap.next) return false;
  if (snap.nextOffline) return false;
  return snap.isPlaying && !snap.buffering;
}

/**
 * The preload ticket key for a queue item — slug + entry, so a
 * skip or a version switch re-keys (and thereby discards) the
 * preload instead of serving a stale one.
 */
export function queuePreloadKey(item: {
  slug: string;
  atEntryId: number | null;
}): string {
  return `queue:${item.slug}:${item.atEntryId ?? 'first'}`;
}

/* ------------------------------------------------------------------ */
/* Watch quality (fixed best — owner ruling 2026-11-11: NO switching) */
/* ------------------------------------------------------------------ */

/**
 * One offered quality: an entry video source, by its REAL
 * resolution value. The watch chain walks these best-first; the
 * hero's resolution chip names the rung ACTUALLY playing.
 */
export interface WatchQualityOption {
  url: string;
  resolution: number;
}

/**
 * The resolution of the source ACTUALLY playing: the engine's
 * active URL matched back to an offered source. A fallback URL
 * (entry / theme videoUrl) or a local download matches nothing —
 * the result is null and the chip is omitted, NEVER guessed from
 * the highest resolution the entry merely offers (the batch-2
 * rule the Player chip already lives by).
 */
export function playingResolution(
  sources: readonly WatchQualityOption[],
  activeUrl: string | null,
): number | null {
  if (activeUrl === null) return null;
  return sources.find((s) => s.url === activeUrl)?.resolution ?? null;
}

/**
 * The surface-readiness gate (2026-11-11 video fix — the owner's
 * field report on the 1.0.1 build: Watch rendered real frames
 * for ~3s, then fell to the audio fallback). Root cause: the
 * engine called play() on a video player before any VideoView
 * surface had attached/rendered — expo-video on Android can lose
 * the player's video pipeline when playback starts surfaceless
 * (expo/expo#35012 family): frames flash briefly, the player
 * errors, and the chain falls back. The gate holds every WATCH
 * play until the bound surface signals its first rendered frame
 * (VideoView's onFirstFrameRender).
 *
 * This is the pure decision seam; the engine wires it to refs.
 *
 * - `watchSurfaceGateDecision` answers one question — may this
 *   play request reach the video player NOW?
 *   · only a 'primary' VIDEO candidate is gated: it is the one
 *     meant for the visible watch surface. Every VIDEO
 *     candidate with another role plays sound-only through the
 *     hidden surface (the listen chain's video files, incl. the
 *     'hidden-video' last resort — UNTOUCHABLE) and bypasses
 *     unconditionally.
 *   · a surface already ready for the CURRENT player instance
 *     plays immediately.
 *   · anything else HOLDS — the request is remembered by the
 *     engine and released the moment readiness fires.
 * - `surfaceReadinessAfterSwap`: readiness is PER PLAYER
 *   INSTANCE. A surface-player identity change (the pool reset
 *   on a claim change, unmount) forgets the old instance's
 *   readiness — the new instance must render its own first frame
 *   before a watch play reaches it.
 * - The gate never replaces the stall watchdog: a held play
 *   keeps the engine in `loading`, so a surface that never
 *   signals fails through the existing watchdog → chain path.
 */
export type SurfaceGateDecision = 'play' | 'hold';

export function watchSurfaceGateDecision(args: {
  /** The candidate's kind: audio-engine candidates never reach
      the video player, so the gate question does not arise. */
  kind: 'audio' | 'video';
  /** The candidate's role: a VIDEO candidate with any role but
      'primary' plays sound-only (the listen chain's video files,
      incl. the 'hidden-video' last resort) and is NEVER gated;
      only a 'primary' VIDEO candidate is meant for the visible
      watch surface. */
  role: 'primary' | 'audio-fallback' | 'hidden-video';
  /** Has the bound surface rendered a frame for THIS player? */
  surfaceReady: boolean;
  /** Watch fix (2026-11-11, diagnosis H2/§6.4): the player
      itself reports 'readyToPlay' for the current source — the
      source is loaded and playable, which is the same safety
      the first frame was proxying for. A held play releases on
      EITHER signal. Optional; omitting it keeps the original
      first-frame-only behaviour (the engine passes it only for
      fresh load/adopt/retry plays — a post-detach RESUME still
      waits for the new surface's own first frame, preserving
      the detach discipline). */
  playerReadyToPlay?: boolean;
}): SurfaceGateDecision {
  if (args.kind !== 'video' || args.role !== 'primary') return 'play';
  return args.surfaceReady || args.playerReadyToPlay ? 'play' : 'hold';
}

export function surfaceReadinessAfterSwap(args: {
  previousPlayerKey: string | null;
  nextPlayerKey: string | null;
  readyPlayerKey: string | null;
}): { ready: boolean; readyPlayerKey: string | null } {
  if (args.nextPlayerKey === null) {
    return { ready: false, readyPlayerKey: null };
  }
  if (args.nextPlayerKey !== args.previousPlayerKey) {
    // A different instance owns the surface now: only readiness
    // recorded FOR that instance counts.
    return {
      ready: args.readyPlayerKey === args.nextPlayerKey,
      readyPlayerKey: args.readyPlayerKey,
    };
  }
  return {
    ready: args.readyPlayerKey === args.nextPlayerKey,
    readyPlayerKey: args.readyPlayerKey,
  };
}

/* ------------------------------------------------------------------ */
/* Buffer package (2026-11-11 evening) — NetInfo-aware buffer        */
/* cushions for the detail/player video player.                      */
/*                                                                   */
/* Field report (1.0.3 APK, peak hour): BOTH detail modes froze /    */
/* buffered / stuck while the media edge probed perfectly healthy    */
/* from a datacenter — the choke is the single-flow phone→edge       */
/* road, and expo-video's defaults (Android: ~20s forward buffer,    */
/* 2s to start) leave almost no cushion for a dipping flow to ride   */
/* out. The cushion is therefore sized by the CONNECTION: an          */
/* unmetered road buffers toward the whole file; a metered one       */
/* keeps a bounded runway. These are the player's BufferOptions      */
/* (expo-video: a player property the engine sets as each load is    */
/* issued — see usePlayback); this section is only the pure          */
/* decision of WHICH options a given load gets.                      */
/* ------------------------------------------------------------------ */

/**
 * The connection sample the buffer decision reads — the fields
 * of a NetInfo state the engine extracts (the hook maps the
 * native state onto this shape; nothing native lives here).
 */
export interface BufferConnectionSample {
  /** NetInfo's connection type ('wifi' | 'cellular' | 'ethernet'
      | 'none' | 'unknown' | …), null before the first sample. */
  type: string | null;
  isInternetReachable: boolean | null;
  /** NetInfo details.isConnectionExpensive where the platform
      reports it (a metered Wi-Fi / a metered cellular plan);
      null when unreported. */
  isConnectionExpensive: boolean | null;
}

export type BufferConnectionKind = 'unmetered' | 'metered';

/**
 * Classify the connection for buffering. Unmetered = a Wi-Fi /
 * ethernet type (unless the platform explicitly marks it
 * expensive — metered Wi-Fi is metered), or any connection the
 * platform explicitly reports as NOT expensive while the
 * internet is reachable. Everything else — cellular without a
 * cheap report, unknown, no sample yet — is metered: when in
 * doubt the bounded profile applies, never the greedy one.
 */
export function bufferConnectionKind(
  sample: BufferConnectionSample | null,
): BufferConnectionKind {
  if (!sample) return 'metered';
  if (sample.isConnectionExpensive === true) return 'metered';
  if (sample.type === 'wifi' || sample.type === 'ethernet') {
    return 'unmetered';
  }
  if (
    sample.isInternetReachable === true &&
    sample.isConnectionExpensive === false
  ) {
    return 'unmetered';
  }
  return 'metered';
}

/** expo-video's BufferOptions, structurally (seconds). */
export interface VideoBufferOptions {
  waitsToMinimizeStalling: boolean;
  minBufferForPlayback: number;
  preferredForwardBufferDuration: number;
}

/**
 * The forward buffer for the unmetered profile: an hour of
 * media — beyond any theme file in the catalogue (~90s), so in
 * effect the player buffers TO COMPLETE and a mid-play dip in
 * the road has the whole rest of the song to ride out on.
 * (Android's LoadControl turns this into its target buffer and
 * simply stops at end-of-file; the byte cap stays unset.)
 */
export const UNMETERED_FORWARD_BUFFER_S = 3600;

/**
 * The Watch buffer profile for a connection kind (owner's
 * network-aware sketch, 2026-11-11): playback starts once a
 * small cushion exists (2.5s unmetered / 5s metered — enough
 * that the first seconds never starve), then keeps the runway
 * ahead as large as the connection class allows.
 */
export function watchBufferOptions(
  kind: BufferConnectionKind,
): VideoBufferOptions {
  return kind === 'unmetered'
    ? {
        waitsToMinimizeStalling: true,
        minBufferForPlayback: 2.5,
        preferredForwardBufferDuration: UNMETERED_FORWARD_BUFFER_S,
      }
    : {
        waitsToMinimizeStalling: true,
        minBufferForPlayback: 5,
        preferredForwardBufferDuration: 50,
      };
}

/**
 * The buffer options for ONE video load: a watch candidate gets
 * its connection's Watch profile; the hidden-video listen
 * fallback ALWAYS gets the metered profile, whatever the
 * connection — it is an audio-only rescue, and letting it pull
 * a whole 40–60 MB video ahead on an unmetered road would gorge
 * the very road the rescue exists to survive (its audible part
 * needs seconds, not the file).
 */
export function videoBufferOptionsFor(args: {
  role: MediaCandidate['role'];
  connection: BufferConnectionKind;
}): VideoBufferOptions {
  if (args.role === 'hidden-video') return watchBufferOptions('metered');
  return watchBufferOptions(args.connection);
}

/**
 * The artwork-under-player rule (perf problem 7): while a watch
 * surface has NOT rendered video frames for the CURRENT source —
 * before the first frame, and during a quality switch until the
 * new source renders — the anime artwork shows under/behind the
 * video surface instead of a black rectangle. The moment frames
 * render, the video fully covers it. Listen mode never reaches
 * this rule (its own artwork presentation is separate), and a
 * source with no artwork leaves the plain black surface.
 *
 * - `framesRendered`: frames for the CURRENT source are on
 *   screen (the engine keys this per source; any source change
 *   resets it — a switch is a new source).
 */
export function watchArtworkUnderPlayer(args: {
  hasArtwork: boolean;
  framesRendered: boolean;
}): boolean {
  return args.hasArtwork && !args.framesRendered;
}

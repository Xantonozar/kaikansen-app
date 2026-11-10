import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  PlaybackMode,
  ThemeDetail,
  ThemeEntry,
  ThemeSummary,
} from '@kaikansen/contracts';
import { fetchThemeBySlug } from './api';
import {
  resolveListenCandidates,
  resolveWatchCandidates,
} from './playback';
import { queuePreloadKey } from './mediaEngine';
import {
  usePlayback,
  type NextTrackPreload,
  type PlaybackPreloadRequest,
  type PlaybackSlow,
} from './usePlayback';

/**
 * Shared playback session (layout-fidelity redesign, Slice 1) — the
 * ONE usePlayback instance for the whole app, owned here instead of
 * per-screen, so playback survives navigation and the floating
 * MiniPlayer (src/components/MiniPlayer.tsx) can sit on tab screens
 * and pushed screens alike, exactly as the Lavender Dusk mocks show.
 *
 * A consumer CLAIMS the session by writing its playback intent —
 * { slug, detail, entry, entryIdOverride, mode, active } — through
 * startSession/updateSession; the engine (src/usePlayback.ts, itself
 * unchanged) simply runs on whatever the session currently holds:
 * source resolution, the listen fallback chain, offline-first
 * downloads and history record-once all behave exactly as they did
 * when the two consumers owned private hook instances.
 *
 * Claimants today:
 * - Theme detail: Watch/Listen claims with the selected entry;
 *   switching the selected version updates `entry`; landing on a
 *   different slug ends the session (the old hook unloaded on slug
 *   change — that reset is preserved deliberately).
 * - Player route: syncs its route params (slug/mode/entry) in and
 *   renders from the shared engine; closing the route no longer
 *   stops playback — the mini player is the continuation surface.
 *
 * `endSession` only flips `active` off (the engine pauses and
 * unloads); the session data stays, so a screen returning to the
 * same slug can re-attach to it.
 *
 * QUEUE (Slice 2.5, ozar's ruling — design elements get made
 * workable, never dropped): list screens that open the player
 * (Playlist, Library segments, Season / Anime / Artist rows, Home
 * Continue Listening) claim a QUEUE alongside the session via
 * startQueue. The provider then owns advancing: next()/prev() and
 * auto-advance on track end move the session to the neighbouring
 * item, resolving its ThemeDetail + entry itself (the same
 * fetchThemeBySlug + entry resolution the player route performs),
 * so the mini player's Next button, the player route's prev/next
 * controls and its Up Next card all drive the real engine. The
 * mode is the session's — advancing never flips watch/listen.
 * A non-queue claim (startSession without a queue claim — a fresh
 * player open) clears the queue: those plays are single-track by
 * design. Theme detail is the exception: its Watch/Listen passes
 * an explicit queue claim — [this theme, ...its similar themes] —
 * alongside the session, so Next walks the related rail. And
 * `endSession` clears the queue too: a dead session has no next.
 *
 * Advance failure + duplicate rules (Slice 2.5 completion):
 * - If resolving an advanced-to item fails (fetch error / 404):
 *   an item carrying an explicit entry id STAYS claimed with no
 *   detail — the engine can still play that entry's downloaded
 *   file offline, and nowPlaying falls back to the download
 *   snapshot. An item with no entry id is skipped in the travel
 *   direction until one resolves; if none does, the pre-advance
 *   session and queue index are restored untouched.
 * - If the target resolves to the SAME slug + entry the session
 *   already held (a list containing the same theme twice), the
 *   engine's URL never changes, so playback is restarted through
 *   the engine's replay path (replay when ended, else seek to 0
 *   and play) while the queue index still advances.
 * - Race safety: each resolution carries a monotonic token; a
 *   fetch that lands after the session/queue moved on is dropped.
 *
 * REPEAT (design polish pass): the player route's repeat control
 * cycles off → queue → one through `cycleRepeat`. The mode is
 * honoured where a track ends: 'one' replays the finished track
 * through the engine's replay path; 'queue' advances like 'off'
 * but wraps from the last item back to the first (a one-item or
 * absent queue wraps onto the track itself, replayed); 'off'
 * keeps the original advance-or-stop behaviour. Manual next()
 * wraps the same way in 'queue' mode, so the mini player and the
 * player route agree.
 *
 * QUEUE ORIGIN (owner ruling 2026-11-10, completed): the player
 * route may open ONLY for playback started from a Playlist or
 * from Offline/Downloads; every other start lands on the theme
 * detail. Direct entry points have followed that since d450320;
 * the queue now also records WHERE it was claimed (`origin` on
 * PlaybackQueue, set by startQueue / startSession) so the one
 * surface that re-opens a live session — the mini player — can
 * follow the same rule: a 'playlist' or 'offline' origin reopens
 * the player route; anything else (including no queue at all)
 * navigates to the current track's theme detail instead.
 * Advancing never changes the origin: a playlist queue stays a
 * playlist queue to its last track. A fresh claim replaces it —
 * theme detail's queue claim and any queue-less claim are
 * 'other' by construction.
 */
export interface PlaybackSession {
  slug: string | null;
  detail: ThemeDetail | null;
  entry: ThemeEntry | null;
  /** Download lookup key when it differs from the resolved entry
      (the player route's explicit entry param). */
  entryIdOverride: number | null;
  mode: PlaybackMode;
  active: boolean;
  /** Opt-in for the engine's watch→audio degradation (W2): an
      exhausted watch chain plays the listen chain's audio instead
      of surfacing the error. Claimed by theme detail (its hero
      renders the artwork + audio-only note); queue claims and the
      player route leave it off. Preserved across queue advances
      so a claim's degradation survives walking its queue. */
  watchAudioFallback?: boolean;
  /** Playback plan (2026-11-10): while this claim is INACTIVE the
      engine preloads the claim mode's media (theme detail claims
      it from its open mode: Listen preloads the whole .ogg,
      Watch the video — preload only, no autoplay), so the tap
      starts near-instantly. The claim key is slug+entry+mode and
      must match the key the engine derives for adoption. */
  preloadKey?: string | null;
}

const IDLE_SESSION: PlaybackSession = {
  slug: null,
  detail: null,
  entry: null,
  entryIdOverride: null,
  mode: 'watch',
  active: false,
};

/**
 * One queue entry — a light playback target. Presentation fields
 * ride along so the mini player and the Up Next card can render
 * the track before (or even without) its detail resolving.
 * `atEntryId: null` means the theme's primary/first entry.
 */
export interface QueueItem {
  slug: string;
  atEntryId: number | null;
  title: string;
  artistLine: string;
  coverUrl: string | null;
}

/** Build a queue item from a catalogue summary (the row data every
    list screen already holds). */
export function queueItemFromSummary(item: ThemeSummary): QueueItem {
  return {
    slug: item.slug,
    atEntryId: null,
    title: item.songTitle,
    artistLine:
      item.allArtists.length > 0
        ? item.allArtists.join(' / ')
        : (item.artistName ?? ''),
    // Perf problem 11: the queue cover feeds the mini-player's
    // 44px thumb (and the player page's Up Next card) — the SMALL
    // variant, never the large/banner-class field.
    coverUrl: item.animeCoverImageSmall ?? item.animeCoverImage,
  };
}

export function queueItemsFromSummaries(
  items: ThemeSummary[],
): QueueItem[] {
  return items.map(queueItemFromSummary);
}

export type { QueueOrigin } from './queueOrigin';
export { isPlayerRouteOrigin } from './queueOrigin';
import type { QueueOrigin } from './queueOrigin';

export interface PlaybackQueue {
  items: QueueItem[];
  index: number;
  /** The surface family that claimed this queue. Set at claim
      time, preserved across advances and entry switches. */
  origin: QueueOrigin;
}

/** Repeat modes the player route's control cycles through. */
export type RepeatMode = 'off' | 'queue' | 'one';

/** Status of the provider's own detail resolution for a claimed
    track (queue advance, fresh player open). Screens that claim
    WITH a detail never pass through here. */
export type ResolutionStatus = 'loading' | 'ready' | 'missing' | 'error';
export interface PlaybackResolution {
  slug: string;
  status: ResolutionStatus;
}

type Playback = ReturnType<typeof usePlayback>;

/** What the mini player renders — title, artist line, cover.
    `cover` is the SMALL variant only (perf problem 11): the
    detail's grill image is the ~1900px AniList banner and must
    never feed the 44px thumb. */
export interface NowPlaying {
  title: string;
  artist: string;
  cover: string | null;
}

interface PlaybackContextValue {
  session: PlaybackSession;
  playback: Playback;
  nowPlaying: NowPlaying | null;
  /** Replace the session wholesale (a consumer claiming playback).
      With no queue claim this clears any queue — the claim is a
      single-track play. A caller holding a queue for the claimed
      track (theme detail: [theme, ...similar]) passes it as
      `queueClaim` and it becomes the live queue. */
  startSession: (
    next: PlaybackSession,
    queueClaim?: { items: QueueItem[]; index: number },
  ) => void;
  /** Merge fields into the current session. */
  updateSession: (patch: Partial<PlaybackSession>) => void;
  /** Deactivate: the engine pauses and unloads; data stays. The
      queue is cleared too — a dead session has no next. */
  endSession: () => void;
  /** The live queue, or null for single-track sessions. */
  queue: PlaybackQueue | null;
  /** Index of the current item within `queue` (0 when no queue). */
  queueIndex: number;
  /** The queue item the session is currently on, if it is one. */
  currentQueueItem: QueueItem | null;
  /** The item next() would play, or null at the end / no queue. */
  nextQueueItem: QueueItem | null;
  hasNext: boolean;
  hasPrev: boolean;
  /** Alias of hasPrev (queue-spec naming). */
  hasPrevious: boolean;
  /** Claim playback of a list: session starts on `items[startIndex]`
      in `mode`, and the rest becomes the queue. `origin` tags
      which surface family claimed it (defaults to 'other'); only
      'playlist' and 'offline' claims may open the player route —
      see the header's QUEUE ORIGIN note. */
  startQueue: (
    items: QueueItem[],
    startIndex: number,
    mode: PlaybackMode,
    origin?: QueueOrigin,
  ) => void;
  /** The live queue's origin, or 'other' when there is no queue —
      the mini player routes its tap on this (player route for
      'playlist'/'offline', theme detail otherwise). */
  queueOrigin: QueueOrigin;
  /** Alias of startQueue in the session's current mode (watch when
      the session is idle) — for claim sites that think in terms of
      "the list this row belongs to" rather than a mode switch. */
  setQueue: (items: QueueItem[], startIndex: number) => void;
  /** The live repeat mode (player route's repeat control). */
  repeatMode: RepeatMode;
  /** Cycle the repeat mode: off → queue → one → off. */
  cycleRepeat: () => void;
  /** Advance to the next queue item (no-op at the end, unless
      repeat 'queue' wraps it back to the first item). */
  next: () => void;
  /** Go back to the previous queue item (no-op at the start). */
  prev: () => void;
  /** Alias of prev (queue-spec naming). */
  previous: () => void;
  /** Provider-side detail resolution for the claimed track. */
  resolution: PlaybackResolution | null;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

/* Perf problem 12 (theme detail split) — two extra channels off
   the same provider, so a consumer can subscribe to exactly the
   rate of change it renders:
   - the PROGRESS channel carries only the tick pair
     ({ progress, fraction }); it changes ~2×/sec while a track
     plays, and ONLY the small progress components (seek fill,
     waveform split, time labels) consume it.
   - the SLOW session channel carries the session + the engine's
     slow object (identity stable across ticks, problem 8) + the
     claim actions; a page body on this channel does NOT
     re-render on progress ticks.
   The main context above is unchanged for every existing
   consumer (the mini player and the player route keep reading
   the combined object). */
export interface PlaybackProgressValue {
  progress: { current: number; duration: number };
  fraction: number;
}

const PlaybackProgressContext =
  createContext<PlaybackProgressValue | null>(null);

export function usePlaybackProgress(): PlaybackProgressValue {
  const ctx = useContext(PlaybackProgressContext);
  if (!ctx) {
    throw new Error(
      'usePlaybackProgress must be used inside <PlaybackProvider>.',
    );
  }
  return ctx;
}

export interface PlaybackSlowSessionValue {
  session: PlaybackSession;
  /** The engine's slow channel only (see PlaybackSlow). */
  playback: PlaybackSlow;
  startSession: PlaybackContextValue['startSession'];
  updateSession: PlaybackContextValue['updateSession'];
  endSession: PlaybackContextValue['endSession'];
}

const PlaybackSlowContext =
  createContext<PlaybackSlowSessionValue | null>(null);

export function usePlaybackSlowSession(): PlaybackSlowSessionValue {
  const ctx = useContext(PlaybackSlowContext);
  if (!ctx) {
    throw new Error(
      'usePlaybackSlowSession must be used inside <PlaybackProvider>.',
    );
  }
  return ctx;
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlaybackSession>(IDLE_SESSION);
  const [queue, setQueue] = useState<PlaybackQueue | null>(null);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  const [resolution, setResolution] = useState<PlaybackResolution | null>(
    null,
  );

  /* Playback-plan wiring (2026-11-10): the engine's two preload
     inputs, derived from the live session + queue.
     - `enginePreload`: an INACTIVE claim carrying a preloadKey
       (theme detail's open mode) preloads its mode's chain —
       Listen resolves the listen chain, Watch the watch chain —
       under the claim key, so the activating tap adopts it.
     - `engineNextPreload` (problem 3): the NEXT queue item,
       resolved through the same fetch + entry resolution queue
       advances use, feeds its listen chain to the engine; the
       engine preloads its .ogg only once the current track is
       stably playing, under the queue item's key, and the
       advance's claim adopts it when it lands on that item. The
       next item's detail resolution is kicked when the CURRENT
       item's resolution settles (never competing with the
       current track's own load beyond a catalogue read); an
       offline next item (a usable download for listen) passes
       `offline` and needs no preload. */
  const enginePreload = useMemo<PlaybackPreloadRequest | null>(() => {
    if (session.active || !session.preloadKey || !session.detail) {
      return null;
    }
    const entry = session.entry ?? session.detail.entries[0] ?? null;
    if (!entry) return null;
    const candidates =
      session.mode === 'watch'
        ? resolveWatchCandidates(session.detail, entry)
        : resolveListenCandidates(session.detail, entry);
    if (candidates.length === 0) return null;
    return { key: session.preloadKey, mode: session.mode, candidates };
  }, [session]);

  const [nextDetail, setNextDetail] = useState<{
    slug: string;
    detail: ThemeDetail;
  } | null>(null);
  const rawNextItem =
    queue && queue.index < queue.items.length - 1
      ? queue.items[queue.index + 1]
      : null;
  useEffect(() => {
    if (!rawNextItem || !session.active) {
      setNextDetail(null);
      return;
    }
    let live = true;
    fetchThemeBySlug(rawNextItem.slug)
      .then((data) => {
        if (live && data) setNextDetail({ slug: rawNextItem.slug, detail: data });
      })
      .catch(() => {
        // A failed next resolution simply means no preload.
      });
    return () => {
      live = false;
    };
  }, [rawNextItem?.slug, session.active]); // eslint-disable-line react-hooks/exhaustive-deps

  const engineNextPreload = useMemo<NextTrackPreload | null>(() => {
    if (!rawNextItem || !nextDetail || nextDetail.slug !== rawNextItem.slug) {
      return null;
    }
    const entry =
      nextDetail.detail.entries.find(
        (e) => e.atEntryId === rawNextItem.atEntryId,
      ) ??
      nextDetail.detail.entries[0] ??
      null;
    if (!entry) return null;
    return {
      key: queuePreloadKey(rawNextItem),
      candidates: resolveListenCandidates(nextDetail.detail, entry),
      offline: false,
    };
  }, [rawNextItem, nextDetail]);

  const playback = usePlayback({
    slug: session.slug,
    detail: session.detail,
    entry: session.entry,
    entryIdOverride: session.entryIdOverride,
    mode: session.mode,
    active: session.active,
    watchAudioFallback: session.watchAudioFallback ?? false,
    preload: enginePreload,
    nextPreload: engineNextPreload,
    claimPreloadKey: session.preloadKey ?? null,
  });

  /** Point the session at a queue item, detail unresolved — the
      resolution effect below fetches it, exactly the fetch + entry
      resolution the player route used to perform for itself. */
  const claimQueueItem = useCallback(
    (item: QueueItem, mode: PlaybackMode) => {
      setSession({
        slug: item.slug,
        detail: null,
        entry: null,
        entryIdOverride: item.atEntryId,
        mode,
        active: true,
        // Problem 3 (2026-11-10): the item's queue key rides the
        // claim, so an engine-side .ogg preload for this item
        // (made while the previous track played) is adopted on
        // activation instead of loading fresh.
        preloadKey: queuePreloadKey(item),
      });
    },
    [],
  );

  /* Live mirrors for the async resolution path (failure skips,
     duplicate restarts), which must read the CURRENT session and
     queue, never the render it was scheduled from. */
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const repeatModeRef = useRef(repeatMode);
  repeatModeRef.current = repeatMode;

  const cycleRepeat = useCallback(() => {
    setRepeatMode((prev) =>
      prev === 'off' ? 'queue' : prev === 'queue' ? 'one' : 'off',
    );
  }, []);

  /** Restart the current track from the top through the engine:
      replay when it has ended, else seek to 0 and play (the same
      restart the duplicate-advance path performs). */
  const replayCurrent = useCallback(() => {
    const pb = playbackRef.current;
    try {
      if (pb.ended) {
        pb.toggleMain();
      } else {
        pb.player.currentTime = 0;
        pb.player.play();
      }
    } catch {
      // Player already released — nothing to restart.
    }
  }, []);
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  /* One in-flight advance chain: the snapshot to restore if every
     candidate fails, the indexes already tried, the travel
     direction for skips, and where playback came from (for the
     duplicate restart check). Set by a fresh claim/advance,
     extended by failure skips, cleared when a claim resolves or
     is superseded. */
  interface AdvanceChain {
    snapshotSession: PlaybackSession;
    snapshotQueue: PlaybackQueue | null;
    tried: Set<number>;
    direction: 1 | -1;
    restartFrom: { slug: string; entryId: number | null } | null;
  }
  const chainRef = useRef<AdvanceChain | null>(null);

  const startSession = useCallback(
    (
      next: PlaybackSession,
      queueClaim?: { items: QueueItem[]; index: number },
    ) => {
      chainRef.current = null;
      if (queueClaim && queueClaim.items.length > 0) {
        const index = Math.min(
          Math.max(queueClaim.index, 0),
          queueClaim.items.length - 1,
        );
        // A session claim's queue is 'other' by construction —
        // its only caller is theme detail ([theme, ...similar]),
        // which is not a player-route origin.
        setQueue({ items: queueClaim.items, index, origin: 'other' });
      } else {
        setQueue(null);
      }
      setSession(next);
    },
    [],
  );
  const updateSession = useCallback((patch: Partial<PlaybackSession>) => {
    setSession((prev) => ({ ...prev, ...patch }));
    // Keep the queue's current item honest when the owning screen
    // switches the playing entry (theme detail's version tiles):
    // returning to this item later must resolve the entry the user
    // actually picked, not the one the queue was claimed with.
    if (patch.entry) {
      const entryId = patch.entry.atEntryId;
      setQueue((prevQueue) => {
        if (!prevQueue) return prevQueue;
        const item = prevQueue.items[prevQueue.index];
        if (
          !item ||
          item.slug !== sessionRef.current.slug ||
          item.atEntryId === entryId
        ) {
          return prevQueue;
        }
        const items = prevQueue.items.slice();
        items[prevQueue.index] = { ...item, atEntryId: entryId };
        return { ...prevQueue, items };
      });
    }
  }, []);
  const endSession = useCallback(() => {
    chainRef.current = null;
    // A dead session has no next — the queue goes with it.
    setQueue(null);
    setSession((prev) => (prev.active ? { ...prev, active: false } : prev));
  }, []);

  const startQueue = useCallback(
    (
      items: QueueItem[],
      startIndex: number,
      mode: PlaybackMode,
      origin: QueueOrigin = 'other',
    ) => {
      if (items.length === 0) return;
      const index = Math.min(Math.max(startIndex, 0), items.length - 1);
      chainRef.current = {
        snapshotSession: sessionRef.current,
        snapshotQueue: queueRef.current,
        tried: new Set([index]),
        direction: 1,
        restartFrom: null,
      };
      setQueue({ items, index, origin });
      claimQueueItem(items[index], mode);
    },
    [claimQueueItem],
  );

  const setQueueClaim = useCallback(
    (items: QueueItem[], startIndex: number) => {
      startQueue(items, startIndex, sessionRef.current.mode);
    },
    [startQueue],
  );

  const goToQueueIndex = useCallback(
    (index: number, direction: 1 | -1, continuation = false) => {
      const currentQueue = queueRef.current;
      if (!currentQueue) return;
      const item = currentQueue.items[index];
      if (!item) return;
      if (!continuation || !chainRef.current) {
        const prevSession = sessionRef.current;
        chainRef.current = {
          snapshotSession: prevSession,
          snapshotQueue: currentQueue,
          tried: new Set([index]),
          direction,
          // Duplicate candidate: the target is the theme already
          // in the session — if it also resolves to the same
          // entry, the engine URL won't move and playback must be
          // restarted explicitly (checked at resolution time).
          restartFrom:
            item.slug === prevSession.slug
              ? {
                  slug: item.slug,
                  entryId:
                    prevSession.entry?.atEntryId ??
                    prevSession.entryIdOverride ??
                    null,
                }
              : null,
        };
      } else {
        chainRef.current.tried.add(index);
        chainRef.current.direction = direction;
      }
      // The spread keeps the queue's origin: advancing within a
      // playlist/offline queue never re-tags it.
      setQueue({ ...currentQueue, index });
      // The mode is whatever the session runs in — advancing
      // never flips watch/listen. The claim's W2 opt-in rides
      // along for the same reason: the degradation a screen
      // claimed with applies to the tracks it advances to.
      setSession((prevSession) => ({
        slug: item.slug,
        detail: null,
        entry: null,
        entryIdOverride: item.atEntryId,
        mode: prevSession.mode,
        active: true,
        watchAudioFallback: prevSession.watchAudioFallback,
        // Problem 3: the advanced-to item's queue key rides the
        // claim, so its engine-side .ogg preload (if the gate
        // passed on the previous track) is adopted on activation.
        preloadKey: queuePreloadKey(item),
      }));
    },
    [],
  );

  const next = useCallback(() => {
    const currentQueue = queueRef.current;
    if (!currentQueue) {
      // No queue: repeat 'queue' wraps the queue-of-one onto
      // the track itself.
      if (repeatModeRef.current === 'queue') replayCurrent();
      return;
    }
    if (currentQueue.index >= currentQueue.items.length - 1) {
      if (repeatModeRef.current === 'queue') {
        if (currentQueue.items.length > 1) {
          goToQueueIndex(0, 1);
        } else {
          replayCurrent();
        }
      }
      return;
    }
    goToQueueIndex(currentQueue.index + 1, 1);
  }, [goToQueueIndex, replayCurrent]);

  const prev = useCallback(() => {
    const currentQueue = queueRef.current;
    if (!currentQueue || currentQueue.index <= 0) return;
    goToQueueIndex(currentQueue.index - 1, -1);
  }, [goToQueueIndex]);

  /* Detail resolution: a claimed track with no detail in hand (a
     queue claim, or the player route's fresh open) is resolved
     here — fetchThemeBySlug, then the entry the player route has
     always picked: the explicit entry id when it exists in the
     payload, else the first entry. A token guards the race where
     the session moves on before a slow fetch lands: a superseded
     fetch never applies. Claims that arrive WITH a detail (theme
     detail) skip this entirely.
     Failure handling follows the advance rules in the header:
     entry-specific queue claims stay claimed (offline download
     fallback); entry-less queue claims skip in the travel
     direction, restoring the pre-advance snapshot if the whole
     rest of the queue fails; anything else surfaces its status
     for the player route's error state. A success that resolves
     to the pre-advance slug + entry restarts playback through
     the engine's replay path — the URL never changed, so the
     engine would otherwise sit on the old position (or on
     `ended`, for an auto-advance onto a duplicate). */
  const resolveTokenRef = useRef(0);
  const claimSlug = session.slug;
  const claimOverride = session.entryIdOverride;
  const claimDetail = session.detail;
  const claimActive = session.active;
  useEffect(() => {
    if (!claimActive || !claimSlug || claimDetail) return;
    const slug = claimSlug;
    const token = ++resolveTokenRef.current;
    setResolution({ slug, status: 'loading' });

    const handleFailure = (status: ResolutionStatus) => {
      const chain = chainRef.current;
      const liveQueue = queueRef.current;
      const item = liveQueue?.items[liveQueue.index];
      if (
        chain &&
        liveQueue &&
        item &&
        item.slug === slug &&
        item.atEntryId == null
      ) {
        let idx = liveQueue.index + chain.direction;
        while (
          idx >= 0 &&
          idx < liveQueue.items.length &&
          chain.tried.has(idx)
        ) {
          idx += chain.direction;
        }
        if (idx >= 0 && idx < liveQueue.items.length) {
          goToQueueIndex(idx, chain.direction, true);
          return;
        }
        // No further item works — the current session stands.
        chainRef.current = null;
        setQueue(chain.snapshotQueue);
        setSession(chain.snapshotSession);
        setResolution(null);
        return;
      }
      chainRef.current = null;
      setResolution({ slug, status });
    };

    fetchThemeBySlug(slug)
      .then((data) => {
        if (resolveTokenRef.current !== token) return;
        if (!data) {
          handleFailure('missing');
          return;
        }
        const current = sessionRef.current;
        if (current.slug !== slug || current.detail) {
          // Superseded by a claim that brought its own detail.
          chainRef.current = null;
          return;
        }
        setResolution({ slug, status: 'ready' });
        const entry =
          data.entries.find(
            (e) => e.atEntryId === current.entryIdOverride,
          ) ??
          data.entries[0] ??
          null;
        setSession((prevSession) => {
          if (prevSession.slug !== slug || prevSession.detail) {
            return prevSession;
          }
          return { ...prevSession, detail: data, entry };
        });
        // Duplicate restart (see header): same slug + entry as
        // the session held before the advance.
        const chain = chainRef.current;
        chainRef.current = null;
        if (
          chain?.restartFrom &&
          chain.restartFrom.slug === slug &&
          chain.restartFrom.entryId != null &&
          entry !== null &&
          entry.atEntryId === chain.restartFrom.entryId
        ) {
          const pb = playbackRef.current;
          try {
            if (pb.ended) {
              pb.toggleMain();
            } else {
              pb.player.currentTime = 0;
              pb.player.play();
            }
          } catch {
            // Player already released — nothing to restart.
          }
        }
      })
      .catch(() => {
        if (resolveTokenRef.current !== token) return;
        handleFailure('error');
      });
  }, [claimActive, claimSlug, claimOverride, claimDetail, goToQueueIndex]);

  /* Auto-advance: a genuine play-to-end transition (the engine's
     `ended` flipping false → true) moves the queue on, honouring
     the repeat mode: 'one' replays the finished track instead of
     advancing; 'queue' advances through next(), which wraps at
     the end (and replays a queue-less session onto itself);
     'off' advances or stops at the end. Manual next/prev go
     through the same claim path; the engine's load cycle resets
     `ended` for the new track, so each track end is exactly one
     transition. */
  const prevEndedRef = useRef(false);
  const ended = playback.ended;
  useEffect(() => {
    const wasEnded = prevEndedRef.current;
    prevEndedRef.current = ended;
    if (wasEnded || !ended) return;
    if (repeatModeRef.current === 'one') {
      replayCurrent();
      return;
    }
    next();
  }, [ended, next, replayCurrent]);

  const currentQueueItem = useMemo<QueueItem | null>(() => {
    if (!queue) return null;
    const item = queue.items[queue.index];
    if (!item || item.slug !== session.slug) return null;
    if (
      item.atEntryId != null &&
      item.atEntryId !== session.entryIdOverride &&
      item.atEntryId !== session.entry?.atEntryId
    ) {
      return null;
    }
    return item;
  }, [queue, session.slug, session.entryIdOverride, session.entry]);

  const nextQueueItem =
    queue && queue.index < queue.items.length - 1
      ? queue.items[queue.index + 1]
      : null;
  const hasNext = nextQueueItem !== null;
  const hasPrev = queue !== null && queue.index > 0;

  // Presentation for the mini player: the session's detail when the
  // catalogue payload is in hand; otherwise the current queue
  // item's carried fields (a queue track mid-resolution, or one
  // whose detail could not load); otherwise the download snapshot
  // the engine resolved (fully-offline opens have no detail).
  const nowPlaying = useMemo<NowPlaying | null>(() => {
    const detail = session.detail;
    if (detail) {
      return {
        title: detail.songTitle,
        artist:
          detail.allArtists.length > 0
            ? detail.allArtists.join(' / ')
            : (detail.artistName ?? ''),
        // Perf problem 11: the mini-player thumb takes the
        // theme's SMALL cover variant — the detail's grill image
        // is the ~1900px banner and its large cover is hero-sized;
        // neither may feed a 44px thumb again.
        cover:
          detail.animeCoverImageSmall ?? detail.animeCoverImage,
      };
    }
    if (currentQueueItem) {
      return {
        title: currentQueueItem.title,
        artist: currentQueueItem.artistLine,
        cover: currentQueueItem.coverUrl,
      };
    }
    const local = playback.localUsable;
    if (local) {
      return {
        title: local.songTitle,
        artist: local.artistName ?? local.animeTitle,
        cover: local.coverImage,
      };
    }
    return null;
  }, [session.detail, currentQueueItem, playback.localUsable]);

  const value = useMemo<PlaybackContextValue>(
    () => ({
      session,
      playback,
      nowPlaying,
      startSession,
      updateSession,
      endSession,
      queue,
      queueOrigin: queue?.origin ?? 'other',
      queueIndex: queue?.index ?? 0,
      currentQueueItem,
      nextQueueItem,
      hasNext,
      hasPrev,
      hasPrevious: hasPrev,
      startQueue,
      setQueue: setQueueClaim,
      repeatMode,
      cycleRepeat,
      next,
      prev,
      previous: prev,
      resolution,
    }),
    [
      session,
      playback,
      nowPlaying,
      startSession,
      updateSession,
      endSession,
      queue,
      currentQueueItem,
      nextQueueItem,
      hasNext,
      hasPrev,
      startQueue,
      setQueueClaim,
      repeatMode,
      cycleRepeat,
      next,
      prev,
      resolution,
    ],
  );

  /* Perf problem 12: the two extra channels (see their note at
     the context declarations). The progress value is rebuilt
     only when the tick pair actually changes (the engine's
     stabilized progress keeps its identity within a second, so
     this memo holds across same-second ticks too); the slow
     value rides the engine slow object's identity, which is
     stable across ALL ticks. */
  const progressValue = useMemo<PlaybackProgressValue>(
    () => ({ progress: playback.progress, fraction: playback.fraction }),
    [playback.progress, playback.fraction],
  );
  const slowSessionValue = useMemo<PlaybackSlowSessionValue>(
    () => ({
      session,
      playback: playback.slow,
      startSession,
      updateSession,
      endSession,
    }),
    [session, playback.slow, startSession, updateSession, endSession],
  );

  return (
    <PlaybackContext.Provider value={value}>
      <PlaybackSlowContext.Provider value={slowSessionValue}>
        <PlaybackProgressContext.Provider value={progressValue}>
          {children}
        </PlaybackProgressContext.Provider>
      </PlaybackSlowContext.Provider>
    </PlaybackContext.Provider>
  );
}

export function usePlaybackSession(): PlaybackContextValue {
  const ctx = useContext(PlaybackContext);
  if (!ctx) {
    throw new Error(
      'usePlaybackSession must be used inside <PlaybackProvider>.',
    );
  }
  return ctx;
}

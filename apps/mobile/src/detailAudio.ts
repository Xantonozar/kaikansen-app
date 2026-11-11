import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  createDownloadResumable,
  type DownloadResumable,
} from 'expo-file-system/legacy';

/**
 * Detail Listen prepare cache (buffer package, 2026-11-11) —
 * the theme detail page's Listen file, fetched as a DOWNLOAD
 * instead of streamed into a player.
 *
 * Why: on a dipping single-flow road a player STREAM dies on
 * the first connection reset, and the listen chain's next step
 * is the 40–60 MB video file played hidden — so a chopped
 * 3.5 MB .ogg turned into "Listen stuck buffering" while the
 * video drowned (the owner's 1.0.3 peak-hour field report).
 * A DownloadResumable transfer RESUMES across resets instead
 * of dying, so the whole small file lands even on a bad road —
 * and a completed local file then plays perfectly, immune to
 * the road entirely.
 *
 * Shape (the quiz part-6 slice engine, src/quizPrefetch.ts, is
 * the working reference for cache hygiene; this module differs
 * where the job differs — the WHOLE file, not a capped slice,
 * and a per-theme lifetime rather than a per-game one):
 *
 * - The detail page's passive Listen preload calls
 *   prepareDetailAudio(claimKey, url): the transfer runs into
 *   a dedicated CACHE directory (`Paths.cache/detail-audio/`)
 *   — never the user's Downloads library, never the quiz
 *   slices folder. Dedupe is by claim key + URL: in-flight or
 *   ready entries are never restarted, so the activating tap
 *   waits on the SAME transfer the preload started.
 * - When the file lands, the engine leads the listen chain
 *   with it (detailListenCandidates below); a tap that arrives
 *   mid-transfer waits for it under the module's own stall
 *   watchdog (detailAudioStallShouldTrip: 30s without a byte
 *   of progress and the engine abandons the download and falls
 *   through to the streamed chain, unchanged).
 * - A failed transfer leaves NO entry, so the engine streams
 *   instead of waiting, and a later claim may retry the
 *   download once.
 *
 * Retention: the current claim's entry is PINNED (prepare
 * moves the pin); beyond it the newest
 * DETAIL_AUDIO_RETAIN_COUNT unpinned entries are retained and
 * the rest evicted (cancel + delete) at prepare time. A
 * theme-hopping user therefore keeps the last few themes'
 * files warm — a return visit plays instantly — while the
 * cache stays bounded at a handful of ~2–4 MB files. Leaving
 * a claim unpins it (the engine calls unpinDetailAudio); the
 * files themselves are OS-reclaimable cache throughout.
 */

export const detailAudioSupported = Platform.OS !== 'web';

/**
 * The download stall budget (owner's audio grace, mirrored):
 * a prepare transfer that delivers no byte for this long is
 * abandoned and the engine falls through to the streamed
 * chain. Progress — any byte — restarts the clock.
 */
export const DETAIL_AUDIO_STALL_MS = 30_000;

/** Unpinned entries retained beside the pinned claim's. */
export const DETAIL_AUDIO_RETAIN_COUNT = 2;

const DETAIL_AUDIO_DIR_NAME = 'detail-audio';

/* ------------------------------------------------------------------ */
/* Pure decisions                                                      */
/* ------------------------------------------------------------------ */

/**
 * The cache file's name for a claim key. The extension comes
 * from the source URL and is load-bearing: the engine
 * classifies candidates by extension, and the prepared file
 * must read as audio (the catalogue norm is .ogg).
 */
export function detailAudioFileNameFor(key: string, url: string): string {
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  const ext =
    dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
  const suffix = /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'ogg';
  return `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.${suffix}`;
}

/** The transfer's progress as a fraction, or null while the
    total is unknown (no honest % exists yet — never faked). */
export function detailAudioFraction(
  totalBytesWritten: number,
  totalBytesExpectedToWrite: number,
): number | null {
  if (
    !Number.isFinite(totalBytesWritten) ||
    !Number.isFinite(totalBytesExpectedToWrite) ||
    totalBytesExpectedToWrite <= 0
  ) {
    return null;
  }
  return Math.min(1, Math.max(0, totalBytesWritten / totalBytesExpectedToWrite));
}

/**
 * The prepare download's stall decision: the engine abandons
 * the download candidate (and falls through to the streamed
 * chain, attribution intact) only when ALL hold:
 * - the transfer is still fetching (a landed file has no
 *   stall left to judge);
 * - playback has NOT started — a started source is immune,
 *   the same rule the player watchdog lives by;
 * - no byte of progress for DETAIL_AUDIO_STALL_MS, measured
 *   from the last progress stamp (the transfer's start stamps
 *   it, so a transfer that never delivers a byte is judged
 *   from its start, and every byte restarts the clock).
 */
export function detailAudioStallShouldTrip(args: {
  status: 'fetching' | 'ready';
  now: number;
  lastProgressAt: number;
  playbackStarted: boolean;
}): boolean {
  if (args.status !== 'fetching') return false;
  if (args.playbackStarted) return false;
  if (args.lastProgressAt <= 0) return false;
  return args.now - args.lastProgressAt >= DETAIL_AUDIO_STALL_MS;
}

/**
 * The detail Listen candidate plan — the single statement of
 * what the engine's listen chain IS for a detail claim:
 * - a completed LIBRARY download wins outright (the engine's
 *   long-standing precedence: localUsable short-circuits the
 *   chain; the plan states the same winner so the rule lives
 *   in one tested place);
 * - else the PREPARED cache file leads, once its download has
 *   completed, with the untouched remote chain behind it (a
 *   file that fails to decode advances into the streamed .ogg
 *   and then the hidden video, exactly as today);
 * - else the remote chain as resolved. No-audio themes (an
 *   empty remote chain) stay empty — a prepared file only ever
 *   comes from a chain's first candidate, so it can never
 *   invent one.
 */
export function detailListenCandidates(args: {
  libraryUri: string | null;
  preparedUri: string | null;
  remoteChain: readonly string[];
}): string[] {
  if (args.libraryUri !== null) return [args.libraryUri];
  if (args.preparedUri !== null && args.remoteChain.length > 0) {
    return [
      args.preparedUri,
      ...args.remoteChain.filter((url) => url !== args.preparedUri),
    ];
  }
  return [...args.remoteChain];
}

/* ------------------------------------------------------------------ */
/* Registry + prepare transfer                                         */
/* ------------------------------------------------------------------ */

export interface DetailAudioEntry {
  key: string;
  url: string;
  fileName: string;
  /** The playable local URI once (and while) the file exists. */
  uri: string;
  status: 'fetching' | 'ready';
  /** Bytes delivered so far, and the expected total (-1/0
      while the server has not said). */
  bytesWritten: number;
  totalBytesExpected: number;
  /** Epoch ms of the last byte of progress (the start stamps
      it — see detailAudioStallShouldTrip). */
  lastProgressAt: number;
  /** The live claim's entry: exempt from eviction. */
  pinned: boolean;
  /** Monotonic touch order, for retention (newest kept). */
  seq: number;
  task: DownloadResumable | null;
  /** The progress snapshot handed to React subscribers —
      rebuilt only when the whole-percent or the status moves,
      so its identity is stable between visible changes. */
  snapshot: DetailAudioProgress;
}

export interface DetailAudioProgress {
  status: 'fetching' | 'ready';
  fraction: number | null;
}

const entries = new Map<string, DetailAudioEntry>();
const listeners = new Set<() => void>();
let seqCounter = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeDetailAudio(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function detailAudioDir(): Directory {
  return new Directory(Paths.cache, DETAIL_AUDIO_DIR_NAME);
}

function deleteDetailAudioFile(fileName: string): void {
  try {
    const file = new File(detailAudioDir(), fileName);
    if (file.exists) file.delete();
  } catch {
    // Best-effort: the cache directory is OS-reclaimable scratch.
  }
}

function evictEntry(entry: DetailAudioEntry): void {
  if (entry.task) {
    void entry.task.cancelAsync().catch(() => undefined);
    entry.task = null;
  }
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  deleteDetailAudioFile(entry.fileName);
}

/** Refresh an entry's React snapshot if its visible progress
    (whole percent or status) moved; returns whether it did. */
function refreshSnapshot(entry: DetailAudioEntry): boolean {
  const fraction = detailAudioFraction(
    entry.bytesWritten,
    entry.totalBytesExpected,
  );
  const prev = entry.snapshot;
  const prevPercent =
    prev.fraction === null ? null : Math.floor(prev.fraction * 100);
  const nextPercent = fraction === null ? null : Math.floor(fraction * 100);
  if (prev.status === entry.status && prevPercent === nextPercent) {
    return false;
  }
  entry.snapshot = { status: entry.status, fraction };
  return true;
}

/**
 * Prepare the detail Listen file for a claim: start the
 * download (or join the one already running / done) for
 * `key` + `url`, and pin the entry as the live claim's.
 * Fire-and-forget for callers; never throws.
 */
export function prepareDetailAudio(key: string, url: string): void {
  if (!detailAudioSupported) return;
  const existing = entries.get(key);
  if (existing && existing.url !== url) evictEntry(existing);
  // The pin follows the newest prepare; everything else is
  // retention-eligible.
  for (const entry of entries.values()) entry.pinned = entry.key === key;
  const current = entries.get(key);
  if (current && current.url === url) {
    current.seq = ++seqCounter;
    return;
  }
  const fileName = detailAudioFileNameFor(key, url);
  const entry: DetailAudioEntry = {
    key,
    url,
    fileName,
    uri: new File(detailAudioDir(), fileName).uri,
    status: 'fetching',
    bytesWritten: 0,
    totalBytesExpected: -1,
    lastProgressAt: Date.now(),
    pinned: true,
    seq: ++seqCounter,
    task: null,
    snapshot: { status: 'fetching', fraction: null },
  };
  entries.set(key, entry);
  // Retention: the pinned entry plus the newest few unpinned;
  // a stale theme's transfer/file never survives a new prepare.
  const unpinned = [...entries.values()]
    .filter((e) => !e.pinned)
    .sort((a, b) => b.seq - a.seq);
  for (const stale of unpinned.slice(DETAIL_AUDIO_RETAIN_COUNT)) {
    evictEntry(stale);
  }
  emit();
  void runDetailAudioFetch(entry);
}

async function runDetailAudioFetch(entry: DetailAudioEntry): Promise<void> {
  try {
    const dir = detailAudioDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const dest = new File(dir, entry.fileName);
    entry.uri = dest.uri;
    // A stale partial from a killed attempt starts from byte
    // zero (the downloads module's precedent).
    try {
      if (dest.exists) dest.delete();
    } catch {
      // The transfer below surfaces any real problem.
    }
    const task = createDownloadResumable(entry.url, dest.uri, {}, (data) => {
      if (entries.get(entry.key) !== entry) return;
      if (data.totalBytesWritten > entry.bytesWritten) {
        entry.bytesWritten = data.totalBytesWritten;
        entry.lastProgressAt = Date.now();
      }
      entry.totalBytesExpected = data.totalBytesExpectedToWrite;
      if (refreshSnapshot(entry)) emit();
    });
    entry.task = task;
    const result = await task.downloadAsync();
    entry.task = null;
    if (entries.get(entry.key) !== entry) {
      // Evicted / abandoned / replaced while in flight (the
      // evictor already handled the file) — nothing to register.
      return;
    }
    if (result === undefined) {
      // Cancelled without an eviction — the stall abandon is
      // the only other canceller, and it removes the entry
      // itself first; reaching here means the entry was
      // dropped another way. Leave no phantom behind.
      entries.delete(entry.key);
      deleteDetailAudioFile(entry.fileName);
      emit();
      return;
    }
    const size = dest.exists ? dest.size : 0;
    if (size > 0) {
      entry.bytesWritten = size;
      entry.status = 'ready';
      refreshSnapshot(entry);
      emit();
      return;
    }
    // Nothing landed: no entry — the engine streams instead,
    // and a later claim may retry once.
    entries.delete(entry.key);
    deleteDetailAudioFile(entry.fileName);
    emit();
  } catch {
    // A failed prepare is silent by design: the streamed chain
    // is unaffected. Leave no entry (see above) — and only
    // touch the file while this entry is still the registered
    // one: a replaced entry's successor may already be writing
    // the same file name for the same claim key.
    if (entries.get(entry.key) === entry) {
      entries.delete(entry.key);
      deleteDetailAudioFile(entry.fileName);
      emit();
    }
  }
}

/** The registry entry for a claim key, or null. */
export function getDetailAudioEntry(key: string): DetailAudioEntry | null {
  return entries.get(key) ?? null;
}

/**
 * Drop EVERY prepared entry (cancel + delete): the registry's
 * reset hatch. Playback never calls it — prepared files are
 * public catalogue audio, warm across claims by design — but a
 * cache/account reset surface (and the unit suite) can clear
 * the whole prepare cache deterministically.
 */
export function clearDetailAudioCache(): void {
  for (const entry of [...entries.values()]) evictEntry(entry);
  emit();
}

/** The progress snapshot for a claim key (stable identity
    between visible changes — the useSyncExternalStore
    contract), or null when nothing is prepared for the key. */
export function getDetailAudioProgressSnapshot(
  key: string,
): DetailAudioProgress | null {
  return entries.get(key)?.snapshot ?? null;
}

/**
 * Release a claim's pin (the claim left — a mode flip, a new
 * theme, session end): the entry becomes retention-eligible
 * but is NOT deleted — a return visit finds it warm.
 */
export function unpinDetailAudio(key: string): void {
  const entry = entries.get(key);
  if (entry) entry.pinned = false;
}

/**
 * Abandon a claim's download (the engine's stall verdict):
 * cancel the transfer, delete the partial, drop the entry —
 * the engine falls through to the streamed chain, and a later
 * claim may prepare the file afresh.
 */
export function abandonDetailAudio(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  evictEntry(entry);
  emit();
}

/* ------------------------------------------------------------------ */
/* React binding                                                       */
/* ------------------------------------------------------------------ */

/**
 * The prepare progress for a claim key, for load-state UI (the
 * Listen hero's honest %): re-renders only when the whole
 * percent or the status moves. Null when no download is (or
 * was) preparing for the key.
 */
export function useDetailAudioProgress(
  key: string | null,
): DetailAudioProgress | null {
  return useSyncExternalStore(
    subscribeDetailAudio,
    () =>
      key === null ? null : getDetailAudioProgressSnapshot(key),
    () => null,
  );
}

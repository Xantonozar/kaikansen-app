import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  createDownloadResumable,
  type DownloadResumable,
} from 'expo-file-system/legacy';
import {
  detailAudioFileNameFor,
  detailAudioFraction,
  detailAudioStallShouldTrip,
  detailListenCandidates,
} from './detailAudio';

/**
 * Queue Listen prepare cache (owner order 2026-11-15) — the
 * queue counterpart of the detail prepare cache
 * (src/detailAudio.ts): while a queue track plays in Listen
 * mode, the NEXT queue items' whole .ogg files are fetched as
 * resumable DOWNLOADS into a dedicated cache
 * (`Paths.cache/queue-audio/`), so advancing plays a landed
 * local file instantly instead of streaming through a dipping
 * road. This replaces the problem-3 slot STREAM for queue
 * next-tracks (a stream dies on the first connection reset;
 * a DownloadResumable transfer resumes across resets — the
 * detail cache's proven lesson).
 *
 * Rolling window (owner's spec, sequential — never parallel):
 * - N+1 (the next track) is prepared as soon as the engine's
 *   relaxed gate opens (mediaEngine.shouldStartQueuePrepare);
 * - N+2 is prepared ONLY once N+1's entry is 'ready'
 *   (shouldPrepareSecondNext) and never on a metered
 *   connection. At most ONE queue-audio transfer therefore
 *   runs at a time in queue order, and downloads never race
 *   each other or the current track's start burst.
 *
 * Background behaviour (owner's reason for the order: Library
 * / Popular listeners background the app and do other tasks):
 * the prepare lives in the app-level playback provider's
 * engine, not in any screen, so it is not tied to a screen
 * being focused or foregrounded; the transfers are native
 * DownloadResumable tasks, which keep running while expo-audio
 * plays in the background (AUDIO_MODE shouldPlayInBackground).
 * Honest limit: if Android kills the app process itself (a
 * swipe-away / force-stop), no JS or in-flight transfer can
 * survive — a later launch simply re-prepares; nothing here
 * claims a foreground-service download guarantee.
 *
 * Adoption: when the queue advances to a prepared item, the
 * engine leads its listen chain with the landed file
 * (queueListenCandidates — the detail plan, shared); while
 * the transfer is still fetching at advance, the engine WAITS
 * on that same transfer (no restart, no parallel stream) and
 * the 30s no-progress stall verdict (queueAudioStallShouldTrip
 * — detailAudio's rule, shared) abandons to the streamed
 * chain. A completed library/offline download still wins
 * outright; the hidden-video fallback is untouched.
 *
 * Retention: at most QUEUE_AUDIO_MAX_ENTRIES entries; the
 * pinned window (the provider pins current + next + next-next
 * keys via pinQueueAudioWindow) is eviction-exempt, the rest
 * are evicted oldest-first at prepare time. A failed transfer
 * leaves NO entry, so the engine streams and a later claim
 * may retry. Files are OS-reclaimable cache throughout —
 * never the user's Downloads library.
 */

export const queueAudioSupported = Platform.OS !== 'web';

/** The prepare stall budget — the owner's 30s audio grace,
    shared with the detail cache (detailAudio). */
export const QUEUE_AUDIO_STALL_MS = 30_000;

/** Hard cap on retained queue-audio entries (~2–4 MB each). */
export const QUEUE_AUDIO_MAX_ENTRIES = 5;

const QUEUE_AUDIO_DIR_NAME = 'queue-audio';

/* ------------------------------------------------------------------ */
/* Pure decisions (shared with detailAudio where the rule is one)      */
/* ------------------------------------------------------------------ */

/** Cache file name for a queue key — detailAudio's rule
    (sanitised key + the source's real extension). */
export const queueAudioFileNameFor = detailAudioFileNameFor;

/** Transfer progress fraction — detailAudio's rule. */
export const queueAudioFraction = detailAudioFraction;

/** The candidate plan for a queue advance — detailAudio's plan:
    library download wins, else the landed prepare file leads
    with the untouched remote chain behind it, else the remote
    chain as resolved. */
export const queueListenCandidates = detailListenCandidates;

/**
 * The prepare download's stall verdict — detailAudio's rule:
 * abandon only a still-fetching transfer with no byte of
 * progress for QUEUE_AUDIO_STALL_MS and no started playback.
 */
export function queueAudioStallShouldTrip(args: {
  status: 'fetching' | 'ready';
  now: number;
  lastProgressAt: number;
  playbackStarted: boolean;
}): boolean {
  return detailAudioStallShouldTrip(args);
}

/**
 * The rolling-second decision (owner spec 2026-11-15): N+2 is
 * prepared ONLY when ALL hold —
 * - a second-next item exists;
 * - N+1's entry is fully 'ready' (sequential: the N+2 transfer
 *   never runs parallel to N+1's);
 * - the connection is NOT metered (N+1 always prepares; the
 *   opportunistic second file is a Wi-Fi/unmetered luxury).
 */
export function shouldPrepareSecondNext(args: {
  hasSecond: boolean;
  firstStatus: 'fetching' | 'ready' | null;
  metered: boolean;
}): boolean {
  if (!args.hasSecond) return false;
  if (args.metered) return false;
  return args.firstStatus === 'ready';
}

/* ------------------------------------------------------------------ */
/* Registry + prepare transfer (detailAudio's shape, queue keys)       */
/* ------------------------------------------------------------------ */

export interface QueueAudioEntry {
  key: string;
  url: string;
  fileName: string;
  uri: string;
  status: 'fetching' | 'ready';
  bytesWritten: number;
  totalBytesExpected: number;
  lastProgressAt: number;
  /** In the pinned window (current/next/next-next): exempt
      from eviction. */
  pinned: boolean;
  seq: number;
  task: DownloadResumable | null;
  snapshot: QueueAudioProgress;
}

export interface QueueAudioProgress {
  status: 'fetching' | 'ready';
  fraction: number | null;
}

const entries = new Map<string, QueueAudioEntry>();
const listeners = new Set<() => void>();
let seqCounter = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeQueueAudio(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function queueAudioDir(): Directory {
  return new Directory(Paths.cache, QUEUE_AUDIO_DIR_NAME);
}

function deleteQueueAudioFile(fileName: string): void {
  try {
    const file = new File(queueAudioDir(), fileName);
    if (file.exists) file.delete();
  } catch {
    // Best-effort: the cache directory is OS-reclaimable scratch.
  }
}

function evictEntry(entry: QueueAudioEntry): void {
  if (entry.task) {
    void entry.task.cancelAsync().catch(() => undefined);
    entry.task = null;
  }
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  deleteQueueAudioFile(entry.fileName);
}

function refreshSnapshot(entry: QueueAudioEntry): boolean {
  const fraction = queueAudioFraction(
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
 * Pin the rolling window: exactly these keys are
 * eviction-exempt (the provider passes current + next +
 * next-next queue keys as the queue moves). Entries outside
 * the window stay warm until the retention cap evicts them.
 */
export function pinQueueAudioWindow(keys: readonly string[]): void {
  const window = new Set(keys);
  let changed = false;
  for (const entry of entries.values()) {
    const pinned = window.has(entry.key);
    if (entry.pinned !== pinned) {
      entry.pinned = pinned;
      changed = true;
    }
  }
  if (changed) emit();
}

function enforceRetention(): void {
  if (entries.size <= QUEUE_AUDIO_MAX_ENTRIES) return;
  const unpinned = [...entries.values()]
    .filter((e) => !e.pinned)
    .sort((a, b) => a.seq - b.seq);
  for (const stale of unpinned) {
    if (entries.size <= QUEUE_AUDIO_MAX_ENTRIES) break;
    evictEntry(stale);
  }
}

/**
 * Prepare the queue Listen file for `key` + `url`: start the
 * download (or join the one already running / done). Dedupe
 * is by key + URL — an in-flight or ready entry is never
 * restarted, so an advance waits on the SAME transfer the
 * preload started. Fire-and-forget; never throws.
 */
export function prepareQueueAudio(key: string, url: string): void {
  if (!queueAudioSupported) return;
  const existing = entries.get(key);
  if (existing && existing.url !== url) evictEntry(existing);
  const current = entries.get(key);
  if (current && current.url === url) {
    current.seq = ++seqCounter;
    return;
  }
  const fileName = queueAudioFileNameFor(key, url);
  const entry: QueueAudioEntry = {
    key,
    url,
    fileName,
    uri: new File(queueAudioDir(), fileName).uri,
    status: 'fetching',
    bytesWritten: 0,
    totalBytesExpected: -1,
    lastProgressAt: Date.now(),
    pinned: false,
    seq: ++seqCounter,
    task: null,
    snapshot: { status: 'fetching', fraction: null },
  };
  entries.set(key, entry);
  enforceRetention();
  emit();
  void runQueueAudioFetch(entry);
}

async function runQueueAudioFetch(entry: QueueAudioEntry): Promise<void> {
  try {
    const dir = queueAudioDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const dest = new File(dir, entry.fileName);
    entry.uri = dest.uri;
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
    if (entries.get(entry.key) !== entry) return;
    if (result === undefined) {
      entries.delete(entry.key);
      deleteQueueAudioFile(entry.fileName);
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
    entries.delete(entry.key);
    deleteQueueAudioFile(entry.fileName);
    emit();
  } catch {
    if (entries.get(entry.key) === entry) {
      entries.delete(entry.key);
      deleteQueueAudioFile(entry.fileName);
      emit();
    }
  }
}

/** The registry entry for a queue key, or null. */
export function getQueueAudioEntry(key: string): QueueAudioEntry | null {
  return entries.get(key) ?? null;
}

/** Drop EVERY prepared entry (cancel + delete) — the reset
    hatch (and the unit suite's deterministic clear). */
export function clearQueueAudioCache(): void {
  for (const entry of [...entries.values()]) evictEntry(entry);
  emit();
}

/** The progress snapshot for a queue key (stable identity
    between visible changes), or null. */
export function getQueueAudioProgressSnapshot(
  key: string,
): QueueAudioProgress | null {
  return entries.get(key)?.snapshot ?? null;
}

/**
 * Abandon / discard a queue key's preparation (a skip or queue
 * change re-keyed away from it, or the stall verdict): cancel
 * the transfer, delete the partial, drop the entry. A key that
 * IS the live claim's must never be passed here — the engine
 * guards that at its call sites, as the slot path did.
 */
export function abandonQueueAudio(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  evictEntry(entry);
  emit();
}

/** Discard name for the re-key call sites (same operation). */
export const discardQueueAudio = abandonQueueAudio;

/* ------------------------------------------------------------------ */
/* React binding                                                       */
/* ------------------------------------------------------------------ */

/** The prepare progress for a queue key — the engine reads the
    next entry's status through this to fire the rolling-second
    decision the moment N+1 lands. */
export function useQueueAudioProgress(
  key: string | null,
): QueueAudioProgress | null {
  return useSyncExternalStore(
    subscribeQueueAudio,
    () => (key === null ? null : getQueueAudioProgressSnapshot(key)),
    () => null,
  );
}

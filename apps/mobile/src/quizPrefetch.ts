import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  createDownloadResumable,
  type DownloadResumable,
} from 'expo-file-system/legacy';

/**
 * Solo quiz slice prefetch (quiz total solution part 6,
 * 2026-11-11) — the next question's song, prefetched as a
 * PARTIAL file instead of a whole-song player preload.
 *
 * Why a slice: the old preload loaded the entire ~3.5 MB .ogg
 * into the shared player slot during the ~2.8s feedback window,
 * which slow connections could not finish — the preload was
 * starved, not broken. Part 5 widened the window (the audio URL
 * is revealed at the CURRENT question's playback start, ~20s
 * ahead); this module spends that window on only the HEAD of
 * the file: the first ~1 MB. At the catalogue's bitrates
 * (192–317 kbps) 1 MB is ~25–40s of audio — more than the whole
 * 20s question — for roughly a quarter of the bytes. Per game
 * that is ~8–10 MB instead of ~35 MB.
 *
 * How: the app's existing resumable-download machinery
 * (expo-file-system's DownloadResumable, the same handle
 * src/downloads.ts drives) streams the .ogg into a dedicated
 * CACHE directory — never the user's Downloads library, never
 * registered as a user download — and the transfer is CANCELLED
 * the moment the byte cap is reached. Cancelling keeps the
 * partial file on disk (the downloads module's precedent: a
 * cancelled transfer resolves undefined and its partial stays
 * until deleted), and that partial IS the slice. If the host
 * ignores range semantics the stream is still progressive, so
 * the cancel-at-cap is what bounds the bytes either way.
 *
 * When the question starts, its candidate chain tries the slice
 * FIRST (a local file:// … .ogg URI — an ordinary audio
 * candidate to the quiz engine: the v2 watchdog, clock and
 * resurrection rules treat it exactly like the remote .ogg),
 * with the untouched remote chain (.ogg URL → video URL) behind
 * it. A slice that is missing, too small, or undecodable falls
 * through to that chain — the design self-heals; nothing here
 * can make a question LESS playable than today. (Decoder
 * tolerance of a truncated Ogg cannot be unit-proven — ogg
 * headers sit at the START of the file and expo-audio streams
 * progressively, but the field test is still owed; see the
 * part 5–7 report.)
 *
 * Storage hygiene (slices are per-game scratch):
 * - at most ONE unpinned slice is retained — the next
 *   question's; starting a prefetch evicts every other
 *   unpinned slice (cancel + delete);
 * - the CURRENT question's slice is PINNED when the question
 *   starts (its player may be reading the file) and survives
 *   eviction until the game is cleared;
 * - clearQuizSlices() (new game / screen unmount) cancels and
 *   deletes everything, pinned or not. Nothing leaks across
 *   games.
 *
 * Both reveals feed the SAME prefetch: the part-5 early reveal
 * (playback-start response) and the feedback reveal (answer
 * response) both resolve — via mediaEngine.resolveSoloNextPreload
 * — to the same nextCandidates/nextMediaKey props, and the quiz
 * hook's effect calls prefetchQuizSlice for both. Dedupe is by
 * mediaKey + URL: a slice in flight or ready for a key is never
 * restarted; a FAILED prefetch leaves no entry, so the later
 * reveal may retry once.
 *
 * F6 grace (clock batch, 2026-11-12): a question that starts
 * while its slice is STILL IN FLIGHT no longer throws the
 * transfer's progress away. The screen holds its chain freeze
 * for a short bounded grace (QUIZ_SLICE_GRACE_MS), waiting on
 * the entry's settle promise (whenQuizSliceSettles); if the
 * slice finalizes inside the grace it leads the chain exactly
 * as a slice that landed early would have. The grace is free
 * under the clock doctrine — the answer clock starts on
 * genuine audio start, so a loading beat costs no answer
 * time — and it is bounded so a stuck transfer delays the
 * freeze by at most the grace, never more. Partial-byte
 * adoption (starting playback from an UNFINISHED slice file)
 * was evaluated and NOT adopted — see the batch report
 * BATCH-109-2026-11-12.md §F6 for the mechanism-A/B evidence.
 */

export const quizSlicesSupported = Platform.OS !== 'web';

/** Byte cap for one slice: ~25–40s of audio at catalogue bitrates. */
export const QUIZ_SLICE_CAP_BYTES = 1_000_000;

/**
 * A slice smaller than this is not worth handing to the decoder
 * (a couple of seconds of audio at best, likely a truncated
 * header) — it is discarded and the remote chain plays instead.
 */
export const QUIZ_SLICE_MIN_BYTES = 64 * 1024;

const SLICE_DIR_NAME = 'quiz-slices';

/* ------------------------------------------------------------------ */
/* Pure decisions                                                      */
/* ------------------------------------------------------------------ */

/** Whether a streamed byte count has reached the slice cap. */
export function sliceCapReached(
  totalBytesWritten: number,
  capBytes: number = QUIZ_SLICE_CAP_BYTES,
): boolean {
  return totalBytesWritten >= capBytes;
}

/** Whether a finished slice file is big enough to be usable. */
export function sliceIsUsable(
  sizeBytes: number,
  minBytes: number = QUIZ_SLICE_MIN_BYTES,
): boolean {
  return sizeBytes >= minBytes;
}

/**
 * F6 grace bound (2026-11-12): how long a starting question
 * may hold its chain freeze for an in-flight slice to
 * finalize. ~3 s at the owner's measured ~87 KB/s worst-case
 * flow is ~260 KB — a large share of the remaining distance
 * for a slice that spent a whole question + feedback window
 * downloading — while a slice nowhere near done expires the
 * grace and the question proceeds exactly as before.
 */
export const QUIZ_SLICE_GRACE_MS = 3_000;

/** A mediaKey's slice situation, for the freeze decision. */
export type QuizSliceState = 'none' | 'fetching' | 'ready';

/**
 * The F6 grace decision: the freeze waits ONLY for a slice
 * that is actually in flight. 'ready' needs no wait (the
 * freeze reads it immediately) and 'none' must never wait —
 * there is nothing coming, and holding would only delay the
 * question's own load (and its failed/empty verdict paths)
 * for nothing.
 */
export function sliceGraceApplies(state: QuizSliceState): boolean {
  return state === 'fetching';
}

/** The slice's file name for a mediaKey (`game:3` → `game_3.ogg`).
    The `.ogg` ending is load-bearing: the quiz engine classifies
    candidates by extension, and the slice must read as audio. */
export function sliceFileNameFor(mediaKey: string): string {
  return `${mediaKey.replace(/[^a-zA-Z0-9._-]/g, '_')}.ogg`;
}

/** Whether a URI is one of this module's slice files. The quiz
    hook's candidate filter accepts these alongside http(s) URLs
    (playback.isPlausibleUrl deliberately stays http-only for
    every other caller). */
export function isQuizSliceUri(uri: string | null): uri is string {
  return (
    uri !== null &&
    uri.startsWith('file://') &&
    uri.split(/[?#]/)[0].toLowerCase().endsWith('.ogg')
  );
}

/**
 * The question's candidate chain with its slice first: the
 * slice (when ready) leads, then the remote chain in its given
 * order, deduplicated, nulls dropped — byte-identical to the
 * old inline construction when no slice exists.
 */
export function quizSliceCandidates(
  sliceUri: string | null,
  chain: readonly (string | null)[],
): string[] {
  const rest = chain.filter(
    (url, i, all): url is string => url !== null && all.indexOf(url) === i,
  );
  if (!sliceUri) return rest;
  return [sliceUri, ...rest.filter((url) => url !== sliceUri)];
}

/* ------------------------------------------------------------------ */
/* Registry + prefetch                                                 */
/* ------------------------------------------------------------------ */

interface SliceEntry {
  key: string;
  url: string;
  fileName: string;
  uri: string;
  status: 'fetching' | 'ready';
  /** The live question's slice: exempt from eviction. */
  pinned: boolean;
  task: DownloadResumable | null;
  /**
   * The in-flight fetch's own promise (F6): resolves when the
   * fetch settles — ready, discarded, or failed — and never
   * rejects. The question-start grace waits on THIS rather
   * than polling the registry.
   */
  settled: Promise<void>;
}

const slices = new Map<string, SliceEntry>();

function slicesDir(): Directory {
  return new Directory(Paths.cache, SLICE_DIR_NAME);
}

function deleteSliceFile(fileName: string): void {
  try {
    const file = new File(slicesDir(), fileName);
    if (file.exists) file.delete();
  } catch {
    // Best-effort: the cache directory is OS-reclaimable scratch.
  }
}

function evictEntry(entry: SliceEntry): void {
  if (entry.task) {
    void entry.task.cancelAsync().catch(() => undefined);
    entry.task = null;
  }
  if (slices.get(entry.key) === entry) slices.delete(entry.key);
  deleteSliceFile(entry.fileName);
}

/**
 * Prefetch the slice for `mediaKey` from `url` (the next
 * question's resolved audio URL). Fire-and-forget for callers;
 * the returned promise resolves when the slice is ready or has
 * been given up on — it never rejects.
 */
export function prefetchQuizSlice(
  mediaKey: string,
  url: string,
): Promise<void> {
  if (!quizSlicesSupported) return Promise.resolve();
  const existing = slices.get(mediaKey);
  if (existing && existing.url === url) {
    // Dedupe: in flight or ready — both reveals name the same
    // slice; never restart it. Returns the entry's OWN settle
    // promise (F6): a caller waiting on finalization (the
    // question-start grace) must observe the real transfer,
    // not an already-resolved stand-in.
    return existing.settled;
  }
  if (existing) evictEntry(existing);
  // Keep only the target slice among the unpinned: yesterday's
  // next is today's played question or a stale game entirely.
  for (const entry of [...slices.values()]) {
    if (!entry.pinned) evictEntry(entry);
  }

  const fileName = sliceFileNameFor(mediaKey);
  const entry: SliceEntry = {
    key: mediaKey,
    url,
    fileName,
    uri: new File(slicesDir(), fileName).uri,
    status: 'fetching',
    pinned: false,
    task: null,
    settled: Promise.resolve(),
  };
  slices.set(mediaKey, entry);
  entry.settled = runSliceFetch(entry);
  return entry.settled;
}

async function runSliceFetch(entry: SliceEntry): Promise<void> {
  try {
    const dir = slicesDir();
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
    let cancelSent = false;
    const task = createDownloadResumable(entry.url, dest.uri, {}, (data) => {
      if (!cancelSent && sliceCapReached(data.totalBytesWritten)) {
        cancelSent = true;
        // The partial file stays on disk — it IS the slice.
        void task.cancelAsync().catch(() => undefined);
      }
    });
    entry.task = task;
    // Resolves undefined when cancelled (at the cap, or by an
    // eviction/clear) and with a result on natural completion —
    // BOTH can leave a usable slice, so the verdict is the file.
    await task.downloadAsync();
    entry.task = null;
    if (slices.get(entry.key) !== entry) {
      // Evicted or cleared while in flight (its file was
      // already deleted by the evictor) — nothing to register.
      return;
    }
    const size = dest.exists ? dest.size : 0;
    if (sliceIsUsable(size)) {
      entry.status = 'ready';
      return;
    }
    // Too small to trust (or nothing landed): discard and let
    // the remote chain carry the question.
    slices.delete(entry.key);
    deleteSliceFile(entry.fileName);
  } catch {
    // A failed prefetch is silent by design: the question's
    // remote chain is unaffected. Leave no entry, so a later
    // reveal for the same key may retry.
    if (slices.get(entry.key) === entry) slices.delete(entry.key);
    deleteSliceFile(entry.fileName);
  }
}

/** The ready slice's file URI for a question, or null. */
export function getQuizSliceUri(mediaKey: string): string | null {
  const entry = slices.get(mediaKey);
  return entry && entry.status === 'ready' ? entry.uri : null;
}

/** A mediaKey's slice situation right now (F6 freeze decision). */
export function getQuizSliceState(mediaKey: string): QuizSliceState {
  const entry = slices.get(mediaKey);
  if (!entry) return 'none';
  return entry.status;
}

/**
 * The promise that resolves when a mediaKey's IN-FLIGHT slice
 * settles (ready, discarded, or failed — it never rejects), or
 * null when no fetch is in flight for the key. The F6 grace
 * races this against QUIZ_SLICE_GRACE_MS; on expiry the caller
 * simply re-reads getQuizSliceUri, exactly like a freeze with
 * no grace.
 */
export function whenQuizSliceSettles(mediaKey: string): Promise<void> | null {
  const entry = slices.get(mediaKey);
  if (!entry || entry.status !== 'fetching') return null;
  return entry.settled;
}

/**
 * Pin a question's slice while that question is live: its
 * player may be reading the file, so eviction (the next
 * prefetch) must not delete it from under the player.
 */
export function pinQuizSlice(mediaKey: string): void {
  const entry = slices.get(mediaKey);
  if (entry) entry.pinned = true;
}

/** Drop every slice (new game / screen unmount): cancel any
    in-flight transfer and delete every file, pinned or not. */
export function clearQuizSlices(): void {
  for (const entry of [...slices.values()]) evictEntry(entry);
  slices.clear();
}

import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import {
  createDownloadResumable,
  type DownloadResumable,
} from 'expo-file-system/legacy';
import type {
  PlaybackMode,
  ThemeDetail,
  ThemeEntry,
} from '@kaikansen/contracts';
import { fixtureMode } from './api';
import { isPlausibleUrl, resolvePlaybackUrl } from './playback';
import { plainStorage } from './storage';

/**
 * Offline downloads (Slice M3) — a mobile-only capability: the
 * website is a browser app and has no downloads to mirror, so this is
 * designed inside the app's own patterns (module store like
 * favoritesStore.ts, index in plain AsyncStorage via storage.ts,
 * files on disk via expo-file-system's SDK 58 API).
 *
 * What gets downloaded is exactly what the player would stream
 * (src/playback.ts is the single source of URL truth): `listen`
 * fetches the entry's audio file, `watch` its best video file. Files
 * live in `<document>/downloads/`; a JSON index in AsyncStorage
 * carries the metadata snapshot (title / artist / version / cover)
 * that lets the Library render and the player open a download with
 * no network and no catalogue fetch.
 *
 * Downloads are a LOCAL feature: no account is involved, so they are
 * available signed-out (the CDN URLs are public). Two honest gates:
 * fixture/demo mode disables starting downloads (demo URLs are not a
 * real catalogue — M1/M2 precedent), and web has no device storage to
 * fill, so the feature presents as unavailable there.
 *
 * Robustness: a failed download deletes its partial file and records
 * the real error; hydration re-checks every indexed file against the
 * disk — a vanished file marks its record `fileMissing` (shown broken
 * in the Library, ignored by the player, removable), and files in the
 * folder that no record points at (orphans of a killed download) are
 * swept. Downloads run in the foreground only: leaving the app
 * mid-download can orphan a partial, which the next hydration sweep
 * cleans up. Pause/resume is deliberately not offered; CANCEL is
 * (Slice 4 — the Downloads design draws a ✕ on the in-progress row):
 * the transfer runs on the legacy DownloadResumable for exactly
 * that handle, while all file bookkeeping stays on the SDK 58 API.
 * An in-flight download also keeps a display snapshot in the store
 * (`pending`), so the Downloads screen can draw its row — cover,
 * title, artist — before any record exists.
 */

export const downloadsSupported = Platform.OS !== 'web';

const INDEX_KEY = 'kaikansen.downloads.v1';
const DIR_NAME = 'downloads';

/** One completed download, as persisted in the index. */
export interface DownloadRecord {
  /** `${slug}:${atEntryId}:${mode}` — one file per entry + mode. */
  id: string;
  slug: string;
  atEntryId: number;
  mode: PlaybackMode;
  /** Bare file name inside the downloads folder. */
  fileName: string;
  /** Bytes on disk, refreshed from the file at hydration. */
  size: number;
  sourceUrl: string;
  /* Display snapshot for offline rendering. */
  songTitle: string;
  animeTitle: string;
  artistName: string | null;
  version: string;
  coverImage: string | null;
  downloadedAt: string;
  /**
   * Runtime-only drift flag (never trusted from disk): set when
   * hydration finds the indexed file gone. Broken records stay listed
   * so the user can remove them, but the player ignores them.
   */
  fileMissing?: boolean;
}

export function downloadId(
  slug: string,
  atEntryId: number,
  mode: PlaybackMode,
): string {
  return `${slug}:${atEntryId}:${mode}`;
}

export function findDownload(
  records: readonly DownloadRecord[],
  slug: string,
  atEntryId: number,
  mode: PlaybackMode,
): DownloadRecord | undefined {
  return records.find((r) => r.id === downloadId(slug, atEntryId, mode));
}

/** "812 KB" / "42.1 MB" — sizes in rows and the Library total. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/* ------------------------------------------------------------------ */
/* File plumbing (native only — every caller gates on support)         */
/* ------------------------------------------------------------------ */

function downloadsDir(): Directory {
  return new Directory(Paths.document, DIR_NAME);
}

function fileFor(record: DownloadRecord): File {
  return new File(downloadsDir(), record.fileName);
}

/** The playable local URI for a completed download. */
export function downloadFileUri(record: DownloadRecord): string {
  return fileFor(record).uri;
}

function fileNameFor(
  slug: string,
  atEntryId: number,
  mode: PlaybackMode,
  url: string,
): string {
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  const ext =
    dot > path.lastIndexOf('/')
      ? path.slice(dot + 1).toLowerCase()
      : '';
  const suffix = /^[a-z0-9]{2,5}$/.test(ext)
    ? ext
    : mode === 'watch'
      ? 'mp4'
      : 'm4a';
  const safeSlug = slug.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safeSlug}--${atEntryId}--${mode}.${suffix}`;
}

/* ------------------------------------------------------------------ */
/* Store (favoritesStore.ts pattern: module state + external store)    */
/* ------------------------------------------------------------------ */

/**
 * Display snapshot of a download still in flight (Slice 4): what
 * the Downloads screen's progress row renders. Set when a download
 * starts, cleared when it settles — success replaces it with a
 * record, failure with an error, cancel with nothing.
 */
export interface PendingDownload {
  id: string;
  slug: string;
  mode: PlaybackMode;
  songTitle: string;
  animeTitle: string;
  artistName: string | null;
  version: string;
  coverImage: string | null;
}

interface DownloadsState {
  records: DownloadRecord[];
  /** id → fraction 0..1, or null while the total size is unknown. */
  progress: ReadonlyMap<string, number | null>;
  /** id → display snapshot for downloads still in flight. */
  pending: ReadonlyMap<string, PendingDownload>;
  /** id → last failure message, until the next attempt clears it. */
  errors: ReadonlyMap<string, string>;
  hydrated: boolean;
}

const EMPTY: DownloadsState = {
  records: [],
  progress: new Map(),
  pending: new Map(),
  errors: new Map(),
  hydrated: false,
};

let state: DownloadsState = EMPTY;
const listeners = new Set<() => void>();

function emit(next: Partial<DownloadsState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DownloadsState {
  return state;
}

function setProgress(id: string, value: number | null): void {
  const progress = new Map(state.progress);
  progress.set(id, value);
  emit({ progress });
}

function clearProgress(id: string): void {
  if (!state.progress.has(id)) return;
  const progress = new Map(state.progress);
  progress.delete(id);
  emit({ progress });
}

function setPending(snapshot: PendingDownload): void {
  const pending = new Map(state.pending);
  pending.set(snapshot.id, snapshot);
  emit({ pending });
}

function clearPending(id: string): void {
  if (!state.pending.has(id)) return;
  const pending = new Map(state.pending);
  pending.delete(id);
  emit({ pending });
}

function setError(id: string, message: string): void {
  const errors = new Map(state.errors);
  errors.set(id, message);
  emit({ errors });
}

function clearError(id: string): void {
  if (!state.errors.has(id)) return;
  const errors = new Map(state.errors);
  errors.delete(id);
  emit({ errors });
}

async function persist(records: DownloadRecord[]): Promise<void> {
  // fileMissing is recomputed at hydration; keep it out of the index.
  const clean = records.map((r) => ({ ...r, fileMissing: undefined }));
  try {
    await plainStorage.set(INDEX_KEY, JSON.stringify(clean));
  } catch {
    // A failed index write loses the record at next launch, but the
    // file sweep treats the leftover as an orphan — nothing leaks.
  }
}

/* ------------------------------------------------------------------ */
/* Hydration + drift repair                                            */
/* ------------------------------------------------------------------ */

let hydratePromise: Promise<void> | null = null;

export function ensureDownloadsHydrated(): Promise<void> {
  if (state.hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      if (!downloadsSupported) {
        emit({ records: [], hydrated: true });
        return;
      }
      let parsed: DownloadRecord[] = [];
      const raw = await plainStorage.get(INDEX_KEY);
      if (raw) {
        const data: unknown = JSON.parse(raw);
        if (Array.isArray(data)) {
          parsed = data.filter(
            (r): r is DownloadRecord =>
              r !== null &&
              typeof r === 'object' &&
              typeof (r as DownloadRecord).id === 'string' &&
              typeof (r as DownloadRecord).fileName === 'string',
          );
        }
      }
      const records = parsed
        .map((r) => {
          try {
            const file = fileFor(r);
            if (!file.exists) return { ...r, fileMissing: true };
            return { ...r, size: file.size, fileMissing: undefined };
          } catch {
            return { ...r, fileMissing: true };
          }
        })
        .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
      emit({ records, hydrated: true });
      sweepOrphans(records);
    } catch {
      // A corrupt index must not wedge the feature: start empty; the
      // sweep (skipped here) leaves orphaned files for a later pass,
      // and new downloads proceed normally.
      emit({ records: [], hydrated: true });
    } finally {
      hydratePromise = null;
    }
  })();
  return hydratePromise;
}

/** File names with a download currently in flight (sweep guard). */
const inFlightFiles = new Set<string>();

/** Delete files in the downloads folder that no record points at. */
function sweepOrphans(records: DownloadRecord[]): void {
  try {
    const dir = downloadsDir();
    if (!dir.exists) return;
    const known = new Set(records.map((r) => r.fileName));
    for (const child of dir.list()) {
      if (
        child instanceof File &&
        !known.has(child.name) &&
        !inFlightFiles.has(child.name)
      ) {
        try {
          child.delete();
        } catch {
          // One stubborn file must not stop the sweep.
        }
      }
    }
  } catch {
    // Listing is best-effort hygiene, never user-facing.
  }
}

/**
 * Re-verify every record against the disk (Library focus): a file
 * deleted outside the app flips its record to broken without waiting
 * for a restart.
 */
export function recheckDownloads(): void {
  if (!downloadsSupported || !state.hydrated) return;
  let changed = false;
  const records = state.records.map((r) => {
    try {
      const exists = fileFor(r).exists;
      if (exists && r.fileMissing) {
        changed = true;
        return { ...r, fileMissing: undefined };
      }
      if (!exists && !r.fileMissing) {
        changed = true;
        return { ...r, fileMissing: true };
      }
    } catch {
      if (!r.fileMissing) {
        changed = true;
        return { ...r, fileMissing: true };
      }
    }
    return r;
  });
  if (changed) emit({ records });
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Download one entry in one mode. Never throws — resolves null on
 * success (or when the entry+mode is already downloaded / already in
 * flight) and the user-facing error message on failure. The outcome
 * also lands in the store (progress while running, record when done,
 * error map on failure), so any mounted surface stays in step.
 */
export async function startDownload(
  detail: ThemeDetail,
  entry: ThemeEntry,
  mode: PlaybackMode,
): Promise<string | null> {
  const id = downloadId(detail.slug, entry.atEntryId, mode);
  if (!downloadsSupported) return 'Downloads are not available on web.';
  if (fixtureMode) return 'Downloads are not available in demo mode.';
  if (state.progress.has(id)) return null;
  const existing = findDownload(state.records, detail.slug, entry.atEntryId, mode);
  if (existing && !existing.fileMissing) return null;

  const url = resolvePlaybackUrl(detail, entry, mode);
  if (!isPlausibleUrl(url)) {
    return mode === 'listen'
      ? 'This version has no audio source to download.'
      : 'This version has no video source to download.';
  }

  const fileName = fileNameFor(detail.slug, entry.atEntryId, mode, url);
  const artists = detail.artistName ?? detail.allArtists.join(', ');
  clearError(id);
  setProgress(id, null);
  setPending({
    id,
    slug: detail.slug,
    mode,
    songTitle: detail.songTitle,
    animeTitle: detail.animeTitle,
    artistName: artists.length > 0 ? artists : null,
    version: entry.version,
    coverImage: detail.animeCoverImage,
  });
  inFlightFiles.add(fileName);
  try {
    const dir = downloadsDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const dest = new File(dir, fileName);
    // A partial from a killed attempt has no index record; clear the
    // target so the fresh download starts from byte zero.
    try {
      if (dest.exists) dest.delete();
    } catch {
      // If the stale file cannot be removed the download below fails
      // with the real error, which is what gets surfaced.
    }
    let lastPercent = -1;
    const task = createDownloadResumable(url, dest.uri, {}, (data) => {
      if (data.totalBytesExpectedToWrite <= 0) return;
      const fraction = Math.min(
        1,
        Math.max(0, data.totalBytesWritten / data.totalBytesExpectedToWrite),
      );
      const percent = Math.floor(fraction * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        setProgress(id, fraction);
      }
    });
    activeTasks.set(id, task);
    const result = await task.downloadAsync();
    if (result === undefined) {
      // Cancelled (cancelDownload): not an error — the partial is
      // removed below and nothing is recorded anywhere.
      try {
        if (dest.exists) dest.delete();
      } catch {
        // Best-effort; the hydration sweep is the backstop.
      }
      clearProgress(id);
      clearPending(id);
      return null;
    }
    const record: DownloadRecord = {
      id,
      slug: detail.slug,
      atEntryId: entry.atEntryId,
      mode,
      fileName,
      size: dest.exists ? dest.size : 0,
      sourceUrl: url,
      songTitle: detail.songTitle,
      animeTitle: detail.animeTitle,
      artistName: artists.length > 0 ? artists : null,
      version: entry.version,
      coverImage: detail.animeCoverImage,
      downloadedAt: new Date().toISOString(),
    };
    const records = [record, ...state.records.filter((r) => r.id !== id)].sort(
      (a, b) => b.downloadedAt.localeCompare(a.downloadedAt),
    );
    clearProgress(id);
    clearPending(id);
    emit({ records });
    await persist(records);
    return null;
  } catch (e) {
    // Failed downloads clean up after themselves: no partial file is
    // left posing as content, and the error is the real one.
    try {
      const partial = new File(downloadsDir(), fileName);
      if (partial.exists) partial.delete();
    } catch {
      // Cleanup is best-effort; the hydration sweep is the backstop.
    }
    clearProgress(id);
    clearPending(id);
    const message =
      e instanceof Error ? e.message : 'The download failed. Try again.';
    setError(id, message);
    return message;
  } finally {
    activeTasks.delete(id);
    inFlightFiles.delete(fileName);
  }
}

/** In-flight transfer handles, by download id — the cancel lever. */
const activeTasks = new Map<string, DownloadResumable>();

/**
 * Cancel a download in flight (the Downloads screen's ✕). The
 * transfer resolves as cancelled inside startDownload, which
 * removes the partial and clears the row without recording an
 * error. Cancelling an id that is not downloading is a no-op.
 */
export async function cancelDownload(id: string): Promise<void> {
  const task = activeTasks.get(id);
  if (!task) return;
  try {
    await task.cancelAsync();
  } catch {
    // The transfer may have settled in the same tick — startDownload
    // owns the cleanup either way.
  }
}

/** Delete a download: file first (best-effort), then the index row. */
export async function removeDownload(id: string): Promise<void> {
  const record = state.records.find((r) => r.id === id);
  if (!record) return;
  if (downloadsSupported) {
    try {
      const file = fileFor(record);
      if (file.exists) file.delete();
    } catch {
      // Already gone or unremovable — the record still comes out, so
      // the Library never traps the user with an undeletable row.
    }
  }
  const records = state.records.filter((r) => r.id !== id);
  const errors = new Map(state.errors);
  errors.delete(id);
  emit({ records, errors });
  await persist(records);
}

/* ------------------------------------------------------------------ */
/* React binding                                                       */
/* ------------------------------------------------------------------ */

export interface UseDownloads {
  hydrated: boolean;
  records: DownloadRecord[];
  /** Display snapshots of downloads still in flight (start order). */
  downloading: PendingDownload[];
  /** Bytes held by healthy (non-broken) downloads. */
  totalBytes: number;
  /** True while id is downloading (progress may still be unknown). */
  isDownloading: (id: string) => boolean;
  /** 0..1 while downloading with a known total, else undefined/null. */
  progressFor: (id: string) => number | null | undefined;
  errorFor: (id: string) => string | null;
  find: (
    slug: string,
    atEntryId: number,
    mode: PlaybackMode,
  ) => DownloadRecord | undefined;
  start: (
    detail: ThemeDetail,
    entry: ThemeEntry,
    mode: PlaybackMode,
  ) => Promise<string | null>;
  remove: (id: string) => Promise<void>;
  /** Cancel a download in flight; a no-op for settled ids. */
  cancel: (id: string) => Promise<void>;
}

export function useDownloads(): UseDownloads {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void ensureDownloadsHydrated();
  }, []);

  return {
    hydrated: snap.hydrated,
    records: snap.records,
    downloading: [...snap.pending.values()],
    totalBytes: snap.records.reduce(
      (sum, r) => sum + (r.fileMissing ? 0 : r.size),
      0,
    ),
    isDownloading: (id) => snap.progress.has(id),
    progressFor: (id) => snap.progress.get(id),
    errorFor: (id) => snap.errors.get(id) ?? null,
    find: (slug, atEntryId, mode) =>
      findDownload(snap.records, slug, atEntryId, mode),
    start: startDownload,
    remove: removeDownload,
    cancel: cancelDownload,
  };
}

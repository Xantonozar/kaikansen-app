import { Injectable, Optional } from '@nestjs/common';
import { createWriteStream, promises as fsp } from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import path from 'node:path';

/**
 * Phase 2 head cache (owner-approved 2026-11-12, SOLO QUIZ
 * ONLY) — the API keeps the first {@link QUIZ_HEAD_BYTES} of
 * quiz songs on its own disk and serves them itself.
 *
 * Why: the phone's slow leg is the origin audio host
 * (a.animethemes.moe, Europe — ~1.5 s first byte and a thin
 * single flow from the owner's network; measured 2026-11-12:
 * a song's first 30 s is ~1.16 MB / ~2.3 s even on a datacenter
 * pipe). The API server sits on a datacenter pipe, so it pulls
 * each song's head ONCE, in parallel with the game, and the
 * phone then fetches its quiz slices (and its first player
 * candidate) from the API — same bytes, much shorter road. A
 * cache loss is only ever a miss: every consumer falls back to
 * the origin exactly as before this module existed.
 *
 * Hard rules baked in:
 * - DISPOSABLE: the cache is a plain directory of files
 *   (env QUIZ_HEAD_CACHE_DIR, default `quiz-heads-cache` under
 *   the service working directory — on hosts with an ephemeral
 *   disk it simply re-warms after a restart). Nothing here is
 *   read from or written to the shared database; there is no
 *   schema, no index, no record of what is cached — the
 *   directory IS the state.
 * - NOT AN OPEN PROXY: the origin host is hard-coded and the
 *   only names ever fetched or served match
 *   {@link isValidHeadFileName} (a single path segment, .ogg).
 * - Failures are never cached: an origin 404 / error / timeout
 *   stores nothing and answers null, so the client's origin
 *   fallback decides, exactly as today.
 */

export const QUIZ_HEAD_BYTES = 1_500_000;

/** The only origin this cache will ever talk to. */
export const QUIZ_HEAD_ORIGIN = 'https://a.animethemes.moe';

/** Default total cache budget (env QUIZ_HEAD_CACHE_MAX_MB). */
export const QUIZ_HEAD_CACHE_DEFAULT_MAX_MB = 500;

/**
 * A stuck origin must not hang a fill (or a request waiting on
 * one) forever: the whole pull — first byte plus the head's
 * transfer — gets this one budget. Datacenter pulls measured
 * ~2.3 s; 30 s is generous headroom, not a target.
 */
const HEAD_FETCH_TIMEOUT_MS = 30_000;

const HEAD_FILE_PATTERN = /^[A-Za-z0-9._-]+\.ogg$/;

/**
 * Whether a name is a servable head file: ONE path segment
 * (no separators, so no traversal is expressible), .ogg only.
 * This is the gate for BOTH the route parameter and cache-dir
 * scans — temp files (`<file>.part-<pid>-<n>`) never match, so
 * eviction and serving can never touch a file being written
 * under its final name.
 */
export function isValidHeadFileName(file: unknown): file is string {
  return typeof file === 'string' && HEAD_FILE_PATTERN.test(file);
}

/**
 * The head file name for a resolved audio URL, or null when
 * the URL is not an AnimeThemes .ogg this cache may mirror
 * (stored non-AnimeThemes audio, video links, null) — the
 * client keeps those on the plain origin chain.
 */
export function headFileNameForAudioUrl(
  audioUrl: string | null | undefined,
): string | null {
  if (typeof audioUrl !== 'string') return null;
  const prefix = `${QUIZ_HEAD_ORIGIN}/`;
  if (!audioUrl.startsWith(prefix)) return null;
  const file = audioUrl.slice(prefix.length);
  return isValidHeadFileName(file) ? file : null;
}

/** A parsed single Range against a body of `size` bytes. */
export type ParsedRange =
  | { start: number; end: number }
  | 'unsatisfiable'
  | null;

/**
 * Parse one Range header the way the phone's players ask:
 * `bytes=a-b`, `bytes=a-`, `bytes=-n`. Anything else (no
 * header, multi-range, garbage) is null = "serve the whole
 * head" — the RFC-permitted reading, and the head is at most
 * 1.5 MB. An in-form but impossible range is 'unsatisfiable'
 * (the controller answers 416).
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ParsedRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/** One landed head on disk. */
export interface QuizHeadEntry {
  path: string;
  size: number;
}

/**
 * The warming surface the solo quiz consumes: deal-time,
 * fire-and-forget, never throws, never awaited. Modelled as an
 * interface so the quiz service depends on the CONTRACT, and
 * any construction without the real cache (model-less boots,
 * unit tests) gets {@link NOOP_QUIZ_HEAD_WARMER}.
 */
export interface QuizHeadWarmer {
  warm(audioUrl: string | null | undefined): void;
}

/** The no-op warmer: warming simply does not happen. */
export const NOOP_QUIZ_HEAD_WARMER: QuizHeadWarmer = {
  warm(): void {
    // Deliberately empty — see QuizHeadWarmer.
  },
};

export interface QuizHeadCacheOptions {
  /** Cache directory (default: env QUIZ_HEAD_CACHE_DIR, else `<cwd>/quiz-heads-cache`). */
  cacheDir?: string;
  /** Total cache budget in bytes (default: env QUIZ_HEAD_CACHE_MAX_MB, else 500 MB). */
  maxBytes?: number;
  /** Origin fetch (default: the global fetch, captured per call so tests can spy on it). */
  fetchImpl?: typeof fetch;
}

@Injectable()
export class QuizHeadCacheService implements QuizHeadWarmer {
  private readonly cacheDir: string;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;
  /** Same-file fills share ONE origin pull (request + warmers racing). */
  private readonly inFlight = new Map<
    string,
    Promise<QuizHeadEntry | null>
  >();
  /** Files with a fill in progress — eviction never touches them. */
  private readonly filling = new Set<string>();
  private tempSeq = 0;

  constructor(
    // @Optional: DI has no options provider — it injects
    // undefined and the env/defaults apply. Tests construct
    // the service directly with explicit options (the
    // HttpAudioProbe TTL precedent).
    @Optional()
    options?: QuizHeadCacheOptions,
  ) {
    const envDir = process.env.QUIZ_HEAD_CACHE_DIR?.trim();
    this.cacheDir =
      options?.cacheDir ??
      (envDir ? envDir : path.join(process.cwd(), 'quiz-heads-cache'));
    const envMb = Number(process.env.QUIZ_HEAD_CACHE_MAX_MB);
    this.maxBytes =
      options?.maxBytes ??
      (Number.isFinite(envMb) && envMb > 0
        ? Math.floor(envMb * 1_000_000)
        : QUIZ_HEAD_CACHE_DEFAULT_MAX_MB * 1_000_000);
    this.fetchImpl =
      options?.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** The directory heads live in (diagnostics/tests). */
  get directory(): string {
    return this.cacheDir;
  }

  /**
   * Fire-and-forget warm for one resolved audio URL (the solo
   * quiz's deal points call this): underivable URLs are a
   * no-op, and every failure is swallowed — warming is a
   * performance hint, never a dependency.
   */
  warm(audioUrl: string | null | undefined): void {
    const file = headFileNameForAudioUrl(audioUrl);
    if (!file) return;
    void this.ensureHead(file).catch(() => undefined);
  }

  /**
   * The cached head for `file`, filling it from the origin
   * first when missing. Resolves null when the head cannot be
   * had (invalid name, origin 404/error/timeout) — callers
   * fall back to the origin, so null is a normal answer, and
   * this method never rejects for an origin problem.
   */
  async ensureHead(file: string): Promise<QuizHeadEntry | null> {
    if (!isValidHeadFileName(file)) return null;
    const hit = await this.cachedEntry(file);
    if (hit) return hit;
    const existing = this.inFlight.get(file);
    if (existing) return existing;
    const fillPromise: Promise<QuizHeadEntry | null> = this.fill(file).then(
      (entry) => {
        if (this.inFlight.get(file) === fillPromise) {
          this.inFlight.delete(file);
        }
        return entry;
      },
      () => {
        if (this.inFlight.get(file) === fillPromise) {
          this.inFlight.delete(file);
        }
        return null;
      },
    );
    this.inFlight.set(file, fillPromise);
    return fillPromise;
  }

  /** The on-disk head, refreshed as most-recently-used, or null. */
  private async cachedEntry(file: string): Promise<QuizHeadEntry | null> {
    const filePath = path.join(this.cacheDir, file);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size <= 0) return null;
    // LRU bookkeeping: a serve counts as use. Fire-and-forget —
    // a failed touch only makes this entry look older.
    const now = new Date();
    void fsp.utimes(filePath, now, now).catch(() => undefined);
    return { path: filePath, size: stat.size };
  }

  /**
   * One origin pull → atomic store → eviction pass. The bytes
   * land under a temp name and are RENAMED into place, so a
   * concurrent reader either sees the whole head or no file —
   * never a half-written one.
   */
  private async fill(file: string): Promise<QuizHeadEntry | null> {
    // A racing filler may have landed it while this call queued.
    const already = await this.cachedEntry(file);
    if (already) return already;
    this.filling.add(file);
    const tmpPath = path.join(
      this.cacheDir,
      `${file}.part-${process.pid}-${++this.tempSeq}`,
    );
    const finalPath = path.join(this.cacheDir, file);
    try {
      await fsp.mkdir(this.cacheDir, { recursive: true });
      const written = await this.pullFromOrigin(file, tmpPath);
      if (written <= 0) {
        await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
        return null;
      }
      await fsp.rename(tmpPath, finalPath);
      await this.evictOverCap(file);
      const stat = await fsp.stat(finalPath).catch(() => null);
      return stat ? { path: finalPath, size: stat.size } : null;
    } catch {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      return null;
    } finally {
      this.filling.delete(file);
    }
  }

  /**
   * GET the head's byte range from the hard-coded origin into
   * `tmpPath`, returning the bytes written (0 = could not be
   * had). A 200 (origin ignored the Range) is truncated at the
   * same cap — the stream is cut, not drained.
   */
  private async pullFromOrigin(
    file: string,
    tmpPath: string,
  ): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEAD_FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${QUIZ_HEAD_ORIGIN}/${file}`, {
        headers: { Range: `bytes=0-${QUIZ_HEAD_BYTES - 1}` },
        signal: controller.signal,
      });
      if (res.status !== 200 && res.status !== 206) return 0;
      if (!res.body) return 0;
      const source = Readable.fromWeb(
        res.body as Parameters<typeof Readable.fromWeb>[0],
      );
      const out = createWriteStream(tmpPath);
      let writeFailed = false;
      out.on('error', () => {
        writeFailed = true;
      });
      let written = 0;
      try {
        for await (const chunk of source) {
          const buf = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as Uint8Array);
          if (written >= QUIZ_HEAD_BYTES) break;
          const room = QUIZ_HEAD_BYTES - written;
          const piece = buf.length > room ? buf.subarray(0, room) : buf;
          written += piece.length;
          if (!out.write(piece)) await once(out, 'drain');
        }
      } finally {
        out.end();
        await once(out, 'finish').catch(() => undefined);
      }
      return writeFailed ? 0 : written;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * LRU eviction: while the cache is over its budget, delete
   * the least-recently-used heads (mtime = last serve/store).
   * Never deletes a file being written, nor `protectFile` (the
   * head whose store triggered this pass — a fresh fill is
   * never instantly evicted). Housekeeping only: any failure
   * leaves the cache over cap until the next store retries.
   */
  private async evictOverCap(protectFile: string): Promise<void> {
    try {
      const names = await fsp.readdir(this.cacheDir);
      const entries: { name: string; size: number; mtimeMs: number }[] = [];
      let total = 0;
      for (const name of names) {
        if (!isValidHeadFileName(name)) continue;
        const stat = await fsp
          .stat(path.join(this.cacheDir, name))
          .catch(() => null);
        if (!stat || !stat.isFile()) continue;
        entries.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
        total += stat.size;
      }
      if (total <= this.maxBytes) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of entries) {
        if (total <= this.maxBytes) break;
        if (entry.name === protectFile || this.filling.has(entry.name)) {
          continue;
        }
        await fsp
          .rm(path.join(this.cacheDir, entry.name), { force: true })
          .catch(() => undefined);
        total -= entry.size;
      }
    } catch {
      // Deliberately empty — see the docblock.
    }
  }
}

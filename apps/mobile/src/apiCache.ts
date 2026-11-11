/**
 * App response cache (perf problem 5) — ONE memory-only cache for
 * the app's GET reads, with per-data-class freshness windows and
 * stale-while-revalidate reads:
 *
 *   - fresh entry  → served from memory, NO network call at all
 *     (screens re-reading on focus inside the window cost nothing);
 *   - stale entry  → served immediately AND one background refetch
 *     runs; on success the entry is replaced and subscribers are
 *     notified so the screen swaps silently;
 *   - missing      → the fetch runs (deduped, see below) and the
 *     awaited result is served.
 *
 * Keys are request identities: method + path (the path carries its
 * query string) + the authenticated user scope — the session's user
 * id, or 'anon' signed out — so one account can never be served
 * another account's data. The scope is tracked in session.ts
 * (setSessionUserId): a user-id CHANGE clears the whole cache (a
 * login as someone else starts empty), and an explicit clear on
 * logout covers the same-account case.
 *
 * In-flight dedupe: concurrent reads of one key share ONE promise /
 * network call — Home and Social mounting together, or a focus
 * storm while a fetch is already running, collapse into one call.
 *
 * Mutation wiring lives in api.ts: apiJson drops the affected keys
 * the moment a mutation call SUCCEEDS (and only then — a failed
 * mutation changed nothing, so nothing is invalidated).
 *
 * Deliberately NOT here: auth flows, quiz room/game state,
 * search-as-you-type, the friends-activity SOCIAL EXEMPTION (it
 * refetches on focus; it only borrows the dedupe helper below),
 * playback candidate resolution for the playing item, downloads
 * (device-local store), and the problem-4 profile-stats store
 * (src/profileStatsCache.ts — persisted on-device by its own spec,
 * untouched here). The cache itself is memory-only: an app restart
 * starts empty — EXCEPT the first-paint snapshot (speed batch,
 * src/firstPaintCache.ts): Home + own-profile are persisted on
 * disk and hydrated back into this cache as STALE entries at
 * startup, so a cold open paints instantly and revalidates
 * through the exact path below. Persistence is that module's
 * job; this cache still owns every read.
 *
 * The store logic is pure (injectable clock, no IO) so it
 * unit-tests directly; `appCache` is the module singleton the API
 * layer uses.
 */

/** Freshness windows per data class — the spec's numbers, one place. */
export const CACHE_TTL_MS = {
  /** Home feed — 2 minutes. */
  FEED: 2 * 60_000,
  /** Library / playlists / profile data — 5 minutes. */
  USER: 5 * 60_000,
  /** Catalogue data (theme detail, season lists, anime/artist) — 15 minutes. */
  CATALOGUE: 15 * 60_000,
} as const;

export type CacheTtlClass = keyof typeof CACHE_TTL_MS;

export interface CacheReadOptions {
  /** Freshness window class for this read (default USER). */
  ttl?: CacheTtlClass;
  /** Pull-to-refresh: skip the freshness check, always refetch. */
  force?: boolean;
}

interface CacheEntry {
  value: unknown;
  fetchedAt: number;
}

export interface CacheSnapshot {
  state: 'fresh' | 'stale';
  value: unknown;
  fetchedAt: number;
}

/**
 * The `cached()` marker apiJson stamps on a response it served
 * WITHOUT network (a fresh hit, or a stale hit whose background
 * refetch is still running): a non-enumerable own property, so
 * payload spreads / JSON never see it. Screens use it to know the
 * data on screen is cache data — Home's full-screen loading gate
 * stays down for it, while a NETWORK answer (no marker) remains
 * the "genuinely first load" signal. A stale hit's background
 * refetch lands through the subscription channel instead.
 */
export const CACHE_SERVED = '__kaikansenCacheServed';

export function wasCacheServed(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)[CACHE_SERVED] === true
  );
}

function markCacheServed<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    try {
      Object.defineProperty(value, CACHE_SERVED, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // Frozen payloads simply go unmarked.
    }
  }
  return value;
}

/**
 * Build a cache key from a request identity. `scope` is the
 * authenticated user scope ('' treats it as the shared anon scope);
 * the caller (api.ts) always passes the live scope.
 */
export function cacheKey(
  method: string,
  path: string,
  scope: string,
): string {
  return `${method} ${path} @${scope || 'anon'}`;
}

export class ResponseCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<(value: unknown) => void>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The cached value for a key (any age), or undefined on a miss. */
  peek(key: string): unknown {
    return this.entries.get(key)?.value;
  }

  /** Age snapshot for a key: fresh/stale against a window, or null. */
  snapshot(key: string, ttlMs: number): CacheSnapshot | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    return {
      state:
        this.now() - entry.fetchedAt < ttlMs ? 'fresh' : 'stale',
      value: entry.value,
      fetchedAt: entry.fetchedAt,
    };
  }

  /** Store a value under a key (stamps the fetch time). */
  set(key: string, value: unknown): void {
    this.entries.set(key, { value, fetchedAt: this.now() });
  }

  /**
   * Seed an entry with an EXPLICIT fetch time, WITHOUT notifying
   * subscribers (the speed batch's disk hydration): the entry is
   * backdated past every freshness window, so the next read takes
   * the stale path — served instantly, revalidated in the
   * background. Never overwrites an entry the session already
   * holds (memory is always at least as fresh as disk).
   */
  seedStale(key: string, value: unknown, fetchedAt: number): void {
    if (this.entries.has(key)) return;
    this.entries.set(key, { value, fetchedAt });
  }

  /** Drop one key (mutation invalidation). */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Drop every entry whose FULL key contains `fragment` (a path
   * substring — api.ts's invalidation table works in path terms,
   * and the fragment match covers every user scope's copy).
   */
  invalidateMatching(fragment: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.includes(fragment)) this.entries.delete(key);
    }
  }

  /** Drop everything (logout, account change). */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  /**
   * Watch one key: the listener fires with the fresh value when a
   * background revalidation (or a set from another reader of the
   * same key) lands. Returns the unsubscribe.
   */
  subscribe(key: string, listener: (value: unknown) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  private notify(key: string, value: unknown): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const listener of [...set]) listener(value);
  }

  /**
   * In-flight dedupe, the standalone primitive: concurrent calls
   * with the same key share one promise. Used by cached reads AND
   * by the friends-activity exemption (dedupe without caching).
   */
  dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise: Promise<unknown> = run().then(
      (value) => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
        return value;
      },
      (error: unknown) => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
        throw error;
      },
    );
    this.inflight.set(key, promise);
    return promise as Promise<T>;
  }

  /**
   * The cached read. `load` performs the actual network fetch.
   *
   * - force → always load (deduped); the fresh value replaces the
   *   entry and is returned.
   * - fresh hit → the cached value, marked cache-served; load never
   *   runs, regardless of focus.
   * - stale hit → the cached value, marked cache-served, returned
   *   immediately; ONE background revalidation runs (deduped): on
   *   success the entry is replaced and subscribers notified; on
   *   failure the stale entry stays (the screen keeps its data).
   * - miss → load (deduped), store, return.
   *
   * A load failure on miss/force rejects to the caller, exactly
   * like an uncached read.
   */
  async read<T>(
    key: string,
    ttlClass: CacheTtlClass,
    load: () => Promise<T>,
    opts?: { force?: boolean },
  ): Promise<T> {
    if (!opts?.force) {
      const snap = this.snapshot(key, CACHE_TTL_MS[ttlClass]);
      if (snap) {
        if (snap.state === 'fresh') {
          return markCacheServed(snap.value) as T;
        }
        // Stale: serve now, revalidate in the background.
        void this.dedupe(key, load)
          .then((fresh) => {
            this.set(key, fresh);
            this.notify(key, fresh);
          })
          .catch(() => {
            // A failed revalidation keeps the stale entry.
          });
        return markCacheServed(snap.value) as T;
      }
    }
    const value = await this.dedupe(key, load);
    this.set(key, value);
    return value;
  }
}

/** The module singleton the API layer (api.ts) uses. */
export const appCache = new ResponseCache();

/**
 * Subscribe to fresh values for a request key — the channel a
 * screen's stale-while-revalidate swap arrives on. Thin wrapper
 * over the singleton so screens import one name.
 */
export function subscribeCache<T>(
  key: string,
  listener: (value: T) => void,
): () => void {
  return appCache.subscribe(key, (value) => listener(value as T));
}

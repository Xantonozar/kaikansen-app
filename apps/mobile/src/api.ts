import type {
  AnimeDetailResponse,
  ArtistDetailResponse,
  HomeResponse,
  RecordWatchRequest,
  SearchGroup,
  SearchResponse,
  Season,
  SeasonResponse,
  SimilarThemesResponse,
  ThemeDetail,
  ThemeSummary,
  ThemeType,
} from '@kaikansen/contracts';
import { popularThemesFixture } from './fixtures/popularThemes';
import {
  getAccessToken,
  getSessionScope,
  notifySessionExpired,
  refreshAccessToken,
} from './session';
import {
  appCache,
  cacheKey,
  CACHE_TTL_MS,
  wasCacheServed,
  type CacheReadOptions,
} from './apiCache';
import type { UserProfile } from '@kaikansen/contracts';
import {
  clearFirstPaintSnapshot,
  readFirstPaintSnapshot,
  snapshotForScope,
  withServedPayload,
  writeFirstPaintSnapshot,
  type FirstPaintSnapshot,
} from './firstPaintCache';

export { wasCacheServed, subscribeCache } from './apiCache';
export type { CacheReadOptions } from './apiCache';

/**
 * Read-path client for the new NestJS API (Slice 1).
 *
 * FIXTURE MODE: when EXPO_PUBLIC_API_URL is not set there is no API to talk
 * to (and the sandbox cannot reach Atlas), so the same three functions
 * resolve the bundled fixture instead — 20 real popular themes pulled from
 * the production catalogue. `fixtureMode` says honestly which world the app
 * is in. In fixture mode, search mirrors the API's two-stage regex search
 * locally (prefix narrowing, then per-word substring over the web's
 * fields) and home derives its season rail from the fixture data (see
 * fixtureHome).
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '');
export const fixtureMode = !apiUrl;

/** The configured API base URL (undefined in fixture mode). */
export const apiBaseUrl: string | undefined = apiUrl;

/**
 * Request deadlines (perf problem 13B — audit C3: no fetch timeout).
 *
 * Every REST attempt gets its own AbortController clock; when it
 * fires, the attempt rejects with ApiTimeoutError, which extends
 * TypeError — the exact class a dead network rejects with today —
 * so a timeout settles through the same error/retry states a
 * connection failure already uses. No new UI states anywhere.
 *
 * Two named classes and no others:
 *  - STANDARD: catalogue / feed / library / social / quiz reads and
 *    writes (default 25s).
 *  - LONG: the calls that legitimately ride a waking server or a
 *    heavy first sync — the auth session calls (authApi.ts) and the
 *    first AniList library sync (45s).
 *
 * The clock covers ONE attempt: apiFetch's 401 retry re-enters the
 * timed send and gets a fresh clock of its own (the refresh call in
 * between carries its own deadline inside authApi.ts).
 */
export const REQUEST_DEADLINE_MS = {
  /** Default ceiling for one REST attempt. */
  STANDARD: 25_000,
  /** Waking-server / heavy-first-sync calls (auth, first AniList sync). */
  LONG: 45_000,
} as const;

export type RequestDeadlineClass = keyof typeof REQUEST_DEADLINE_MS;

/**
 * A request that hit its deadline. Extends TypeError so it is
 * indistinguishable in class from fetch's own network-failure
 * rejection — existing error handling needs no new branch.
 */
export class ApiTimeoutError extends TypeError {
  constructor(deadlineMs: number) {
    super(`Request timed out after ${Math.round(deadlineMs / 1000)}s`);
    this.name = 'ApiTimeoutError';
  }
}

/**
 * fetch() under a deadline: aborts the attempt when its clock runs
 * out and converts that abort into an ApiTimeoutError. An abort
 * that is NOT ours (the caller passed their own signal and it
 * fired) rethrows verbatim — it is not a timeout.
 */
export async function fetchWithDeadline(
  url: string,
  init: (RequestInit & { deadlineMs?: number }) | undefined,
  deadlineMs: number = REQUEST_DEADLINE_MS.STANDARD,
): Promise<Response> {
  const { deadlineMs: _initDeadline, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  // A caller-supplied signal stays honoured: it is LINKED into our
  // controller (fetch only ever sees ours), so a foreign abort
  // still cancels the attempt — and the catch below can tell it
  // apart from our deadline by checking which signal fired.
  const callerSignal = fetchInit.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort);
  }
  try {
    return await fetch(url, { ...fetchInit, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted && !(callerSignal?.aborted ?? false)) {
      throw new ApiTimeoutError(deadlineMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Authenticated fetch (Slice 2): attaches the in-memory access token
 * when a session exists, and on a 401 makes ONE silent refresh attempt
 * (via the AuthProvider's registered handler, session.ts) and retries
 * once. If the refresh fails the provider is told the session expired
 * (it signs out) and the 401 response stands. Requests made signed-out
 * never trigger a refresh.
 *
 * Perf problem 13B: each attempt rides fetchWithDeadline — the
 * first send and the post-refresh retry each get a FRESH clock of
 * the call's deadline class; the clock never spans both attempts.
 */
interface ApiFetchInit {
  method?: string;
  /** JSON-serialisable body; sets Content-Type: application/json. */
  body?: unknown;
  /** Deadline class for this call (default STANDARD). */
  deadline?: RequestDeadlineClass;
}

async function apiFetch(path: string, init?: ApiFetchInit): Promise<Response> {
  const deadlineMs =
    REQUEST_DEADLINE_MS[init?.deadline ?? 'STANDARD'];
  const send = (token: string | null) =>
    fetchWithDeadline(
      `${apiUrl}${path}`,
      {
        method: init?.method ?? 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      },
      deadlineMs,
    );

  const token = getAccessToken();
  let res = await send(token);
  if (res.status === 401 && token) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      res = await send(fresh);
    } else {
      notifySessionExpired();
    }
  }
  return res;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    throw new Error(`API ${path} answered ${res.status}`);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Response cache wiring (perf problem 5)                              */
/*                                                                     */
/* Reads through apiJson/getJson route through src/apiCache.ts by      */
/* the path table below; mutations invalidate centrally, here, the     */
/* moment they SUCCEED — a failed mutation changed nothing, so it      */
/* invalidates nothing. Paths not in the table (auth is a separate      */
/* client; quiz room/game state; search-as-you-type) never touch       */
/* the cache. Playback candidate resolution stays uncached too:        */
/* fetchThemeBySlug keeps its own direct path (see below).             */
/* ------------------------------------------------------------------ */

/** The cache key for a GET of `path` under the live session scope. */
export function cacheKeyFor(path: string): string {
  return cacheKey('GET', path, getSessionScope());
}

/* ------------------------------------------------------------------ */
/* First-paint snapshot (speed batch)                                  */
/*                                                                     */
/* Home + own-profile are ALSO persisted on disk (firstPaintCache)     */
/* so a cold start can paint before the network answers. Hydration     */
/* runs lazily, on the first cached read under a scope: the disk       */
/* record is scope-stamped, and only a scope-matching copy seeds       */
/* entries — under a scope that cannot name its user yet ('anon'       */
/* while the session restores) nothing seeds, and the signed-in        */
/* scope's first read hydrates then. Seeded entries are backdated      */
/* past their TTL, so they take the cache's stale path (instant        */
/* paint + background revalidation + subscriber swap).                 */
/* ------------------------------------------------------------------ */

/** The scope already hydrated this run (undefined = not yet). */
let firstPaintHydratedScope: string | undefined;

export async function ensureFirstPaintHydrated(): Promise<void> {
  const scope = getSessionScope();
  if (scope === firstPaintHydratedScope) return;
  // Mark before the await: concurrent first reads share this pass.
  firstPaintHydratedScope = scope;
  try {
    const hydratable = snapshotForScope(
      await readFirstPaintSnapshot(),
      scope,
    );
    if (!hydratable) return;
    const staleBefore = Date.now() - CACHE_TTL_MS.CATALOGUE - 1;
    if (hydratable.home) {
      appCache.seedStale(
        cacheKey('GET', '/home', scope),
        hydratable.home.value,
        Math.min(hydratable.home.fetchedAt, staleBefore),
      );
    }
    if (hydratable.profile?.value.id) {
      const profile = hydratable.profile;
      appCache.seedStale(
        cacheKey('GET', `/users/${profile.value.username}`, scope),
        profile.value,
        Math.min(profile.fetchedAt, staleBefore),
      );
    }
  } catch {
    // A failed hydration is just a cold cache — the read proceeds.
  }
}

/**
 * Merge a freshly served payload into the disk snapshot under
 * the CURRENT session scope. Fire-and-forget, chained so two
 * near-simultaneous persists cannot interleave their
 * read-modify-write cycles.
 */
let firstPaintWriteChain: Promise<void> = Promise.resolve();

export function persistFirstPaint(patch: {
  home?: { value: HomeResponse; fetchedAt: number };
  profile?: { value: UserProfile; fetchedAt: number };
}): void {
  const scope = getSessionScope();
  firstPaintWriteChain = firstPaintWriteChain
    .then(async () => {
      const current = await readFirstPaintSnapshot();
      await writeFirstPaintSnapshot(
        withServedPayload(current, scope, patch),
      );
    })
    .catch(() => {
      // Persistence is an optimisation; a lost write only loses
      // the next cold open's instant paint.
    });
  // Keep the chain itself forever-resolved for the next caller.
  void firstPaintWriteChain;
}

/** Freshness class per cached read path — the spec's classes. */
function readCacheClass(path: string): 'FEED' | 'USER' | 'CATALOGUE' | null {
  const clean = path.split('?')[0];
  if (clean === '/home') return 'FEED';
  if (
    clean === '/library/favorites' ||
    clean === '/library/history' ||
    clean === '/library/themes' ||
    clean === '/playlists' ||
    clean.startsWith('/playlists/') ||
    clean.startsWith('/users/') ||
    clean === '/notifications' ||
    clean === '/rank/me' ||
    clean.startsWith('/rank/')
  ) {
    return 'USER';
  }
  if (
    clean.startsWith('/themes/') ||
    clean === '/season' ||
    clean.startsWith('/anime/') ||
    clean.startsWith('/artists/')
  ) {
    return 'CATALOGUE';
  }
  return null;
}

/**
 * Invalidation table: for a SUCCESSFUL mutation, the cache path
 * fragments to drop (matched against full keys, so every scope's
 * copy goes). Returns null for mutations with no cached dependents.
 * Search, quiz and auth mutations are absent by design — nothing
 * cached depends on them in a way this table must chase (quiz
 * rank-adjacent reads ride their USER window).
 */
function invalidationFragments(method: string, path: string): string[] | null {
  const clean = path.split('?')[0];
  if (method === 'POST' && clean === '/library/history') {
    // A listen: history + continue-listening (Home) + profile
    // reads + the theme's own detail read — its "Plays" count
    // just moved, and the CATALOGUE-class detail cache would
    // otherwise paint the pre-play number for up to 15 minutes
    // (counts fix RC2, 2026-11-12).
    return ['/library/history', '/home', '/users', '/themes/'];
  }
  if (clean === '/library/favorites' || clean.startsWith('/library/favorites/')) {
    return ['/library/favorites'];
  }
  if (/^\/themes\/[^/]+\/rating$/.test(clean)) {
    // A rating moves the profile stats + the user's ratings list.
    return ['/users/'];
  }
  if (/^\/users\/[^/]+\/follow$/.test(clean)) {
    return [
      '/social/friends-activity',
      '/users/',
      '/rank/leaderboard',
      '/rank/players',
    ];
  }
  if (clean === '/playlists' || clean.startsWith('/playlists/')) {
    return ['/playlists', '/users/'];
  }
  if (/^\/themes\/[^/]+\/comments$/.test(clean)) {
    return [clean];
  }
  if (clean === '/notifications/mark-read') {
    return ['/notifications'];
  }
  if (method === 'PATCH' && clean === '/auth/me') {
    return ['/users/', '/rank/'];
  }
  return null;
}

/** Drop a mutation's dependents (apiJson calls this on success only). */
export function invalidateAfterMutation(method: string, path: string): void {
  const fragments = invalidationFragments(method, path);
  if (!fragments) return;
  for (const fragment of fragments) appCache.invalidateMatching(fragment);
}

/** Empty the whole response cache (logout / account change). */
export function clearResponseCache(): void {
  appCache.clear();
  // Speed batch: the disk snapshot dies with the session too —
  // the next account must cold-open to its OWN first paint, never
  // this one's. The in-memory hydration memo resets so a later
  // scope can re-read the (now cleared) disk state honestly.
  firstPaintHydratedScope = undefined;
  void clearFirstPaintSnapshot();
}

/** Error thrown by apiJson — carries the HTTP status alongside the message. */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Authenticated JSON request with a body (Slice M2): apiFetch plus
 * response handling — resolves the parsed body on success; on failure
 * throws an ApiRequestError carrying the API's own message when it
 * sent one (the ApiErrorResponse shape), so library/playlist callers
 * can surface the web-parity reason instead of a bare status. Shared
 * by the sibling client modules (libraryApi.ts); authApi.ts keeps its
 * own plain-fetch client because its calls create the session this
 * one relies on.
 */
export interface ApiJsonInit extends ApiFetchInit {
  cache?: CacheReadOptions;
}

export async function apiJson<T>(
  path: string,
  init?: ApiJsonInit,
): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    // Fixture mode never reaches here (every caller resolves its
    // fixture shape first), so the cache only ever holds live data.
    const ttlClass = readCacheClass(path);
    if (ttlClass) {
      // Speed batch: give the disk snapshot its chance to seed
      // this scope's first-paint entries before the read decides.
      await ensureFirstPaintHydrated();
      return appCache.read<T>(cacheKeyFor(path), ttlClass, () =>
        apiJsonNetwork<T>(path, init),
        { force: init?.cache?.force },
      );
    }
    // Uncached GET: still deduped in flight (concurrent identical
    // reads share one call — e.g. the friends-activity exemption,
    // whose screens refetch on focus by design).
    return appCache.dedupe(cacheKeyFor(path), () =>
      apiJsonNetwork<T>(path, init),
    );
  }
  const result = await apiJsonNetwork<T>(path, init);
  // Success only: a rejection above skips this, so a failed
  // mutation invalidates nothing (perf problem 5 contract).
  invalidateAfterMutation(method, path);
  return result;
}

/** The raw apiJson request (no cache) — apiJson's network leg. */
async function apiJsonNetwork<T>(
  path: string,
  init?: ApiJsonInit,
): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    let message = `API ${path} answered ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (body !== null && typeof body === 'object' && 'message' in body) {
        const m = (body as { message: unknown }).message;
        if (typeof m === 'string') {
          message = m;
        } else if (
          Array.isArray(m) &&
          m.every((x) => typeof x === 'string')
        ) {
          message = m.join(' ');
        }
      }
    } catch {
      // Non-JSON error body — keep the status message.
    }
    throw new ApiRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Fixture mode                                                        */
/* ------------------------------------------------------------------ */

/** Same season rule as the API (apps/api/src/themes/season.ts). */
function currentSeason(date: Date): { season: Season; year: number } {
  const month = date.getMonth();
  const year = date.getFullYear();
  if (month === 11) return { season: 'WINTER', year: year + 1 };
  if (month <= 1) return { season: 'WINTER', year };
  if (month <= 4) return { season: 'SPRING', year };
  if (month <= 7) return { season: 'SUMMER', year };
  return { season: 'FALL', year };
}

const SEASON_ORDER: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

function toSummary(theme: ThemeDetail): ThemeSummary {
  return {
    slug: theme.slug,
    songTitle: theme.songTitle,
    animeTitle: theme.animeTitle,
    animeTitleEnglish: theme.animeTitleEnglish,
    artistName: theme.artistName,
    allArtists: theme.allArtists,
    type: theme.type,
    sequence: theme.sequence,
    animeSeason: theme.animeSeason,
    animeSeasonYear: theme.animeSeasonYear,
    animeCoverImage: theme.animeCoverImage,
    animeCoverImageSmall: theme.animeCoverImageSmall,
    avgRating: theme.avgRating,
    totalRatings: theme.totalRatings,
    totalWatches: theme.totalWatches,
    totalListens: theme.totalListens,
    duration: theme.duration,
    isPopular: theme.isPopular,
    popularRank: theme.popularRank,
    anilistId: theme.anilistId,
  };
}

function fixtureHome(): HomeResponse {
  const wanted = currentSeason(new Date());
  let season = wanted;
  let rail = popularThemesFixture.filter(
    (t) => t.animeSeason === season.season && t.animeSeasonYear === season.year,
  );
  if (rail.length === 0) {
    // The fixture is a 20-theme popular snapshot, not a full catalogue: if
    // it holds nothing for the current season, rail the newest season it
    // does hold and label it truthfully.
    const newest = [...popularThemesFixture]
      .filter((t) => t.animeSeason && t.animeSeasonYear)
      .sort(
        (a, b) =>
          (b.animeSeasonYear ?? 0) - (a.animeSeasonYear ?? 0) ||
          SEASON_ORDER.indexOf(b.animeSeason as Season) -
            SEASON_ORDER.indexOf(a.animeSeason as Season),
      )[0];
    if (newest?.animeSeason && newest.animeSeasonYear) {
      season = { season: newest.animeSeason, year: newest.animeSeasonYear };
      rail = popularThemesFixture.filter(
        (t) => t.animeSeason === season.season && t.animeSeasonYear === season.year,
      );
    }
  }
  const seasonRail = [...rail]
    .sort((a, b) => b.totalWatches - a.totalWatches)
    .slice(0, 20)
    .map(toSummary);
  const popular = popularThemesFixture
    .filter((t) => t.isPopular)
    .sort((a, b) => (a.popularRank ?? 0) - (b.popularRank ?? 0))
    .slice(0, 20)
    .map(toSummary);
  return { season, seasonRail, popular };
}

function fixtureSearch(
  query: string,
  group: SearchGroup = 'all',
  page = 1,
  limit?: number,
): SearchResponse {
  const trimmed = query.trim();
  const emptyMeta = { total: 0, hasMore: false };
  const base: SearchResponse = {
    query: trimmed,
    results: [],
    // The bundled snapshot holds no AnimeCache/ArtistCache/user
    // data, so fixture mode honestly serves empty groups — the
    // search screen renders its Themes group alone, as it does for
    // a live search with no anime/artist/user matches.
    anime: [],
    artists: [],
    users: [],
    searchType: 'regex',
    group,
    groups: {
      themes: { ...emptyMeta },
      anime: { ...emptyMeta },
      artists: { ...emptyMeta },
      users: { ...emptyMeta },
    },
    page,
    total: 0,
    hasMore: false,
    themeTypeFilter: null,
    themeSeqFilter: null,
  };
  if (trimmed.length === 0) return base;
  // The snapshot cannot answer the catalogue-group views either:
  // they stay honestly empty, like the groups above.
  if (group === 'anime' || group === 'artists' || group === 'users') {
    return base;
  }

  // Local mirror of the API's two-stage regex search (web semantics):
  // "op"/"ed12"/"op 9" tokens become type/sequence filters; stage 1
  // prefix-matches the first remaining word over the web's theme fields
  // (animeTitle, songTitle, artistName) to narrow the candidate pool;
  // stage 2 requires every remaining word to appear in one of those
  // fields. Plain substring checks stand in for the server's escaped
  // case-insensitive regexes.
  const words = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6)
    .map((w) => w.slice(0, 32));
  let themeTypeFilter: ThemeType | null = null;
  let themeSeqFilter: number | null = null;
  const cleanWords: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = words[i].match(/^(op|ed)(\d+)?$/);
    if (m) {
      themeTypeFilter = m[1].toUpperCase() as ThemeType;
      if (m[2]) {
        themeSeqFilter = parseInt(m[2], 10);
      } else if (i + 1 < words.length && /^\d+$/.test(words[i + 1])) {
        themeSeqFilter = parseInt(words[i + 1], 10);
        i++; // consume the number token
      }
    } else {
      cleanWords.push(words[i]);
    }
  }

  const fields = (t: ThemeDetail) => [t.animeTitle, t.songTitle, t.artistName];
  const contains = (t: ThemeDetail, word: string) =>
    fields(t).some((f) => f?.toLowerCase().includes(word));

  let pool = popularThemesFixture;
  if (themeTypeFilter === null && cleanWords.length > 0) {
    const prefix = cleanWords[0];
    const candidates = pool.filter((t) =>
      fields(t).some((f) => f?.toLowerCase().startsWith(prefix)),
    );
    if (candidates.length > 0) pool = candidates;
  }

  const matched = pool
    .filter(
      (t) =>
        cleanWords.every((w) => contains(t, w)) &&
        (themeTypeFilter === null || t.type === themeTypeFilter) &&
        (themeSeqFilter === null || t.sequence === themeSeqFilter),
    )
    .sort(
      (a, b) => b.totalWatches - a.totalWatches || b.avgRating - a.avgRating,
    );
  // The preview caps themes at the groups' 5; the themes full
  // view pages at the requested limit (legacy SONGS sizes when
  // none was sent: 20, or 50 under an OP/ED modifier).
  const pageSize =
    group === 'all'
      ? themeTypeFilter !== null
        ? 50
        : 5
      : (limit ?? (themeTypeFilter !== null ? 50 : 20));
  const skip = (page - 1) * pageSize;
  const results = matched.slice(skip, skip + pageSize).map(toSummary);
  const themesMeta = {
    total: matched.length,
    hasMore: skip + results.length < matched.length,
  };
  return {
    ...base,
    results,
    groups: { ...base.groups, themes: themesMeta },
    total: matched.length,
    hasMore: themesMeta.hasMore,
    themeTypeFilter,
    themeSeqFilter,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function fetchHome(
  opts?: CacheReadOptions,
): Promise<HomeResponse> {
  if (fixtureMode) return fixtureHome();
  // FEED class (2 min) via the apiJson cache wiring on '/home'.
  const home = await apiJson<HomeResponse>('/home', { cache: opts });
  // Speed batch: a NETWORK answer refreshes the disk snapshot
  // (a cache-served answer already matches what's on disk).
  if (!wasCacheServed(home)) {
    persistFirstPaint({ home: { value: home, fetchedAt: Date.now() } });
  }
  return home;
}

/**
 * One season's themes (GET /season — the web's seasonal read,
 * ported in layout-fidelity Slice 6 for the Season browse screen's
 * season chips). Fixture mode answers from the bundled snapshot
 * with the endpoint's own semantics (season filter, sequence then
 * avgRating order): the snapshot holds few seasons, so most
 * answers are honestly empty, and it never paginates (hasMore is
 * always false — the whole snapshot fits one page by construction).
 */
export async function fetchSeason(
  season: Season,
  year: number,
  page = 1,
  opts?: CacheReadOptions,
): Promise<SeasonResponse> {
  if (fixtureMode) {
    const themes = popularThemesFixture
      .filter((t) => t.animeSeason === season && t.animeSeasonYear === year)
      .sort((a, b) => a.sequence - b.sequence || b.avgRating - a.avgRating)
      .map(toSummary);
    return { season, year, themes, page: 1, hasMore: false, total: themes.length };
  }
  // CATALOGUE class (15 min) via the apiJson cache wiring on '/season'.
  return apiJson<SeasonResponse>(
    `/season?season=${season}&year=${year}&page=${page}`,
    { cache: opts },
  );
}

/** Resolves null when the theme does not exist (API 404 / not in fixture). */
export async function fetchThemeBySlug(
  slug: string,
): Promise<ThemeDetail | null> {
  if (fixtureMode) {
    return popularThemesFixture.find((t) => t.slug === slug) ?? null;
  }
  // Playback candidate resolution (perf problem 5: deliberately
  // uncached) — STANDARD deadline like every catalogue read.
  const res = await apiFetch(`/themes/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API /themes/${slug} answered ${res.status}`);
  return (await res.json()) as ThemeDetail;
}

/**
 * GET /search — with no options, the 'all' preview (top 5 per
 * group + per-group totals). A group's full view passes
 * { group, page, limit } — the search screen lazy-loads it at
 * limit 15 with infinite scroll (Option B spec, 2026-11-10).
 */
export async function searchThemes(
  query: string,
  opts?: { page?: number; group?: SearchGroup; limit?: number },
): Promise<SearchResponse> {
  if (fixtureMode) {
    return fixtureSearch(query, opts?.group, opts?.page, opts?.limit);
  }
  const params = new URLSearchParams({ q: query.trim() });
  if (opts?.group) params.set('group', opts.group);
  if (opts?.page) params.set('page', String(opts.page));
  if (opts?.limit) params.set('limit', String(opts.limit));
  return getJson<SearchResponse>(`/search?${params.toString()}`);
}

/**
 * Similar themes for the detail screen's bottom rail (Slice S8):
 * GET /themes/:slug/similar — the web's similar-themes read (themes
 * sharing the anime, artist, mood or first-entry tags; most-rated
 * first, cap 20). FIXTURE MODE resolves [] — the bundled snapshot
 * cannot answer similarity honestly, so the rail hides, exactly as
 * it does for an empty or failed live read (the caller swallows
 * errors into the same empty state).
 */
export async function fetchSimilarThemes(
  slug: string,
): Promise<ThemeSummary[]> {
  if (fixtureMode) return [];
  // CATALOGUE class via the apiJson cache wiring on '/themes/…'.
  const res = await apiJson<SimilarThemesResponse>(
    `/themes/${encodeURIComponent(slug)}/similar`,
  );
  return res.themes;
}

/**
 * Anime detail (GET /anime/:id): metadata header + all of the anime's
 * themes. Resolves null on 404 — and in fixture mode, where the
 * bundled snapshot cannot answer for an arbitrary anime honestly
 * (the screen renders its not-found state, like a missing theme).
 */
export async function fetchAnimeDetail(
  id: number,
): Promise<AnimeDetailResponse | null> {
  if (fixtureMode) return null;
  try {
    // CATALOGUE class via the apiJson cache wiring on '/anime/…'.
    return await apiJson<AnimeDetailResponse>(`/anime/${id}`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
}

/** Artist detail (GET /artists/:slug). Null on 404 / fixture mode. */
export async function fetchArtistDetail(
  slug: string,
): Promise<ArtistDetailResponse | null> {
  if (fixtureMode) return null;
  try {
    return await apiJson<ArtistDetailResponse>(
      `/artists/${encodeURIComponent(slug)}`,
    );
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Record a watch/listen (Slice M1): POST /library/history, which writes
 * the caller's history row AND moves the theme/user counters with the
 * web's hook parity. Deliberately narrow about when it fires — the
 * player calls it once playback genuinely starts, and only for a real
 * signed-in session against the real API: fixture mode resolves
 * silently (fixture themes are not real catalogue rows) and a
 * signed-out caller has nobody to record against (the endpoint is
 * Bearer-guarded anyway). Failures reject — the player treats history
 * as fire-and-forget and swallows them.
 */
export async function recordWatch(body: RecordWatchRequest): Promise<void> {
  if (fixtureMode) return;
  if (!getAccessToken()) return;
  const res = await apiFetch('/library/history', { method: 'POST', body });
  if (!res.ok) {
    throw new Error(`API /library/history answered ${res.status}`);
  }
  // Perf problem 5: a recorded listen invalidates its dependents
  // (history, Home's continue-listening, profile reads) — on
  // success only; the throw above skips this on failure.
  invalidateAfterMutation('POST', '/library/history');
}

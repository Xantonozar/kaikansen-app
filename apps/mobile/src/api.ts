import type {
  HomeResponse,
  SearchResponse,
  Season,
  ThemeDetail,
  ThemeSummary,
  ThemeType,
} from '@kaikansen/contracts';
import { popularThemesFixture } from './fixtures/popularThemes';
import {
  getAccessToken,
  notifySessionExpired,
  refreshAccessToken,
} from './session';

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
 * Authenticated fetch (Slice 2): attaches the in-memory access token
 * when a session exists, and on a 401 makes ONE silent refresh attempt
 * (via the AuthProvider's registered handler, session.ts) and retries
 * once. If the refresh fails the provider is told the session expired
 * (it signs out) and the 401 response stands. Requests made signed-out
 * never trigger a refresh.
 */
async function apiFetch(path: string): Promise<Response> {
  const send = (token: string | null) =>
    fetch(`${apiUrl}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

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
    isPopular: theme.isPopular,
    popularRank: theme.popularRank,
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

function fixtureSearch(query: string): SearchResponse {
  const trimmed = query.trim();
  const base: SearchResponse = {
    query: trimmed,
    results: [],
    searchType: 'regex',
    page: 1,
    total: 0,
    hasMore: false,
    themeTypeFilter: null,
    themeSeqFilter: null,
  };
  if (trimmed.length === 0) return base;

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
  const limit = themeTypeFilter !== null ? 50 : 20;
  const results = matched.slice(0, limit).map(toSummary);
  return {
    ...base,
    results,
    total: matched.length,
    hasMore: results.length < matched.length,
    themeTypeFilter,
    themeSeqFilter,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function fetchHome(): Promise<HomeResponse> {
  if (fixtureMode) return fixtureHome();
  return getJson<HomeResponse>('/home');
}

/** Resolves null when the theme does not exist (API 404 / not in fixture). */
export async function fetchThemeBySlug(
  slug: string,
): Promise<ThemeDetail | null> {
  if (fixtureMode) {
    return popularThemesFixture.find((t) => t.slug === slug) ?? null;
  }
  const res = await apiFetch(`/themes/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API /themes/${slug} answered ${res.status}`);
  return (await res.json()) as ThemeDetail;
}

export async function searchThemes(query: string): Promise<SearchResponse> {
  if (fixtureMode) return fixtureSearch(query);
  return getJson<SearchResponse>(
    `/search?q=${encodeURIComponent(query.trim())}`,
  );
}

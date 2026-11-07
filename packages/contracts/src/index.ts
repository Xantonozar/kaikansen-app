/**
 * Shared API contract types for the Kaikansen monorepo.
 * Slice 0 keeps this genuinely minimal — it grows as endpoints land.
 */

/** Response body of GET /health on the API. */
export interface HealthResponse {
  status: 'ok';
  service: string;
}

/** NestJS-style error body shape returned by the API on failures. */
export interface ApiErrorResponse {
  statusCode: number;
  message: string | string[];
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Themes (Slice 1 — read path)                                        */
/*                                                                     */
/* Mirrors the web app's ThemeCache documents (shared `kaikansen` DB), */
/* projected into the shapes the mobile read path consumes.            */
/* ------------------------------------------------------------------ */

/** Anime season, as stored on ThemeCache docs (`animeSeason`). */
export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

/** Theme kind: opening or ending (`type` on ThemeCache docs). */
export type ThemeType = 'OP' | 'ED';

/** One downloadable/streamable source of a theme entry. */
export interface VideoSource {
  resolution: number;
  url: string;
  source: string | null;
  mime: string;
}

/** One version of a theme (a theme can have several BD/WEB versions). */
export interface ThemeEntry {
  atEntryId: number;
  version: string;
  episodes: string | null;
  spoiler: boolean;
  nsfw: boolean;
  tags: string[];
  videoSources: VideoSource[];
  videoUrl: string | null;
  audioUrl: string | null;
  duration: number | null;
}

/** Card/row projection of a theme — home rails, popular list, search. */
export interface ThemeSummary {
  slug: string;
  songTitle: string;
  animeTitle: string;
  animeTitleEnglish: string | null;
  artistName: string | null;
  allArtists: string[];
  type: ThemeType;
  sequence: number;
  animeSeason: Season | null;
  animeSeasonYear: number | null;
  animeCoverImage: string | null;
  animeCoverImageSmall: string | null;
  avgRating: number;
  totalRatings: number;
  totalWatches: number;
  totalListens: number;
  isPopular: boolean;
  popularRank: number | null;
}

/**
 * Full theme for the detail screen: the stored document minus `embedding`
 * and `__v`. Dates are ISO strings on the wire.
 */
export interface ThemeDetail extends ThemeSummary {
  id: string;
  animethemesId: number;
  anilistId: number | null;
  kitsuId: string | null;
  animeTitleAlternative: string[];
  animeGrillImage: string | null;
  animeStudios: string[];
  animeSeries: string[];
  artistSlugs: string[];
  artistRoles: string[];
  entries: ThemeEntry[];
  videoUrl: string;
  audioUrl: string | null;
  mood: string[];
  duration: number | null;
  syncedAt: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Response body of GET /home. */
export interface HomeResponse {
  season: { season: Season; year: number };
  seasonRail: ThemeSummary[];
  popular: ThemeSummary[];
}

/**
 * Response body of GET /search — the theme ("song") slice of the web
 * app's search envelope (ZadidSalman/Kaisen `app/api/search/route.ts`):
 * the web returns grouped artists/anime/users alongside songs; this
 * backend serves themes only, so `results` carries the songs group and
 * the remaining fields mirror the web's `meta` object.
 */
export interface SearchResponse {
  query: string;
  /** This page of theme results (web order: totalWatches desc, avgRating desc). */
  results: ThemeSummary[];
  /** The web search is regex-only end to end (AUDIT.md §6) — always 'regex'. */
  searchType: 'regex';
  /** 1-based page served. */
  page: number;
  /** Total matches across all pages. */
  total: number;
  /** True when another page follows this one. */
  hasMore: boolean;
  /** OP/ED filter parsed out of the query tokens ("op", "ed12", "op 9"), when present. */
  themeTypeFilter: ThemeType | null;
  /** Sequence filter parsed out of the query tokens, when present. */
  themeSeqFilter: number | null;
}

/* ------------------------------------------------------------------ */
/* Auth (Slice 2)                                                      */
/*                                                                     */
/* Mirrors the web app's auth payloads (ZadidSalman/Kaisen             */
/* app/api/auth/*) with the one native fix: the refresh token travels  */
/* in the JSON body both ways — the web reads it only from an httpOnly */
/* cookie, which a native client cannot ride (AUDIT.md §3).           */
/* ------------------------------------------------------------------ */

/**
 * Public profile of a user, as returned by the auth endpoints and
 * GET /auth/me. Mirrors the web auth response's `user` object (plus
 * `isPublic`, which the web profile endpoints also expose).
 * NEVER carries `passwordHash`.
 */
export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  bio: string;
  totalRatings: number;
  totalFollowers: number;
  totalFollowing: number;
  isPublic: boolean;
}

/** A fresh access + refresh token pair (JSON Web Tokens). */
export interface AuthTokens {
  /** 15-minute access token, signed with the API's JWT_SECRET. */
  accessToken: string;
  /** 7-day refresh token, signed with the API's JWT_REFRESH_SECRET. */
  refreshToken: string;
}

/** Response body of POST /auth/register and POST /auth/login. */
export interface AuthResponse extends AuthTokens {
  user: UserProfile;
}

/** Request body of POST /auth/register. */
export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  /** Optional — the API defaults it to the username (the web form collects it explicitly). */
  displayName?: string;
}

/** Request body of POST /auth/login. */
export interface LoginRequest {
  email: string;
  password: string;
}

/** Request body of POST /auth/refresh — the refresh token, in the body. */
export interface RefreshRequest {
  refreshToken: string;
}

/** Response body of POST /auth/refresh: a ROTATED pair (both tokens are new). */
export type RefreshResponse = AuthTokens;

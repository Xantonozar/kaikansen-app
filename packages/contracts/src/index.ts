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
  /**
   * Representative duration in seconds — the themecache document's
   * own `duration` field, the very value ThemeDetail serves (the
   * web's stored per-theme duration; schema default 90). Null only
   * when a stored document carries none.
   */
  duration: number | null;
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
 * Response body of GET /season — one season's themes, the port of
 * the web's GET /api/themes/seasonal (the read behind the web's
 * /season/[season]/[year] page and the app's Season browse screen).
 * The web's own semantics: filter on animeSeason/animeSeasonYear,
 * optional OP/ED type filter, sort sequence asc then avgRating
 * desc, 20 per page. `hasMore` mirrors the web's meta (a full page
 * was served).
 */
export interface SeasonResponse {
  season: Season;
  year: number;
  themes: ThemeSummary[];
  page: number;
  hasMore: boolean;
}

/**
 * One anime match in GET /search's anime group — the web's ALL-view
 * anime filter (titleRomaji / titleEnglish / synonyms) projected for
 * a search row: identity + display title, cover, year, and how many
 * themes the catalogue holds for it (counted from ThemeCache, the
 * number the row shows and the anime page will list).
 */
export interface SearchAnimeResult {
  anilistId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  coverImageLarge: string | null;
  seasonYear: number | null;
  themeCount: number;
}

/**
 * One artist match in GET /search's artist group — the web's
 * ALL-view artist filter (name / aliases). `totalThemes` never
 * reports below the number of themes actually carrying the slug
 * (the cache counter drifts; same rule as GET /artists/:slug).
 */
export interface SearchArtistResult {
  slug: string;
  name: string;
  imageUrl: string | null;
  totalThemes: number;
}

/**
 * Response body of GET /search — the web app's search envelope
 * (ZadidSalman/Kaisen `app/api/search/route.ts`) minus its users
 * group (people search lives at /social/users/search here): the
 * web returns grouped artists/anime alongside songs; `results`
 * carries the songs group with its SONGS-view pagination, `anime`
 * and `artists` carry the ALL-view groups (web cap: 5 each), and the
 * remaining fields mirror the web's `meta` object. The groups are
 * served on page 1 only and stay empty when an OP/ED modifier was
 * parsed out of the query — the web skips them then too.
 */
export interface SearchResponse {
  query: string;
  /** This page of theme results (web order: totalWatches desc, avgRating desc). */
  results: ThemeSummary[];
  /** Anime group (page 1 only; empty when an OP/ED modifier is used). */
  anime: SearchAnimeResult[];
  /** Artist group (page 1 only; empty when an OP/ED modifier is used). */
  artists: SearchArtistResult[];
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
  /**
   * The user's AniList linkage, in the web /api/users/me shape:
   * `{ userId, username }` when linked, `null` when not. Never carries
   * the stored AniList access token. Lets the app persist linked state
   * across restarts (it previously had to re-derive it per session).
   */
  anilist: { userId: number; username: string } | null;
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

/**
 * Request body of PATCH /auth/me — the web's profile edit (its
 * PATCH /api/users/me zod schema, ported): a PARTIAL update in which
 * omitted fields keep their stored values and unknown fields are
 * ignored, exactly as the web's parser leaves them. The response is
 * the full updated UserProfile, same shape as GET /auth/me.
 */
export interface UpdateProfileRequest {
  /** 1–50 characters (the web rejects an empty name). */
  displayName?: string;
  /** Up to 200 characters; an empty bio is allowed. */
  bio?: string;
  /** A valid URL, or null to clear the avatar; omitted = unchanged. */
  avatarUrl?: string | null;
  /**
   * Public-profile toggle (the app's Edit Profile design, §6.28).
   * The field already exists on the user record (default true) and
   * already has a real effect on BOTH stacks: people search only
   * returns public profiles. The web's own edit schema does not
   * accept it (the web has no toggle UI) — this API accepts it
   * additively; omitted = unchanged.
   */
  isPublic?: boolean;
}

/* ------------------------------------------------------------------ */
/* AniList OAuth (login + linking)                                     */
/*                                                                     */
/* Native port of the web's app/api/auth/anilist/* flow: the web rides */
/* a browser redirect + popup postMessage; the API instead hands the  */
/* client an authorize URL to open, then accepts the returned code    */
/* in a POST body and answers with the standard auth payload.         */
/* ------------------------------------------------------------------ */

/** Response body of GET /auth/anilist/url — open this in a browser / web view. */
export interface AnilistUrlResponse {
  url: string;
}

/**
 * GET /auth/anilist/url accepts an optional ?state=login|link, forwarded
 * verbatim into the authorize URL; AniList echoes it back to the
 * callback, where it switches the GET callback's behaviour (see the
 * GET callback note below).
 */

/** Request body of POST /auth/anilist/callback — the OAuth authorization code. */
export interface AnilistCallbackRequest {
  code: string;
}

/** Response body of POST /auth/anilist/callback — identical to password login. */
export type AnilistCallbackResponse = AuthResponse;

/**
 * GET /auth/anilist/callback?code=… — the server-side OAuth landing
 * (AniList client 56177's registered redirect points at the API).
 * Not a JSON endpoint: it answers 302 to ANILIST_POST_LOGIN_REDIRECT
 * with this fragment on success —
 *   #accessToken=…&refreshToken=…&userId=…
 * — or #error=auth_failed | exchange_failed | internal_error on
 * failure. It answers 503 JSON (no redirect) when the API is booted
 * without a database, the AniList env trio, or the redirect target.
 *
 * With state=link echoed back, the GET callback exchanges NOTHING:
 * it 302s with #code=…&state=link instead, so the already-signed-in
 * app can POST the code to /auth/anilist/link with its Bearer token —
 * linking stays bound to the caller's session, which a redirect
 * cannot carry.
 */

/** Request body of POST /auth/anilist/link (Bearer access token required). */
export interface AnilistLinkRequest {
  code: string;
}

/** Response body of POST /auth/anilist/link. */
export interface AnilistLinkResponse {
  linked: true;
  anilist: {
    /** The linked AniList account's id. */
    userId: number;
    /** The linked AniList account's username. */
    username: string;
  };
}

/* ------------------------------------------------------------------ */
/* User library (Slice S1 — saves, watch history, ratings)             */
/*                                                                     */
/* Native port of the web's /api/themes/favorites, /api/history and    */
/* /api/themes/[slug]/rate routes over the shared `favorites`,         */
/* `watchhistories` and `ratings` collections. Storage and counter     */
/* side effects mirror the web's models + hooks exactly (see           */
/* apps/api/src/library for the per-write ports). Themes are addressed */
/* by slug, as everywhere else in this API.                            */
/* ------------------------------------------------------------------ */

/**
 * Playback mode of a rating or a watch/listen event — the web's
 * `mode` enum on the Rating and WatchHistory models.
 */
export type PlaybackMode = 'watch' | 'listen';

/** Request body of POST /library/favorites — save a theme by slug. */
export interface FavoriteRequest {
  slug: string;
}

/**
 * The caller's favourite state for one theme — the response of
 * POST /library/favorites, DELETE /library/favorites/:slug and
 * GET /library/favorites/:slug. Add and remove are idempotent: the
 * state after the call is the same whether or not it changed anything.
 */
export interface FavoriteState {
  slug: string;
  isFavorite: boolean;
}

/**
 * Response body of GET /library/favorites — the caller's saved themes.
 * Order mirrors the web's favourites route: the saved ids are collected
 * newest-save-first, but the themes themselves are listed in the web
 * query's own order (animeSeasonYear desc, animeTitle asc) — a web
 * quirk, mirrored deliberately. `type` filters OP/ED when provided.
 */
export interface FavoritesResponse {
  themes: ThemeSummary[];
  /** Total saved themes matching the filter, across all pages. */
  total: number;
  /** 1-based page served (the web defaults: page 1, limit 50). */
  page: number;
  limit: number;
  /** True when another page follows this one. */
  hasMore: boolean;
}

/**
 * Request body of POST /library/history — record that the caller
 * watched/listened to a theme (the web's POST /api/history body, with
 * the slug naming this API uses).
 */
export interface RecordWatchRequest {
  slug: string;
  /** The theme entry (version) played, when the player knows it. */
  atEntryId?: number | null;
  mode: PlaybackMode;
}

/** Response body of POST /library/history. */
export interface RecordWatchResponse {
  recorded: true;
}

/**
 * Response body of GET /library/count — how many catalogue themes
 * with an audio source the caller's library spans: the themes they
 * have watched/listened to locally (watch history) UNION the themes
 * whose anime appears in their stored AniList completed ids. The
 * web's GET /api/user/library/count computation, verbatim; themes
 * with no audio source (audioUrl null) are never counted.
 */
export interface LibraryCountResponse {
  count: number;
}

/** One row of the caller's watch history (GET /library/history). */
export interface WatchHistoryEntry {
  id: string;
  themeSlug: string;
  atEntryId: number | null;
  mode: PlaybackMode;
  /** ISO timestamp of the watch/listen. */
  viewedAt: string;
  /** The theme joined in (null only if the theme left the catalogue). */
  theme: ThemeSummary | null;
}

/**
 * Response body of GET /library/history — most recent first. The web's
 * history read caps at the 50 most recent events; mirrored as-is
 * (no pagination parameters).
 */
export interface WatchHistoryResponse {
  entries: WatchHistoryEntry[];
}

/** Request body of PUT /themes/:slug/rating — set the caller's rating. */
export interface SetRatingRequest {
  /** 1–10, the web's scale (fractional values pass, as on the web). */
  score: number;
  /**
   * The mode the rating belongs to. Optional here: the web requires it
   * (its schema rejects a missing mode with a 500); this API defaults a
   * create to 'watch' and keeps the existing mode on an update instead.
   */
  mode?: PlaybackMode;
}

/**
 * The caller's rating state for one theme plus the theme's aggregate
 * AFTER the call — the response of GET / PUT / DELETE
 * /themes/:slug/rating. The aggregate fields are exactly what the web's
 * Rating post-save hook leaves on the theme document.
 */
export interface ThemeRatingState {
  slug: string;
  /** The caller's own score, or null when they have not rated it. */
  myScore: number | null;
  /** The mode of the caller's rating, or null when unrated. */
  myMode: PlaybackMode | null;
  /** Theme aggregate (2-dp average, as the web's hook stores it). */
  avgRating: number;
  /** Theme aggregate (number of ratings). */
  totalRatings: number;
}

/* ------------------------------------------------------------------ */
/* Playlists (Slice S2 — CRUD + items + public view)                   */
/*                                                                     */
/* Native port of the web's /api/playlists and /api/playlists/[id]     */
/* over the shared `playlists` collection. The web stores theme        */
/* ObjectIds in an ordered array on the playlist document; items are   */
/* addressed by slug here, as everywhere else in this API, and served  */
/* back as ThemeSummary projections in stored order.                   */
/* ------------------------------------------------------------------ */

/** Request body of POST /playlists — create a playlist. */
export interface CreatePlaylistRequest {
  /** Required; the web trims it and caps it at 100 characters. */
  name: string;
  /** Optional; the web defaults it to '' and caps it at 300 characters. */
  description?: string;
  /** Optional; the web defaults it to true. */
  isPublic?: boolean;
}

/**
 * Request body of PATCH /playlists/:id — partial metadata edit
 * (owner only). Fields left undefined keep their stored values,
 * mirroring the web's metadata branch.
 */
export interface UpdatePlaylistRequest {
  name?: string;
  description?: string;
  isPublic?: boolean;
}

/**
 * Card projection of one of the caller's playlists
 * (GET /playlists list rows). The web serves the raw documents; this
 * API projects them the way it projects themes.
 */
export interface PlaylistSummary {
  id: string;
  name: string;
  description: string;
  isPublic: boolean;
  /**
   * Stored item count (the length of the playlist's theme array —
   * the only "counter" the web maintains for playlists; there are no
   * hooks or per-user totals).
   */
  themeCount: number;
  /**
   * Derived cover: the first resolvable item's cover image, or null
   * for an empty playlist (the web derives covers client-side from
   * the first theme the same way).
   */
  coverImage: string | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Response body of GET /playlists — the caller's playlists, in the
 * web's order (most recently updated first).
 */
export interface PlaylistsResponse {
  playlists: PlaylistSummary[];
}

/**
 * One playlist with its items resolved (create / get / edit /
 * add-item / remove-item responses). `items` are ThemeSummary
 * projections in STORED order; a stored id whose theme has left the
 * catalogue is dropped from `items` but still counted in
 * `themeCount`, exactly like the web's populate behaves.
 */
export interface PlaylistDetail extends PlaylistSummary {
  /** The owner's user id (the web serves the raw document's userId). */
  userId: string;
  /**
   * The owner's public identity for the design's "by <owner>" line —
   * the same two public fields the profile endpoint projects
   * (GET /users/:username), resolved from the user document. Null
   * when the owner no longer resolves (e.g. a deleted account);
   * never any private field.
   */
  ownerDisplayName: string | null;
  ownerUsername: string | null;
  items: ThemeSummary[];
}

/** Request body of POST /playlists/:id/items — add a theme by slug. */
export interface AddPlaylistItemRequest {
  slug: string;
}

/** Response body of DELETE /playlists/:id. */
export interface PlaylistDeletedResponse {
  id: string;
  deleted: true;
}

/* ------------------------------------------------------------------ */
/* Comments (Slice S3 — theme comments)                                */
/*                                                                     */
/* Native port of the web's /api/themes/[slug]/comments over the       */
/* shared `comments` collection. The web's surface is exactly two      */
/* operations — list and post. There are NO replies (the model has     */
/* no parent field), NO likes, NO edit and NO delete anywhere on the   */
/* web, and no counters: nothing maintains a comment total on the      */
/* theme or the user. This API mirrors that surface exactly.           */
/* ------------------------------------------------------------------ */

/**
 * The comment author's public projection — the fields the web's
 * populate selects off the user document (username, displayName,
 * avatarUrl, plus the id).
 */
export interface CommentAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * One comment on a theme. The web serves the raw document with
 * userId replaced by the populated author; this API projects it.
 * `author` is null when the author's account no longer exists —
 * the web's populate yields exactly that.
 */
export interface ThemeComment {
  id: string;
  themeSlug: string;
  content: string;
  author: CommentAuthor | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Response body of GET /themes/:slug/comments — the web's order
 * (newest first) and the web's hard cap: the 100 most recent
 * comments. The web offers no pagination beyond that cap; mirrored
 * as-is.
 */
export interface ThemeCommentsResponse {
  comments: ThemeComment[];
}

/** Request body of POST /themes/:slug/comments. */
export interface CreateCommentRequest {
  /**
   * Required, non-blank; the web caps it at 1000 characters
   * (measured on the untrimmed string) and stores it trimmed.
   */
  content: string;
}

/* ------------------------------------------------------------------ */
/* Quiz (Slice S4)                                                     */
/*                                                                     */
/* Solo quiz over REST + multiplayer rooms over this API's OWN         */
/* Socket.IO gateway (Gate 2: the website keeps Pusher; web and        */
/* mobile rooms never mix). Game rules — question counts, option       */
/* derivation, timers, scoring — are the website's, ported from        */
/* ZadidSalman/Kaisen `app/api/quiz/*` + `lib/quiz-room-utils.ts` +    */
/* `lib/rank-utils.ts`.                                                */
/* ------------------------------------------------------------------ */

/**
 * What the player must guess. Solo web name: the `type` parameter of
 * GET /api/quiz/question; room name: `guessType`. 'title' (solo) and
 * 'song' (rooms) are the same question — guess the song title.
 */
export type QuizGuessType = 'anime' | 'title' | 'artist';

/** Room guess type, in the web QuizRoom settings vocabulary. */
export type RoomGuessType = 'anime' | 'song' | 'artist';

/** Solo question pool: the web's `source` parameter. */
export type QuizSource = 'random' | 'library';

/** Solo game length — the web client plays exactly 10 questions. */
export const SOLO_QUESTION_COUNT = 10;

/** Solo per-question timer (seconds) — the web client's countdown. */
export const SOLO_TIME_LIMIT_SECONDS = 20;

/** POST /quiz/solo/games body. */
export interface CreateSoloGameRequest {
  quizType: QuizGuessType;
  /** Defaults to 'random' (the web's default). */
  source?: QuizSource;
}

/**
 * The playable projection of a solo question's theme: everything the
 * client needs to play the clip and reveal the answer afterwards —
 * and NOT the fields the answer is derived from (the web's question
 * response ships the whole theme + the correct value; this API
 * deliberately withholds them until the answer is submitted).
 */
export interface SoloQuestionTheme {
  slug: string;
  videoUrl: string;
  audioUrl: string | null;
  coverImage: string | null;
  /** 'OP' | 'ED'. */
  type: string;
  sequence: number;
}

/** One solo question as served (never carries the correct answer). */
export interface SoloQuestion {
  /** 1-based position inside the game. */
  index: number;
  theme: SoloQuestionTheme;
  /** Shuffled answer options (the web derives 4: 1 correct + 3 distractors). */
  options: string[];
}

/** Response of POST /quiz/solo/games and the state half of GET. */
export interface SoloGameState {
  gameId: string;
  quizType: QuizGuessType;
  source: QuizSource;
  totalQuestions: number;
  timeLimitSeconds: number;
  answeredCount: number;
  correctCount: number;
  /** Current streak (consecutive correct answers). */
  streak: number;
  totalScore: number;
  gameOver: boolean;
  /** The live question; null once the game is over. */
  question: SoloQuestion | null;
}

/** POST /quiz/solo/games/:gameId/answers body. */
export interface SoloAnswerRequest {
  /** The chosen option, verbatim. null = skip / let the timer expire. */
  answer: string | null;
}

/** Full theme reveal shown after answering (the web's post-answer reveal). */
export interface SoloAnswerReveal {
  slug: string;
  animeTitle: string;
  animeTitleEnglish: string | null;
  songTitle: string;
  artistName: string | null;
  coverImage: string | null;
}

/** Response of POST /quiz/solo/games/:gameId/answers. */
export interface SoloAnswerResponse {
  correct: boolean;
  /** The correct option (revealed only now, like the web's reveal). */
  correctValue: string;
  /** Points this answer earned — the web formula, computed server-side. */
  scoreGained: number;
  /** Server-measured seconds remaining when the answer landed. */
  secondsRemaining: number;
  streak: number;
  totalScore: number;
  correctCount: number;
  answeredCount: number;
  gameOver: boolean;
  reveal: SoloAnswerReveal;
  /** The next question, or null when the game just ended. */
  nextQuestion: SoloQuestion | null;
}

/** One row of GET /quiz/leaderboard (the web's top-10 attempts). */
export interface QuizLeaderboardEntry {
  id: string;
  themeSlug: string;
  quizType: QuizGuessType;
  correct: boolean;
  timeTaken: number;
  score: number;
  streak: number;
  /** ISO timestamp. */
  createdAt: string;
  /** The attempt's author; null for the web's anonymous attempts. */
  author: CommentAuthor | null;
}

/** Response body of GET /quiz/leaderboard. */
export interface QuizLeaderboardResponse {
  entries: QuizLeaderboardEntry[];
}

/* ------------------------- Multiplayer rooms ---------------------- */

export type QuizRoomType = 'party' | 'duel';
export type QuizPoolMode = 'random' | 'watched' | 'common';
export type QuizRoomStatus = 'waiting' | 'in_progress' | 'ended';
export type QuizMatchmaking = 'invite' | 'public';

/** Room settings — the web QuizRoom `settings` sub-document. */
export interface QuizRoomSettings {
  poolMode: QuizPoolMode;
  guessType: RoomGuessType;
  roundCount: number;
  maxPlayers: number;
  /** Web default 30. */
  timeLimitSeconds: number;
}

/** One player in a room — the web QuizRoom `players[]` shape. */
export interface QuizRoomPlayer {
  userId: string;
  username: string;
  avatar: string | null;
  totalScore: number;
  ready: boolean;
  /** ISO timestamps. */
  joinedAt: string;
  lastSeenAt: string;
}

/** One recorded answer inside a round — the web `rounds[].answers[]` shape. */
export interface QuizRoundAnswer {
  userId: string;
  submittedAnswer: string;
  correct: boolean;
  answeredAt: string;
  secondsRemaining: number;
  baseScore: number;
  bonusScore: number;
  totalScoreGained: number;
  autoLocked: boolean;
}

/**
 * A round as clients may see it. While the round is live, the fields
 * that would leak the answer (themeId, correctAnswer,
 * alternateAnswers) are withheld; they appear once the round ends —
 * the web broadcasts the correct answer in its round-ended event.
 */
export interface QuizRoundState {
  roundNumber: number;
  options: string[];
  startedAt: string;
  endedAt: string | null;
  answers: QuizRoundAnswer[];
  firstCorrectUserId: string | null;
  themeId?: string;
  correctAnswer?: string;
  /** Reveal metadata (present once the round has ended). */
  theme?: QuizRoundThemeMeta;
}

/** The reveal metadata the web stores on each round. */
export interface QuizRoundThemeMeta {
  animeTitle: string | null;
  animeTitleEnglish: string | null;
  coverImage: string | null;
  malId: number | null;
  themeType: string | null;
  themeSequence: number | null;
  songTitle: string | null;
  artistName: string | null;
}

/** Full room state as served to room members (join/subscribe acks). */
export interface QuizRoomState {
  roomId: string;
  roomCode: string;
  roomType: QuizRoomType;
  /** Host user id; null for hostless public duels (the web's shape). */
  hostId: string | null;
  settings: QuizRoomSettings;
  status: QuizRoomStatus;
  matchmaking: QuizMatchmaking;
  currentRound: number;
  players: QuizRoomPlayer[];
  rounds: QuizRoundState[];
}

/**
 * One row of the public-rooms list (`room:list-public` ack) — the
 * multiplayer lobby's discovery list (Slice 5). This API's own
 * addition: the web has no room list (its public flow is join-or-
 * create matchmaking only), but the app's lobby design draws open
 * public rooms, so the data is served from the same room documents.
 * Full rooms are included with `isFull` set — the design renders
 * them with a disabled "Full" state rather than hiding them.
 */
export interface PublicRoomListItem {
  roomId: string;
  roomCode: string;
  roomType: QuizRoomType;
  guessType: RoomGuessType;
  roundCount: number;
  playerCount: number;
  maxPlayers: number;
  isFull: boolean;
  /** Host display data, from the host's own player row. */
  hostUsername: string;
  hostAvatar: string | null;
}

/** Ack envelope for every room socket event (mirrors the web REST bodies). */
export interface QuizRoomAck {
  success: boolean;
  error?: string;
  heartbeatAccepted?: boolean;
  roomId?: string;
  roomCode?: string;
  room?: QuizRoomState;
  /** `room:list-public` ack payload. */
  rooms?: PublicRoomListItem[];
  gameStarted?: boolean;
  alreadyAdvanced?: boolean;
  currentRound?: number;
  autoLocked?: boolean;
  correct?: boolean;
  baseScore?: number;
  bonusScore?: number;
  totalScoreGained?: number;
  secondsRemaining?: number;
  settings?: QuizRoomSettings;
}

/** Client → server `room:create` payload (the web create body). */
export interface CreateRoomRequest {
  roomType: QuizRoomType;
  poolMode: QuizPoolMode;
  guessType: RoomGuessType;
  roundCount: number;
  maxPlayers?: number;
  matchmaking: QuizMatchmaking;
}

/** Client → server `room:public` payload (public matchmaking). */
export interface PublicRoomRequest {
  roomType: QuizRoomType;
  poolMode: QuizPoolMode;
  guessType: RoomGuessType;
  maxPlayers?: number;
}

/** Server → clients `room:round-started` (the web Pusher payload's shape). */
export interface RoundStartedEvent {
  round: number;
  theme: {
    videoUrl: string;
    /** Playable candidates in order: video, audio, entry sources (raw URLs). */
    mediaCandidates: string[];
    options: string[];
  };
  startedAt: string;
  timeLimitSeconds: number;
}

/** Server → clients `room:player-answered`. */
export interface PlayerAnsweredEvent {
  round: number;
  userId: string;
  submittedAnswer: string;
  correct: boolean;
  totalScoreGained: number;
  bonusScore?: number;
  autoLocked: boolean;
  answeredCount: number;
  totalPlayers: number;
}

/** Server → clients `room:round-ended`. */
export interface RoundEndedEvent {
  round: number;
  answers: QuizRoundAnswer[];
  correctAnswer: string;
  gameOver: boolean;
  players: QuizRoomPlayer[];
  theme: QuizRoundThemeMeta;
}

/** Server → clients `room:rank-updated` (one per player at game end). */
export interface RankUpdatedEvent {
  userId: string;
  rpBefore: number;
  rpAfter: number;
  rpChange: number;
  streakBonus: number;
  tierBefore: string;
  tierAfter: string;
  promoted: boolean;
  demoted: boolean;
  newStreak: number;
}

/* ------------------------------------------------------------------ */
/* Social (Slice S5 — profiles, follows, network feed, notifications)  */
/*                                                                     */
/* Native port of the web's /api/users/[username] (+ /stats,           */
/* /network, /activity), /api/follow/[username],                       */
/* /api/social/friends-activity, the USERS branch of /api/search,      */
/* and /api/notifications, over the shared `users`, `follows` and      */
/* `notifications` collections.                                        */
/*                                                                     */
/* Privacy: the web's public projections NEVER carry email,            */
/* passwordHash or the stored AniList access token, and the public     */
/* profile carries no AniList linkage and no rank at all — the web     */
/* simply does not expose them there. These shapes mirror that.        */
/* ------------------------------------------------------------------ */

/**
 * The web's small public projection of a user — what the network
 * lists' populate and the user search's select return: username,
 * displayName, avatarUrl, bio, plus the id.
 */
export interface NetworkUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  /**
   * Quiz rank tier — enriched ONLY by GET /users/:username/network,
   * whose rows the app's Network screen (§6.17) draws with the tier
   * beside the handle. Read from the user's rank document; a user
   * with no document gets 'academy', the default the rank reads
   * themselves materialise. User-search results omit it (the web's
   * projection there has no rank either).
   */
  tier?: RankTier;
  /**
   * Whether the CALLER follows this user — enriched ONLY by the
   * network endpoint, and only when the request carried a valid
   * Bearer <redacted> (anonymous reads omit the field). Drives the
   * rows' Follow / Following buttons.
   */
  isFollowing?: boolean;
}

/**
 * Response body of GET /users/:username — the web's profile
 * projection, field for field. (The web looks the username up
 * lower-cased and 404s unknown names.)
 */
export interface UserPublicProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  totalRatings: number;
  totalFollowers: number;
  totalFollowing: number;
  /** ISO timestamp of account creation. */
  createdAt: string;
}

/** Response body of GET /users/:username/stats — the web's stats projection. */
export interface UserStats {
  totalFollowers: number;
  totalFollowing: number;
  /** Cumulative seconds watched/listened (maintained by the history write path). */
  totalTime: number;
  totalRatings: number;
}

/**
 * Response body of GET /users/:username/network — BOTH lists, in the
 * web's order: the Follow queries carry no sort, so rows come back
 * in storage (insertion) order, unpaginated however long they get.
 * An element is null when the other account no longer exists — the
 * web's populate yields exactly that.
 */
export interface NetworkResponse {
  followers: (NetworkUser | null)[];
  following: (NetworkUser | null)[];
}

/**
 * The caller's follow state for one user — the response of GET /
 * POST / DELETE /users/:username/follow. Follow and unfollow are
 * idempotent (the web answers success either way; a duplicate follow
 * creates no second row and moves no counter).
 */
export interface FollowState {
  username: string;
  isFollowing: boolean;
}

/**
 * One row of GET /users/:username/activity — a rating or a watch of
 * the profile owner, in the web's merged shape (activityType marks
 * the source; `date` is the timestamp the web sorts by: the rating's
 * createdAt / the history row's viewedAt).
 *
 * The list is privacy-gated on the web: it is only served when the
 * caller is the owner, or the owner follows the caller — everyone
 * else (and every anonymous caller) receives an empty list.
 */
export interface UserActivityItem {
  id: string;
  activityType: 'rating' | 'watch';
  /** ISO timestamp (see above). */
  date: string;
  themeSlug: string;
  /** The 1–10 score on rating rows; null on watch rows. */
  score: number | null;
  mode: PlaybackMode;
  /** The theme joined in (null only if it left the catalogue). */
  theme: ThemeSummary | null;
}

/** Response body of GET /users/:username/activity. */
export interface UserActivityResponse {
  activity: UserActivityItem[];
}

/**
 * One row of GET /social/friends-activity — recent watches
 * ('listening') and ratings ('liked') by users the caller follows.
 * `user.avatar` is always a string: the web falls back to a
 * DiceBear avatar URL seeded by username when none is stored.
 */
export interface FriendsActivityItem {
  id: string;
  user: {
    username: string;
    displayName: string;
    avatar: string;
  };
  type: 'listening' | 'liked';
  item: {
    title: string;
    slug: string;
  };
  /** ISO timestamp (viewedAt for watches, createdAt for ratings). */
  timestamp: string;
}

/**
 * Response body of GET /social/friends-activity. `isGlobal` is the
 * web's meta flag, which is always false in the web's code (the
 * feed is never global). Anonymous callers and callers who follow
 * nobody receive an empty list, not a 401 — the web's behaviour.
 */
export interface FriendsActivityResponse {
  activities: FriendsActivityItem[];
  isGlobal: false;
}

/**
 * Response body of GET /social/users/search — the USERS branch of
 * the web's /api/search: only public accounts (isPublic), every
 * query word must appear (case-insensitive substring) in the
 * username or the display name, 20 per page. The web requires at
 * least 2 query characters (400 otherwise) — mirrored.
 */
export interface UserSearchResponse {
  query: string;
  users: NetworkUser[];
  /** 1-based page served. */
  page: number;
  /** Total matching public accounts across all pages. */
  total: number;
  /** True when another page follows this one. */
  hasMore: boolean;
}

/**
 * The web Notification model's type enum. Of these, ONLY 'follow'
 * is ever created by web code (the Follow post-save hook);
 * 'theme_rated', 'theme_favorited', 'comment', 'rating_like' and
 * 'playlist_like' are dead vocabulary — no route, hook or script
 * creates them. This API creates 'follow' notifications the same
 * way and serves the rest if rows ever exist.
 */
export type NotificationType =
  | 'follow'
  | 'theme_rated'
  | 'theme_favorited'
  | 'comment'
  | 'rating_like'
  | 'playlist_like';

/**
 * One notification (GET /notifications — the caller's 50 most
 * recent, newest first). `actor` is the web populate's projection
 * (CommentAuthor), null when the actor's account is gone.
 * `entityMeta` is the model's free-form Mixed payload, passed
 * through untouched (null when unset).
 */
export interface NotificationItem {
  id: string;
  type: NotificationType;
  actor: CommentAuthor | null;
  entityId: string | null;
  entityMeta: unknown;
  read: boolean;
  /** ISO timestamps. Notifications expire 30 days after creation (the model's TTL index). */
  createdAt: string;
  updatedAt: string;
}

/** Response body of GET /notifications. */
export interface NotificationsResponse {
  notifications: NotificationItem[];
}

/**
 * Request body of POST /notifications/mark-read — the web's POST
 * /api/notifications body. With an id list, only those of the
 * caller's own notifications are marked; with no list (or a
 * non-array), ALL of the caller's unread notifications are marked.
 */
export interface MarkNotificationsReadRequest {
  notificationIds?: string[];
}

/** Response body of POST /notifications/mark-read. */
export interface MarkNotificationsReadResponse {
  markedRead: true;
}

/* ------------------------------------------------------------------ */
/* Per-user history + ratings (Slice S6)                               */
/*                                                                     */
/* Native port of the web's /api/users/[username]/history and          */
/* /api/users/[username]/ratings — the per-user reads S5 deliberately  */
/* left behind (S5 ported the profile/stats/network/activity surface   */
/* of the same prefix). Both are PUBLIC on the web: no session, no     */
/* isPublic check — any caller can read any user's 50 most recent      */
/* ratings and watch rows. Mirrored as-is (flagged, not "fixed").      */
/* ------------------------------------------------------------------ */

/** One row of GET /users/:username/ratings. */
export interface UserRatingEntry {
  id: string;
  themeSlug: string;
  /** The 1–10 score. */
  score: number;
  mode: PlaybackMode;
  /** ISO timestamps of the rating row. */
  createdAt: string;
  updatedAt: string;
  /** The theme joined in (null only if it left the catalogue). */
  theme: ThemeSummary | null;
}

/**
 * Response body of GET /users/:username/ratings — the web's order
 * (newest first) and the web's hard cap: the 50 most recent ratings.
 * No pagination parameters exist on the web route; mirrored as-is.
 */
export interface UserRatingsResponse {
  ratings: UserRatingEntry[];
}

/**
 * The `meta` block of both history responses — the web route's own
 * fields. `libraryTotal`, `anilistConnected`, `anilistIncluded` and
 * `anilistError` exist ONLY in merged mode (the web's non-merged
 * meta carries just total / localCount / remoteCount / merged).
 */
export interface UserHistoryMeta {
  /** Rows in this response (after merging, in merged mode). */
  total: number;
  localCount: number;
  remoteCount: number;
  merged: boolean;
  /**
   * Merged mode only: how many catalogue themes (with an audio
   * source) the user has in their library — local watched themes
   * union the AniList completed ids (or the stored fallback ids
   * when the remote fetch returned nothing).
   */
  libraryTotal?: number;
  /** Merged mode only: the owner has an AniList id linked. */
  anilistConnected?: boolean;
  /**
   * Merged mode only: remote entries were actually fetched for
   * this response — true only for the owner viewing their own
   * history with a stored AniList token while includeRemote is on.
   */
  anilistIncluded?: boolean;
  /** Merged mode only: the AniList fetch failure message, if any. */
  anilistError?: string | null;
}

/**
 * Response body of GET /users/:username/history (default mode) —
 * the owner's 50 most recent watch/listen rows, newest first, in
 * the same entry shape as the caller's own GET /library/history.
 */
export interface UserHistoryResponse {
  entries: WatchHistoryEntry[];
  meta: UserHistoryMeta;
}

/**
 * One row of the MERGED history (?includeMerged=1) — the web's
 * normalized watch-history shape (lib/history-utils): local theme
 * watches and AniList completed anime flattened into one entry
 * kind and deduplicated, local rows winning conflicts.
 */
export interface MergedHistoryEntry {
  /** Theme id (string) for local rows; AniList media id (number) for remote rows. */
  id: string | number;
  /** Song title (local) or anime title (AniList). */
  title: string;
  /** The anime title — local rows only; null on AniList rows. */
  animeTitle: string | null;
  /** Episode count — AniList rows only; null on local rows. */
  episodeCount: number | null;
  /** ISO timestamp: viewedAt (local) / AniList updatedAt (remote). */
  lastWatchedAt: string;
  source: 'AniList' | 'Local';
  /** Cover image URL, when one is stored. */
  image: string | null;
  /** 'OP' | 'ED' — local rows only; null on AniList rows. */
  type: string | null;
  /** Theme slug — local rows only; null on AniList rows. */
  slug: string | null;
}

/** Response body of GET /users/:username/history?includeMerged=1. */
export interface UserMergedHistoryResponse {
  entries: MergedHistoryEntry[];
  meta: UserHistoryMeta;
}

/* ------------------------------------------------------------------ */
/* Rank (Slice S6)                                                     */
/*                                                                     */
/* Native port of the web's /api/rank/me, /api/rank/[userId] and       */
/* /api/leaderboard over the shared `userranks` and                    */
/* `leaderboardsnapshots` collections (the rank write path itself —    */
/* RP arithmetic at game end — was S4's RankService).                  */
/*                                                                     */
/* Two web facts worth knowing: (1) there is NO rank-history read      */
/* route on the web — `rankhistories` rows are written at game end     */
/* and read by nothing; nothing is ported for them here. (2) The       */
/* web's getUserRank CREATES a default rank document when none         */
/* exists, so both rank reads can write — mirrored deliberately and    */
/* flagged; see apps/api/src/rank.                                     */
/* ------------------------------------------------------------------ */

/** The web's rank tiers, low to high (lib/rank-utils TIERS). */
export type RankTier =
  | 'academy'
  | 'genin'
  | 'chunin'
  | 'jonin'
  | 'anbu'
  | 'kage';

/** The UserRank `stats` sub-document. */
export interface UserRankStats {
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  peakRP: number;
  peakTier: RankTier;
}

/** The UserRank `season` sub-document. */
export interface UserRankSeason {
  seasonId: string;
  seasonRP: number;
  seasonWins: number;
  seasonLosses: number;
  seasonPlacement: number | null;
}

/**
 * A user's rank document, projected — the response of
 * GET /rank/me (Bearer required) and GET /rank/:userId (public).
 * The web serves the raw document; this API projects it the way it
 * projects every other document, minus bookkeeping fields.
 */
export interface UserRankProfile {
  id: string;
  /** The ranked user's id (a plain string on UserRank, as on the web). */
  userId: string;
  rp: number;
  tier: RankTier;
  division: number | null;
  tierFloor: number;
  currentWinStreak: number;
  longestWinStreak: number;
  stats: UserRankStats;
  season: UserRankSeason;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of GET /rank/players — a player's rank standing reduced
 * to what a room roster draws (tier + RP). Unlike GET /rank/:userId
 * this read NEVER creates a rank document: a player with no rank
 * document reports the materialised defaults (academy, 0 RP),
 * exactly what the web's getUserRank would create for them.
 */
export interface PlayerRankSummary {
  userId: string;
  tier: RankTier;
  rp: number;
}

/** Response body of GET /rank/players?ids=<csv> (public, read-only). */
export interface PlayerRanksResponse {
  players: PlayerRankSummary[];
}

/**
 * One row of GET /rank/leaderboard (the web's /api/leaderboard) —
 * the projection the web itself applies on its snapshot path,
 * extracted identically from live rows on the fallback path.
 */
export interface RankLeaderboardEntry {
  userId: string;
  username: string;
  /**
   * The display name — except on the snapshot path, where the web
   * serves the USERNAME in this field (its snapshot map does
   * `displayName: entry.username`). Mirrored quirk.
   */
  displayName: string;
  avatarUrl: string | null;
  rp: number;
  tier: RankTier;
  division: number | null;
  wins: number;
  winRate: number;
}

/**
 * Response body of GET /rank/leaderboard — the web's top 100 by RP.
 * `meta.source` is 'snapshot' when a fresh (≤15 min)
 * LeaderboardSnapshot was served — `computedAt` is then its ISO
 * timestamp — and 'live' when the board was aggregated from
 * `userranks` on the spot (computedAt null, as the web's live meta
 * carries no timestamp).
 */
export interface RankLeaderboardResponse {
  leaderboard: RankLeaderboardEntry[];
  meta: {
    source: 'snapshot' | 'live';
    computedAt: string | null;
  };
}

/* ------------------------------------------------------------------ */
/* Residual reads (Slice S8)                                           */
/*                                                                     */
/* The last app-relevant reads of the web's API surface, closing out   */
/* the S7 sweep's residual list. Route map (web → here):               */
/*   GET /api/themes/[slug]/similar → GET /themes/:slug/similar        */
/*   GET /api/anime/[id]/related    → GET /anime/:id/related           */
/*   GET /api/themes/library        → GET /library/themes              */
/*     (renamed onto this API's /library prefix — S1/S7 precedent —    */
/*      and because the literal path would collide with                */
/*      GET /themes/:slug)                                             */
/*   GET /api/history/check         → GET /library/history/check       */
/*   GET /api/stats/live            → GET /stats/live                  */
/*   GET /api/stats/top-artists     → GET /stats/top-artists           */
/* The web's /api/users/[username]/friends is a byte-identical         */
/* duplicate of its /network route, ported in S5 — nothing new here.   */
/* ------------------------------------------------------------------ */

/**
 * Response body of GET /themes/:slug/similar — themes sharing the
 * theme's anime, artist, mood or first-entry tags, in the web's
 * order (totalRatings desc, then avgRating desc), capped at the
 * web's 20. The web serves raw documents; this API projects them
 * through ThemeSummary, like every other theme read here.
 */
export interface SimilarThemesResponse {
  themes: ThemeSummary[];
}

/**
 * One related anime (GET /anime/:id/related) — an AnimeCache
 * document projected to its content fields (the web serves the raw
 * document; bookkeeping — synonyms, AT images, syncedAt, timestamps
 * — stays server-side, as with this API's other projections).
 */
export interface RelatedAnime {
  anilistId: number | null;
  malId: number | null;
  kitsuId: string | null;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  titleAlternative: string[];
  season: Season | null;
  seasonYear: number | null;
  genres: string[];
  coverImageLarge: string | null;
  coverImageMedium: string | null;
  bannerImage: string | null;
  studios: string[];
  /** Series/franchise names this anime belongs to — the join key. */
  series: string[];
  totalEpisodes: number | null;
  status: string | null;
  averageScore: number | null;
}

/**
 * Response body of GET /anime/:id/related — the OTHER anime sharing
 * a `series` name with the requested AniList id, in the web's
 * chronological order (seasonYear asc), capped at the web's 10.
 * Empty when the anime has no series recorded.
 */
export interface RelatedAnimeResponse {
  related: RelatedAnime[];
}

/**
 * Response body of GET /anime/:id — one anime's detail page (the web's
 * `app/anime/[id]/page.tsx` read): the AnimeCache projection (same
 * shape as RelatedAnime; synthesized from the first theme when the
 * cache has no document, exactly as the web page does) plus every
 * theme of the anime as ThemeSummary rows, in the web's natural
 * (unsorted) find order — clients group/sort for display.
 */
export interface AnimeDetailResponse {
  anime: RelatedAnime;
  themes: ThemeSummary[];
}

/** One artist's header (GET /artists/:slug) — the ArtistCache projection. */
export interface ArtistDetail {
  slug: string;
  name: string;
  aliases: string[];
  imageUrl: string | null;
  totalThemes: number;
}

/**
 * Response body of GET /artists/:slug — one artist's detail page (the
 * web's `app/artist/[slug]/page.tsx` read): the ArtistCache header
 * (synthesized from the first matching theme when the cache has no
 * document, as the web page does) plus every theme carrying the
 * artist's slug, as ThemeSummary rows in natural find order.
 */
export interface ArtistDetailResponse {
  artist: ArtistDetail;
  themes: ThemeSummary[];
}

/**
 * Response body of GET /library/themes (Bearer required) — the
 * caller's "library themes": catalogue themes they have watched or
 * listened to locally UNION themes whose anime is in their AniList
 * completed list, in the web's order (animeSeasonYear desc,
 * animeTitle asc), paged with the web's defaults (page 1, limit 50).
 *
 * The AniList meta fields mirror the web's meta block — with the
 * web's own omission: when BOTH sides of the union are empty the
 * web's early return carries no AniList fields at all, so all three
 * are absent (not null/false) in that case.
 */
export interface LibraryThemesResponse {
  themes: ThemeSummary[];
  /** Total matching themes across all pages. */
  total: number;
  /** 1-based page served. */
  page: number;
  limit: number;
  /** The caller's linked AniList username, or null when unlinked. */
  anilistUser?: string | null;
  /**
   * True when the stored AniList completed ids were stale and a
   * background refresh was fired instead of blocking the response
   * (the stored ids were still served).
   */
  anilistSyncDeferred?: boolean;
  /** True when the stored AniList completed ids are older than 6h. */
  anilistDataStale?: boolean;
}

/**
 * Response body of GET /library/history/check?slug=… — whether the
 * caller has a watch-history row for the theme. OPTIONAL auth, like
 * the web: anonymous callers (and invalid tokens) get
 * `{ watched: false }`, never a 401 — and the web resolves the
 * session BEFORE validating the slug, so an anonymous caller gets
 * `watched: false` even with no slug, while a signed-in caller
 * without one gets the web's 400 'Slug required'.
 */
export interface HistoryCheckResponse {
  watched: boolean;
}

/**
 * Response body of GET /stats/live (public) — the web's live
 * counters, quirks included: `activeUsers` is the TOTAL user count
 * (the web's mislabel, mirrored), and `listeningNow` is the number
 * of distinct users with a watch in the last 10 minutes PLUS a
 * random 0–4 "live feel" noise term the web adds. `listeningAvatars`
 * is up to 3 avatar URLs of those recent listeners, or the web's
 * three hard-coded DiceBear fallback URLs when there are none.
 */
export interface LiveStatsResponse {
  activeUsers: number;
  listeningNow: number;
  listeningAvatars: string[];
}

/** One row of GET /stats/top-artists. */
export interface TopArtistEntry {
  name: string;
  /** Total plays of this artist's themes in the caller's history. */
  plays: number;
  /** The artist's ArtistCache slug ('' when the theme stored none). */
  slug: string;
  /** ArtistCache image, or null when unknown/unimaged. */
  image: string | null;
}

/**
 * Response body of GET /stats/top-artists (Bearer required) — the
 * caller's top artists by plays: their 20 most-played themes are
 * aggregated into artists, summed per artist, sorted by plays desc
 * and capped at the web's 6, enriched with ArtistCache images.
 */
export interface TopArtistsResponse {
  artists: TopArtistEntry[];
}

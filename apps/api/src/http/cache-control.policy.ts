/**
 * The API's Cache-Control policy (perf problem 10, B4's second
 * half) — conservative by design:
 *
 * - CATALOGUE reads — exactly the routes the app's response cache
 *   (problem 5) treats as 15-minute data — may carry
 *   `private, max-age=60` as a hint. `private` (never `public`):
 *   no shared cache may store or reuse these responses; the 60 s
 *   is a browser/per-device freshness hint only, far inside the
 *   app's own 15-minute window.
 * - USER reads — authenticated responses and user-specific data —
 *   get an explicit `no-store` where they previously had nothing.
 * - Everything else (writes, quiz game state, search, feed,
 *   internal endpoints, health) is left exactly as it was: no
 *   header added. When in doubt the route is NOT in a table.
 *
 * The tables mirror the mobile app's own cache classes
 * (apps/mobile/src/api.ts readCacheClass): FEED and USER map to
 * no-store, CATALOGUE maps to the private hint. Search is absent
 * from the app's classes and from these tables alike.
 */

export const CATALOGUE_HINT = 'private, max-age=60';
export const USER_NO_STORE = 'no-store';

/** Exact catalogue GET routes (the app's CATALOGUE class). */
const CATALOGUE_EXACT: ReadonlySet<string> = new Set(['/season']);

/** Catalogue GET route prefixes (the app's CATALOGUE class). */
const CATALOGUE_PREFIXES: readonly string[] = ['/anime/', '/artists/'];

/**
 * Theme-detail reads under /themes/ are the one catalogue route
 * family that needs a shape check: /themes/:slug and
 * /themes/:slug/similar are catalogue reads, but
 * /themes/:slug/rating and /themes/:slug/comments are user reads
 * handled by other controllers on the same prefix.
 */
function isThemeCatalogueRead(segments: string[]): boolean {
  if (segments.length === 2) return true; // /themes/:slug
  return segments.length === 3 && segments[2] === 'similar';
}

/** Exact user-read GET routes (the app's FEED + USER classes). */
const USER_EXACT: ReadonlySet<string> = new Set([
  '/home',
  '/auth/me',
  '/library/favorites',
  '/library/history',
  '/library/count',
  '/library/themes',
  '/library/anilist-entries',
  '/library/history/check',
  '/notifications',
  '/social/friends-activity',
  '/social/users/search',
  '/rank/me',
  '/rank/leaderboard',
  '/rank/players',
  '/playlists',
]);

/** User-read GET route prefixes (the app's FEED + USER classes). */
const USER_PREFIXES: readonly string[] = [
  '/users/',
  '/playlists/',
  '/rank/',
  '/library/favorites/',
];

/** The caller's own per-theme rating state: /themes/:slug/rating. */
function isThemeRatingRead(segments: string[]): boolean {
  return segments.length === 3 && segments[2] === 'rating';
}

/**
 * The Cache-Control value for a request, or null to leave the
 * response's headers exactly as they are. Only GET requests are
 * classified: writes and game-state mutations are never cacheable
 * answers, and no header is added to them.
 */
export function cacheControlFor(method: string, path: string): string | null {
  if (method !== 'GET') return null;
  const clean = path.split('?')[0];
  const segments = clean.split('/').filter((s) => s.length > 0);

  // Catalogue class.
  if (CATALOGUE_EXACT.has(clean)) return CATALOGUE_HINT;
  if (CATALOGUE_PREFIXES.some((p) => clean.startsWith(p))) {
    return CATALOGUE_HINT;
  }
  if (segments[0] === 'themes' && isThemeCatalogueRead(segments)) {
    return CATALOGUE_HINT;
  }

  // User class (feed + user reads).
  if (USER_EXACT.has(clean)) return USER_NO_STORE;
  if (USER_PREFIXES.some((p) => clean.startsWith(p))) return USER_NO_STORE;
  if (segments[0] === 'themes' && isThemeRatingRead(segments)) {
    return USER_NO_STORE;
  }

  return null;
}

/**
 * Queue origin (owner ruling 2026-11-10): which surface family
 * claimed the playback queue. 'playlist' and 'offline' are the
 * two origins allowed to open the full-screen player route;
 * 'other' covers every other surface (Home, Search, Season,
 * Anime/Artist detail, Library's non-offline segments,
 * Favourites, theme detail itself) and is also the default for
 * untagged and queue-less sessions — the safe side of the
 * ruling. Kept in this pure module so the rule is unit-testable
 * without the playback provider (audit S6).
 */
export type QueueOrigin = 'playlist' | 'offline' | 'other';

/**
 * Whether a queue origin may open the full-screen player route:
 * 'playlist' and 'offline' may; everything else resolves to the
 * theme detail instead. The mini-player's tap handler routes
 * by it.
 */
export function isPlayerRouteOrigin(origin: QueueOrigin): boolean {
  return origin === 'playlist' || origin === 'offline';
}

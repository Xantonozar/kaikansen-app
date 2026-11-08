/**
 * Port of the web's `lib/history-utils.ts` — the normalization and
 * merge behind GET /api/users/[username]/history?includeMerged=1.
 * The logic is the web's, line for line in effect:
 *
 * - AniList entries flatten to { id: media.id, title: english ||
 *   romaji, episodeCount, lastWatchedAt: updatedAt (AniList
 *   seconds) as a Date, source: 'AniList', image: cover large }.
 * - Local entries flatten to { id: theme._id, title: songTitle,
 *   animeTitle, lastWatchedAt: viewedAt, source: 'Local',
 *   image: small cover || cover, type, slug }.
 * - The merge seeds the map with the remote entries, then walks
 *   the local ones: a remote entry whose title equals the local
 *   entry's song title OR anime title (case-insensitive) is
 *   deleted, and the local entry is set under its own id — local
 *   wins conflicts. The result sorts by lastWatchedAt desc.
 *
 * (The web file's long exploratory comment block and its two dead
 * locals — matchKey / localKey — are not carried over; behaviour
 * is identical.)
 */

export interface NormalizedWatchEntry {
  /** themeId for local, mediaId for AniList. */
  id: string | number;
  title: string;
  animeTitle?: string;
  episodeCount?: number;
  lastWatchedAt: Date;
  source: 'AniList' | 'Local';
  image: string;
  /** OP, ED, etc. (local only). */
  type?: string;
  /** Theme slug (local only). */
  slug?: string;
}

/** The AniList MediaList entry shape the web's query returns. */
export interface AniListCompletedEntry {
  updatedAt?: number;
  media?: {
    id: number;
    title?: { romaji?: string | null; english?: string | null };
    coverImage?: { large?: string | null } | null;
    episodes?: number | null;
  };
  // The web tolerates an entry that IS the media object.
  id?: number;
  title?: { romaji?: string | null; english?: string | null };
  coverImage?: { large?: string | null } | null;
  episodes?: number | null;
}

/** The joined local row the normalizer reads (history row + its theme). */
export interface LocalHistoryRow {
  viewedAt: Date | string;
  theme: {
    _id: unknown;
    songTitle: string;
    animeTitle: string;
    animeCoverImage?: string | null;
    animeCoverImageSmall?: string | null;
    type: string;
    slug: string;
  };
}

export function normalizeAniListEntry(
  entry: AniListCompletedEntry,
): NormalizedWatchEntry {
  const media = entry.media || entry;
  return {
    id: media.id as number,
    title: (media.title?.english || media.title?.romaji) as string,
    episodeCount: media.episodes ?? undefined,
    // AniList uses seconds; a missing value falls back to now,
    // exactly like the web's `entry.updatedAt * 1000 || Date.now()`.
    lastWatchedAt: new Date((entry.updatedAt ?? 0) * 1000 || Date.now()),
    source: 'AniList',
    image: media.coverImage?.large as string,
  };
}

export function normalizeLocalEntry(
  entry: LocalHistoryRow,
): NormalizedWatchEntry {
  const theme = entry.theme;
  return {
    id: String(theme._id),
    title: theme.songTitle,
    animeTitle: theme.animeTitle,
    lastWatchedAt: new Date(entry.viewedAt),
    source: 'Local',
    image: (theme.animeCoverImageSmall || theme.animeCoverImage) as string,
    type: theme.type,
    slug: theme.slug,
  };
}

export function mergeWatchHistory(
  localEntries: NormalizedWatchEntry[],
  remoteEntries: NormalizedWatchEntry[],
): NormalizedWatchEntry[] {
  const mergedMap = new Map<string | number, NormalizedWatchEntry>();

  // Add remote entries first
  remoteEntries.forEach((entry) => {
    mergedMap.set(entry.id, entry);
  });

  // Add local entries, taking precedence on conflict: a remote
  // entry matching the local one's title or anime title (by
  // lower-cased string equality) is removed first.
  localEntries.forEach((local) => {
    const remoteMatch = remoteEntries.find((remote) => {
      const remoteKey = remote.title.toLowerCase();
      return (
        remoteKey === local.title.toLowerCase() ||
        (local.animeTitle &&
          remoteKey === local.animeTitle.toLowerCase())
      );
    });

    if (remoteMatch) {
      mergedMap.delete(remoteMatch.id);
    }

    mergedMap.set(local.id, local);
  });

  return Array.from(mergedMap.values()).sort(
    (a, b) => b.lastWatchedAt.getTime() - a.lastWatchedAt.getTime(),
  );
}

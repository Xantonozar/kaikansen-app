import { Injectable } from '@nestjs/common';

const GRAPHQL_URL = 'https://graphql.anilist.co';

/** The web library route's AniList timeout (ANILIST_TIMEOUT_MS there). */
const ANILIST_TIMEOUT_MS = 1500;

/**
 * The library's AniList media-ids query. Based on the web library
 * route's MediaListCollection query with ONE deliberate change —
 * see the DEVIATION note on the class below: `status_in` asks for
 * COMPLETED and CURRENT (watching) in a single collection call.
 */
const LIBRARY_IDS_QUERY = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME, status_in: [COMPLETED, CURRENT]) {
      lists {
        entries {
          mediaId
        }
      }
    }
  }
`;

/**
 * The AniList-entries query (GET /library/anilist-entries): the
 * same COMPLETED + CURRENT collection as the ids query, but with
 * the per-entry fields the Library segment's entry cards draw —
 * progress, the caller's score (normalised to the 10-point scale
 * by AniList itself via the field's format argument), and the
 * media's format / episode count / titles / cover. One collection
 * call serves both groups; entries carry their own list status.
 */
const LIBRARY_ENTRIES_QUERY = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME, status_in: [COMPLETED, CURRENT]) {
      lists {
        status
        entries {
          status
          progress
          score(format: POINT_10)
          media {
            id
            format
            episodes
            title {
              romaji
              english
            }
            coverImage {
              large
              medium
            }
          }
        }
      }
    }
  }
`;

/**
 * One fetched AniList list entry, in the shape the caller's user
 * document caches (AnilistCachedEntry in the user schema mirrors
 * this field-for-field) and LibraryService groups into the
 * contract's Watching / Completed lists.
 */
export interface AnilistLibraryEntry {
  mediaId: number;
  /** 'CURRENT' (watching) or 'COMPLETED'. */
  status: string;
  title: string;
  coverImage: string | null;
  format: string | null;
  episodes: number | null;
  progress: number;
  /** 10-point score, or null when unscored (AniList stores 0). */
  score: number | null;
}

/**
 * Thin injectable wrapper over the AniList GraphQL calls the
 * library reads make: the caller's library anime media ids (the
 * themes/count reads) and their full list entries (the
 * anilist-entries read), fetched with the caller's own stored
 * access token
 * under a 1500 ms abort timeout. The failure contract mirrors the
 * web's fetchAniListCompletedMediaIds exactly: ANY failure
 * (non-OK status, network error, timeout) resolves null rather
 * than throwing, and the caller falls back to whatever ids it
 * already has stored. Kept behind a class so tests can mock it —
 * no test ever touches the live AniList API. (The users module's
 * AnilistHistoryClient is the sibling fetch for the history route:
 * different query, different timeout, throw-on-failure contract.)
 *
 * DEVIATION from the web — deliberate, owner-ordered (2026-11-08):
 * the web's query reads the caller's COMPLETED list only; this API
 * asks for COMPLETED + CURRENT (watching) and merges both lists'
 * ids into the one stored set, so the app's AniList library
 * segment covers anime the user is watching too. Planning /
 * Paused / Dropped stay out, exactly as on the web. The merged
 * set is stored in the user document's existing
 * `anilist.completedMediaIds` field — the field NAME is the web's
 * and stays for shared-DB schema compatibility; in this API it
 * holds completed+watching ids (see user.schema.ts).
 */
@Injectable()
export class AnilistLibraryClient {
  async fetchLibraryMediaIds(
    accessToken: string,
    userId: number,
  ): Promise<number[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANILIST_TIMEOUT_MS);
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query: LIBRARY_IDS_QUERY,
          variables: { userId },
        }),
        signal: controller.signal,
      });

      if (!res.ok) return null;
      const data = (await res.json()) as {
        data?: {
          MediaListCollection?: {
            lists?: { entries?: { mediaId: number }[] }[];
          };
        };
      } | null;
      const entries =
        data?.data?.MediaListCollection?.lists?.flatMap(
          (list) => list.entries ?? [],
        ) ?? [];
      // Both statuses arrive in one collection; merge + dedupe
      // (a media sits in exactly one status list, but the union
      // is stored verbatim downstream, so keep it clean here).
      return [...new Set(entries.map((e) => e.mediaId))];
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The caller's full AniList Watching + Completed entries (see
   * LIBRARY_ENTRIES_QUERY). Same transport contract as
   * fetchLibraryMediaIds: the caller's own stored token, the
   * web's 1500 ms abort timeout, and ANY failure resolves null so
   * the caller falls back to whatever it has cached. Entries are
   * flattened across the collection's lists (each entry's own
   * status wins; the list's status is the fallback) and deduped
   * by media id — a media sits in exactly one status list, but
   * the stored cache is served verbatim, so keep it clean here.
   */
  async fetchLibraryEntries(
    accessToken: string,
    userId: number,
  ): Promise<AnilistLibraryEntry[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANILIST_TIMEOUT_MS);
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          query: LIBRARY_ENTRIES_QUERY,
          variables: { userId },
        }),
        signal: controller.signal,
      });

      if (!res.ok) return null;
      const data = (await res.json()) as {
        data?: {
          MediaListCollection?: {
            lists?: {
              status?: string;
              entries?: {
                status?: string;
                progress?: number;
                score?: number;
                media?: {
                  id?: number;
                  format?: string | null;
                  episodes?: number | null;
                  title?: {
                    romaji?: string | null;
                    english?: string | null;
                  } | null;
                  coverImage?: {
                    large?: string | null;
                    medium?: string | null;
                  } | null;
                } | null;
              }[];
            }[];
          };
        };
      } | null;

      const lists = data?.data?.MediaListCollection?.lists ?? [];
      const seen = new Set<number>();
      const entries: AnilistLibraryEntry[] = [];
      for (const list of lists) {
        for (const entry of list.entries ?? []) {
          const media = entry.media;
          if (!media || typeof media.id !== 'number') continue;
          if (seen.has(media.id)) continue;
          seen.add(media.id);
          entries.push({
            mediaId: media.id,
            status: entry.status ?? list.status ?? 'COMPLETED',
            title:
              media.title?.english ??
              media.title?.romaji ??
              'Unknown title',
            coverImage:
              media.coverImage?.large ?? media.coverImage?.medium ?? null,
            format: media.format ?? null,
            episodes:
              typeof media.episodes === 'number' ? media.episodes : null,
            progress:
              typeof entry.progress === 'number' ? entry.progress : 0,
            // AniList stores 0 for an unscored entry; on the
            // POINT_10 scale that is "no score", never a real 0.
            score:
              typeof entry.score === 'number' && entry.score > 0
                ? entry.score
                : null,
          });
        }
      }
      return entries;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

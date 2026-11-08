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
 * Thin injectable wrapper over the ONE AniList GraphQL call the
 * library themes/count reads make: the caller's library anime
 * media ids, fetched with the caller's own stored access token
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
}

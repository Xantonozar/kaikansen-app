import { Injectable } from '@nestjs/common';

const GRAPHQL_URL = 'https://graphql.anilist.co';

/** The web library route's AniList timeout (ANILIST_TIMEOUT_MS there). */
const ANILIST_TIMEOUT_MS = 1500;

/** The web library route's MediaListCollection query, verbatim. */
const COMPLETED_IDS_QUERY = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME, status: COMPLETED) {
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
 * web's themes/library route makes: the caller's COMPLETED anime
 * media ids, fetched with the caller's own stored access token
 * under a 1500 ms abort timeout. Mirrors the web's
 * fetchAniListCompletedMediaIds exactly — including its failure
 * contract: ANY failure (non-OK status, network error, timeout)
 * resolves null rather than throwing, and the caller falls back to
 * whatever ids it already has stored. Kept behind a class so
 * tests can mock it — no test ever touches the live AniList API.
 * (The users module's AnilistHistoryClient is the sibling fetch
 * for the history route: different query, different timeout,
 * throw-on-failure contract.)
 */
@Injectable()
export class AnilistLibraryClient {
  async fetchCompletedMediaIds(
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
          query: COMPLETED_IDS_QUERY,
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
      return entries.map((e) => e.mediaId);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

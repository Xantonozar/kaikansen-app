import { Injectable } from '@nestjs/common';
import type { AniListCompletedEntry } from './history.utils';

const GRAPHQL_URL = 'https://graphql.anilist.co';

/** The web's AniList history timeout (history route: ANILIST_TIMEOUT_MS). */
const ANILIST_TIMEOUT_MS = 1800;

/** The web's MediaListCollection query, verbatim (history route). */
const COMPLETED_QUERY = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME, status: COMPLETED) {
      lists {
        entries {
          updatedAt
          media {
            id
            title {
              romaji
              english
            }
            coverImage {
              large
            }
            episodes
          }
        }
      }
    }
  }
`;

/**
 * Thin injectable wrapper over the ONE AniList GraphQL call the
 * web's per-user history route makes: the owner's COMPLETED anime
 * list, fetched with the owner's own stored access token under an
 * 1800 ms abort timeout. Mirrors the web's fetch exactly (headers,
 * body, `!res.ok` → `AniList request failed with status N` throw,
 * lists flattened to their entries). Kept behind a class so tests
 * can mock it — no test ever touches the live AniList API. The
 * caller maps a rejection named 'AbortError' to the web's
 * 'AniList request timed out' message, as the web route does.
 */
@Injectable()
export class AnilistHistoryClient {
  async fetchCompletedEntries(
    accessToken: string,
    userId: number,
  ): Promise<AniListCompletedEntry[]> {
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
          query: COMPLETED_QUERY,
          variables: { userId },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`AniList request failed with status ${res.status}`);
      }

      const data = (await res.json()) as {
        data?: {
          MediaListCollection?: {
            lists?: { entries?: AniListCompletedEntry[] }[];
          };
        };
      } | null;
      const lists = data?.data?.MediaListCollection?.lists ?? [];
      return lists.flatMap((list) => list.entries ?? []);
    } finally {
      clearTimeout(timer);
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { AniListMedia, KitsuAnime } from './sync.types';

const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';
const KITSU_BASE = 'https://kitsu.io/api/edge/anime';

/* The web's enrichment queries, verbatim (scripts/seed-utils.ts). */
const BY_MAL_ID_QUERY = `
    query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) {
        id
        idMal
        title { romaji english native }
        synonyms
        season seasonYear
        genres
        episodes
        status
        averageScore
        coverImage { large medium }
        bannerImage
        studios { nodes { name } }
      }
    }
  `;

const BY_TITLE_QUERY = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        id
        idMal
        title { romaji english native }
        synonyms
        season seasonYear
        genres
        episodes
        status
        averageScore
        coverImage { large medium }
        bannerImage
        studios { nodes { name } }
      }
    }
  `;

/**
 * Injectable wrapper over the two enrichment sources the web's seed
 * scripts use, ported from `scripts/seed-utils.ts`:
 *
 * - AniList GraphQL (unauthenticated): POST, `data.Media` unwrapped;
 *   HTTP 429 honours `Retry-After` (default 60s) with at most 3 retries;
 *   any other failure resolves to null rather than throwing — the web's
 *   `fetchAniList` swallows errors the same way.
 * - Kitsu (unauthenticated): title search, first hit only; the anime
 *   season is DERIVED from `startDate` (month ≤3 WINTER, ≤6 SPRING,
 *   ≤9 SUMMER, else FALL) and the year from the same date — exactly the
 *   web's mapping.
 *
 * Polite delays between calls live in EnrichmentService (as they live in
 * the web's enrichTheme, not in its fetch helpers). Tests mock this
 * class; no test touches the network.
 */
@Injectable()
export class EnrichmentClient {
  private readonly logger = new Logger(EnrichmentClient.name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetchAniList(
    query: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    variables: Record<string, any>,
    retryCount = 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    try {
      const res = await fetch(ANILIST_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 429 && retryCount < 3) {
        const parsed = parseInt(res.headers.get('Retry-After') ?? '60', 10);
        const retryAfter = Number.isFinite(parsed) ? parsed : 60;
        this.logger.warn(
          `AniList rate limited. Retrying in ${retryAfter}s...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, retryAfter * 1000),
        );
        return this.fetchAniList(query, variables, retryCount + 1);
      }

      if (!res.ok) {
        this.logger.warn(
          `AniList HTTP ${res.status} for ${JSON.stringify(variables)}`,
        );
        return null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = (await res.json()) as any;
      return data ?? null;
    } catch (err) {
      this.logger.error(`AniList ${err} for ${JSON.stringify(variables)}`);
      return null;
    }
  }

  async fetchAniListByMalId(malId: number): Promise<AniListMedia | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await this.fetchAniList(BY_MAL_ID_QUERY, { malId });
    return (data?.Media as AniListMedia) ?? null;
  }

  async fetchAniListByTitle(title: string): Promise<AniListMedia | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await this.fetchAniList(BY_TITLE_QUERY, {
      search: title,
    });
    return (data?.Media as AniListMedia) ?? null;
  }

  async fetchKitsuByTitle(title: string): Promise<KitsuAnime | null> {
    try {
      const encoded = encodeURIComponent(title);
      const res = await fetch(
        `${KITSU_BASE}?filter[text]=${encoded}&page[limit]=1`,
        { headers: { Accept: 'application/vnd.api+json' } },
      );
      if (!res.ok) {
        this.logger.warn(`Kitsu title search "${title}" → HTTP ${res.status}`);
        return null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = (await res.json()) as any;
      if (!data || data.length === 0) return null;

      const anime = data[0];
      const attrs = anime.attributes;

      let season: string | null = null;
      let seasonYear: number | null = null;
      if (attrs.startDate) {
        const d = new Date(attrs.startDate);
        seasonYear = d.getFullYear();
        const month = d.getMonth() + 1;
        season =
          month <= 3
            ? 'WINTER'
            : month <= 6
              ? 'SPRING'
              : month <= 9
                ? 'SUMMER'
                : 'FALL';
      }

      return {
        kitsuId: anime.id,
        titleEnglish: attrs.titles?.en || attrs.titles?.en_us || null,
        titleJapanese: attrs.titles?.ja_jp || null,
        season,
        seasonYear,
        posterImage: attrs.posterImage?.large ?? null,
        coverImage: attrs.coverImage?.large ?? null,
      };
    } catch (err) {
      this.logger.error(`Kitsu title search "${title}" → ${err}`);
      return null;
    }
  }
}

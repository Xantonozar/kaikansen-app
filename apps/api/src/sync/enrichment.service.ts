import { Injectable } from '@nestjs/common';
import { EnrichmentClient } from './enrichment.client';
import { SyncTiming } from './sync.constants';
import { deriveMood } from './theme-parser';
import type {
  AnimeEnrichment,
  AtAnime,
  ParsedTheme,
} from './sync.types';

/**
 * Per-run, in-memory cache of anime-level enrichment, keyed by the
 * AnimeThemes anime (id → malId → name). Values are promises so themes
 * processed back-to-back share one in-flight lookup.
 */
export type EnrichmentCache = Map<string, Promise<AnimeEnrichment>>;

/**
 * Theme enrichment, ported from `enrichTheme` in the web's
 * `scripts/seed-utils.ts`: AniList first (by MAL id, then by title),
 * Kitsu as the fallback, and the same merged-document shape (AT fields
 * win, then AniList, then Kitsu).
 *
 * DEVIATION (a) — deliberate, cost-driven: the web's enrichTheme paid
 * the AniList delay (2s) plus up to two AniList calls and a possible
 * Kitsu call PER THEME. Here the anime-level lookups are resolved ONCE
 * PER ANIME per run and cached (see {@link EnrichmentCache}); themes of
 * the same anime share the result, and the polite delays are paid only
 * on a cache miss. Everything derived per theme (notably the mood, which
 * depends on the song title) is still computed per theme.
 */
@Injectable()
export class EnrichmentService {
  constructor(
    private readonly client: EnrichmentClient,
    private readonly timing: SyncTiming,
  ) {}

  /** Fresh cache for one sync run. */
  createCache(): EnrichmentCache {
    return new Map();
  }

  private cacheKey(atAnime: AtAnime): string {
    if (atAnime.id != null) return `id:${atAnime.id}`;
    if (atAnime.malId != null) return `mal:${atAnime.malId}`;
    return `name:${atAnime.name ?? ''}`;
  }

  private resolveAnime(
    atAnime: AtAnime,
    cache: EnrichmentCache,
  ): Promise<AnimeEnrichment> {
    const key = this.cacheKey(atAnime);
    let pending = cache.get(key);
    if (!pending) {
      pending = this.fetchAnimeEnrichment(atAnime);
      cache.set(key, pending);
    }
    return pending;
  }

  /** The web's lookup chain, delays included, for ONE anime. */
  private async fetchAnimeEnrichment(
    atAnime: AtAnime,
  ): Promise<AnimeEnrichment> {
    let anilistData: AnimeEnrichment['anilistData'] = null;
    let kitsuData: AnimeEnrichment['kitsuData'] = null;

    if (atAnime.malId) {
      await this.timing.delay(this.timing.anilistDelayMs);
      anilistData = await this.client.fetchAniListByMalId(atAnime.malId);
    }

    if (!anilistData) {
      await this.timing.delay(this.timing.anilistDelayMs);
      anilistData = await this.client.fetchAniListByTitle(atAnime.name ?? '');
    }

    if (!anilistData) {
      await this.timing.delay(this.timing.kitsuDelayMs);
      kitsuData = await this.client.fetchKitsuByTitle(atAnime.name ?? '');
    }

    return { anilistData, kitsuData };
  }

  /**
   * Merges a parsed theme with its anime's enrichment — the web's
   * enrichTheme body, field for field. Never returns null in practice
   * (the web's version doesn't either; the runner keeps its `?? parsed`
   * fallback for shape parity with runSeedByAnime).
   */
  async enrichTheme(
    themeDoc: ParsedTheme,
    atAnime: AtAnime,
    cache: EnrichmentCache,
  ): Promise<ParsedTheme> {
    const { anilistData, kitsuData } = await this.resolveAnime(
      atAnime,
      cache,
    );

    const animeTitleEnglish =
      anilistData?.title?.english ?? kitsuData?.titleEnglish ?? null;

    const altNames = [
      anilistData?.title?.native,
      anilistData?.title?.romaji,
      ...(anilistData?.synonyms ?? []),
      kitsuData?.titleJapanese,
    ]
      .filter(Boolean)
      .filter((t) => t !== themeDoc.animeTitle) as string[];
    const animeTitleAlternative = [...new Set(altNames)];

    const animeSeason =
      themeDoc.animeSeason ?? anilistData?.season ?? kitsuData?.season ?? null;

    const animeSeasonYear =
      themeDoc.animeSeasonYear ??
      anilistData?.seasonYear ??
      kitsuData?.seasonYear ??
      null;

    const animeCoverImage =
      themeDoc.animeCoverImage ??
      anilistData?.coverImage?.large ??
      kitsuData?.posterImage ??
      null;

    const animeCoverImageSmall =
      themeDoc.animeCoverImageSmall ??
      anilistData?.coverImage?.medium ??
      themeDoc.animeCoverImage ?? // Fallback to AT cover if AniList medium is missing
      null;

    const animeGrillImage =
      themeDoc.animeGrillImage ??
      anilistData?.bannerImage ??
      kitsuData?.coverImage ??
      null;

    const genres = anilistData?.genres ?? [];
    const mood = deriveMood(themeDoc.songTitle, themeDoc.animeTitle, genres);

    const studios = [
      ...themeDoc.animeStudios,
      ...(anilistData?.studios?.nodes?.map((n) => n.name) ?? []),
    ];
    const animeStudios = [...new Set(studios)].filter(Boolean);

    const series = [...themeDoc.animeSeries];
    const animeSeries = [...new Set(series)].filter(Boolean);

    return {
      ...themeDoc,
      anilistId: anilistData?.id ?? null,
      malId: anilistData?.idMal ?? null,
      kitsuId: kitsuData?.kitsuId ?? null,
      animeTitleEnglish,
      animeTitleAlternative,
      titleNative: anilistData?.title?.native ?? null,
      synonyms: anilistData?.synonyms ?? [],
      animeSeason,
      animeSeasonYear,
      animeCoverImage,
      animeCoverImageSmall,
      animeGrillImage,
      coverImageLarge: anilistData?.coverImage?.large ?? null,
      coverImageMedium: anilistData?.coverImage?.medium ?? null,
      bannerImage: anilistData?.bannerImage ?? null,
      genres: anilistData?.genres ?? [],
      studios: animeStudios,
      series: animeSeries,
      animeStudios,
      animeSeries,
      totalEpisodes: anilistData?.episodes ?? null,
      animeStatus: anilistData?.status ?? null,
      averageScore: anilistData?.averageScore ?? null,
      mood,
      _nullAudioCount: undefined,
    };
  }
}

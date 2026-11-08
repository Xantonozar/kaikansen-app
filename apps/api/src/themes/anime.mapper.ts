import type { RelatedAnime, Season } from '@kaikansen/contracts';
import type { AnimeCache } from '../sync/anime-cache.schema';

/**
 * Lean (plain-object) shape of an animecaches document as it comes
 * back from Mongoose `.lean()` — the schema fields plus the
 * bookkeeping fields.
 */
export type AnimeDoc = AnimeCache & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

/**
 * The RelatedAnime projection (GET /anime/:id/related): the
 * document's content fields. The web serves the raw document; this
 * API projects it like every other document it serves — synonyms,
 * AnimeThemes-side images, syncedAt and the timestamps stay
 * server-side.
 */
export function toRelatedAnime(doc: AnimeDoc): RelatedAnime {
  return {
    anilistId: doc.anilistId ?? null,
    malId: doc.malId ?? null,
    kitsuId: doc.kitsuId ?? null,
    titleRomaji: doc.titleRomaji,
    titleEnglish: doc.titleEnglish ?? null,
    titleNative: doc.titleNative ?? null,
    titleAlternative: doc.titleAlternative ?? [],
    season: (doc.season as Season | null) ?? null,
    seasonYear: doc.seasonYear ?? null,
    genres: doc.genres ?? [],
    coverImageLarge: doc.coverImageLarge ?? null,
    coverImageMedium: doc.coverImageMedium ?? null,
    bannerImage: doc.bannerImage ?? null,
    studios: doc.studios ?? [],
    series: doc.series ?? [],
    totalEpisodes: doc.totalEpisodes ?? null,
    status: doc.status ?? null,
    averageScore: doc.averageScore ?? null,
  };
}

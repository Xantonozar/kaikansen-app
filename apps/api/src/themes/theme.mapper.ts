import type {
  Season,
  ThemeDetail,
  ThemeSummary,
  ThemeType,
} from '@kaikansen/contracts';
import type { ThemeCache } from './theme-cache.schema';

/**
 * Lean (plain-object) shape of a themecaches document as it comes back from
 * Mongoose `.lean()` — the schema fields plus the bookkeeping fields.
 */
export type ThemeDoc = ThemeCache & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toThemeSummary(doc: ThemeDoc): ThemeSummary {
  return {
    slug: doc.slug,
    songTitle: doc.songTitle,
    animeTitle: doc.animeTitle,
    animeTitleEnglish: doc.animeTitleEnglish ?? null,
    artistName: doc.artistName ?? null,
    allArtists: doc.allArtists ?? [],
    type: doc.type as ThemeType,
    sequence: doc.sequence,
    animeSeason: (doc.animeSeason as Season | null) ?? null,
    animeSeasonYear: doc.animeSeasonYear ?? null,
    animeCoverImage: doc.animeCoverImage ?? null,
    animeCoverImageSmall: doc.animeCoverImageSmall ?? null,
    avgRating: doc.avgRating ?? 0,
    totalRatings: doc.totalRatings ?? 0,
    totalWatches: doc.totalWatches ?? 0,
    totalListens: doc.totalListens ?? 0,
    isPopular: doc.isPopular ?? false,
    popularRank: doc.popularRank ?? null,
  };
}

/** Full detail projection — `embedding` and `__v` never leave the API. */
export function toThemeDetail(doc: ThemeDoc): ThemeDetail {
  return {
    ...toThemeSummary(doc),
    id: String(doc._id),
    animethemesId: doc.animethemesId,
    anilistId: doc.anilistId ?? null,
    kitsuId: doc.kitsuId ?? null,
    animeTitleAlternative: doc.animeTitleAlternative ?? [],
    animeGrillImage: doc.animeGrillImage ?? null,
    animeStudios: doc.animeStudios ?? [],
    animeSeries: doc.animeSeries ?? [],
    artistSlugs: doc.artistSlugs ?? [],
    artistRoles: doc.artistRoles ?? [],
    entries: (doc.entries ?? []).map((entry) => ({
      atEntryId: entry.atEntryId,
      version: entry.version,
      episodes: entry.episodes ?? null,
      spoiler: entry.spoiler ?? false,
      nsfw: entry.nsfw ?? false,
      tags: entry.tags ?? [],
      videoSources: (entry.videoSources ?? []).map((source) => ({
        resolution: source.resolution,
        url: source.url,
        source: source.source ?? null,
        mime: source.mime ?? 'video/webm',
      })),
      videoUrl: entry.videoUrl ?? null,
      audioUrl: entry.audioUrl ?? null,
      duration: entry.duration ?? null,
    })),
    videoUrl: doc.videoUrl,
    audioUrl: doc.audioUrl ?? null,
    mood: doc.mood ?? [],
    duration: doc.duration ?? null,
    syncedAt: iso(doc.syncedAt) ?? '',
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

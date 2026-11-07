/**
 * Payload + document shapes for the theme sync engine, mirroring the
 * loosely-typed objects the web's seed scripts pass around
 * (ZadidSalman/Kaisen `scripts/seed-utils.ts` / `scripts/seed-shared.ts`).
 */

/* ── AnimeThemes API payloads ─────────────────────────────────────── */

export interface AtVideo {
  resolution: number;
  link: string;
  nc?: boolean;
  bd?: boolean;
  source?: string | null;
  tags?: string[];
}

export interface AtEntry {
  id: number;
  episodes?: string | null;
  spoiler?: boolean;
  nsfw?: boolean;
  version?: number | null;
  videos?: AtVideo[];
}

export interface AtArtist {
  id?: number;
  name?: string;
  slug?: string;
  as?: string;
  aliases?: string[];
  images?: { link: string }[];
}

export interface AtAnime {
  id?: number;
  slug?: string;
  name?: string;
  season?: string | null;
  year?: number | null;
  malId?: number | null;
  images?: { facet: string; link: string }[];
  studios?: { name: string }[];
  series?: { name: string }[];
  animethemes?: AtTheme[];
}

export interface AtTheme {
  id: number;
  type: 'OP' | 'ED';
  sequence?: number | null;
  song?: { title?: string; artists?: AtArtist[] };
  animethemeentries?: AtEntry[];
  anime?: AtAnime;
}

/* ── Enrichment payloads ──────────────────────────────────────────── */

export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
  };
  synonyms?: string[];
  season?: string | null;
  seasonYear?: number | null;
  genres?: string[];
  episodes?: number | null;
  status?: string | null;
  averageScore?: number | null;
  coverImage?: { large?: string | null; medium?: string | null } | null;
  bannerImage?: string | null;
  studios?: { nodes: { name: string }[] };
}

/** Shape returned by the Kitsu fallback in seed-utils.ts. */
export interface KitsuAnime {
  kitsuId: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  season: string | null;
  seasonYear: number | null;
  posterImage: string | null;
  coverImage: string | null;
}

/** The anime-level enrichment both AniList and Kitsu contribute to. */
export interface AnimeEnrichment {
  anilistData: AniListMedia | null;
  kitsuData: KitsuAnime | null;
}

/* ── Theme documents ──────────────────────────────────────────────── */

export interface ParsedThemeEntry {
  atEntryId: number;
  version: string;
  episodes: string | null;
  spoiler: boolean;
  nsfw: boolean;
  tags: string[];
  videoSources: {
    resolution: number;
    url: string;
    source: string | null;
    mime: string;
  }[];
  videoUrl: string | null;
  audioUrl: string | null;
}

/**
 * A parsed (and, after enrichment, enriched) theme document — the object
 * the web engine passes to `ThemeCache.findOneAndUpdate({ $set: doc })`.
 * Extra enrichment-only fields (malId, genres, coverImageLarge, …) ride
 * along exactly as in the web's object; the ThemeCache schema does not
 * declare them, and the AnimeCache write reads them from this object.
 */
export interface ParsedTheme {
  slug: string;
  animethemesId: number;
  songTitle: string;
  artistName: string | null;
  allArtists: string[];
  artistSlugs: string[];
  artistRoles: string[];
  animeTitle: string;
  animeTitleEnglish: string | null;
  animeTitleAlternative: string[];
  animeSeason: string | null;
  animeSeasonYear: number | null;
  animeCoverImage: string | null;
  animeCoverImageSmall: string | null;
  animeGrillImage: string | null;
  animeStudios: string[];
  animeSeries: string[];
  type: 'OP' | 'ED';
  sequence: number;
  entries: ParsedThemeEntry[];
  videoUrl: string | null;
  audioUrl: string | null;
  mood: string[];
  embedding: null;
  anilistId: number | null;
  kitsuId: string | null;
  syncedAt: Date;
  /* Enrichment additions (present after enrichTheme): */
  malId?: number | null;
  titleNative?: string | null;
  synonyms?: string[];
  genres?: string[];
  coverImageLarge?: string | null;
  coverImageMedium?: string | null;
  bannerImage?: string | null;
  studios?: string[];
  series?: string[];
  totalEpisodes?: number | null;
  animeStatus?: string | null;
  averageScore?: number | null;
  /** Parse-time bookkeeping, stripped before the write (as on the web). */
  _nullAudioCount?: number;
}

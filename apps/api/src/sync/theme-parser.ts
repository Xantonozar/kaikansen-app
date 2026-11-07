import type { AtTheme, ParsedTheme } from './sync.types';

/**
 * Pure parsing functions ported from the web's `scripts/seed-utils.ts`
 * (`deriveMood`, `buildVersionLabel`, `parseATTheme`). No I/O, no Nest —
 * the only behavioural difference from the source is that the web's
 * file/console logging is dropped; the job runner counts the same
 * outcomes (skipped themes, null-audio entries) from the return values.
 */

export function deriveMood(
  songTitle: string,
  animeTitle: string,
  genres: string[],
): string[] {
  const moods: string[] = [];
  const combined = [songTitle, animeTitle, ...genres].join(' ').toLowerCase();

  const moodMap: Record<string, string[]> = {
    sad: ['sad', 'grief', 'loss', 'cry', 'tear', 'sorrow', 'melancholy'],
    emotional: ['emotional', 'feel', 'heart', 'soul', 'memory', 'memories', 'never'],
    epic: ['epic', 'battle', 'fight', 'war', 'hero', 'warrior', 'legend', 'rise'],
    calm: ['calm', 'peace', 'gentle', 'soft', 'quiet', 'still', 'breeze'],
    hype: ['hype', 'fast', 'rush', 'fire', 'burn', 'explosion', 'racing'],
    dark: ['dark', 'death', 'despair', 'demon', 'devil', 'shadow', 'curse'],
    upbeat: ['happy', 'joy', 'smile', 'bright', 'fun', 'cheer', 'bounce'],
    nostalgic: ['past', 'remember', 'childhood', 'youth', 'old', 'yesterday', 'again'],
    romantic: ['love', 'kiss', 'heart', 'together', 'forever', 'your name', 'promise'],
    mysterious: ['mystery', 'unknown', 'secret', 'hidden', 'void', 'abyss'],
  };

  for (const [mood, keywords] of Object.entries(moodMap)) {
    if (keywords.some((kw) => combined.includes(kw))) {
      moods.push(mood);
    }
  }

  if (genres.includes('Romance')) moods.push('romantic');
  if (genres.includes('Horror')) moods.push('dark');
  if (genres.includes('Slice of Life')) moods.push('calm');
  if (genres.includes('Action')) moods.push('epic');
  if (genres.includes('Comedy')) moods.push('upbeat');
  if (genres.includes('Drama')) moods.push('emotional');
  if (genres.includes('Mystery')) moods.push('mysterious');

  return [...new Set(moods)];
}

export function buildVersionLabel(tags: string[]): string {
  if (!tags || tags.length === 0) return 'Standard';
  return tags.map((t) => t.toUpperCase()).join('+');
}

/**
 * Parses one AnimeThemes theme payload into a theme document, or null
 * when the theme is unusable (no anime, no entries, or no entry with a
 * playable video). Rules ported one-to-one:
 *
 * - entries' videos are sorted by resolution DESCENDING (in place, as
 *   the web does); an entry's videoUrl is the highest-resolution link
 *   and its audioUrl the LOWEST-resolution video's link;
 * - entry tags come from the first (highest-res) video: NC, BD (flag or
 *   source === 'BD'), Lyrics, Piano, plus `V<n>` when entry.version > 1;
 *   the version label is the tags uppercased and joined with '+', or
 *   'Standard' when tagless;
 * - the theme's own videoUrl/audioUrl come from the first tagless entry
 *   (the "standard" one), else the first usable entry;
 * - slug is `${anime.slug}-${type.toLowerCase()}${sequence ?? 1}-${atTheme.id}`;
 * - season/year are AnimeThemes' own fields (uppercased season); the
 *   AniList/Kitsu fallback chain runs later, in EnrichmentService;
 * - `_nullAudioCount` reports entries without videos, for the runner's
 *   bookkeeping — enrichment strips it before the write, as on the web.
 */
export function parseATTheme(
  atTheme: AtTheme,
  genres: string[] = [],
): ParsedTheme | null {
  try {
    const anime = atTheme.anime;
    if (!anime) return null;

    const entries = atTheme.animethemeentries ?? [];
    if (entries.length === 0) {
      return null;
    }

    const parsedEntries: ParsedTheme['entries'] = [];
    let nullAudioCount = 0;

    for (const entry of entries) {
      const videos = (entry.videos ?? []).sort(
        (a, b) => b.resolution - a.resolution,
      );

      if (videos.length === 0) {
        nullAudioCount++;
      }

      const tags: string[] = [];
      if (videos[0]?.nc) tags.push('NC');
      if (videos[0]?.bd || videos[0]?.source === 'BD') tags.push('BD');
      if (videos[0]?.tags?.includes('Lyrics')) tags.push('Lyrics');
      if (videos[0]?.tags?.includes('Piano')) tags.push('Piano');
      if (
        entry.version &&
        typeof entry.version === 'number' &&
        entry.version > 1
      ) {
        tags.push(`V${entry.version}`);
      }

      const videoSources = videos.map((v) => ({
        resolution: v.resolution,
        url: v.link,
        source: v.source ?? null,
        mime: 'video/webm',
      }));

      parsedEntries.push({
        atEntryId: entry.id,
        version: buildVersionLabel(tags),
        episodes: entry.episodes ?? null,
        spoiler: entry.spoiler ?? false,
        nsfw: entry.nsfw ?? false,
        tags,
        videoSources,
        videoUrl: videos[0]?.link ?? null,
        audioUrl: videos.length > 0 ? videos[videos.length - 1].link : null,
      });
    }

    const validEntries = parsedEntries.filter((e) => e.videoUrl !== null);
    if (validEntries.length === 0) {
      return null;
    }

    const standardEntry =
      validEntries.find((e) => e.tags.length === 0) ?? validEntries[0];

    const artists = atTheme.song?.artists ?? [];
    const allArtists = artists.map((a) => a.name).filter(Boolean) as string[];
    const artistSlugs = artists.map((a) => a.slug).filter(Boolean) as string[];
    const artistRoles = artists.map((a) => a.as ?? 'performer');

    const images = anime.images ?? [];
    const atCoverImage =
      images.find((i) => i.facet === 'Large Cover')?.link ??
      images.find((i) => i.facet === 'Cover')?.link ??
      null;
    const atGrillImage =
      images.find((i) => i.facet === 'Grill')?.link ?? null;
    const atSmallCover =
      images.find((i) => i.facet === 'Small Cover')?.link ?? null;

    const atStudios = (anime.studios ?? [])
      .map((s) => s.name)
      .filter(Boolean) as string[];
    const atSeries = (anime.series ?? [])
      .map((s) => s.name)
      .filter(Boolean) as string[];

    const slug = `${anime.slug}-${atTheme.type.toLowerCase()}${atTheme.sequence ?? 1}-${atTheme.id}`;

    const mood = deriveMood(atTheme.song?.title ?? '', anime.name ?? '', genres);

    return {
      slug,
      animethemesId: atTheme.id,
      songTitle: atTheme.song?.title ?? 'Unknown',
      artistName: allArtists[0] ?? null,
      allArtists,
      artistSlugs,
      artistRoles,
      animeTitle: anime.name as string,
      animeTitleEnglish: null,
      animeTitleAlternative: [],
      animeSeason: anime.season?.toUpperCase() ?? null,
      animeSeasonYear: anime.year ?? null,
      animeCoverImage: atCoverImage,
      animeCoverImageSmall: atSmallCover,
      animeGrillImage: atGrillImage,
      animeStudios: atStudios,
      animeSeries: atSeries,
      type: atTheme.type,
      sequence: atTheme.sequence ?? 1,
      entries: validEntries,
      videoUrl: standardEntry.videoUrl,
      audioUrl: standardEntry.audioUrl,
      mood,
      embedding: null,
      anilistId: null,
      kitsuId: null,
      syncedAt: new Date(),
      _nullAudioCount: nullAudioCount,
    };
  } catch {
    return null;
  }
}

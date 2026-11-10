/**
 * Field projections for catalogue reads whose consumers map whole
 * theme documents down to summaries (perf problem 10 — the B3
 * finding: list reads were fetching full theme documents,
 * entries[] + embedding included, to serve ~20 summary fields).
 *
 * The rule for every list here: exactly the fields the mapper (or
 * the read's own logic) reads, plus `_id` (Mongoose includes it by
 * default in an inclusion projection). A field the mapper reads
 * that is ABSENT from a stored document still projects as absent,
 * and the mapper's `?? default` fallbacks apply unchanged — a
 * projection narrows the wire, never the semantics.
 */

/**
 * toThemeSummary's field set (theme.mapper.ts) — the projection
 * for every read that serves ThemeSummary rows: /home's rails,
 * the /season page, both detail pages' theme lists, similar
 * themes, the social feeds' theme joins, library history and
 * playlist theme resolution.
 */
export const THEME_SUMMARY_PROJECTION = [
  'slug',
  'songTitle',
  'animeTitle',
  'animeTitleEnglish',
  'artistName',
  'allArtists',
  'type',
  'sequence',
  'animeSeason',
  'animeSeasonYear',
  'animeCoverImage',
  'animeCoverImageSmall',
  'avgRating',
  'totalRatings',
  'totalWatches',
  'totalListens',
  'duration',
  'isPopular',
  'popularRank',
  'anilistId',
].join(' ');

/**
 * getFriendsActivity's theme join reads only these (its item
 * mapper: title, slug fallback + artist / anime / cover pair) —
 * narrower than a full summary because the feed never serves one.
 */
export const THEME_FEED_PROJECTION = [
  'songTitle',
  'slug',
  'artistName',
  'animeTitle',
  'animeCoverImage',
  'animeCoverImageSmall',
].join(' ');

/**
 * getRelatedAnime's mapper (anime.mapper.ts toRelatedAnime) reads
 * exactly these AnimeCache fields.
 */
export const ANIME_RELATED_PROJECTION = [
  'anilistId',
  'malId',
  'kitsuId',
  'titleRomaji',
  'titleEnglish',
  'titleNative',
  'titleAlternative',
  'season',
  'seasonYear',
  'genres',
  'coverImageLarge',
  'coverImageMedium',
  'bannerImage',
  'studios',
  'series',
  'totalEpisodes',
  'status',
  'averageScore',
].join(' ');

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type {
  AnimeDetailResponse,
  ArtistDetailResponse,
  HomeResponse,
  NetworkUser,
  RelatedAnime,
  RelatedAnimeResponse,
  SearchAnimeResult,
  SearchArtistResult,
  SearchResponse,
  Season,
  SeasonResponse,
  SimilarThemesResponse,
  ThemeDetail,
  ThemeType,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import {
  AnimeCache,
  type AnimeCacheDocument,
} from '../sync/anime-cache.schema';
import {
  ArtistCache,
  type ArtistCacheDocument,
} from '../sync/artist-cache.schema';
import { ThemeCache, type ThemeCacheDocument } from './theme-cache.schema';
import { currentSeason, previousSeason, SEASON_ORDER } from './season';
import { toRelatedAnime, type AnimeDoc } from './anime.mapper';
import { toThemeDetail, toThemeSummary, type ThemeDoc } from './theme.mapper';

const RAIL_LIMIT = 20;
/** The web seasonal endpoint's page size (app/api/themes/seasonal). */
const SEASON_PAGE_SIZE = 20;
/**
 * The /home popular rail serves the full curated list: 50 entries
 * since the 2026-11-08 rebuild (30 OP + 20 ED), so its cap is
 * separate from the season rail's 20.
 */
const POPULAR_LIMIT = 50;
/**
 * How far back the /home season rail may walk when the current season
 * has no themes yet (owner's order, 2026-11-08): two full years of
 * seasons. Beyond that the rail honestly stays empty.
 */
const SEASON_FALLBACK_STEPS = 8;
/* Search constants — the web's own values (app/api/search/route.ts). */
const SEARCH_PAGE_SIZE = 20; // per-type limit of the web's SONGS view
const SEARCH_GROUP_LIMIT = 5; // per-group limit of the web's ALL view
const SEARCH_MODIFIER_LIMIT = 50; // songs limit when an OP/ED modifier is used
const SONG_CANDIDATE_LIMIT = 400; // stage-1 candidate cap
const MAX_TERMS = 6;
const MAX_TERM_LENGTH = 32;

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Query normalisation, ported from the web's normalizeWords. */
function normalizeWords(query: string): string[] {
  return query
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 0)
    .slice(0, MAX_TERMS)
    .map((w) => w.slice(0, MAX_TERM_LENGTH));
}

/**
 * Parses OP/ED type and optional sequence number out of the raw query
 * tokens. Handles: "op", "ed", "op9", "ed12", "op 9", "ed 3". Returns the
 * cleaned word list (without op/ed tokens) plus the extracted filters.
 * Ported from the web's parseThemeModifiers.
 */
function parseThemeModifiers(words: string[]): {
  cleanWords: string[];
  themeTypeFilter: 'OP' | 'ED' | null;
  themeSeqFilter: number | null;
} {
  let themeTypeFilter: 'OP' | 'ED' | null = null;
  let themeSeqFilter: number | null = null;
  const cleanWords: string[] = [];

  let i = 0;
  while (i < words.length) {
    const w = words[i].toLowerCase();
    // Token like "op9" or "ed12" or bare "op"/"ed"
    const inlineMatch = w.match(/^(op|ed)(\d+)?$/);
    if (inlineMatch) {
      themeTypeFilter = inlineMatch[1].toUpperCase() as 'OP' | 'ED';
      if (inlineMatch[2]) {
        // Sequence embedded: "op9" → sequence 9
        themeSeqFilter = parseInt(inlineMatch[2], 10);
      } else if (i + 1 < words.length && /^\d+$/.test(words[i + 1])) {
        // Next token is a bare number: "op 9" → sequence 9
        themeSeqFilter = parseInt(words[i + 1], 10);
        i++; // consume the number token
      }
    } else {
      cleanWords.push(words[i]);
    }
    i++;
  }

  return { cleanWords, themeTypeFilter, themeSeqFilter };
}

/**
 * Read path over the shared themecaches collection (Slice 1).
 *
 * The model is OPTIONAL: when the API is booted without MONGODB_URI the
 * themes module registers no Mongoose model, this service is constructed
 * with `undefined`, and every endpoint answers 503 — while /health and the
 * rest of the app keep working. All queries are reads; nothing here writes.
 */
/** A `users` row as the search users group reads it (lean). */
type SearchUserDoc = User & { _id: Types.ObjectId };

@Injectable()
export class ThemesService {
  constructor(
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(AnimeCache.name)
    private readonly animeModel?: Model<AnimeCacheDocument>,
    @Optional()
    @InjectModel(ArtistCache.name)
    private readonly artistModel?: Model<ArtistCacheDocument>,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
  ) {}

  private requireModel(): Model<ThemeCacheDocument> {
    if (!this.themeModel) {
      throw new ServiceUnavailableException(
        'Theme data unavailable — API booted without MONGODB_URI',
      );
    }
    return this.themeModel;
  }

  private requireAnimeModel(): Model<AnimeCacheDocument> {
    if (!this.animeModel) {
      throw new ServiceUnavailableException(
        'Anime data unavailable — API booted without MONGODB_URI',
      );
    }
    return this.animeModel;
  }

  private requireArtistModel(): Model<ArtistCacheDocument> {
    if (!this.artistModel) {
      throw new ServiceUnavailableException(
        'Artist data unavailable — API booted without MONGODB_URI',
      );
    }
    return this.artistModel;
  }

  /**
   * GET /home — current-season rail + the popular ("hall of fame") list.
   *
   * Season fallback (owner's order, 2026-11-08): when the catalogue
   * holds no themes for the current season yet (the real DB had no
   * FALL 2026 data while SUMMER 2026 was fully synced), an empty rail
   * is a dead home page. So on an empty current season the rail walks
   * BACK season by season to the first season that has themes, and
   * the response's `season` names the season actually served — the
   * label always tells the truth, summer data is never dressed up as
   * fall. When the current season has data, behaviour is exactly the
   * pre-fallback one (a single query). If no season within
   * SEASON_FALLBACK_STEPS back has anything, the rail stays empty
   * under the current season's label, as before.
   */
  async getHome(now: Date = new Date()): Promise<HomeResponse> {
    const model = this.requireModel();
    const current = currentSeason(now);

    const fetchRail = (s: typeof current.season, y: number) =>
      model
        .find({ animeSeason: s, animeSeasonYear: y })
        .sort({ totalWatches: -1 })
        .limit(RAIL_LIMIT)
        .lean()
        .exec();

    const [firstRail, popularDocs] = await Promise.all([
      fetchRail(current.season, current.year),
      model
        .find({ isPopular: true })
        .sort({ popularRank: 1 })
        .limit(POPULAR_LIMIT)
        .lean()
        .exec(),
    ]);

    // The served season only advances to a walked-back season when
    // that season actually has themes; an all-empty walk leaves the
    // label on the current season (the pre-fallback behaviour).
    let served = current;
    let cursor = current;
    let railDocs = firstRail as ThemeDoc[];
    for (
      let step = 0;
      railDocs.length === 0 && step < SEASON_FALLBACK_STEPS;
      step++
    ) {
      cursor = previousSeason(cursor);
      railDocs = (await fetchRail(cursor.season, cursor.year)) as ThemeDoc[];
      if (railDocs.length > 0) served = cursor;
    }

    return {
      season: served,
      seasonRail: railDocs.map(toThemeSummary),
      popular: (popularDocs as ThemeDoc[]).map(toThemeSummary),
    };
  }

  /**
   * GET /season — one season's themes, the port of the web's
   * GET /api/themes/seasonal (app/api/themes/seasonal/route.ts),
   * the read behind the web's /season/[season]/[year] page. The
   * web's semantics, mirrored: season and year are required (400
   * without them — the web's 'Season and year required'), the
   * filter is animeSeason/animeSeasonYear plus an optional OP/ED
   * type, the order is sequence asc then avgRating desc, and the
   * page size is the web's 20 with hasMore = a full page served.
   * Season names are validated against the Season enum (the
   * schema's own vocabulary); an unknown name is the same 400 the
   * web's missing-parameter case produces in spirit — the web
   * would serve an empty list for it, but an API client passing a
   * non-season has a bug worth surfacing, and no real season's
   * answer changes. Pages below 1 clamp to 1 (the web's parseInt
   * would produce a negative skip and a Mongo error; the clamp is
   * the one deliberate deviation, noted here).
   */
  async getSeasonThemes(
    seasonRaw: string | undefined,
    yearRaw: string | undefined,
    typeRaw?: string,
    pageRaw?: string,
  ): Promise<SeasonResponse> {
    const model = this.requireModel();
    const season = (seasonRaw ?? '').toUpperCase() as Season;
    const year = Number.parseInt(yearRaw ?? '', 10);
    if (
      !SEASON_ORDER.includes(season) ||
      Number.isNaN(year) ||
      year < 1900 ||
      year > 2200
    ) {
      throw new BadRequestException('Season and year required');
    }
    const type = (typeRaw ?? '').toUpperCase();
    const filter: Record<string, unknown> = {
      animeSeason: season,
      animeSeasonYear: year,
    };
    if (type === 'OP' || type === 'ED') {
      filter.type = type as ThemeType;
    }
    const parsedPage = Number.parseInt(pageRaw ?? '', 10);
    const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const docs = (await model
      .find(filter)
      .sort({ sequence: 1, avgRating: -1 })
      .skip((page - 1) * SEASON_PAGE_SIZE)
      .limit(SEASON_PAGE_SIZE)
      .lean()
      .exec()) as ThemeDoc[];
    // The season's real size across all pages (the web serves no
    // count; the app's "N themes this season" line needs the true
    // total, not the loaded page's length).
    const total = (await model.countDocuments(filter).exec()) as number;
    return {
      season,
      year,
      themes: docs.map(toThemeSummary),
      page,
      hasMore: docs.length === SEASON_PAGE_SIZE,
      total,
    };
  }

  /** GET /themes/:slug — full document minus embedding/__v, or 404. */
  async getThemeBySlug(slug: string): Promise<ThemeDetail> {
    const model = this.requireModel();
    const doc = await model
      .findOne({ slug })
      .select('-embedding -__v')
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException(`Theme not found: ${slug}`);
    }
    return toThemeDetail(doc as ThemeDoc);
  }

  /**
   * GET /search — theme search with the web's own semantics (AUDIT.md §6;
   * ZadidSalman/Kaisen `app/api/search/route.ts`). The web's search is
   * regex end to end — it self-labels `searchType: 'regex'` and issues no
   * `$text` query anywhere. (The collection does carry a `theme_full_search`
   * TEXT index, but the web code never uses it, and neither does this port.)
   *
   * Two stages, mirroring the web's songs search:
   *
   * Stage 1 — candidate narrowing: unless an OP/ED modifier was parsed out
   * of the query, prefix-match the first clean word (`^word`,
   * case-insensitive) over animeTitle/songTitle/artistName and collect up
   * to 400 candidate ids.
   *
   * Stage 2 — full regex over the candidates: every clean word must appear
   * (escaped, case-insensitive substring) in at least one of
   * animeTitle/songTitle/artistName — `$and` across words, `$or` across
   * fields — restricted to the stage-1 ids when stage 1 produced any.
   * Results sort by totalWatches desc, then avgRating desc.
   *
   * Tokens like "op", "ed12" or "op 9" are not search words: they parse
   * into type/sequence filters (and widen the page size to 50, as on the
   * web). Pagination mirrors the web's SONGS view: 20 per page, and the
   * total is counted on every search (the web counts it for that view).
   *
   * Alongside the songs, page 1 carries the web's ALL-view anime and
   * artist groups plus the users group (see searchGroups) — the
   * grouped results the app's search screen renders under the
   * Themes list.
   */
  async search(rawQuery: string, page = 1): Promise<SearchResponse> {
    const model = this.requireModel();
    const query = rawQuery.trim();
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    if (query.length === 0) {
      return {
        query,
        results: [],
        anime: [],
        artists: [],
        users: [],
        searchType: 'regex',
        page: safePage,
        total: 0,
        hasMore: false,
        themeTypeFilter: null,
        themeSeqFilter: null,
      };
    }

    const words = normalizeWords(query);
    const { cleanWords, themeTypeFilter, themeSeqFilter } =
      parseThemeModifiers(words);
    const themeModifierUsed = themeTypeFilter !== null;

    const contains = (word: string) => new RegExp(escapeRegExp(word), 'i');
    const wordConditions = cleanWords.map((word) => ({
      $or: [
        { animeTitle: contains(word) },
        { songTitle: contains(word) },
        { artistName: contains(word) },
      ],
    }));
    // The filter is assembled dynamically, exactly as on the web.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let themeFilter: any =
      wordConditions.length === 1
        ? wordConditions[0]
        : wordConditions.length > 1
          ? { $and: wordConditions }
          : {};
    if (themeTypeFilter) themeFilter.type = themeTypeFilter;
    if (themeSeqFilter !== null) themeFilter.sequence = themeSeqFilter;

    // — Stage 1: prefix narrowing to candidate ids —
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let effectiveFilter: any = themeFilter;
    if (!themeModifierUsed && cleanWords.length > 0) {
      const prefix = new RegExp(`^${escapeRegExp(cleanWords[0])}`, 'i');
      const candidates = (await model
        .find({
          $or: [
            { animeTitle: prefix },
            { songTitle: prefix },
            { artistName: prefix },
          ],
        })
        .select('_id')
        .limit(SONG_CANDIDATE_LIMIT)
        .lean()
        .exec()) as Array<{ _id: unknown }>;
      if (candidates.length > 0) {
        effectiveFilter = {
          $and: [
            { _id: { $in: candidates.map((c) => c._id) } },
            themeFilter,
          ],
        };
      }
    }

    // — Stage 2: full regex over the (possibly narrowed) filter —
    const limit = themeModifierUsed ? SEARCH_MODIFIER_LIMIT : SEARCH_PAGE_SIZE;
    const skip = (safePage - 1) * limit;
    const [docs, total] = await Promise.all([
      model
        .find(effectiveFilter)
        // Bug 6 (multi-user matrix 2026-11-09): the web's two-key
        // sort leaves hundreds of rows tied at 0 watches / 0
        // rating, and MongoDB's order among ties is unspecified —
        // skip/limit pages overlapped (page 2 repeated 10–12 of
        // page 1's 20). `_id: 1` is a unique final tiebreaker, so
        // pages partition cleanly; the primary ordering is
        // unchanged. (The web has the same flaw; this is the one
        // deliberate deviation, in the direction of correctness.)
        .sort({ totalWatches: -1, avgRating: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      model.countDocuments(effectiveFilter).exec(),
    ]);

    const results = (docs as ThemeDoc[]).map(toThemeSummary);
    // The anime/artist/user groups are the web's ALL view: page 1 only.
    const groups =
      safePage === 1
        ? await this.searchGroups(cleanWords, themeModifierUsed)
        : { anime: [], artists: [], users: [] };
    return {
      query,
      results,
      anime: groups.anime,
      artists: groups.artists,
      users: groups.users,
      searchType: 'regex',
      page: safePage,
      total,
      hasMore: skip + results.length < total,
      themeTypeFilter,
      themeSeqFilter,
    };
  }

  /**
   * The anime + artist + user groups of GET /search — the web's
   * ALL-view filters (app/api/search/route.ts): every clean word
   * must appear (escaped, case-insensitive substring) in at least
   * one of the group's fields — anime: titleRomaji / titleEnglish /
   * synonyms; artists: name / aliases; users: username /
   * displayName (public accounts only, the people search's own
   * filter — see searchUserGroup) — capped at the web's ALL-view 5
   * per group, in the collection's natural order (the web sorts
   * none of the groups). The web skips the groups when an OP/ED
   * modifier was parsed out of the query, and so does this port.
   *
   * Theme counts come from the theme collection itself (one light
   * projection find per group, counted in memory — the groups cap
   * at 5 and a catalogue anime/artist carries at most dozens of
   * themes): an anime row's count is exactly what its detail page
   * lists, and an artist's total is max(cache counter, counted) —
   * the cache counter drifts (see getArtistDetail), so a search row
   * never reports fewer themes than the artist page would.
   *
   * A model the service was constructed without simply yields an
   * empty group — the themes slice never depends on them.
   */
  private async searchGroups(
    cleanWords: string[],
    themeModifierUsed: boolean,
  ): Promise<{
    anime: SearchAnimeResult[];
    artists: SearchArtistResult[];
    users: NetworkUser[];
  }> {
    if (themeModifierUsed || cleanWords.length === 0) {
      return { anime: [], artists: [], users: [] };
    }
    const contains = (word: string) => new RegExp(escapeRegExp(word), 'i');
    // The filters are assembled dynamically, exactly as on the web.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groupFilter = (fields: string[]): any => {
      const conditions = cleanWords.map((word) => ({
        $or: fields.map((field) => ({ [field]: contains(word) })),
      }));
      return conditions.length === 1 ? conditions[0] : { $and: conditions };
    };

    const [anime, artists, users] = await Promise.all([
      this.searchAnimeGroup(
        groupFilter(['titleRomaji', 'titleEnglish', 'synonyms']),
      ),
      this.searchArtistGroup(groupFilter(['name', 'aliases'])),
      this.searchUserGroup(cleanWords),
    ]);
    return { anime, artists, users };
  }

  private async searchAnimeGroup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: any,
  ): Promise<SearchAnimeResult[]> {
    if (!this.animeModel) return [];
    const docs = (await this.animeModel
      .find(filter)
      .limit(SEARCH_GROUP_LIMIT)
      .lean()
      .exec()) as unknown as AnimeDoc[];
    // Rows navigate by AniList id — a document without one cannot
    // be opened, so it is not a result.
    const openable = docs.filter((d) => d.anilistId !== null);
    if (openable.length === 0) return [];

    const counts = new Map<number, number>();
    const themeModel = this.requireModel();
    const themeDocs = (await themeModel
      .find({ anilistId: { $in: openable.map((d) => d.anilistId) } })
      .select('anilistId')
      .lean()
      .exec()) as unknown as Array<{ anilistId: number | null }>;
    for (const t of themeDocs) {
      if (t.anilistId !== null) {
        counts.set(t.anilistId, (counts.get(t.anilistId) ?? 0) + 1);
      }
    }

    return openable.map((d) => ({
      anilistId: d.anilistId as number,
      titleRomaji: d.titleRomaji,
      titleEnglish: d.titleEnglish ?? null,
      coverImageLarge: d.coverImageLarge ?? null,
      seasonYear: d.seasonYear ?? null,
      themeCount: counts.get(d.anilistId as number) ?? 0,
    }));
  }

  private async searchArtistGroup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: any,
  ): Promise<SearchArtistResult[]> {
    if (!this.artistModel) return [];
    const docs = (await this.artistModel
      .find(filter)
      .limit(SEARCH_GROUP_LIMIT)
      .lean()
      .exec()) as unknown as ArtistCacheDocument[];
    if (docs.length === 0) return [];

    const counts = new Map<string, number>();
    const themeModel = this.requireModel();
    const themeDocs = (await themeModel
      .find({ artistSlugs: { $in: docs.map((d) => d.slug) } })
      .select('artistSlugs')
      .lean()
      .exec()) as unknown as Array<{ artistSlugs?: string[] }>;
    for (const t of themeDocs) {
      for (const slug of t.artistSlugs ?? []) {
        counts.set(slug, (counts.get(slug) ?? 0) + 1);
      }
    }

    return docs.map((d) => ({
      slug: d.slug,
      name: d.name,
      imageUrl: d.imageUrl ?? null,
      totalThemes: Math.max(d.totalThemes ?? 0, counts.get(d.slug) ?? 0),
    }));
  }

  /**
   * The users group of GET /search (owner order 2026-11-10: the
   * app's search shows users as a result group, as the web's own
   * search does). The matching is the people search's own
   * (SocialService.searchUsers, the USERS branch of the web's
   * /api/search): public accounts only (isPublic), every clean
   * word a case-insensitive substring of the username or the
   * display name. Two group-level differences from the dedicated
   * endpoint, both following the other ALL-view groups: the cap
   * is the groups' 5 (not the endpoint's 20-per-page), and there
   * is no 2-character minimum — /search answers one-character
   * queries for every other group, so the group simply matches
   * what it matches. The projection is the people search's
   * NetworkUser, field for field — public profile fields only;
   * the stored email, password hash and AniList token never
   * leave the document. Natural order, like the other groups.
   */
  private async searchUserGroup(
    cleanWords: string[],
  ): Promise<NetworkUser[]> {
    if (!this.userModel) return [];
    const contains = (word: string) => new RegExp(escapeRegExp(word), 'i');
    const conditions = cleanWords.map((word) => ({
      $or: [{ username: contains(word) }, { displayName: contains(word) }],
    }));
    // The filter is assembled dynamically, exactly as on the web.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: any = {
      isPublic: true,
      ...(conditions.length === 1
        ? conditions[0]
        : { $and: conditions }),
    };
    const docs = (await this.userModel
      .find(filter)
      .limit(SEARCH_GROUP_LIMIT)
      .lean()
      .exec()) as unknown as SearchUserDoc[];
    return docs.map((d) => this.toSearchUser(d));
  }

  /** The people search's projection (SocialService.toNetworkUser). */
  private toSearchUser(doc: SearchUserDoc): NetworkUser {
    return {
      id: String(doc._id),
      username: doc.username,
      displayName: doc.displayName,
      avatarUrl: doc.avatarUrl ?? null,
      bio: doc.bio ?? '',
    };
  }

  /**
   * GET /themes/:slug/similar — the web's similar-themes read
   * (`app/api/themes/[slug]/similar/route.ts`), query for query:
   * themes (excluding the theme itself) that share its anime title,
   * its artist name, any of its moods, or any tag of its FIRST
   * entry — sorted totalRatings desc / avgRating desc, capped at
   * 20. Unknown slug 404s with this API's message (the web's 404
   * body says just 'Theme not found').
   *
   * Mirrored quirks: the web passes `theme.artistName` into the
   * $or unguarded, so a theme with a null artist matches the other
   * null-artist themes; an empty mood list / tag list simply
   * matches nothing on that clause. The web serves the raw
   * documents; this API projects ThemeSummary, as everywhere here.
   */
  async getSimilarThemes(slug: string): Promise<SimilarThemesResponse> {
    const model = this.requireModel();
    const theme = (await model
      .findOne({ slug })
      .lean()
      .exec()) as ThemeDoc | null;
    if (!theme) {
      throw new NotFoundException(`Theme not found: ${slug}`);
    }

    const docs = await model
      .find({
        $and: [
          { slug: { $ne: slug } },
          {
            $or: [
              { animeTitle: theme.animeTitle },
              { artistName: theme.artistName },
              { mood: { $in: theme.mood ?? [] } },
              {
                entries: {
                  $elemMatch: { tags: { $in: theme.entries?.[0]?.tags ?? [] } },
                },
              },
            ],
          },
        ],
      })
      .sort({ totalRatings: -1, avgRating: -1 })
      .limit(20)
      .lean()
      .exec();

    return { themes: (docs as ThemeDoc[]).map(toThemeSummary) };
  }

  /**
   * GET /anime/:id/related — the web's related-anime read
   * (`app/api/anime/[id]/related/route.ts`): the OTHER anime whose
   * `series` list shares a name with the requested anime's,
   * chronological (seasonYear asc), capped at 10. The web parses
   * the id with parseInt — '42x' reads as 42 and a non-numeric id
   * becomes NaN, which matches no document and 404s; mirrored.
   * An anime with no series recorded answers an empty list, not
   * a 404. The web serves raw documents; this API projects them
   * (see anime.mapper.ts).
   *
   * Bug 4 (multi-user matrix 2026-11-09): through Mongoose a NaN
   * value does NOT match nothing — casting it to the Number path
   * throws a CastError, so a non-numeric id 500ed instead of
   * 404ing. Guarded explicitly below; parseInt's '42x' → 42
   * behaviour is unchanged.
   */
  async getRelatedAnime(idParam: string): Promise<RelatedAnimeResponse> {
    const model = this.requireAnimeModel();
    const animeId = Number.parseInt(idParam, 10);
    if (Number.isNaN(animeId)) {
      throw new NotFoundException('Anime not found');
    }

    const anime = (await model
      .findOne({ anilistId: animeId })
      .lean()
      .exec()) as AnimeDoc | null;
    if (!anime) {
      throw new NotFoundException('Anime not found');
    }

    const seriesNames = anime.series ?? [];
    if (seriesNames.length === 0) {
      return { related: [] };
    }

    const docs = await model
      .find({
        $and: [
          { anilistId: { $ne: animeId } },
          { series: { $in: seriesNames } },
        ],
      })
      .sort({ seasonYear: 1 })
      .limit(10)
      .lean()
      .exec();

    return { related: (docs as AnimeDoc[]).map(toRelatedAnime) };
  }

  /**
   * GET /anime/:id — the web's anime detail page read
   * (`app/anime/[id]/page.tsx`): AnimeCache by AniList id plus every
   * ThemeCache row for the id, fetched in parallel. 404 only when
   * NEITHER exists; when the cache has no document the header is
   * synthesized from the first theme, field for field as the web
   * page synthesizes it. The web parses the id with parseInt ('42x'
   * reads as 42, non-numeric becomes NaN and matches nothing);
   * mirrored — except that through Mongoose a NaN cast throws
   * instead of matching nothing, so NaN is answered 404 explicitly
   * (Bug 4, multi-user matrix 2026-11-09).
   */
  async getAnimeDetail(idParam: string): Promise<AnimeDetailResponse> {
    const themeModel = this.requireModel();
    const animeModel = this.requireAnimeModel();
    const animeId = Number.parseInt(idParam, 10);
    if (Number.isNaN(animeId)) {
      throw new NotFoundException('Anime not found');
    }

    const [animeDoc, themeDocs] = await Promise.all([
      animeModel.findOne({ anilistId: animeId }).lean().exec(),
      themeModel
        .find({ anilistId: animeId })
        .select('-embedding -__v')
        .lean()
        .exec(),
    ]);

    if (!animeDoc && themeDocs.length === 0) {
      throw new NotFoundException('Anime not found');
    }

    const anime: RelatedAnime = animeDoc
      ? toRelatedAnime(animeDoc as AnimeDoc)
      : (() => {
          const t = themeDocs[0] as unknown as ThemeDoc;
          return {
            anilistId: animeId,
            malId: null,
            kitsuId: null,
            titleRomaji: t.animeTitle,
            titleEnglish: t.animeTitleEnglish ?? null,
            titleNative: null,
            titleAlternative: [],
            season: (t.animeSeason as Season | null) ?? null,
            seasonYear: t.animeSeasonYear ?? null,
            genres: [],
            coverImageLarge: t.animeCoverImage ?? null,
            coverImageMedium: t.animeCoverImageSmall ?? null,
            bannerImage: null,
            studios: t.animeStudios ?? [],
            series: t.animeSeries ?? [],
            totalEpisodes: null,
            status: null,
            averageScore: null,
          };
        })();

    return {
      anime,
      themes: (themeDocs as unknown as ThemeDoc[]).map(toThemeSummary),
    };
  }

  /**
   * GET /artists/:slug — the web's artist detail page read
   * (`app/artist/[slug]/page.tsx`): ArtistCache by slug plus every
   * ThemeCache row carrying the slug in `artistSlugs`, in parallel.
   * 404 only when NEITHER exists; a missing cache document is
   * synthesized from the first theme (name at the slug's index in
   * allArtists, falling back to artistName, then the slug itself),
   * exactly as the web page does.
   */
  async getArtistDetail(slug: string): Promise<ArtistDetailResponse> {
    const themeModel = this.requireModel();
    const artistModel = this.requireArtistModel();

    const [artistDoc, themeDocs] = await Promise.all([
      artistModel.findOne({ slug }).lean().exec(),
      themeModel
        .find({ artistSlugs: slug })
        .select('-embedding -__v')
        .lean()
        .exec(),
    ]);

    if (!artistDoc && themeDocs.length === 0) {
      throw new NotFoundException('Artist not found');
    }

    const artist = artistDoc
      ? {
          slug: artistDoc.slug,
          name: artistDoc.name,
          aliases: artistDoc.aliases ?? [],
          imageUrl: artistDoc.imageUrl ?? null,
          // The cache counter drifts in production (e.g. Youko
          // Takahashi's document says 0 while 10 themes carry her
          // slug) — never report fewer themes than this very
          // response returns.
          totalThemes: Math.max(artistDoc.totalThemes ?? 0, themeDocs.length),
        }
      : (() => {
          const t = themeDocs[0] as unknown as ThemeDoc;
          const idx = (t.artistSlugs ?? []).indexOf(slug);
          return {
            slug,
            name:
              idx !== -1
                ? (t.allArtists[idx] ?? t.artistName ?? slug)
                : (t.artistName ?? slug),
            aliases: [],
            imageUrl: null,
            totalThemes: themeDocs.length,
          };
        })();

    return {
      artist,
      themes: (themeDocs as unknown as ThemeDoc[]).map(toThemeSummary),
    };
  }
}

import {
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type {
  HomeResponse,
  RelatedAnimeResponse,
  SearchResponse,
  SimilarThemesResponse,
  ThemeDetail,
} from '@kaikansen/contracts';
import {
  AnimeCache,
  type AnimeCacheDocument,
} from '../sync/anime-cache.schema';
import { ThemeCache, type ThemeCacheDocument } from './theme-cache.schema';
import { currentSeason, previousSeason } from './season';
import { toRelatedAnime, type AnimeDoc } from './anime.mapper';
import { toThemeDetail, toThemeSummary, type ThemeDoc } from './theme.mapper';

const RAIL_LIMIT = 20;
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
@Injectable()
export class ThemesService {
  constructor(
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(AnimeCache.name)
    private readonly animeModel?: Model<AnimeCacheDocument>,
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
   */
  async search(rawQuery: string, page = 1): Promise<SearchResponse> {
    const model = this.requireModel();
    const query = rawQuery.trim();
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    if (query.length === 0) {
      return {
        query,
        results: [],
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
        .sort({ totalWatches: -1, avgRating: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      model.countDocuments(effectiveFilter).exec(),
    ]);

    const results = (docs as ThemeDoc[]).map(toThemeSummary);
    return {
      query,
      results,
      searchType: 'regex',
      page: safePage,
      total,
      hasMore: skip + results.length < total,
      themeTypeFilter,
      themeSeqFilter,
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
   */
  async getRelatedAnime(idParam: string): Promise<RelatedAnimeResponse> {
    const model = this.requireAnimeModel();
    const animeId = Number.parseInt(idParam, 10);

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
}

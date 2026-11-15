import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type {
  AnimeDetailResponse,
  AnimeFranchiseResponse,
  ArtistDetailResponse,
  FranchiseAnimeGroup,
  HomeResponse,
  NetworkUser,
  RelatedAnime,
  RelatedAnimeResponse,
  SearchAnimeResult,
  SearchArtistResult,
  SearchGroup,
  SearchGroupMeta,
  SearchResponse,
  Season,
  SeasonResponse,
  SimilarThemesResponse,
  ThemeDetail,
  ThemeSummary,
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
import {
  SEARCH_READINESS_PROBE,
  SearchIndexService,
  type SearchReadinessProbe,
} from './search-index.service';
import { currentSeason, previousSeason, SEASON_ORDER } from './season';
import { toRelatedAnime, type AnimeDoc } from './anime.mapper';
import { toThemeDetail, toThemeSummary, type ThemeDoc } from './theme.mapper';
import {
  ANIME_RELATED_PROJECTION,
  THEME_SUMMARY_PROJECTION,
} from './theme-projections';

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
/**
 * Franchise serve caps (GET /anime/:id/franchise, owner's order
 * 2026-11-15): groups and themes SERVED per response, in the
 * franchise's chronological order. The response's totals always
 * count the full franchise and `truncated` flags a cut — the
 * caps bound payload size, never silently shorten the list.
 */
export const FRANCHISE_MAX_GROUPS = 25;
export const FRANCHISE_MAX_THEMES = 200;
/* Search constants — the web's own values (app/api/search/route.ts). */
const SEARCH_PAGE_SIZE = 20; // per-type limit of the web's SONGS view
const SEARCH_GROUP_LIMIT = 5; // per-group limit of the web's ALL view
const SEARCH_MODIFIER_LIMIT = 50; // songs limit when an OP/ED modifier is used
const SONG_CANDIDATE_LIMIT = 400; // stage-1 candidate cap
const MAX_TERMS = 6;
const MAX_TERM_LENGTH = 32;

/* Option B (MongoDB Search) constants — spec 2026-11-10. The index
   names match apps/api/search-indexes/*.json, created at rollout.
   A group uses its index only once the SearchIndexService probe
   reports it READY — a missing/BUILDING index silently answers
   $search with an empty set, it does not fail into anything
   (rollout finding 2026-11-10). */
const SEARCH_GROUPS: readonly SearchGroup[] = [
  'all',
  'themes',
  'anime',
  'artists',
  'users',
];
const SEARCH_FULL_GROUP_PAGE_SIZE = 15; // a group full view's default page
const SEARCH_MAX_LIMIT = 50; // hard cap on a client-supplied `limit`
const THEMES_SEARCH_INDEX = 'kaikansen_themes_search';
const ANIME_SEARCH_INDEX = 'kaikansen_anime_search';
const ARTISTS_SEARCH_INDEX = 'kaikansen_artists_search';
const THEME_SEARCH_FIELDS = ['animeTitle', 'songTitle', 'artistName'];
const ANIME_SEARCH_FIELDS = ['titleRomaji', 'titleEnglish', 'synonyms'];
const ARTIST_SEARCH_FIELDS = ['name', 'aliases'];

/** One group page of a search view: the rows served + the group's total. */
interface GroupPage<T> {
  rows: T[];
  total: number;
}

/**
 * What the Atlas attempt actually did, group by group — the raw
 * material for the response's `searchType`. The label is honest
 * (rollout finding 2026-11-10): 'atlas' only when EVERY catalogue
 * group in view served through `$search`; a single regex-served
 * group makes the whole response 'regex'.
 */
interface AtlasOutcome {
  themes: GroupPage<ThemeSummary>;
  themesServedAtlas: boolean;
  themesSkip: number;
  anime: GroupPage<SearchAnimeResult>;
  animeServedAtlas: boolean;
  artists: GroupPage<SearchArtistResult>;
  artistsServedAtlas: boolean;
  users: GroupPage<NetworkUser>;
}

/** A parsed GET /search request, shared by the Atlas and regex paths. */
interface SearchView {
  query: string;
  page: number;
  /** Effective view ('all' past page 1 is folded to 'themes' by `search`). */
  view: SearchGroup;
  limit: number | undefined;
  cleanWords: string[];
  themeTypeFilter: 'OP' | 'ED' | null;
  themeSeqFilter: number | null;
  themeModifierUsed: boolean;
}

function emptyGroupsMeta(): SearchResponse['groups'] {
  const empty: SearchGroupMeta = { total: 0, hasMore: false };
  return {
    themes: { ...empty },
    anime: { ...empty },
    artists: { ...empty },
    users: { ...empty },
  };
}

/**
 * The regex group filter: every clean word an escaped,
 * case-insensitive substring of at least one of the group's
 * fields — `$and` across words, `$or` across fields (the web's
 * ALL-view shape).
 */
function regexGroupFilter(
  fields: string[],
  cleanWords: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const contains = (word: string) => new RegExp(escapeRegExp(word), 'i');
  const conditions = cleanWords.map((word) => ({
    $or: fields.map((field) => ({ [field]: contains(word) })),
  }));
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

/**
 * The `$search` stage for a catalogue group: one compound per
 * clean word, requiring (minimumShouldMatch 1) an autocomplete
 * match on at least one of the group's fields — Atlas ANDs the
 * per-word compounds, mirroring the regex semantics. Matching is
 * partial by index design: the fields are nGram-tokenized
 * autocomplete (see apps/api/search-indexes/), so a word matches
 * as a fragment anywhere in a field's tokens.
 */
function autocompleteStage(
  index: string,
  fields: string[],
  cleanWords: string[],
): Record<string, unknown> {
  return {
    $search: {
      index,
      compound: {
        must: cleanWords.map((word) => ({
          compound: {
            should: fields.map((path) => ({
              autocomplete: { query: word, path },
            })),
            minimumShouldMatch: 1,
          },
        })),
      },
    },
  };
}

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
    /**
     * The Atlas Search readiness probe (index exists + queryable
     * + READY, cached ~60s), bound via the SEARCH_READINESS_PROBE
     * token: the param's type is an interface, which has NO
     * runtime token — without the explicit @Inject the production
     * module silently constructed this service probe-less
     * (@Optional swallowed the unresolvable dependency) and
     * search served empty 'atlas' answers with no indexes in
     * existence (hotfix 2026-11-10; regression:
     * test/search-probe-di.e2e-spec.ts). The token provider in
     * ThemesModule is deliberately NOT optional: if the binding
     * is ever dropped, boot fails loudly instead.
     *
     * @Optional stays for the POSITIONAL constructions only
     * (unit specs pass a stub or nothing as the 5th argument);
     * "no probe" there keeps the pre-probe behaviour the specs
     * assert — see atlasReady.
     */
    @Optional()
    @Inject(SEARCH_READINESS_PROBE)
    private readonly searchIndexes?: SearchReadinessProbe,
  ) {}

  /**
   * May this catalogue group use its `$search` pipeline right
   * now? Only on a POSITIVE probe answer — see SearchIndexService
   * for the empty-$search trap that makes "unknown" mean no.
   *
   * A service constructed WITHOUT the probe (older unit specs do
   * this positionally) keeps the pre-probe behaviour — pipelines
   * attempted, errors degrading to regex — because those specs
   * assert exactly that contract against bare model doubles.
   * Production always injects the probe (ThemesModule), and
   * there "no positive answer" (absent index, BUILDING, probe
   * failure) means regex.
   */
  private async atlasReady(
    model: 'themes' | 'anime' | 'artists',
    index: string,
  ): Promise<boolean> {
    if (!this.searchIndexes) return true;
    try {
      return await this.searchIndexes.isIndexReady(model, index);
    } catch {
      return false;
    }
  }

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

    // Both rails serve ThemeSummary rows only — the projection
    // fetches exactly the mapper's fields (perf problem 10); the
    // filters/sorts read stored fields, not returned ones, so the
    // query plan is unchanged.
    const fetchRail = (s: typeof current.season, y: number) =>
      model
        .find({ animeSeason: s, animeSeasonYear: y })
        .select(THEME_SUMMARY_PROJECTION)
        .sort({ totalWatches: -1 })
        .limit(RAIL_LIMIT)
        .lean()
        .exec();

    const [firstRail, popularDocs] = await Promise.all([
      fetchRail(current.season, current.year),
      model
        .find({ isPopular: true })
        .select(THEME_SUMMARY_PROJECTION)
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
      .select(THEME_SUMMARY_PROJECTION)
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
   * GET /search — the Option B search (owner spec 2026-11-10): the
   * catalogue groups (themes / anime / artists) match through
   * MongoDB Search (Atlas Search) `$search` pipelines over the
   * nGram-autocomplete indexes shipped in `apps/api/search-indexes/`,
   * which is what keeps PARTIAL matching — "naruto" surfaces Naruto
   * Shippuden and the fragments "naru" / "shippu" / "uto" still
   * match mid-word (whole-word `$text` and prefix-only edgeGram
   * were both rejected for losing exactly that). The users group
   * keeps the people search's own regex matching (public accounts,
   * public fields only — see searchUserGroupRegex).
   *
   * Views (`group` param): 'all' is the preview — top 5 of every
   * group plus per-group totals (the web's ALL view, extended);
   * each other value is that group's full view, paginated at the
   * requested `limit` (the app sends 15; themes default to the
   * web's SONGS sizes, 20 or 50 under an OP/ED modifier). 'all'
   * past page 1 continues as the themes full view, the legacy
   * paging older clients use. Tokens like "op", "ed12" or "op 9"
   * are not search words in either matcher: they parse into
   * type/sequence filters and suppress the non-theme groups.
   *
   * READINESS + FALLBACK: a catalogue group may use its `$search`
   * pipeline ONLY when the readiness probe (SearchIndexService)
   * reports its index exists, queryable and READY. Probing —
   * not error handling — is the gate, because `$search` against
   * a missing or BUILDING index does NOT throw: Atlas answers
   * an EMPTY set (rollout finding 2026-11-10 ~18:47), which an
   * error-only fallback would happily serve as an 'atlas'
   * result. A group whose index is not ready serves its regex
   * implementation (per-group, in preview; whole-view in a
   * strict group view); a group whose READY pipeline still
   * throws (Atlas unreachable) degrades the same way. The
   * response's `searchType` is 'atlas' only when every
   * catalogue group in view actually served via `$search` —
   * any regex-served group makes it 'regex'. A modifier-only
   * query ("op 9", no words) and the users view always go
   * straight to the regex path: `$search` needs text to match,
   * and the users group is regex by design.
   */
  async search(
    rawQuery: string,
    page = 1,
    group: SearchGroup = 'all',
    limit?: number,
  ): Promise<SearchResponse> {
    this.requireModel();
    const query = rawQuery.trim();
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    const requested: SearchGroup = SEARCH_GROUPS.includes(group)
      ? group
      : 'all';
    const view: SearchGroup =
      requested === 'all' && safePage > 1 ? 'themes' : requested;
    const safeLimit =
      limit !== undefined && Number.isFinite(limit) && limit >= 1
        ? Math.min(Math.floor(limit), SEARCH_MAX_LIMIT)
        : undefined;
    if (query.length === 0) {
      return {
        query,
        results: [],
        anime: [],
        artists: [],
        users: [],
        searchType: 'regex',
        group: view,
        groups: emptyGroupsMeta(),
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
    const ctx: SearchView = {
      query,
      page: safePage,
      view,
      limit: safeLimit,
      cleanWords,
      themeTypeFilter,
      themeSeqFilter,
      themeModifierUsed: themeTypeFilter !== null,
    };
    if (cleanWords.length === 0 || view === 'users') {
      return this.searchRegex(ctx);
    }
    let outcome: AtlasOutcome;
    try {
      outcome = await this.searchAtlas(ctx);
    } catch {
      // A READY pipeline threw (Atlas unreachable), or a strict
      // group view's index is not ready: the whole view degrades
      // to the web-parity regex path.
      return this.searchRegex(ctx);
    }
    // Honest labelling: 'atlas' only when every catalogue group
    // in view served through $search. (A strict catalogue-group
    // view whose index is not ready never reaches searchAtlas —
    // searchRegex serves it whole, labelled 'regex' there.)
    const servedAtlas: boolean[] = [];
    if (view === 'all' || view === 'themes') {
      servedAtlas.push(outcome.themesServedAtlas);
    }
    if (!ctx.themeModifierUsed) {
      // A group is only "in view" for labelling when it could
      // have served at all: a group whose model was never
      // injected (no catalogue rows exist to match — the no-model
      // case in the group matchers, and the service's single-model
      // construction in the older specs) answers empty either way,
      // and labelling the view regex over its absence would blame
      // the search engine for an empty catalogue.
      if ((view === 'all' || view === 'anime') && this.animeModel) {
        servedAtlas.push(outcome.animeServedAtlas);
      }
      if ((view === 'all' || view === 'artists') && this.artistModel) {
        servedAtlas.push(outcome.artistsServedAtlas);
      }
    }
    const searchType =
      servedAtlas.length > 0 && servedAtlas.every(Boolean)
        ? 'atlas'
        : 'regex';
    return this.assembleSearch(
      ctx,
      searchType,
      outcome.themes,
      outcome.themesSkip,
      outcome.anime,
      outcome.artists,
      outcome.users,
    );
  }

  /** The themes page size for a view (preview cap / SONGS sizes / client limit). */
  private themesPageSize(ctx: SearchView): number {
    if (ctx.view === 'all') {
      // The preview caps themes like every group — except under an
      // OP/ED modifier, where the groups are suppressed and themes
      // are the whole view: the web widens the page to 50 then.
      return ctx.themeModifierUsed
        ? SEARCH_MODIFIER_LIMIT
        : SEARCH_GROUP_LIMIT;
    }
    if (ctx.limit !== undefined) return ctx.limit;
    return ctx.themeModifierUsed ? SEARCH_MODIFIER_LIMIT : SEARCH_PAGE_SIZE;
  }

  /** The page size for a catalogue group (preview cap / client limit / 15). */
  private groupPageSize(ctx: SearchView): number {
    if (ctx.view === 'all') return SEARCH_GROUP_LIMIT;
    return ctx.limit ?? SEARCH_FULL_GROUP_PAGE_SIZE;
  }

  /**
   * The themes group, regex form — the stage-1/stage-2 half of
   * searchRegex lifted into a group-shaped helper so the
   * Atlas-first assembly can serve themes via regex when the
   * themes index is not READY (preview degradation). searchRegex
   * itself is untouched and still serves strict views whole.
   */
  private async searchThemesRegexGroup(
    ctx: SearchView,
    limit: number,
    skip: number,
  ): Promise<GroupPage<ThemeSummary>> {
    const model = this.requireModel();
    const { cleanWords, themeTypeFilter, themeSeqFilter, themeModifierUsed } =
      ctx;
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
    const [docs, total] = await Promise.all([
      model
        .find(effectiveFilter)
        .sort({ totalWatches: -1, avgRating: -1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      model.countDocuments(effectiveFilter).exec(),
    ]);
    return { rows: (docs as ThemeDoc[]).map(toThemeSummary), total };
  }

  /**
   * The Atlas-first assembly: every catalogue group consults the
   * readiness probe and runs its `$search` pipeline only when
   * its index is READY (see `search` for why probing, not error
   * handling, gates this); a not-ready group serves its regex
   * implementation in place (per-group degradation). A READY
   * group's pipeline that still throws degrades the same way —
   * except themes, whose failure fails the caller into the
   * whole-view regex fallback (`search` re-serves via
   * searchRegex), as before. OP/ED modifiers ride the themes
   * pipeline as a `$match` stage and suppress the other groups,
   * as on the web. The per-group servedVia flags feed the
   * response's honest `searchType`.
   */
  private async searchAtlas(ctx: SearchView): Promise<AtlasOutcome> {
    const inView = (g: SearchGroup) => ctx.view === 'all' || ctx.view === g;
    let themes: GroupPage<ThemeSummary> = { rows: [], total: 0 };
    let themesServedAtlas = true;
    let themesSkip = 0;
    if (inView('themes')) {
      const size = this.themesPageSize(ctx);
      themesSkip = (ctx.page - 1) * size;
      if (await this.atlasReady('themes', THEMES_SEARCH_INDEX)) {
        themes = await this.searchThemesAtlas(ctx, size, themesSkip);
      } else if (ctx.view === 'themes') {
        // Strict view: the whole view is this group, so signal
        // the caller to serve the whole view via regex.
        throw new Error('themes search index not ready');
      } else {
        themes = await this.searchThemesRegexGroup(ctx, size, themesSkip);
        themesServedAtlas = false;
      }
    }

    const empty: GroupPage<never> = { rows: [], total: 0 };
    let anime: GroupPage<SearchAnimeResult> = empty;
    let animeServedAtlas = false;
    let artists: GroupPage<SearchArtistResult> = empty;
    let artistsServedAtlas = false;
    let users: GroupPage<NetworkUser> = empty;
    if (!ctx.themeModifierUsed) {
      const size = this.groupPageSize(ctx);
      const skip = (ctx.page - 1) * size;
      if (inView('anime')) {
        const served = await this.searchAnimeGroupAtlas(
          ctx,
          size,
          skip,
          ctx.view === 'anime',
        );
        anime = served.page;
        animeServedAtlas = served.viaAtlas;
      }
      if (inView('artists')) {
        const served = await this.searchArtistGroupAtlas(
          ctx,
          size,
          skip,
          ctx.view === 'artists',
        );
        artists = served.page;
        artistsServedAtlas = served.viaAtlas;
      }
      if (inView('users')) {
        users = await this.searchUserGroupRegex(ctx.cleanWords, size, skip);
      }
    }

    return {
      themes,
      themesServedAtlas,
      themesSkip,
      anime,
      animeServedAtlas,
      artists,
      artistsServedAtlas,
      users,
    };
  }

  /**
   * One `$search` + facet round trip: the page of documents and
   * the full match count in a single aggregation. Ranking is
   * Atlas relevance first (the `$search` score), tie-broken by
   * totalWatches desc / avgRating desc (themes only — the group
   * collections carry neither) and finally `_id` asc, so pages
   * partition cleanly and never overlap (the Bug 6 rule, carried
   * over from the regex sort).
   */
  private async runSearchFacet(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: Model<any>,
    index: string,
    fields: string[],
    cleanWords: string[],
    match: Record<string, unknown> | null,
    popularityTiebreak: boolean,
    limit: number,
    skip: number,
  ): Promise<GroupPage<unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stages: any[] = [autocompleteStage(index, fields, cleanWords)];
    if (match) stages.push({ $match: match });
    stages.push(
      { $addFields: { _searchScore: { $meta: 'searchScore' } } },
      {
        $sort: popularityTiebreak
          ? { _searchScore: -1, totalWatches: -1, avgRating: -1, _id: 1 }
          : { _searchScore: -1, _id: 1 },
      },
      {
        $facet: {
          results: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'count' }],
        },
      },
    );
    const out = (await model.aggregate(stages)) as Array<{
      results?: unknown[];
      total?: Array<{ count: number }>;
    }>;
    const facet = out[0];
    if (!facet) {
      throw new Error(`MongoDB Search returned no result (index ${index})`);
    }
    return { rows: facet.results ?? [], total: facet.total?.[0]?.count ?? 0 };
  }

  /** Themes through Atlas: text match plus the OP/ED `$match` filters. */
  private async searchThemesAtlas(
    ctx: SearchView,
    limit: number,
    skip: number,
  ): Promise<GroupPage<ThemeSummary>> {
    const model = this.requireModel();
    const match: Record<string, unknown> = {};
    if (ctx.themeTypeFilter) match.type = ctx.themeTypeFilter;
    if (ctx.themeSeqFilter !== null) match.sequence = ctx.themeSeqFilter;
    const facet = await this.runSearchFacet(
      model,
      THEMES_SEARCH_INDEX,
      THEME_SEARCH_FIELDS,
      ctx.cleanWords,
      Object.keys(match).length > 0 ? match : null,
      true,
      limit,
      skip,
    );
    return {
      rows: (facet.rows as ThemeDoc[]).map(toThemeSummary),
      total: facet.total,
    };
  }

  private async searchAnimeGroupAtlas(
    ctx: SearchView,
    limit: number,
    skip: number,
    strict: boolean,
  ): Promise<{ page: GroupPage<SearchAnimeResult>; viaAtlas: boolean }> {
    if (!this.animeModel) return { page: { rows: [], total: 0 }, viaAtlas: false };
    // Not ready → regex for this group; in a strict view the
    // caller (searchAtlas) still sees viaAtlas:false — but the
    // strict contract is stronger: the whole view goes regex, so
    // signal it the way a pipeline failure used to.
    if (!(await this.atlasReady('anime', ANIME_SEARCH_INDEX))) {
      if (strict) throw new Error('anime search index not ready');
      return {
        page: await this.searchAnimeGroupRegex(
          regexGroupFilter(ANIME_SEARCH_FIELDS, ctx.cleanWords),
          limit,
          skip,
        ),
        viaAtlas: false,
      };
    }
    try {
      const facet = await this.runSearchFacet(
        this.animeModel,
        ANIME_SEARCH_INDEX,
        ANIME_SEARCH_FIELDS,
        ctx.cleanWords,
        null,
        false,
        limit,
        skip,
      );
      return {
        page: {
          rows: await this.toAnimeResults(facet.rows as AnimeDoc[]),
          total: facet.total,
        },
        viaAtlas: true,
      };
    } catch (err) {
      if (strict) throw err;
      return {
        page: await this.searchAnimeGroupRegex(
          regexGroupFilter(ANIME_SEARCH_FIELDS, ctx.cleanWords),
          limit,
          skip,
        ),
        viaAtlas: false,
      };
    }
  }

  private async searchArtistGroupAtlas(
    ctx: SearchView,
    limit: number,
    skip: number,
    strict: boolean,
  ): Promise<{ page: GroupPage<SearchArtistResult>; viaAtlas: boolean }> {
    if (!this.artistModel) return { page: { rows: [], total: 0 }, viaAtlas: false };
    if (!(await this.atlasReady('artists', ARTISTS_SEARCH_INDEX))) {
      if (strict) throw new Error('artists search index not ready');
      return {
        page: await this.searchArtistGroupRegex(
          regexGroupFilter(ARTIST_SEARCH_FIELDS, ctx.cleanWords),
          limit,
          skip,
        ),
        viaAtlas: false,
      };
    }
    try {
      const facet = await this.runSearchFacet(
        this.artistModel,
        ARTISTS_SEARCH_INDEX,
        ARTIST_SEARCH_FIELDS,
        ctx.cleanWords,
        null,
        false,
        limit,
        skip,
      );
      return {
        page: {
          rows: await this.toArtistResults(facet.rows as ArtistCacheDocument[]),
          total: facet.total,
        },
        viaAtlas: true,
      };
    } catch (err) {
      if (strict) throw err;
      return {
        page: await this.searchArtistGroupRegex(
          regexGroupFilter(ARTIST_SEARCH_FIELDS, ctx.cleanWords),
          limit,
          skip,
        ),
        viaAtlas: false,
      };
    }
  }

  /**
   * The regex fallback — the web's own search semantics (AUDIT.md
   * §6; ZadidSalman/Kaisen `app/api/search/route.ts`), kept whole
   * and renamed from the original `search` when Option B landed.
   * The web's search is regex end to end — it self-labels
   * `searchType: 'regex'` and issues no `$text` query anywhere.
   * (The collection does carry a `theme_full_search` TEXT index,
   * but the web code never uses it, and neither does this port.)
   *
   * Two stages, mirroring the web's songs search:
   *
   * Stage 1 — candidate narrowing: unless an OP/ED modifier was
   * parsed out of the query, prefix-match the first clean word
   * (`^word`, case-insensitive) over animeTitle/songTitle/
   * artistName and collect up to 400 candidate ids.
   *
   * Stage 2 — full regex over the candidates: every clean word
   * must appear (escaped, case-insensitive substring) in at least
   * one of animeTitle/songTitle/artistName — `$and` across words,
   * `$or` across fields — restricted to the stage-1 ids when
   * stage 1 produced any. Results sort by totalWatches desc, then
   * avgRating desc, then `_id` asc (Bug 6 tiebreaker).
   *
   * The groups use the web's ALL-view filters (every clean word a
   * substring of one of the group's fields) with counts, paginated
   * like the Atlas path; a group model the service was constructed
   * without simply yields an empty group. OP/ED modifiers suppress
   * the groups entirely, exactly as on the web.
   */
  private async searchRegex(ctx: SearchView): Promise<SearchResponse> {
    const model = this.requireModel();
    const { cleanWords, themeTypeFilter, themeSeqFilter, themeModifierUsed } =
      ctx;
    const inView = (g: SearchGroup) => ctx.view === 'all' || ctx.view === g;

    let themesRows: ThemeSummary[] = [];
    let themesTotal = 0;
    let themesSkip = 0;
    if (inView('themes')) {
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
      const limit = this.themesPageSize(ctx);
      themesSkip = (ctx.page - 1) * limit;
      const [docs, total] = await Promise.all([
        model
          .find(effectiveFilter)
          .sort({ totalWatches: -1, avgRating: -1, _id: 1 })
          .skip(themesSkip)
          .limit(limit)
          .lean()
          .exec(),
        model.countDocuments(effectiveFilter).exec(),
      ]);
      themesRows = (docs as ThemeDoc[]).map(toThemeSummary);
      themesTotal = total;
    }

    const empty: GroupPage<never> = { rows: [], total: 0 };
    let anime: GroupPage<SearchAnimeResult> = empty;
    let artists: GroupPage<SearchArtistResult> = empty;
    let users: GroupPage<NetworkUser> = empty;
    if (!themeModifierUsed && cleanWords.length > 0) {
      const size = this.groupPageSize(ctx);
      const skip = (ctx.page - 1) * size;
      if (inView('anime')) {
        anime = await this.searchAnimeGroupRegex(
          regexGroupFilter(ANIME_SEARCH_FIELDS, cleanWords),
          size,
          skip,
        );
      }
      if (inView('artists')) {
        artists = await this.searchArtistGroupRegex(
          regexGroupFilter(ARTIST_SEARCH_FIELDS, cleanWords),
          size,
          skip,
        );
      }
      if (inView('users')) {
        users = await this.searchUserGroupRegex(cleanWords, size, skip);
      }
    }

    return this.assembleSearch(
      ctx,
      'regex',
      { rows: themesRows, total: themesTotal },
      themesSkip,
      anime,
      artists,
      users,
    );
  }

  /**
   * Builds the SearchResponse from the four group pages: the
   * top-level total/hasMore mirror the web's `meta` position —
   * the themes group for the 'all'/'themes' views, the served
   * group for a single-group view — and `groups` carries every
   * group's own meta (groups outside the view report total 0).
   */
  private assembleSearch(
    ctx: SearchView,
    searchType: 'atlas' | 'regex',
    themes: GroupPage<ThemeSummary>,
    themesSkip: number,
    anime: GroupPage<SearchAnimeResult>,
    artists: GroupPage<SearchArtistResult>,
    users: GroupPage<NetworkUser>,
  ): SearchResponse {
    const meta = <T,>(page: GroupPage<T>, skip: number): SearchGroupMeta => ({
      total: page.total,
      hasMore: skip + page.rows.length < page.total,
    });
    const groupSkip = (ctx.page - 1) * this.groupPageSize(ctx);
    const groups: SearchResponse['groups'] = {
      themes: meta(themes, themesSkip),
      anime: meta(anime, groupSkip),
      artists: meta(artists, groupSkip),
      users: meta(users, groupSkip),
    };
    const primary =
      ctx.view === 'anime'
        ? groups.anime
        : ctx.view === 'artists'
          ? groups.artists
          : ctx.view === 'users'
            ? groups.users
            : groups.themes;
    return {
      query: ctx.query,
      results: themes.rows,
      anime: anime.rows,
      artists: artists.rows,
      users: users.rows,
      searchType,
      group: ctx.view,
      groups,
      page: ctx.page,
      total: primary.total,
      hasMore: primary.hasMore,
      themeTypeFilter: ctx.themeTypeFilter,
      themeSeqFilter: ctx.themeSeqFilter,
    };
  }

  private async searchAnimeGroupRegex(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: any,
    limit: number,
    skip: number,
  ): Promise<GroupPage<SearchAnimeResult>> {
    if (!this.animeModel) return { rows: [], total: 0 };
    const [docs, total] = await Promise.all([
      this.animeModel
        .find(filter)
        // `_id` asc partitions skip/limit pages cleanly (the
        // groups historically served in natural order; with real
        // pagination an unstable order would overlap pages — the
        // Bug 6 rule again).
        .sort({ _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.animeModel.countDocuments(filter).exec(),
    ]);
    return { rows: await this.toAnimeResults(docs as AnimeDoc[]), total };
  }

  /**
   * Anime docs → search rows: theme counts come from the theme
   * collection itself (one light projection find — a catalogue
   * anime carries at most dozens of themes), so a row's count is
   * exactly what its detail page lists. Rows navigate by AniList
   * id — a document without one cannot be opened, so it is not a
   * result (it still counts toward the group's total: the matcher
   * matched it).
   */
  private async toAnimeResults(
    docs: AnimeDoc[],
  ): Promise<SearchAnimeResult[]> {
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

  private async searchArtistGroupRegex(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter: any,
    limit: number,
    skip: number,
  ): Promise<GroupPage<SearchArtistResult>> {
    if (!this.artistModel) return { rows: [], total: 0 };
    const [docs, total] = await Promise.all([
      this.artistModel
        .find(filter)
        .sort({ _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.artistModel.countDocuments(filter).exec(),
    ]);
    return {
      rows: await this.toArtistResults(docs as ArtistCacheDocument[]),
      total,
    };
  }

  /**
   * Artist docs → search rows: a row's total is max(cache counter,
   * counted) — the cache counter drifts (see getArtistDetail), so
   * a search row never reports fewer themes than the artist page
   * would.
   */
  private async toArtistResults(
    docs: ArtistCacheDocument[],
  ): Promise<SearchArtistResult[]> {
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
   * display name. There is no 2-character minimum — /search
   * answers one-character queries for every other group, so the
   * group simply matches what it matches. Option B extended the
   * group with page/limit pagination (the preview caps it at the
   * groups' 5); the matching itself is unchanged and never moves
   * to Atlas. The projection is the people search's NetworkUser,
   * field for field — public profile fields only; the stored
   * email, password hash and AniList token never leave the
   * document.
   */
  private async searchUserGroupRegex(
    cleanWords: string[],
    limit: number,
    skip: number,
  ): Promise<GroupPage<NetworkUser>> {
    if (!this.userModel) return { rows: [], total: 0 };
    const contains = (word: string) => new RegExp(escapeRegExp(word), 'i');
    const conditions = cleanWords.map((word) => ({
      $or: [{ username: contains(word) }, { displayName: contains(word) }],
    }));
    // The filter is assembled dynamically, exactly as on the web.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: any = {
      isPublic: true,
      ...(conditions.length === 1 ? conditions[0] : { $and: conditions }),
    };
    const [docs, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return {
      rows: (docs as unknown as SearchUserDoc[]).map((d) =>
        this.toSearchUser(d),
      ),
      total,
    };
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
    // The source theme stays a FULL read: its mood list and first
    // entry's tags build the match filter (perf problem 10 leaves
    // filter-source reads alone).
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
      .select(THEME_SUMMARY_PROJECTION)
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
      .select(ANIME_RELATED_PROJECTION)
      .sort({ seasonYear: 1 })
      .limit(10)
      .lean()
      .exec();

    return { related: (docs as AnimeDoc[]).map(toRelatedAnime) };
  }

  /**
   * The anime header synthesized from a theme document — field
   * for field the synthesis GET /anime/:id performs when the
   * cache has no document for the anime (see getAnimeDetail).
   */
  private animeHeaderFromTheme(animeId: number, t: ThemeDoc): RelatedAnime {
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
  }

  /**
   * GET /anime/:id/franchise (owner's order, 2026-11-15 — "if
   * anime is searched show franchise so all the songs of that
   * franchise including all seasons will show there"): the
   * requested anime plus EVERY anime sharing a `series` name
   * with it, grouped per anime in chronological order
   * (seasonYear asc), each group carrying that anime's themes
   * in the anime page's order (OP before ED, then sequence).
   *
   * Membership comes from AnimeCache `series` — the same join
   * key as the related read, but INCLUDING the requested anime
   * and with no 10-cap. When the requested anime has no cache
   * document, its themes' own `animeSeries` names the series
   * (the detail read's synthesis source), so an uncached anime
   * still expands to its franchise. 404 exactly like the
   * sibling reads: non-numeric id (parseInt NaN — guarded, Bug
   * 4), or an id with neither a cache document nor any theme.
   *
   * Groups are served only for anime that HAVE themes (a
   * themeless season is a related-series card, not an empty
   * group). Serve caps: FRANCHISE_MAX_GROUPS groups /
   * FRANCHISE_MAX_THEMES themes, applied in display order;
   * `totalGroups` / `totalThemes` count the full franchise
   * before the caps and `truncated` says the caps cut — the
   * totals are exact because the read already holds every
   * franchise theme summary in hand to group them.
   */
  async getAnimeFranchise(idParam: string): Promise<AnimeFranchiseResponse> {
    const themeModel = this.requireModel();
    const animeModel = this.requireAnimeModel();
    const animeId = Number.parseInt(idParam, 10);
    if (Number.isNaN(animeId)) {
      throw new NotFoundException('Anime not found');
    }

    const animeDoc = (await animeModel
      .findOne({ anilistId: animeId })
      .lean()
      .exec()) as AnimeDoc | null;

    // Franchise membership: every cache document sharing a
    // series name with the requested anime (itself included —
    // the find matches it through its own series list).
    let seriesNames: string[] = animeDoc?.series ?? [];
    let memberDocs: AnimeDoc[] = [];
    if (seriesNames.length > 0) {
      memberDocs = (await animeModel
        .find({ series: { $in: seriesNames } })
        .select(ANIME_RELATED_PROJECTION)
        .sort({ seasonYear: 1 })
        .lean()
        .exec()) as AnimeDoc[];
    }
    const memberIds = new Set<number>([animeId]);
    for (const doc of memberDocs) {
      if (doc.anilistId != null) memberIds.add(doc.anilistId);
    }

    let themeDocs = (await themeModel
      .find({ anilistId: { $in: [...memberIds] } })
      .select(THEME_SUMMARY_PROJECTION)
      .lean()
      .exec()) as unknown as ThemeDoc[];

    if (!animeDoc && themeDocs.length === 0) {
      throw new NotFoundException('Anime not found');
    }

    if (!animeDoc) {
      // Uncached requested anime: its first theme's animeSeries
      // is the only series evidence — expand membership from it
      // once, then re-read the widened theme set.
      seriesNames = (themeDocs[0] as ThemeDoc).animeSeries ?? [];
      if (seriesNames.length > 0) {
        memberDocs = (await animeModel
          .find({ series: { $in: seriesNames } })
          .select(ANIME_RELATED_PROJECTION)
          .sort({ seasonYear: 1 })
          .lean()
          .exec()) as AnimeDoc[];
        const widened = new Set<number>([animeId]);
        for (const doc of memberDocs) {
          if (doc.anilistId != null) widened.add(doc.anilistId);
        }
        if (widened.size > memberIds.size) {
          themeDocs = (await themeModel
            .find({ anilistId: { $in: [...widened] } })
            .select(THEME_SUMMARY_PROJECTION)
            .lean()
            .exec()) as unknown as ThemeDoc[];
        }
      }
    }

    // Headers by AniList id: cache projections first; the
    // requested anime falls back to the theme synthesis when
    // uncached (member anime without a cache document cannot
    // occur — membership itself comes from the cache).
    const headers = new Map<number, RelatedAnime>();
    for (const doc of memberDocs) {
      if (doc.anilistId != null) headers.set(doc.anilistId, toRelatedAnime(doc));
    }
    if (animeDoc) headers.set(animeId, toRelatedAnime(animeDoc));

    const themesByAnime = new Map<number, ThemeDoc[]>();
    for (const doc of themeDocs) {
      if (doc.anilistId == null) continue;
      const list = themesByAnime.get(doc.anilistId) ?? [];
      list.push(doc);
      themesByAnime.set(doc.anilistId, list);
    }
    if (!headers.has(animeId) && themesByAnime.has(animeId)) {
      headers.set(
        animeId,
        this.animeHeaderFromTheme(animeId, themesByAnime.get(animeId)![0]),
      );
    }

    const groups: FranchiseAnimeGroup[] = [...themesByAnime.entries()]
      .filter(([id]) => headers.has(id))
      .map(([id, docs]) => ({
        anime: headers.get(id)!,
        themes: docs
          .map(toThemeSummary)
          .sort(
            (a, b) =>
              (a.type === 'OP' ? 0 : 1) - (b.type === 'OP' ? 0 : 1) ||
              a.sequence - b.sequence ||
              a.slug.localeCompare(b.slug),
          ),
      }))
      .sort(
        (a, b) =>
          (a.anime.seasonYear ?? Number.MAX_SAFE_INTEGER) -
            (b.anime.seasonYear ?? Number.MAX_SAFE_INTEGER) ||
          (a.anime.anilistId ?? 0) - (b.anime.anilistId ?? 0),
      );

    const totalGroups = groups.length;
    const totalThemes = groups.reduce((sum, g) => sum + g.themes.length, 0);

    // Serve caps, in display order; a group the theme cap cuts
    // into is served partial (its remaining themes are what the
    // totals + truncated flag account for).
    const served: FranchiseAnimeGroup[] = [];
    let servedThemes = 0;
    for (const group of groups) {
      if (served.length >= FRANCHISE_MAX_GROUPS) break;
      const room = FRANCHISE_MAX_THEMES - servedThemes;
      if (room <= 0) break;
      const themes = group.themes.slice(0, room);
      served.push({ anime: group.anime, themes });
      servedThemes += themes.length;
    }
    const truncated =
      served.length < totalGroups || servedThemes < totalThemes;

    return { groups: served, totalGroups, totalThemes, truncated };
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
        // The summary projection PLUS the two fields the header
        // synthesis below reads when no cache document exists
        // (animeStudios / animeSeries) — narrower than the old
        // '-embedding -__v' full read, and the synthesis keeps
        // working on cache-less anime (perf problem 10).
        .select(`${THEME_SUMMARY_PROJECTION} animeStudios animeSeries`)
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
        // The summary projection PLUS artistSlugs: the synthesis
        // below locates the requested slug's index in the first
        // theme's slug list to pick its display name (perf
        // problem 10 — the filter field is not auto-included).
        .select(`${THEME_SUMMARY_PROJECTION} artistSlugs`)
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

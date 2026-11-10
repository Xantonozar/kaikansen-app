import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type {
  AnilistEntriesResponse,
  AnilistEntry,
  FavoriteRequest,
  FavoriteState,
  FavoritesResponse,
  HistoryCheckResponse,
  LibraryThemesResponse,
  PlaybackMode,
  LibraryCountResponse,
  RecordWatchRequest,
  RecordWatchResponse,
  SetRatingRequest,
  ThemeRatingState,
  WatchHistoryResponse,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import { ProfileStatsMaintenance } from '../users/profile-stats-maintenance';
import { resolvePlaySeconds } from '../users/profile-stats';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { toThemeSummary, type ThemeDoc } from '../themes/theme.mapper';
import { THEME_SUMMARY_PROJECTION } from '../themes/theme-projections';
import {
  AnilistLibraryClient,
  type AnilistLibraryEntry,
} from './anilist-library.client';
import { Favorite, type FavoriteDocument } from './favorite.schema';
import { Rating, type RatingDocument } from './rating.schema';
import { FollowerActivityService } from '../social/follower-activity.service';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from './watch-history.schema';

/** The web history read's hard cap (app/api/history/route.ts GET). */
const HISTORY_LIMIT = 50;

/** The web favourites route's pagination defaults. */
const FAVORITES_DEFAULT_PAGE = 1;
const FAVORITES_DEFAULT_LIMIT = 50;

/**
 * The AniList source's GROUP-page defaults (owner's lazy-loading
 * order, 2026-11-10): a page holds this many anime groups when the
 * caller passes no limit, and never more than the cap.
 */
const ANILIST_GROUP_DEFAULT_LIMIT = 10;
const ANILIST_GROUP_LIMIT_CAP = 50;

/**
 * Perf problem 15 (B7): how long the AniList source's group-order
 * totals stay cached per (user, type filter), in memory. Only the
 * TOTALS are cached — group order + theme count, the values the
 * projected pass over the full matching set produces; every page's
 * themes are still read live. An entry also pins the media-id
 * fingerprint it was computed from, and a landed sync drops the
 * user's entries outright (see refreshStoredLibraryIds), so a hit
 * can never serve totals computed from a superseded id set.
 */
const ANILIST_GROUP_TOTALS_TTL_MS = 60_000;

interface AnilistGroupTotals {
  /** Fingerprint of the AniList media-id set the totals came from. */
  fingerprint: string;
  groupOrder: number[];
  totalThemes: number;
  expiresAt: number;
}

interface LibraryModels {
  themes: Model<ThemeCacheDocument>;
  users: Model<UserDocument>;
  favorites: Model<FavoriteDocument>;
  ratings: Model<RatingDocument>;
  history: Model<WatchHistoryDocument>;
}

/**
 * The signed-in user's library (Slice S1): saved themes, watch history
 * and theme ratings over the shared production collections.
 *
 * A port of the web's `app/api/themes/favorites/route.ts`,
 * `app/api/history/route.ts` and `app/api/themes/[slug]/rate/route.ts`,
 * including the counter side effects the web hangs off its Mongoose
 * model hooks in `lib/models/index.ts`. Per this codebase's pattern the
 * hooks are NOT registered on the schemas; their operations are ported
 * here, in the service every write goes through, and cited per method.
 * ARCHITECTURE.md §3 is the bar: a write through this API must leave
 * every counter in exactly the state the web's hook would have.
 *
 * The models are OPTIONAL like everywhere else in this API: booted
 * without MONGODB_URI, every method answers 503 while /health works.
 */
@Injectable()
export class LibraryService {
  constructor(
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(Favorite.name)
    private readonly favoriteModel?: Model<FavoriteDocument>,
    @Optional()
    @InjectModel(Rating.name)
    private readonly ratingModel?: Model<RatingDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly historyModel?: Model<WatchHistoryDocument>,
    /**
     * The library reads' AniList library-ids fetch (S8; widened
     * to completed+watching since — see AnilistLibraryClient).
     * Optional so model-only constructions (unit specs) keep
     * working: without it, the read serves the stored ids alone,
     * exactly the web's state when its fetch returns null.
     */
    @Optional()
    private readonly anilistLibrary?: AnilistLibraryClient,
    /**
     * The follower-activity notification fan-out (owner-approved
     * divergence — see FollowerActivityService). Optional so
     * model-only constructions (unit specs) keep working: without
     * it, ratings and favourites simply notify nobody, which is
     * also the website's behaviour.
     */
    @Optional()
    private readonly followerActivity?: FollowerActivityService,
    /**
     * The stored profile-stats maintenance (perf problem 4):
     * keeps the user record's `stats*` aggregates in step with
     * the history/rating writes below. Optional for the same
     * reason as the two services above — without it, the writes
     * simply leave the stored stats to the recount backstop.
     */
    @Optional()
    private readonly profileStats?: ProfileStatsMaintenance,
  ) {}

  /**
   * B7 group-totals cache (see ANILIST_GROUP_TOTALS_TTL_MS),
   * keyed `${userId}|${type ?? ''}`.
   */
  private readonly anilistGroupTotals = new Map<string, AnilistGroupTotals>();

  /** The id SET defines the totals, not the stored order — hash a sorted copy. */
  private anilistIdsFingerprint(ids: number[]): string {
    const sorted = [...ids].sort((a, b) => a - b);
    let hash = 0;
    for (const id of sorted) {
      hash = (hash * 31 + id) | 0;
    }
    return `${sorted.length}:${hash}`;
  }

  /** Drop every cached totals entry a user holds (a sync landed). */
  private invalidateAnilistGroupTotals(userId: unknown): void {
    const prefix = `${String(userId)}|`;
    for (const key of this.anilistGroupTotals.keys()) {
      if (key.startsWith(prefix)) {
        this.anilistGroupTotals.delete(key);
      }
    }
  }

  private requireModels(): LibraryModels {
    if (
      !this.themeModel ||
      !this.userModel ||
      !this.favoriteModel ||
      !this.ratingModel ||
      !this.historyModel
    ) {
      throw new ServiceUnavailableException(
        'Library unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      themes: this.themeModel,
      users: this.userModel,
      favorites: this.favoriteModel,
      ratings: this.ratingModel,
      history: this.historyModel,
    };
  }

  /** Theme lookup shared by every write — this API's 404 convention. */
  private async findThemeOr404(
    models: LibraryModels,
    slug: string,
  ): Promise<ThemeCacheDocument> {
    const theme = await models.themes.findOne({ slug }).exec();
    if (!theme) {
      throw new NotFoundException(`Theme not found: ${slug}`);
    }
    return theme;
  }

  /* ---------------------------------------------------------------- */
  /* Favourites — the web's app/api/themes/favorites/route.ts.         */
  /* Storage: the `favorites` collection; NO counters move on save or  */
  /* unsave (the web's Favorite model has no hooks).                   */
  /* ---------------------------------------------------------------- */

  /** GET /library/favorites/:slug — is this theme in the caller's saves? */
  async getFavoriteState(
    userId: string,
    slug: string,
  ): Promise<FavoriteState> {
    const models = this.requireModels();
    const theme = await this.findThemeOr404(models, slug);
    const existing = await models.favorites
      .findOne({ userId, themeId: theme._id })
      .exec();
    return { slug: theme.slug, isFavorite: existing !== null };
  }

  /**
   * POST /library/favorites — the web's POST: an already-saved theme is
   * a success no-op ('Already in favorites'), never a duplicate row.
   * One deliberate tightening over the web, which trusts the client's
   * themeId blindly: the slug is resolved against the catalogue first,
   * so an unknown theme is a 404 here (this API's convention).
   */
  async addFavorite(
    userId: string,
    dto: FavoriteRequest,
  ): Promise<FavoriteState> {
    const models = this.requireModels();
    const slug = dto?.slug;
    if (!slug) {
      throw new BadRequestException('slug is required');
    }
    const theme = await this.findThemeOr404(models, slug);
    const existing = await models.favorites
      .findOne({ userId, themeId: theme._id })
      .exec();
    let created = false;
    if (!existing) {
      try {
        await models.favorites.create({
          userId,
          themeId: theme._id,
          themeSlug: theme.slug,
        });
        created = true;
      } catch (err) {
        // Lost a race against the unique (userId, themeId) index: the
        // row exists now, which is the state the caller asked for.
        // The racing request created it, so IT runs the notification
        // fan-out below — this one must not double-notify.
        if ((err as { code?: number }).code !== 11000) {
          throw err;
        }
      }
    }
    if (created) {
      // Owner-approved divergence (the web creates no such
      // notification): a NEW save notifies the saver's followers.
      // Re-saves are no-ops above, so they never reach this.
      await this.followerActivity?.notifyFollowers({
        actorId: userId,
        type: 'theme_favorited',
        entityId: theme._id,
        entityMeta: { themeTitle: theme.songTitle },
      });
    }
    return { slug: theme.slug, isFavorite: true };
  }

  /**
   * DELETE /library/favorites/:slug — the web's DELETE
   * (findOneAndDelete, success whether or not a row matched).
   */
  async removeFavorite(
    userId: string,
    slug: string,
  ): Promise<FavoriteState> {
    const models = this.requireModels();
    const theme = await this.findThemeOr404(models, slug);
    await models.favorites
      .findOneAndDelete({ userId, themeId: theme._id })
      .exec();
    return { slug: theme.slug, isFavorite: false };
  }

  /**
   * GET /library/favorites — the web's GET, including its ordering
   * quirk: favourite ids are gathered newest-save-first, but the theme
   * query itself sorts by animeSeasonYear desc / animeTitle asc, and
   * THAT is the order served. The list projects through this API's
   * ThemeSummary mapper (the web serves heavier raw documents).
   */
  async listFavorites(
    userId: string,
    page = FAVORITES_DEFAULT_PAGE,
    limit = FAVORITES_DEFAULT_LIMIT,
    type?: string,
  ): Promise<FavoritesResponse> {
    const models = this.requireModels();
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;

    const favoriteDocs = await models.favorites
      .find({ userId })
      .sort({ createdAt: -1 })
      .select('themeId')
      .lean()
      .exec();
    const themeIds = favoriteDocs.map((f) => f.themeId);

    if (themeIds.length === 0) {
      return {
        themes: [],
        total: 0,
        page: safePage,
        limit: safeLimit,
        hasMore: false,
      };
    }

    const filter: Record<string, unknown> = { _id: { $in: themeIds } };
    if (type) {
      filter.type = type;
    }

    const total = await models.themes.countDocuments(filter).exec();
    const docs = await models.themes
      .find(filter)
      .sort({ animeSeasonYear: -1, animeTitle: 1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean()
      .exec();

    return {
      themes: (docs as ThemeDoc[]).map(toThemeSummary),
      total,
      page: safePage,
      limit: safeLimit,
      hasMore: safePage * safeLimit < total,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Watch history — the web's app/api/history/route.ts plus the       */
  /* WatchHistory post('save') hook from lib/models/index.ts.          */
  /* ---------------------------------------------------------------- */

  /**
   * POST /library/history — the web's POST: resolve the theme by slug
   * (404 'Theme not found' there; this API's `Theme not found: <slug>`
   * message), insert the event row, then run the hook's counters.
   * The web validates nothing else up front — a missing/invalid mode
   * dies in Mongoose validation as a 500. Here it is a 400 instead
   * (same for ratings below): the hook semantics, which are what the
   * shared DB depends on, are unaffected.
   */
  async recordWatch(
    userId: string,
    dto: RecordWatchRequest,
  ): Promise<RecordWatchResponse> {
    const models = this.requireModels();
    const { slug, atEntryId, mode } = dto ?? ({} as RecordWatchRequest);
    if (!slug) {
      throw new BadRequestException('slug is required');
    }
    if (mode !== 'watch' && mode !== 'listen') {
      throw new BadRequestException('Invalid mode');
    }
    const theme = await this.findThemeOr404(models, slug);

    await models.history.create({
      userId,
      themeId: theme._id,
      themeSlug: theme.slug,
      atEntryId: atEntryId ?? null,
      mode,
    });

    await this.applyWatchCounters(models, {
      userId,
      theme,
      atEntryId: atEntryId ?? null,
      mode,
    });
    return { recorded: true };
  }

  /**
   * The web WatchHistory post('save') hook, ported operation for
   * operation (lib/models/index.ts):
   *   1. $inc the theme's totalWatches (mode 'watch') or totalListens
   *      (mode 'listen') by 1;
   *   2. find the played entry (atEntryId match, else the first entry)
   *      and $inc the user's totalTime by its duration (default 90).
   * The web hook swallows its own errors (try/catch + console) so a
   * counter failure never fails the history write — mirrored here.
   *
   * Perf problem 4 adds step 3: the stored profile-stats
   * maintenance applies the same play to the user record's
   * `stats*` fields (seconds via the SAME resolvePlaySeconds
   * rule; distinct-theme +1 on the user's first row for the
   * theme). It runs inside this same try/catch, and the
   * maintenance itself is failure-tolerant too — a stats failure
   * never fails the listen, exactly like the counters above.
   */
  private async applyWatchCounters(
    models: LibraryModels,
    event: {
      userId: string;
      theme: ThemeCacheDocument;
      atEntryId: number | null;
      mode: PlaybackMode;
    },
  ): Promise<void> {
    try {
      const field =
        event.mode === 'watch' ? 'totalWatches' : 'totalListens';
      await models.themes
        .findByIdAndUpdate(event.theme._id, { $inc: { [field]: 1 } })
        .exec();

      const entryDuration = resolvePlaySeconds(
        event.theme,
        event.atEntryId,
      );

      await models.users
        .findByIdAndUpdate(event.userId, {
          $inc: { totalTime: entryDuration },
        })
        .exec();

      await this.profileStats?.applyWatchDelta({
        userId: event.userId,
        theme: event.theme,
        atEntryId: event.atEntryId,
      });
    } catch (err) {
      console.error('[Library] watch counter update failed:', err);
    }
  }

  /**
   * GET /library/history — the web's GET: the caller's events, newest
   * first, capped at 50. Rows are joined with their theme summaries
   * (the web's profile-history variant populates themeId the same way;
   * its plain /api/history serves the raw rows instead).
   */
  async listHistory(userId: string): Promise<WatchHistoryResponse> {
    const models = this.requireModels();
    const docs = await models.history
      .find({ userId })
      .sort({ viewedAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean()
      .exec();

    const themeDocs =
      docs.length > 0
        ? await models.themes
            .find({ _id: { $in: docs.map((d) => d.themeId) } })
            .select(THEME_SUMMARY_PROJECTION)
            .lean()
            .exec()
        : [];
    const themesById = new Map(
      (themeDocs as ThemeDoc[]).map((t) => [String(t._id), t]),
    );

    return {
      entries: docs.map((d) => {
        const theme = themesById.get(String(d.themeId));
        return {
          id: String(d._id),
          themeSlug: d.themeSlug,
          atEntryId: d.atEntryId ?? null,
          mode: d.mode as PlaybackMode,
          viewedAt:
            d.viewedAt instanceof Date
              ? d.viewedAt.toISOString()
              : String(d.viewedAt),
          theme: theme ? toThemeSummary(theme) : null,
        };
      }),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Library count — the web's app/api/user/library/count/route.ts.    */
  /* ---------------------------------------------------------------- */

  /**
   * GET /library/count — the web's computation: how many
   * catalogue themes WITH an audio source (audioUrl ≠ null) the
   * caller has in their library, where the library is the union of
   *   - themes in the caller's watch history (distinct themeId), and
   *   - themes whose anilistId is in the caller's STORED AniList
   *     library ids (anilist.completedMediaIds — which in this API
   *     holds the completed+watching set; the AniList source was
   *     deliberately widened beyond the web's COMPLETED-only read,
   *     see AnilistLibraryClient's DEVIATION note. This route and
   *     /library/themes read the same stored set, so they agree).
   * A theme matching both sides counts once (a single $or query, as
   * on the web). With neither side populated the web answers 0
   * without ever querying the catalogue — mirrored. (The S6 merged-
   * history meta carries the same count as `libraryTotal`, computed
   * inline there with the live-fetched ids preferred; this route is
   * the standalone original, which only ever reads the stored ids —
   * no AniList fetch happens here, exactly like the web's.)
   *
   * Not-found: the web answers 404 'User not found' when the caller's
   * document is gone; kept (this module's NotFoundException style).
   */
  async getLibraryCount(userId: string): Promise<LibraryCountResponse> {
    const models = this.requireModels();
    const user = await models.users.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const localThemeIds = (await models.history
      .distinct('themeId', { userId })
      .exec()) as unknown[];
    const anilistMediaIds = user.anilist?.completedMediaIds || [];

    const orClauses: Record<string, unknown>[] = [];
    if (localThemeIds.length > 0) {
      orClauses.push({ _id: { $in: localThemeIds } });
    }
    if (anilistMediaIds.length > 0) {
      orClauses.push({ anilistId: { $in: anilistMediaIds } });
    }
    if (orClauses.length === 0) {
      return { count: 0 };
    }

    const count = await models.themes
      .countDocuments({ audioUrl: { $ne: null }, $or: orClauses })
      .exec();
    return { count };
  }

  /* ---------------------------------------------------------------- */
  /* Library themes — the web's app/api/themes/library/route.ts (S8).  */
  /* ---------------------------------------------------------------- */

  /**
   * GET /library/themes — the web's themes/library read: catalogue
   * themes the caller has watched/listened to locally (their watch
   * history's theme ids) UNION themes whose anilistId is in their
   * AniList library set, ordered animeSeasonYear desc /
   * animeTitle asc (the same order the favourites list serves),
   * paged with the web's defaults (page 1, limit 50), `type`
   * filtering OP/ED when given. ONE deliberate deviation from the
   * web: the AniList set covers COMPLETED + CURRENT (watching),
   * not the web's COMPLETED only — see AnilistLibraryClient.
   *
   * The AniList side mirrors the web's cache dance, with ONE
   * deliberate widening (perf problem 15, B7):
   * - the stored completedMediaIds are served as-is while fresh
   *   (syncedAt within 6 hours);
   * - stale WITH a stored cache: the stored ids are served, a
   *   best-effort background refresh is fired (its result lands
   *   on the user document for next time — fire-and-forget, its
   *   failures swallowed), and the response flags
   *   anilistSyncDeferred + anilistDataStale;
   * - no cache (or an empty one): the web AWAITS one fetch under
   *   its 1500 ms timeout here; since B7 this API defers it
   *   exactly like the stale branch — what exists (possibly
   *   nothing) is served, the refresh fires behind the response,
   *   and the same two flags are set — so a first Library open
   *   never blocks on AniList. The empty first-open page is the
   *   honest empty state, never fabricated rows.
   * When NEITHER side yields anything, the web answers early with
   * an empty page whose meta carries NO AniList fields — mirrored
   * (the response simply omits them).
   *
   * `source=anilist` (owner ruling 2026-11-10, "Option B") serves
   * the AniList side ALONE: the Library segment it feeds shows
   * themes from the caller's AniList anime, never their watch
   * history, so the history clause is dropped entirely — the query
   * is only `anilistId ∈ stored ids`, with the same cache dance,
   * ordering and meta as the union. An unlinked caller (or
   * a linked one whose ids never landed) gets the same plain early
   * return the union gives an empty library. Any other `source`
   * value (or none) keeps the union byte-identical.
   *
   * The AniList source's paging unit is the ANIME GROUP, not the
   * theme (owner's lazy-loading order, 2026-11-10 — the segment
   * froze rendering ~950 themes at once): page/limit count groups
   * (default 10, capped at 50), a group never splits across pages,
   * and the response carries totalGroups / totalThemes / hasMore.
   * Group order is the order the groups' first themes take in the
   * served sort (year desc, title asc) — the same order the client
   * has always grouped by — computed from ONE projected pass over
   * the matching set (anilistId only), so the totals cost no full
   * serialisation; only the page's own themes are read whole.
   * Since B7 the pass's totals are cached per (user, type) for
   * ~60 s (invalidated when a sync lands), so paging through the
   * segment does not re-run the pass per page.
   *
   * Not-found: the caller's document being gone is the web's 404
   * 'User not found'; kept, in this module's style.
   */
  async listLibraryThemes(
    userId: string,
    page = FAVORITES_DEFAULT_PAGE,
    limit?: number,
    type?: string,
    source?: string,
  ): Promise<LibraryThemesResponse> {
    const models = this.requireModels();
    const safePage = Number.isFinite(page) && page > 0 ? page : 1;
    const safeLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? Math.trunc(limit)
        : FAVORITES_DEFAULT_LIMIT;
    const anilistOnly = source === 'anilist';
    const groupLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? Math.min(Math.trunc(limit), ANILIST_GROUP_LIMIT_CAP)
        : ANILIST_GROUP_DEFAULT_LIMIT;

    const user = await models.users.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // 1. Watched themes (the web takes every history row's themeId;
    // duplicates collapse inside the $in query itself). Skipped
    // entirely in the AniList-only mode — history never contributes
    // there.
    const watchedThemeIds: unknown[] = [];
    if (!anilistOnly) {
      const historyDocs = await models.history
        .find({ userId: user._id })
        .select('themeId')
        .lean()
        .exec();
      watchedThemeIds.push(...historyDocs.map((wh) => wh.themeId));
    }

    // 2. AniList library media ids (completed+watching), per the
    // cache dance above.
    let anilistMediaIds: number[] = [];
    let anilistSyncDeferred = false;
    let anilistDataStale = false;
    if (user.anilist?.accessToken && user.anilist?.userId) {
      const accessToken = user.anilist.accessToken;
      const anilistUserId = user.anilist.userId;
      let mediaIds = user.anilist.completedMediaIds || [];
      const sixHours = 1000 * 60 * 60 * 6;
      const isStale =
        !user.anilist.syncedAt ||
        new Date().getTime() - new Date(user.anilist.syncedAt).getTime() >
          sixHours;
      anilistDataStale = isStale;

      if (mediaIds.length === 0 || isStale) {
        // Stale WITH a cache and first-ever/empty sync alike
        // (perf problem 15, B7): serve what exists — the stored
        // ids, or nothing — and refresh behind the response, so
        // no Library open ever waits on AniList inline. (The web's
        // deferred branch, generalised from the stale case to the
        // first sync: its awaited fetch cost a first open up to
        // the client's 1500 ms timeout.) The empty first-open
        // state is the honest empty page — never fabricated rows —
        // and the refreshed ids land on the user document for the
        // next read.
        anilistSyncDeferred = true;
        void this.refreshStoredLibraryIds(
          models,
          user._id,
          accessToken,
          anilistUserId,
        );
      }
      anilistMediaIds = mediaIds;
    }

    if (watchedThemeIds.length === 0 && anilistMediaIds.length === 0) {
      // The web's early return — no AniList meta fields at all.
      // The AniList source still carries its group-pagination meta
      // (zeros), the shape its client pages against.
      if (anilistOnly) {
        return {
          themes: [],
          total: 0,
          totalThemes: 0,
          totalGroups: 0,
          page: safePage,
          limit: groupLimit,
          hasMore: false,
        };
      }
      return { themes: [], total: 0, page: safePage, limit: safeLimit };
    }

    // 3. The union query (the web projects its heavy fields out;
    // this API projects ThemeSummary, as everywhere here).
    const queryConditions: Record<string, unknown>[] = [];
    if (watchedThemeIds.length > 0) {
      queryConditions.push({ _id: { $in: watchedThemeIds } });
    }
    if (anilistMediaIds.length > 0) {
      queryConditions.push({ anilistId: { $in: anilistMediaIds } });
    }
    const filter: Record<string, unknown> = { $or: queryConditions };
    if (type) {
      filter.type = type;
    }

    if (anilistOnly) {
      // Group pagination: one projected pass over the matching set
      // in the served order fixes the group order (first appearance
      // in that order) and the per-group counts; the page then reads
      // ONLY its own groups' themes, whole. The pass's OUTPUT (the
      // totals) is cached per (user, type) for ~60s (B7) — pages
      // 2..N and repeat opens reuse it instead of re-running the
      // pass; the page read below always stays live.
      const totalsKey = `${String(user._id)}|${type ?? ''}`;
      const fingerprint = this.anilistIdsFingerprint(anilistMediaIds);
      const cachedTotals = this.anilistGroupTotals.get(totalsKey);
      let groupOrder: number[];
      let totalThemes: number;
      if (
        cachedTotals &&
        cachedTotals.fingerprint === fingerprint &&
        cachedTotals.expiresAt > Date.now()
      ) {
        groupOrder = cachedTotals.groupOrder;
        totalThemes = cachedTotals.totalThemes;
      } else {
        const idRows = (await models.themes
          .find(filter)
          .sort({ animeSeasonYear: -1, animeTitle: 1 })
          .select('anilistId')
          .lean()
          .exec()) as unknown as { anilistId: number }[];
        groupOrder = [];
        const seenGroups = new Set<number>();
        for (const row of idRows) {
          if (!seenGroups.has(row.anilistId)) {
            seenGroups.add(row.anilistId);
            groupOrder.push(row.anilistId);
          }
        }
        totalThemes = idRows.length;
        this.anilistGroupTotals.set(totalsKey, {
          fingerprint,
          groupOrder,
          totalThemes,
          expiresAt: Date.now() + ANILIST_GROUP_TOTALS_TTL_MS,
        });
      }
      const totalGroups = groupOrder.length;
      const pageIds = groupOrder.slice(
        (safePage - 1) * groupLimit,
        safePage * groupLimit,
      );
      const pageFilter: Record<string, unknown> = {
        $or: [{ anilistId: { $in: pageIds } }],
      };
      if (type) {
        pageFilter.type = type;
      }
      const pageDocs =
        pageIds.length > 0
          ? await models.themes
              .find(pageFilter)
              .sort({ animeSeasonYear: -1, animeTitle: 1 })
              .lean()
              .exec()
          : [];
      return {
        themes: (pageDocs as ThemeDoc[]).map(toThemeSummary),
        total: totalThemes,
        totalThemes,
        totalGroups,
        page: safePage,
        limit: groupLimit,
        hasMore: safePage * groupLimit < totalGroups,
        anilistUser: user.anilist?.username || null,
        anilistSyncDeferred,
        anilistDataStale,
      };
    }

    const total = await models.themes.countDocuments(filter).exec();
    const docs = await models.themes
      .find(filter)
      .sort({ animeSeasonYear: -1, animeTitle: 1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean()
      .exec();

    return {
      themes: (docs as ThemeDoc[]).map(toThemeSummary),
      total,
      page: safePage,
      limit: safeLimit,
      anilistUser: user.anilist?.username || null,
      anilistSyncDeferred,
      anilistDataStale,
    };
  }

  /**
   * The deferred branch's background refresh: fetch fresh ids and,
   * on a non-empty result, store them + a new syncedAt. Entirely
   * best-effort — the web fires it with `.catch(() => {})`;
   * mirrored.
   */
  private async refreshStoredLibraryIds(
    models: LibraryModels,
    userId: unknown,
    accessToken: string,
    anilistUserId: number,
  ): Promise<void> {
    try {
      const freshIds = this.anilistLibrary
        ? await this.anilistLibrary.fetchLibraryMediaIds(
            accessToken,
            anilistUserId,
          )
        : null;
      if (freshIds && freshIds.length > 0) {
        await models.users
          .findByIdAndUpdate(userId, {
            'anilist.completedMediaIds': freshIds,
            'anilist.syncedAt': new Date(),
          })
          .exec();
        // B7: a landed sync supersedes any cached group totals
        // for this user. (The entries' id fingerprint would catch
        // a changed set on its own; the explicit drop also covers
        // a same-set refresh, whose totals may still have moved
        // with the catalogue.)
        this.invalidateAnilistGroupTotals(userId);
      }
    } catch {
      // Best-effort refresh — a failure leaves the stored cache as-is.
    }
  }

  /* ---------------------------------------------------------------- */
  /* AniList entries — GET /library/anilist-entries (polish pass).     */
  /* ---------------------------------------------------------------- */

  /**
   * GET /library/anilist-entries — the caller's AniList Watching
   * (CURRENT) + Completed entries for the Library's AniList
   * segment: per-entry progress, score, format, episodes, cover
   * and titles, read from AniList itself with the caller's stored
   * token. NEW capability, no web counterpart: the web stores
   * only the merged media ids (completedMediaIds), which cannot
   * draw the designed entry cards.
   *
   * The cache dance mirrors listLibraryThemes' stored-ids dance
   * exactly, over the API-only `anilistEntriesCache` sub-document:
   * - fresh cache (syncedAt within 6 hours): served as-is;
   * - stale WITH a cache: the cache is served, a best-effort
   *   background refresh is fired, and the response flags
   *   anilistSyncDeferred + anilistDataStale;
   * - no cache: a single awaited fetch under the client's
   *   1500 ms timeout; a non-empty result is persisted before
   *   the response.
   * Degradation is silent by contract: unlinked callers get
   * `linked: false`, and a linked caller whose fetch failed with
   * no cache gets `available: false` — the mobile segment falls
   * back to the /library/themes union view in both cases. A
   * genuinely empty AniList library (a fetch that succeeds with
   * zero entries) is NOT persisted, mirroring the ids dance, and
   * also answers `available: false`.
   *
   * Not-found: the caller's document being gone is the module's
   * usual 404 'User not found'.
   */
  async getAnilistEntries(userId: string): Promise<AnilistEntriesResponse> {
    const models = this.requireModels();
    const user = await models.users.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const anilistUser = user.anilist?.username ?? null;
    if (!user.anilist?.accessToken || !user.anilist?.userId) {
      return {
        linked: false,
        available: false,
        anilistUser,
        watching: [],
        completed: [],
      };
    }
    const accessToken = user.anilist.accessToken;
    const anilistUserId = user.anilist.userId;

    const cache = user.anilistEntriesCache;
    let entries: AnilistLibraryEntry[] = (cache?.entries ?? []).map(
      (e) => ({
        mediaId: e.mediaId,
        status: e.status,
        title: e.title,
        coverImage: e.coverImage ?? null,
        format: e.format ?? null,
        episodes: e.episodes ?? null,
        progress: e.progress ?? 0,
        score: e.score ?? null,
      }),
    );
    let syncDeferred = false;

    const sixHours = 1000 * 60 * 60 * 6;
    const isStale =
      !cache?.syncedAt ||
      new Date().getTime() - new Date(cache.syncedAt).getTime() > sixHours;

    if (entries.length > 0 && isStale) {
      // Stale but cached: serve the cache, refresh behind the
      // response (the deferred branch, as in listLibraryThemes —
      // its anilistDataStale is always true on this branch too).
      syncDeferred = true;
      void this.refreshStoredEntries(
        models,
        user._id,
        accessToken,
        anilistUserId,
      );
    } else if (entries.length === 0) {
      // First sync (or an empty cache): one awaited attempt.
      const fresh = this.anilistLibrary
        ? await this.anilistLibrary.fetchLibraryEntries(
            accessToken,
            anilistUserId,
          )
        : null;
      if (fresh && fresh.length > 0) {
        entries = fresh;
        await models.users
          .findByIdAndUpdate(user._id, {
            anilistEntriesCache: {
              syncedAt: new Date(),
              entries: fresh,
            },
          })
          .exec();
      }
    }

    if (entries.length === 0) {
      return {
        linked: true,
        available: false,
        anilistUser,
        watching: [],
        completed: [],
      };
    }

    const toContract = (e: AnilistLibraryEntry): AnilistEntry => ({
      mediaId: e.mediaId,
      title: e.title,
      coverImage: e.coverImage,
      format: e.format,
      episodes: e.episodes,
      progress: e.progress,
      score: e.score,
    });
    return {
      linked: true,
      available: true,
      anilistUser,
      watching: entries
        .filter((e) => e.status === 'CURRENT')
        .map(toContract),
      completed: entries
        .filter((e) => e.status === 'COMPLETED')
        .map(toContract),
      ...(syncDeferred
        ? { anilistSyncDeferred: true, anilistDataStale: true }
        : {}),
    };
  }

  /**
   * The entries cache's deferred-branch background refresh: fetch
   * fresh entries and, on a non-empty result, store them + a new
   * syncedAt. Entirely best-effort, like refreshStoredLibraryIds.
   */
  private async refreshStoredEntries(
    models: LibraryModels,
    userId: unknown,
    accessToken: string,
    anilistUserId: number,
  ): Promise<void> {
    try {
      const fresh = this.anilistLibrary
        ? await this.anilistLibrary.fetchLibraryEntries(
            accessToken,
            anilistUserId,
          )
        : null;
      if (fresh && fresh.length > 0) {
        await models.users
          .findByIdAndUpdate(userId, {
            anilistEntriesCache: {
              syncedAt: new Date(),
              entries: fresh,
            },
          })
          .exec();
      }
    } catch {
      // Best-effort refresh — a failure leaves the stored cache as-is.
    }
  }

  /* ---------------------------------------------------------------- */
  /* History check — the web's app/api/history/check/route.ts (S8).    */
  /* ---------------------------------------------------------------- */

  /**
   * GET /library/history/check?slug=… — has the caller watched
   * this theme? The web's route is OPTIONAL-auth: no session
   * answers `{ watched: false }` (never a 401), and the session
   * is resolved BEFORE the slug is validated, so an anonymous
   * caller gets watched:false even with no slug while a signed-in
   * caller without one gets the web's 400 'Slug required'. The
   * controller resolves the optional session and hands the user
   * id (or null) in; the order is preserved here.
   */
  async checkWatched(
    userId: string | null,
    slug?: string,
  ): Promise<HistoryCheckResponse> {
    const models = this.requireModels();
    if (!userId) {
      return { watched: false };
    }
    if (!slug) {
      throw new BadRequestException('Slug required');
    }
    const found = await models.history.exists({ userId, themeSlug: slug });
    return { watched: !!found };
  }

  /* ---------------------------------------------------------------- */
  /* Ratings — the web's app/api/themes/[slug]/rate/route.ts plus the  */
  /* Rating post('save') hook from lib/models/index.ts.                */
  /* ---------------------------------------------------------------- */

  /** GET /themes/:slug/rating — the caller's rating + the aggregate. */
  async getRatingState(
    userId: string,
    slug: string,
  ): Promise<ThemeRatingState> {
    const models = this.requireModels();
    const theme = await this.findThemeOr404(models, slug);
    const rating = await models.ratings
      .findOne({ userId, themeId: theme._id })
      .lean()
      .exec();
    return {
      slug: theme.slug,
      myScore: rating ? rating.score : null,
      myMode: rating ? (rating.mode as PlaybackMode) : null,
      avgRating: theme.avgRating ?? 0,
      totalRatings: theme.totalRatings ?? 0,
    };
  }

  /**
   * PUT /themes/:slug/rating — the web's POST: find-or-create the
   * caller's rating, then run the hook's aggregate maintenance.
   * Score validation is the web's (`< 1 || > 10` → 400 'Invalid
   * score'); fractional scores pass, as they do on the web. Mode is
   * the one softening: the web requires it (a missing mode 500s in
   * Mongoose); here a create defaults to 'watch' and an update keeps
   * the stored mode when none is sent.
   */
  async setRating(
    userId: string,
    slug: string,
    dto: SetRatingRequest,
  ): Promise<ThemeRatingState> {
    const models = this.requireModels();
    const { score, mode } = dto ?? ({} as SetRatingRequest);
    if (typeof score !== 'number' || Number.isNaN(score) || score < 1 || score > 10) {
      // The web's check is `score < 1 || score > 10`; the type guard
      // only adds the cases the web crashes on (missing/non-number).
      throw new BadRequestException('Invalid score');
    }
    if (mode !== undefined && mode !== 'watch' && mode !== 'listen') {
      throw new BadRequestException('Invalid mode');
    }
    const theme = await this.findThemeOr404(models, slug);

    const existing = await models.ratings
      .findOne({ userId, themeId: theme._id })
      .exec();

    let isNew = false;
    if (existing) {
      await models.ratings
        .findByIdAndUpdate(existing._id, {
          $set: { score, ...(mode ? { mode } : {}) },
        })
        .exec();
    } else {
      try {
        await models.ratings.create({
          userId,
          themeId: theme._id,
          themeSlug: theme.slug,
          score,
          mode: mode ?? 'watch',
        });
        isNew = true;
      } catch (err) {
        // Lost a race against the unique (userId, themeId) index: the
        // rating exists now — update it like the web's find-then-save
        // would have, and do NOT count it as a first rating.
        if ((err as { code?: number }).code !== 11000) {
          throw err;
        }
        await models.ratings
          .findOneAndUpdate(
            { userId, themeId: theme._id },
            { $set: { score, ...(mode ? { mode } : {}) } },
          )
          .exec();
      }
    }

    const aggregate = await this.syncRatingAggregates(
      models,
      theme._id,
      userId,
      isNew,
    );
    // Perf problem 4: refresh the rater's stored rating stats
    // (sum + count) from the settled rows — a recompute, so the
    // create / update / lost-race branches above all land on the
    // same truth. Failure-tolerant: never fails the rating.
    await this.profileStats?.refreshRatingStats(userId);
    // Read the stored row back so the response is the state of record
    // even when the create above lost the unique-index race.
    const stored = await models.ratings
      .findOne({ userId, themeId: theme._id })
      .lean()
      .exec();
    // Owner-approved divergence (the web creates no such
    // notification): rating a theme notifies the rater's followers,
    // carrying the final stored score. Create and update both land
    // here; the fan-out's unread-dedupe keeps re-rates from
    // stacking duplicates (see FollowerActivityService).
    await this.followerActivity?.notifyFollowers({
      actorId: userId,
      type: 'theme_rated',
      entityId: theme._id,
      entityMeta: {
        themeTitle: theme.songTitle,
        score: stored ? stored.score : score,
      },
    });
    return {
      slug: theme.slug,
      myScore: stored ? stored.score : score,
      myMode: stored ? (stored.mode as PlaybackMode) : (mode ?? 'watch'),
      avgRating: aggregate.avgRating,
      totalRatings: aggregate.totalRatings,
    };
  }

  /**
   * DELETE /themes/:slug/rating — clear the caller's rating.
   *
   * THE WEB HAS NO EQUIVALENT: its rate route is POST/GET only and
   * nothing in the web codebase deletes a Rating. This is the closest
   * faithful equivalent its data model supports: remove the row, then
   * run the SAME aggregate recompute the post('save') hook runs (the
   * theme lands on the values the hook would produce for the remaining
   * ratings — 0/0 when none remain) and reverse the hook's first-rating
   * $inc on the user. Clearing an unrated theme is a no-op success,
   * like the web's favourite DELETE.
   */
  async clearRating(
    userId: string,
    slug: string,
  ): Promise<ThemeRatingState> {
    const models = this.requireModels();
    const theme = await this.findThemeOr404(models, slug);

    const existing = await models.ratings
      .findOne({ userId, themeId: theme._id })
      .lean()
      .exec();

    if (!existing) {
      return {
        slug: theme.slug,
        myScore: null,
        myMode: null,
        avgRating: theme.avgRating ?? 0,
        totalRatings: theme.totalRatings ?? 0,
      };
    }

    await models.ratings.findByIdAndDelete(existing._id).exec();
    const aggregate = await this.syncRatingAggregates(
      models,
      theme._id,
      userId,
      false,
    );
    // Reverse the hook's first-rating increment (see the note above).
    await models.users
      .findByIdAndUpdate(userId, { $inc: { totalRatings: -1 } })
      .exec();
    // Perf problem 4: the stored rating stats follow the delete
    // (the recompute now sees one fewer row). Failure-tolerant.
    await this.profileStats?.refreshRatingStats(userId);

    return {
      slug: theme.slug,
      myScore: null,
      myMode: null,
      avgRating: aggregate.avgRating,
      totalRatings: aggregate.totalRatings,
    };
  }

  /**
   * The web Rating post('save') hook, ported operation for operation
   * (lib/models/index.ts):
   *   1. aggregate the theme's ratings ($avg score, $sum count);
   *   2. write ThemeCache.avgRating (2-dp rounded, NaN-guarded) and
   *      ThemeCache.totalRatings from that aggregate;
   *   3. on a FIRST rating only (the hook's `this.isNew`), $inc the
   *      user's totalRatings by 1.
   * Returns the aggregate as written, for the response body.
   */
  private async syncRatingAggregates(
    models: LibraryModels,
    themeId: unknown,
    userId: string,
    isNew: boolean,
  ): Promise<{ avgRating: number; totalRatings: number }> {
    const stats = await models.ratings.aggregate([
      { $match: { themeId } },
      { $group: { _id: null, avg: { $avg: '$score' }, count: { $sum: 1 } } },
    ]);
    const rawAvg = stats[0]?.avg ?? 0;
    const avgRating = Number.isNaN(rawAvg as number)
      ? 0
      : parseFloat((rawAvg as number).toFixed(2));
    const totalRatings = (stats[0]?.count as number) ?? 0;

    await models.themes
      .findByIdAndUpdate(themeId, { avgRating, totalRatings })
      .exec();

    if (isNew) {
      await models.users
        .findByIdAndUpdate(userId, { $inc: { totalRatings: 1 } })
        .exec();
    }
    return { avgRating, totalRatings };
  }
}

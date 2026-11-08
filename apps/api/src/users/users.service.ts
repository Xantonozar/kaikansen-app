import {
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import type {
  MergedHistoryEntry,
  UserHistoryResponse,
  UserMergedHistoryResponse,
  UserRatingEntry,
  UserRatingsResponse,
  WatchHistoryEntry,
} from '@kaikansen/contracts';
import { AuthService } from '../auth/auth.service';
import { User, type UserDocument } from '../auth/user.schema';
import { Rating, type RatingDocument } from '../library/rating.schema';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { toThemeSummary, type ThemeDoc } from '../themes/theme.mapper';
import { AnilistHistoryClient } from './anilist-history.client';
import {
  mergeWatchHistory,
  normalizeAniListEntry,
  normalizeLocalEntry,
  type NormalizedWatchEntry,
} from './history.utils';

/** The web's per-user history cap (history route: .limit(50)). */
const HISTORY_LIMIT = 50;

/** The web's per-user ratings cap (ratings route: .limit(50)). */
const RATINGS_LIMIT = 50;

function iso(value: Date | string | null | undefined): string {
  if (value == null) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Lean shapes of the documents as they come back from Mongoose. */
type UserDoc = User & { _id: Types.ObjectId };
type RatingDoc = Rating & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};
type HistoryDoc = WatchHistory & { _id: unknown };

interface UsersModels {
  users: Model<UserDocument>;
  ratings: Model<RatingDocument>;
  history: Model<WatchHistoryDocument>;
  themes: Model<ThemeCacheDocument>;
}

/**
 * Per-user history + ratings (Slice S6) — the two reads of the
 * web's users/[username] surface that S5 deliberately left
 * behind: GET /api/users/[username]/history and
 * GET /api/users/[username]/ratings over the shared
 * `watchhistories` and `ratings` collections.
 *
 * What the web actually does (read from its code):
 * - BOTH routes are fully PUBLIC: no session is consulted for the
 *   local data, there is no isPublic check and no follow gate —
 *   any caller can read any user's 50 most recent ratings and
 *   watch rows. (Unlike S5's activity route, which gates — and
 *   gates backwards. These two simply don't gate at all.)
 *   Mirrored as-is and flagged: do not "fix" unilaterally.
 * - Ratings: Rating.find({ userId }).sort({ createdAt: -1 })
 *   .limit(50), themeId populated.
 * - History, default mode: WatchHistory.find({ userId })
 *   .sort({ viewedAt: -1 }).limit(50), themeId populated, served
 *   with meta { total, localCount, remoteCount: 0, merged:
 *   false } (total/localCount are just the row count).
 * - History, merged mode (?includeMerged=1): the same 50 rows are
 *   normalized (lib/history-utils port — see history.utils.ts)
 *   and merged with the owner's AniList COMPLETED list. The
 *   remote side exists ONLY for the owner viewing their own
 *   history (the web checks its session payload against the
 *   profile id) with a stored AniList token, and can be switched
 *   off with ?includeRemote=0. AniList failures are swallowed
 *   into meta.anilistError (the web's exact messages, the abort
 *   timeout reading 'AniList request timed out'). meta then also
 *   carries libraryTotal: catalogue themes with an audio source
 *   whose id is in the user's watched-theme ids or whose
 *   anilistId is in the remote media ids — falling back to the
 *   stored anilist.completedMediaIds when the remote fetch
 *   returned nothing.
 *
 * Mirrored quirks, deliberately kept:
 * - meta.anilistIncluded is `includeRemote && isOwnProfile &&
 *   Boolean(accessToken)` — it does NOT also require the AniList
 *   userId, though the fetch itself does.
 * - The web computes localCount in merged mode AFTER dropping
 *   rows whose theme no longer exists; in default mode no such
 *   filtering happens (a gone theme is a null join here).
 *
 * Deliberate deviations (the established S1–S5 ones):
 * - The web serves raw documents with the full theme document in
 *   place of themeId; this API projects rows into the contract
 *   shapes with the standard ThemeSummary join (null when the
 *   theme is gone), like every other read here.
 * - The web answers its generic 500 on unexpected failures; this
 *   API answers its clean codes (404 'User not found', 503
 *   without a database).
 * - The web's session is its cookie/proxy payload; the merged
 *   mode's owner check reads this API's Bearer access token (the
 *   S5 optional-auth precedent). No/invalid token = not the
 *   owner = local-only merge, never a 401.
 *
 * The models are OPTIONAL like everywhere else in this API:
 * booted without MONGODB_URI, every method answers 503 while
 * /health works.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly auth: AuthService,
    private readonly anilistHistory: AnilistHistoryClient,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(Rating.name)
    private readonly ratingModel?: Model<RatingDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly historyModel?: Model<WatchHistoryDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
  ) {}

  private requireModels(): UsersModels {
    if (
      !this.userModel ||
      !this.ratingModel ||
      !this.historyModel ||
      !this.themeModel
    ) {
      throw new ServiceUnavailableException(
        'User history/ratings unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      users: this.userModel,
      ratings: this.ratingModel,
      history: this.historyModel,
      themes: this.themeModel,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * The web session helpers answer "no payload" for absent AND
   * invalid sessions alike; optional-auth endpoints mirror that:
   * any Bearer token that does not verify simply means anonymous
   * (the S5 precedent).
   */
  private optionalUserId(authorization?: string): string | null {
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return null;
    }
    const payload = this.auth.verifyAccessToken(
      authorization.slice('Bearer '.length),
    );
    return payload ? payload.userId : null;
  }

  /** User lookup by username — the web lower-cases the parameter. */
  private async findUserOr404(
    models: UsersModels,
    username: string,
  ): Promise<UserDoc> {
    const user = (await models.users
      .findOne({ username: String(username ?? '').toLowerCase() })
      .exec()) as UserDoc | null;
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /** Batch-join themes by id (rows with a gone theme map to null). */
  private async themesById(
    models: UsersModels,
    ids: unknown[],
  ): Promise<Map<string, ThemeDoc>> {
    const unique = [...new Set(ids.map((id) => String(id)))];
    if (unique.length === 0) {
      return new Map();
    }
    const docs = (await models.themes
      .find({ _id: { $in: unique } })
      .lean()
      .exec()) as ThemeDoc[];
    return new Map(docs.map((t) => [String(t._id), t]));
  }

  /* ---------------------------------------------------------------- */
  /* Ratings                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * GET /users/:username/ratings — the web's ratings route,
   * verbatim in behaviour: the user's 50 most recent ratings,
   * newest first, themes joined in. Public; unknown usernames
   * 404 (the web's own message).
   */
  async getRatings(username: string): Promise<UserRatingsResponse> {
    const models = this.requireModels();
    const user = await this.findUserOr404(models, username);

    const docs = (await models.ratings
      .find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(RATINGS_LIMIT)
      .lean()
      .exec()) as RatingDoc[];

    const themes = await this.themesById(
      models,
      docs.map((r) => r.themeId),
    );

    const ratings: UserRatingEntry[] = docs.map((r) => {
      const theme = themes.get(String(r.themeId));
      return {
        id: String(r._id),
        themeSlug: r.themeSlug,
        score: r.score,
        mode: r.mode === 'listen' ? 'listen' : 'watch',
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
        theme: theme ? toThemeSummary(theme) : null,
      };
    });

    return { ratings };
  }

  /* ---------------------------------------------------------------- */
  /* History                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * GET /users/:username/history — the web's history route in
   * both modes (see the class comment). `includeMerged` is the
   * web's exact flag ('1' only); `includeRemote` defaults on and
   * is only read in merged mode, like the web's.
   */
  async getHistory(
    authorization: string | undefined,
    username: string,
    includeMergedParam?: string,
    includeRemoteParam?: string,
  ): Promise<UserHistoryResponse | UserMergedHistoryResponse> {
    const models = this.requireModels();
    const user = await this.findUserOr404(models, username);
    const includeMerged = includeMergedParam === '1';

    const docs = (await models.history
      .find({ userId: user._id })
      .sort({ viewedAt: -1 })
      .limit(HISTORY_LIMIT)
      .lean()
      .exec()) as HistoryDoc[];

    const themes = await this.themesById(
      models,
      docs.map((h) => h.themeId),
    );

    if (!includeMerged) {
      const entries: WatchHistoryEntry[] = docs.map((h) => {
        const theme = themes.get(String(h.themeId));
        return {
          id: String(h._id),
          themeSlug: h.themeSlug,
          atEntryId: h.atEntryId ?? null,
          mode: h.mode === 'listen' ? 'listen' : 'watch',
          viewedAt: iso(h.viewedAt),
          theme: theme ? toThemeSummary(theme) : null,
        };
      });
      return {
        entries,
        meta: {
          total: entries.length,
          localCount: entries.length,
          remoteCount: 0,
          merged: false,
        },
      };
    }

    /* ------------------------- merged mode ------------------------- */

    // The web filters rows whose populated theme is gone BEFORE
    // normalizing — mirrored via the join map.
    const localEntries: NormalizedWatchEntry[] = [];
    for (const h of docs) {
      const theme = themes.get(String(h.themeId));
      if (theme) {
        localEntries.push(
          normalizeLocalEntry({ viewedAt: h.viewedAt, theme }),
        );
      }
    }

    let remoteEntries: NormalizedWatchEntry[] = [];
    let anilistError: string | null = null;

    const meId = this.optionalUserId(authorization);
    const isOwnProfile = meId !== null && meId === String(user._id);
    const includeRemote = includeRemoteParam !== '0';

    if (
      includeRemote &&
      isOwnProfile &&
      user.anilist?.accessToken &&
      user.anilist?.userId
    ) {
      try {
        const fetched = await this.anilistHistory.fetchCompletedEntries(
          user.anilist.accessToken,
          user.anilist.userId,
        );
        remoteEntries = fetched.map(normalizeAniListEntry);
      } catch (error) {
        anilistError =
          error instanceof Error
            ? error.name === 'AbortError'
              ? 'AniList request timed out'
              : error.message
            : 'Failed to fetch AniList history';
      }
    }

    const merged = mergeWatchHistory(localEntries, remoteEntries);

    // libraryTotal — the web's count: themes with an audio source
    // among (locally watched theme ids) ∪ (AniList completed ids,
    // with the stored completedMediaIds as the fallback when the
    // remote fetch returned nothing).
    const localThemeIds = (await models.history
      .distinct('themeId', { userId: user._id })
      .exec()) as unknown[];
    const remoteMediaIds = remoteEntries
      .map((entry) => Number(entry.id))
      .filter((id) => Number.isFinite(id));
    const fallbackMediaIds = user.anilist?.completedMediaIds || [];
    const mediaIdsForLibraryCount =
      remoteMediaIds.length > 0 ? remoteMediaIds : fallbackMediaIds;

    const libraryOrClauses: Record<string, unknown>[] = [];
    if (localThemeIds.length > 0) {
      libraryOrClauses.push({ _id: { $in: localThemeIds } });
    }
    if (mediaIdsForLibraryCount.length > 0) {
      libraryOrClauses.push({ anilistId: { $in: mediaIdsForLibraryCount } });
    }
    const libraryTotal =
      libraryOrClauses.length > 0
        ? await models.themes
            .countDocuments({
              audioUrl: { $ne: null },
              $or: libraryOrClauses,
            })
            .exec()
        : 0;

    const entries: MergedHistoryEntry[] = merged.map((e) => ({
      id: e.id,
      title: e.title,
      animeTitle: e.animeTitle ?? null,
      episodeCount: e.episodeCount ?? null,
      lastWatchedAt: e.lastWatchedAt.toISOString(),
      source: e.source,
      image: e.image ?? null,
      type: e.type ?? null,
      slug: e.slug ?? null,
    }));

    return {
      entries,
      meta: {
        total: merged.length,
        libraryTotal,
        localCount: localEntries.length,
        remoteCount: remoteEntries.length,
        merged: true,
        anilistConnected: Boolean(user.anilist?.userId),
        // The web's flag — note it does NOT require the AniList
        // userId, though the fetch itself does. Mirrored.
        anilistIncluded:
          includeRemote &&
          isOwnProfile &&
          Boolean(user.anilist?.accessToken),
        anilistError,
      },
    };
  }
}

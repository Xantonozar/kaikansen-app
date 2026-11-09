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
  CommentAuthor,
  FollowState,
  FriendsActivityItem,
  FriendsActivityResponse,
  MarkNotificationsReadResponse,
  NetworkResponse,
  NetworkUser,
  NotificationItem,
  NotificationsResponse,
  NotificationType,
  RankTier,
  UserActivityItem,
  UserActivityResponse,
  UserPublicProfile,
  UserSearchResponse,
  UserStats,
} from '@kaikansen/contracts';
import { AuthService } from '../auth/auth.service';
import { User, type UserDocument } from '../auth/user.schema';
import {
  UserRank,
  type UserRankDocument,
} from '../quiz/user-rank.schema';
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
import { Follow, type FollowDocument } from './follow.schema';
import {
  Notification,
  type NotificationDocument,
} from './notification.schema';
import {
  PlaylistActivity,
  type PlaylistActivityDocument,
} from '../playlists/playlist-activity.schema';

/** The web's notification list cap (GET /api/notifications). */
const NOTIFICATION_LIST_LIMIT = 50;

/** The web's user-search page size (the USERS branch of /api/search). */
const USER_SEARCH_PAGE_SIZE = 20;

/** The web's friends-activity default limit (?limit= absent). */
const FEED_DEFAULT_LIMIT = 3;

/** The web's friends-activity hard cap: Math.min(limit, 50). */
const FEED_MAX_LIMIT = 50;

/** The web's per-user activity caps: 10 + 10 rows merged, sliced to 15. */
const PROFILE_ACTIVITY_PER_KIND = 10;
const PROFILE_ACTIVITY_LIMIT = 15;

/* Search normalisation limits — the web search's own values. */
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
 * OP/ED modifier parsing, ported from the web's parseThemeModifiers
 * (the same port themes.service.ts carries). The user search needs
 * it for one quirk: when the web's search parses a theme modifier
 * out of the query, the USERS branch is skipped entirely.
 */
function parseThemeModifiers(words: string[]): {
  cleanWords: string[];
  themeModifierUsed: boolean;
} {
  let themeModifierUsed = false;
  const cleanWords: string[] = [];

  let i = 0;
  while (i < words.length) {
    const w = words[i].toLowerCase();
    const inlineMatch = w.match(/^(op|ed)(\d+)?$/);
    if (inlineMatch) {
      themeModifierUsed = true;
      if (!inlineMatch[2] && i + 1 < words.length && /^\d+$/.test(words[i + 1])) {
        i++; // consume the bare sequence number, like the web
      }
    } else {
      cleanWords.push(words[i]);
    }
    i++;
  }

  return { cleanWords, themeModifierUsed };
}

function iso(value: Date | string | null | undefined): string {
  if (value == null) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

function timeOf(value: Date | string | null | undefined): number {
  if (value == null) return 0;
  return value instanceof Date ? value.getTime() : Date.parse(String(value)) || 0;
}

/** Lean shapes of the documents as they come back from Mongoose. */
type UserDoc = User & { _id: Types.ObjectId; createdAt?: Date };
type FollowDoc = Follow & { _id: unknown };
type RatingDoc = Rating & { _id: unknown; createdAt?: Date };
type HistoryDoc = WatchHistory & { _id: unknown };
type NotificationDoc = Notification & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};
type PlaylistActivityDoc = PlaylistActivity & {
  _id: unknown;
  createdAt?: Date;
};

interface SocialModels {
  users: Model<UserDocument>;
  follows: Model<FollowDocument>;
  notifications: Model<NotificationDocument>;
  ratings: Model<RatingDocument>;
  history: Model<WatchHistoryDocument>;
  themes: Model<ThemeCacheDocument>;
}

/**
 * Social / network (Slice S5): public profiles, stats, network
 * lists, follow/unfollow, the per-user activity list, the
 * friends-activity feed, user search, and notifications — a port
 * of the web's users/follow/social/notifications surface
 * (ZadidSalman/Kaisen `app/api/users/[username]/*`,
 * `app/api/follow/[username]`, `app/api/social/friends-activity`,
 * the USERS branch of `app/api/search`, `app/api/notifications`).
 *
 * What the web's social surface actually is (all read from code):
 * - Profile: a fixed 9-field public projection (id, username,
 *   displayName, avatarUrl, bio, totalRatings, totalFollowers,
 *   totalFollowing, createdAt). No rank, no AniList linkage, no
 *   email — the web exposes none of them here. There is NO
 *   isPublic gate on the profile or the network lists (isPublic
 *   only filters user SEARCH).
 * - The web's /network and /friends routes are byte-identical
 *   duplicates; the network page uses /network. One endpoint here.
 * - Follows: stored counters on the user docs, maintained by the
 *   web model's hooks — post('save') $incs both counters and
 *   creates a 'follow' notification for the followee;
 *   post('findOneAndDelete') $incs them back down. Those exact
 *   operations live in followUser/unfollowUser below (this API
 *   registers no Mongoose hooks — see user.schema.ts).
 * - Notifications: of the six enum types, ONLY 'follow' is ever
 *   created anywhere in web code, and it is the only type THIS
 *   service creates. The read + mark-read routes are ported in
 *   full. (API-wide, three more types exist as an owner-approved
 *   follower-activity divergence — FollowerActivityService,
 *   written from the library/comment paths.)
 * - Feed: /social on the web is the friends-activity feed (recent
 *   watches + ratings by followed users) over the network lists —
 *   there is no other feed. Ported with its composition rules.
 *
 * Mirrored quirks, deliberately kept:
 * - Network lists are UNPAGINATED and UNSORTED (the web's Follow
 *   finds carry no sort): storage order, however long they get.
 * - The per-user activity gate is backwards from intuition: a
 *   caller sees the owner's activity when the OWNER FOLLOWS THE
 *   CALLER (or when caller == owner). Everyone else — and every
 *   anonymous caller — gets a 200 with an empty list.
 * - A user search whose query parses as a theme modifier ("op",
 *   "op 9", …) returns NO users at all (the web skips the USERS
 *   branch when a modifier is present).
 * - The follow-status check answers { isFollowing: false } to
 *   anonymous callers BEFORE the target user is looked up — an
 *   unknown username is only a 404 for signed-in callers.
 *
 * Deliberate deviations (precedent: the S1–S3 tightenings, and the
 * API-wide auth shape):
 * - The web's per-user activity reads its session from a cookie
 *   named 'token' ONLY (no Bearer); here the same gate reads the
 *   API's Bearer access token, like every optional-auth port.
 * - The web answers its generic 500 on unexpected failures; this
 *   API answers its clean error codes (404 'User not found', 400
 *   with the web's own messages, 503 without a database).
 * - The web's limit/page parsing propagates NaN into Mongoose;
 *   unparseable or non-positive values fall back to the defaults
 *   here instead.
 * - The friends-activity feed is ENRICHED beyond the web
 *   (owner-approved, additive only): items carry the theme's
 *   artist + cover, 'liked' rows carry the stored score, and a
 *   third event kind — 'playlist_add', from the PlaylistActivity
 *   records PlaylistsService writes at add time — joins the
 *   merge. The web's fields, order and follow-gating are
 *   untouched; the website does not consume this API.
 *
 * The models are OPTIONAL like everywhere else in this API:
 * booted without MONGODB_URI, every method answers 503 while
 * /health works. (Guarded routes still 401 tokenless first —
 * the guard needs no database.)
 */
@Injectable()
export class SocialService {
  constructor(
    private readonly auth: AuthService,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(Follow.name)
    private readonly followModel?: Model<FollowDocument>,
    @Optional()
    @InjectModel(Notification.name)
    private readonly notificationModel?: Model<NotificationDocument>,
    @Optional()
    @InjectModel(Rating.name)
    private readonly ratingModel?: Model<RatingDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly historyModel?: Model<WatchHistoryDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    /**
     * Rank documents, read ONLY to enrich the network rows with
     * their tier (the app's Network screen design shows it). Kept
     * out of requireModels on purpose: the enrichment is additive —
     * without the model the rows simply omit the field.
     */
    @Optional()
    @InjectModel(UserRank.name)
    private readonly userRankModel?: Model<UserRankDocument>,
    /**
     * Playlist-add activity records, read ONLY to serve the
     * feed's 'playlist_add' events (written by PlaylistsService).
     * Kept out of requireModels for the same reason as the rank
     * model above: the third event kind is additive — without
     * the model the feed simply serves the web's two kinds.
     */
    @Optional()
    @InjectModel(PlaylistActivity.name)
    private readonly playlistActivityModel?: Model<PlaylistActivityDocument>,
  ) {}

  private requireModels(): SocialModels {
    if (
      !this.userModel ||
      !this.followModel ||
      !this.notificationModel ||
      !this.ratingModel ||
      !this.historyModel ||
      !this.themeModel
    ) {
      throw new ServiceUnavailableException(
        'Social unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      users: this.userModel,
      follows: this.followModel,
      notifications: this.notificationModel,
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
   * any Bearer token that does not verify simply means anonymous.
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
    models: SocialModels,
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

  /**
   * Batch-resolve users by id into a projection map. Ids with no
   * user document are absent from the map (callers render the
   * web's populate-null for them).
   */
  private async resolveUsers<T>(
    models: SocialModels,
    ids: unknown[],
    project: (doc: UserDoc) => T,
  ): Promise<Map<string, T>> {
    const unique = [...new Set(ids.map((id) => String(id)))];
    if (unique.length === 0) {
      return new Map();
    }
    const filter: Record<string, unknown> = { _id: { $in: unique } };
    const docs = (await models.users
      .find(filter)
      .lean()
      .exec()) as UserDoc[];
    return new Map(docs.map((u) => [String(u._id), project(u)]));
  }

  private toNetworkUser(doc: UserDoc): NetworkUser {
    return {
      id: String(doc._id),
      username: doc.username,
      displayName: doc.displayName,
      avatarUrl: doc.avatarUrl ?? null,
      bio: doc.bio ?? '',
    };
  }

  private toAuthor(doc: UserDoc): CommentAuthor {
    return {
      id: String(doc._id),
      username: doc.username,
      displayName: doc.displayName,
      avatarUrl: doc.avatarUrl ?? null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Profiles                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * GET /users/:username — the web's profile projection, verbatim:
   * id, username, displayName, avatarUrl, bio, totalRatings,
   * totalFollowers, totalFollowing, createdAt. Public; unknown
   * usernames 404 (the web's own message).
   */
  async getProfile(username: string): Promise<UserPublicProfile> {
    const models = this.requireModels();
    const user = await this.findUserOr404(models, username);
    return {
      id: String(user._id),
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? null,
      bio: user.bio ?? '',
      totalRatings: user.totalRatings ?? 0,
      totalFollowers: user.totalFollowers ?? 0,
      totalFollowing: user.totalFollowing ?? 0,
      createdAt: iso(user.createdAt),
    };
  }

  /**
   * GET /users/:username/stats — the web's stats projection
   * (followers / following / totalTime / ratings, || 0 fallbacks).
   */
  async getStats(username: string): Promise<UserStats> {
    const models = this.requireModels();
    const user = await this.findUserOr404(models, username);
    return {
      totalFollowers: user.totalFollowers || 0,
      totalFollowing: user.totalFollowing || 0,
      totalTime: user.totalTime || 0,
      totalRatings: user.totalRatings || 0,
    };
  }

  /**
   * GET /users/:username/network — the web's network route (and
   * its identical twin, /friends): both full lists, populated
   * with username/displayName/avatarUrl/bio, in the Follow
   * queries' own (unsorted, unpaginated) order. Public.
   *
   * App enrichment (additive — the web's fields and order are
   * untouched): the app's Network screen (§6.17) draws each row
   * with the user's rank tier and a Follow/Following button in
   * the CALLER's state, neither of which the web's projection
   * carries. Each row therefore also gets `tier` (from the rank
   * documents) and, when the request carried a valid Bearer <redacted>
   * `isFollowing` for the caller. Anonymous reads omit
   * `isFollowing`, mirroring the follow check's pre-lookup false.
   */
  async getNetwork(
    username: string,
    authorization?: string,
  ): Promise<NetworkResponse> {
    const models = this.requireModels();
    const user = await this.findUserOr404(models, username);

    const [followerRows, followingRows] = await Promise.all([
      models.follows.find({ followeeId: user._id }).lean().exec(),
      models.follows.find({ followerId: user._id }).lean().exec(),
    ]);

    const byId = await this.resolveUsers(
      models,
      [
        ...(followerRows as FollowDoc[]).map((f) => f.followerId),
        ...(followingRows as FollowDoc[]).map((f) => f.followeeId),
      ],
      (u) => this.toNetworkUser(u),
    );

    const response: NetworkResponse = {
      // A row whose user account is gone maps to null — the web's
      // populate yields exactly that; mirrored.
      followers: (followerRows as FollowDoc[]).map(
        (f) => byId.get(String(f.followerId)) ?? null,
      ),
      following: (followingRows as FollowDoc[]).map(
        (f) => byId.get(String(f.followeeId)) ?? null,
      ),
    };
    await this.enrichNetworkRows(models, response, authorization);
    return response;
  }

  /**
   * The network rows' app enrichment (see getNetwork). Tiers are
   * a pure READ: a user with no rank document gets 'academy',
   * exactly the default the rank reads materialise — this list
   * never creates rank documents.
   */
  private async enrichNetworkRows(
    models: SocialModels,
    response: NetworkResponse,
    authorization?: string,
  ): Promise<void> {
    const rows = [...response.followers, ...response.following].filter(
      (u): u is NetworkUser => u !== null,
    );
    if (rows.length === 0) return;
    const ids = [...new Set(rows.map((u) => u.id))];

    if (this.userRankModel) {
      const docs = (await this.userRankModel
        .find({ userId: { $in: ids } })
        .lean()
        .exec()) as { userId?: unknown; tier?: unknown }[];
      const tiers = new Map(docs.map((d) => [String(d.userId), d.tier]));
      for (const row of rows) {
        const tier = tiers.get(row.id);
        row.tier = (typeof tier === 'string' ? tier : 'academy') as RankTier;
      }
    }

    const viewerId = this.optionalUserId(authorization);
    if (viewerId) {
      const mine = (await models.follows
        .find({ followerId: viewerId, followeeId: { $in: ids } })
        .lean()
        .exec()) as FollowDoc[];
      const following = new Set(mine.map((f) => String(f.followeeId)));
      for (const row of rows) {
        row.isFollowing = following.has(row.id);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Follows                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * GET /users/:username/follow — the web's follow-status check.
   * Anonymous callers get { isFollowing: false } BEFORE any user
   * lookup (so unknown usernames are not 404s for them); signed-in
   * callers get the web's 404 for unknown targets.
   */
  async getFollowState(
    authorization: string | undefined,
    username: string,
  ): Promise<FollowState> {
    const models = this.requireModels();
    const meId = this.optionalUserId(authorization);
    const name = String(username ?? '').toLowerCase();
    if (!meId) {
      return { username: name, isFollowing: false };
    }
    const target = await this.findUserOr404(models, username);
    const follow = await models.follows
      .findOne({ followerId: meId, followeeId: target._id })
      .exec();
    return { username: target.username, isFollowing: !!follow };
  }

  /**
   * POST /users/:username/follow — the web's follow: 404 unknown
   * target, 400 'Cannot follow yourself', and a duplicate follow
   * is a silent success (no second row, no counter movement, no
   * second notification). A real follow applies the web model's
   * post('save') hook operations in the hook's own order:
   * $inc the follower's totalFollowing, $inc the followee's
   * totalFollowers, then create the followee's 'follow'
   * notification (its failure swallowed, exactly like the hook's
   * try/catch).
   */
  async followUser(
    meId: string,
    username: string,
  ): Promise<FollowState> {
    const models = this.requireModels();
    const target = await this.findUserOr404(models, username);

    if (String(target._id) === meId) {
      throw new BadRequestException('Cannot follow yourself');
    }

    const existing = await models.follows
      .findOne({ followerId: meId, followeeId: target._id })
      .exec();
    if (!existing) {
      let created = true;
      try {
        await models.follows.create({
          followerId: meId,
          followeeId: target._id,
        });
      } catch (err) {
        // Lost a race against the unique (followerId, followeeId)
        // index (the S1 precedent): the row exists now, and its
        // creator applied the side effects — applying them again
        // here would double-count.
        if ((err as { code?: number }).code !== 11000) {
          throw err;
        }
        created = false;
      }
      if (created) {
        await models.users
          .findByIdAndUpdate(meId, { $inc: { totalFollowing: 1 } })
          .exec();
        await models.users
          .findByIdAndUpdate(target._id, {
            $inc: { totalFollowers: 1 },
          })
          .exec();
        try {
          await models.notifications.create({
            recipientId: target._id,
            actorId: meId,
            type: 'follow',
            read: false,
          });
        } catch (err) {
          // The web hook logs and swallows this — the follow stands.
          console.error('Failed to create follow notification:', err);
        }
      }
    }

    return { username: target.username, isFollowing: true };
  }

  /**
   * DELETE /users/:username/follow — the web's unfollow: 404
   * unknown target; otherwise the row is removed via
   * findOneAndDelete and the hook's counter decrements apply ONLY
   * when a row actually existed. Unfollowing someone never
   * followed is a success no-op. (The web has no self-unfollow
   * check and no notification cleanup — neither has this.)
   */
  async unfollowUser(
    meId: string,
    username: string,
  ): Promise<FollowState> {
    const models = this.requireModels();
    const target = await this.findUserOr404(models, username);

    const removed = await models.follows
      .findOneAndDelete({ followerId: meId, followeeId: target._id })
      .exec();
    if (removed) {
      await models.users
        .findByIdAndUpdate(meId, { $inc: { totalFollowing: -1 } })
        .exec();
      await models.users
        .findByIdAndUpdate(target._id, {
          $inc: { totalFollowers: -1 },
        })
        .exec();
    }

    return { username: target.username, isFollowing: false };
  }

  /* ---------------------------------------------------------------- */
  /* Activity                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * GET /users/:username/activity — the web's profile activity:
   * the owner's 10 newest ratings + 10 newest watches, merged,
   * newest first, sliced to 15, themes joined in.
   *
   * The privacy gate is the web's, mirrored exactly (see the
   * class comment): allowed iff the caller IS the owner or the
   * owner follows the caller. The web reads its cookie-only
   * session here; this port reads the Bearer token. Anyone not
   * allowed — including anonymous callers — receives an empty
   * list with a 200, never a 401/403.
   */
  async getUserActivity(
    authorization: string | undefined,
    username: string,
  ): Promise<UserActivityResponse> {
    const models = this.requireModels();
    const user = await this.findUserOr404(models, username);
    const meId = this.optionalUserId(authorization);

    let allowed = false;
    if (meId) {
      if (meId === String(user._id)) {
        allowed = true;
      } else {
        const ownerFollowsMe = await models.follows
          .findOne({ followerId: user._id, followeeId: meId })
          .exec();
        allowed = !!ownerFollowsMe;
      }
    }
    if (!allowed) {
      return { activity: [] };
    }

    const [ratingDocs, historyDocs] = await Promise.all([
      models.ratings
        .find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(PROFILE_ACTIVITY_PER_KIND)
        .lean()
        .exec(),
      models.history
        .find({ userId: user._id })
        .sort({ viewedAt: -1 })
        .limit(PROFILE_ACTIVITY_PER_KIND)
        .lean()
        .exec(),
    ]);

    const themeIds = [
      ...(ratingDocs as RatingDoc[]).map((r) => r.themeId),
      ...(historyDocs as HistoryDoc[]).map((h) => h.themeId),
    ];
    const uniqueThemeIds = [...new Set(themeIds.map((id) => String(id)))];
    const themeDocs =
      uniqueThemeIds.length === 0
        ? []
        : ((await models.themes
            .find({ _id: { $in: uniqueThemeIds } })
            .lean()
            .exec()) as ThemeDoc[]);
    const themesById = new Map(
      themeDocs.map((t) => [String(t._id), toThemeSummary(t)]),
    );

    const activity: UserActivityItem[] = [
      ...(ratingDocs as RatingDoc[]).map((r) => ({
        id: String(r._id),
        activityType: 'rating' as const,
        date: iso(r.createdAt),
        themeSlug: r.themeSlug,
        score: r.score,
        mode: r.mode === 'listen' ? ('listen' as const) : ('watch' as const),
        theme: themesById.get(String(r.themeId)) ?? null,
      })),
      ...(historyDocs as HistoryDoc[]).map((h) => ({
        id: String(h._id),
        activityType: 'watch' as const,
        date: iso(h.viewedAt),
        themeSlug: h.themeSlug,
        score: null,
        mode: h.mode === 'listen' ? ('listen' as const) : ('watch' as const),
        theme: themesById.get(String(h.themeId)) ?? null,
      })),
    ]
      .sort((a, b) => timeOf(b.date) - timeOf(a.date))
      .slice(0, PROFILE_ACTIVITY_LIMIT);

    return { activity };
  }

  /**
   * GET /social/friends-activity — the web's network feed: the
   * caller's followed users' newest watches ('listening') and
   * ratings ('liked'), each kind fetched at the limit, merged,
   * sorted newest first and sliced to the limit. Rows whose user
   * account is gone are dropped (the web filters 'unknown' users
   * after mapping); rows whose theme is gone keep the stored slug
   * and an 'Unknown Title'. Anonymous callers and callers who
   * follow nobody get an empty feed — never a 401.
   *
   * App enrichment (additive, owner-approved — the contracts doc
   * on FriendsActivityItem carries the full rationale): every
   * item also resolves the theme's artist + cover, 'liked' rows
   * carry the friend's stored score, and a THIRD kind joins the
   * merge — 'playlist_add', read from the PlaylistActivity
   * records PlaylistsService writes at add time (the web records
   * no such event; there is no backfill). Same composition rules
   * throughout: per-kind fetch at the limit, one merge, one sort,
   * one slice, followed users only.
   */
  async getFriendsActivity(
    authorization: string | undefined,
    limitParam?: string,
  ): Promise<FriendsActivityResponse> {
    const models = this.requireModels();
    const parsed = parseInt(limitParam ?? '', 10);
    const fetchLimit = Number.isNaN(parsed) || parsed < 1
      ? FEED_DEFAULT_LIMIT
      : Math.min(parsed, FEED_MAX_LIMIT);

    const meId = this.optionalUserId(authorization);
    if (!meId) {
      return { activities: [], isGlobal: false };
    }

    const following = (await models.follows
      .find({ followerId: meId })
      .lean()
      .exec()) as FollowDoc[];
    const followedIds = following.map((f) => f.followeeId);
    if (followedIds.length === 0) {
      return { activities: [], isGlobal: false };
    }

    const filter: Record<string, unknown> = {
      userId: { $in: followedIds },
    };
    const [historyDocs, ratingDocs, playlistDocs] = await Promise.all([
      models.history
        .find(filter)
        .sort({ viewedAt: -1 })
        .limit(fetchLimit)
        .lean()
        .exec(),
      models.ratings
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(fetchLimit)
        .lean()
        .exec(),
      // The third kind is additive (see the constructor note):
      // without the model the feed serves the web's two kinds.
      this.playlistActivityModel
        ? this.playlistActivityModel
            .find(filter)
            .sort({ createdAt: -1 })
            .limit(fetchLimit)
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    const usersById = await this.resolveUsers(
      models,
      [
        ...(historyDocs as HistoryDoc[]).map((h) => h.userId),
        ...(ratingDocs as RatingDoc[]).map((r) => r.userId),
        ...(playlistDocs as PlaylistActivityDoc[]).map((a) => a.userId),
      ],
      (u) => u,
    );
    const themeIds = [
      ...(historyDocs as HistoryDoc[]).map((h) => h.themeId),
      ...(ratingDocs as RatingDoc[]).map((r) => r.themeId),
      ...(playlistDocs as PlaylistActivityDoc[]).map((a) => a.themeId),
    ];
    const uniqueThemeIds = [...new Set(themeIds.map((id) => String(id)))];
    const themeDocs =
      uniqueThemeIds.length === 0
        ? []
        : ((await models.themes
            .find({ _id: { $in: uniqueThemeIds } })
            .lean()
            .exec()) as ThemeDoc[]);
    const themesById = new Map(
      themeDocs.map((t) => [String(t._id), t]),
    );

    const mapUser = (userId: unknown) => {
      const u = usersById.get(String(userId));
      return {
        username: u?.username || 'unknown',
        displayName: u?.displayName || 'Unknown User',
        avatar:
          u?.avatarUrl ||
          `https://api.dicebear.com/7.x/avataaars/svg?seed=${u?.username || 'guest'}`,
      };
    };

    /**
     * The enriched item shape (see the method doc): title/slug
     * fall back to the row's stored slug + 'Unknown Title' when
     * the theme is gone, exactly like the web's two fields did;
     * artist/cover resolve from the theme document when it
     * exists (cover = animeCoverImage ?? animeCoverImageSmall,
     * the Home rails' rule); score and playlistName are each set
     * by exactly one event kind and null on the others.
     */
    const mapItem = (
      themeId: unknown,
      storedSlug: string,
      extra: { score?: number | null; playlistName?: string | null } = {},
    ) => {
      const t = themesById.get(String(themeId));
      return {
        title: t?.songTitle || 'Unknown Title',
        slug: t?.slug || storedSlug,
        artist: t?.artistName ?? null,
        cover: t
          ? (t.animeCoverImage ?? t.animeCoverImageSmall ?? null)
          : null,
        score: extra.score ?? null,
        playlistName: extra.playlistName ?? null,
      };
    };

    const activities: FriendsActivityItem[] = [
      ...(historyDocs as HistoryDoc[]).map((h) => ({
        id: String(h._id),
        user: mapUser(h.userId),
        type: 'listening' as const,
        item: mapItem(h.themeId, h.themeSlug),
        timestamp: iso(h.viewedAt),
      })),
      ...(ratingDocs as RatingDoc[]).map((r) => ({
        id: String(r._id),
        user: mapUser(r.userId),
        type: 'liked' as const,
        item: mapItem(r.themeId, r.themeSlug, { score: r.score ?? null }),
        timestamp: iso(r.createdAt),
      })),
      ...(playlistDocs as PlaylistActivityDoc[]).map((a) => ({
        id: String(a._id),
        user: mapUser(a.userId),
        type: 'playlist_add' as const,
        item: mapItem(a.themeId, a.themeSlug, {
          playlistName: a.playlistName,
        }),
        timestamp: iso(a.createdAt),
      })),
    ]
      .filter((a) => a.user.username !== 'unknown')
      .sort((a, b) => timeOf(b.timestamp) - timeOf(a.timestamp))
      .slice(0, fetchLimit);

    return { activities, isGlobal: false };
  }

  /* ---------------------------------------------------------------- */
  /* User search / discovery                                           */
  /* ---------------------------------------------------------------- */

  /**
   * GET /social/users/search — the USERS branch of the web's
   * /api/search, as a dedicated endpoint (this API's /search
   * serves themes only and is unchanged): public accounts only
   * (isPublic), every (cleaned) query word must be a
   * case-insensitive substring of the username or the display
   * name, the web's projection, 20 per page, hasMore by the web's
   * formula. Queries under 2 characters are the web's 400. When
   * the query parses as a theme modifier the web skips this
   * branch entirely — mirrored as an empty, total-0 page.
   */
  async searchUsers(
    queryParam?: string,
    pageParam?: string,
  ): Promise<UserSearchResponse> {
    const models = this.requireModels();
    const q = (queryParam ?? '').trim();
    if (q.length < 2) {
      throw new BadRequestException(
        'Query too short — minimum 2 characters',
      );
    }
    const parsedPage = parseInt(pageParam ?? '', 10);
    const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;

    const { cleanWords, themeModifierUsed } = parseThemeModifiers(
      normalizeWords(q),
    );
    if (themeModifierUsed) {
      return { query: q, users: [], page, total: 0, hasMore: false };
    }

    const conditions = cleanWords.map((word) => {
      const escaped = escapeRegExp(word);
      return {
        $or: [
          { username: { $regex: escaped, $options: 'i' } },
          { displayName: { $regex: escaped, $options: 'i' } },
        ],
      };
    });
    const filter: Record<string, unknown> = { isPublic: true };
    if (conditions.length > 0) {
      filter.$and = conditions;
    }

    const skip = (page - 1) * USER_SEARCH_PAGE_SIZE;
    const [docs, total] = await Promise.all([
      models.users
        .find(filter)
        .skip(skip)
        .limit(USER_SEARCH_PAGE_SIZE)
        .lean()
        .exec() as Promise<UserDoc[]>,
      models.users.countDocuments(filter).exec(),
    ]);

    return {
      query: q,
      users: docs.map((u) => this.toNetworkUser(u)),
      page,
      total,
      hasMore: skip + docs.length < total,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * GET /notifications — the web's list: the caller's 50 most
   * recent notifications, newest first, actors populated with
   * username/displayName/avatarUrl (null when the actor's account
   * is gone). Authenticated (the controller's guard).
   */
  async listNotifications(
    meId: string,
  ): Promise<NotificationsResponse> {
    const models = this.requireModels();
    const docs = (await models.notifications
      .find({ recipientId: meId })
      .sort({ createdAt: -1 })
      .limit(NOTIFICATION_LIST_LIMIT)
      .lean()
      .exec()) as NotificationDoc[];

    const actorsById = await this.resolveUsers(
      models,
      docs.map((d) => d.actorId),
      (u) => this.toAuthor(u),
    );

    return {
      notifications: docs.map((d) => ({
        id: String(d._id),
        type: d.type as NotificationType,
        actor: actorsById.get(String(d.actorId)) ?? null,
        entityId: d.entityId != null ? String(d.entityId) : null,
        entityMeta: d.entityMeta ?? null,
        read: d.read,
        createdAt: iso(d.createdAt),
        updatedAt: iso(d.updatedAt),
      })),
    };
  }

  /**
   * POST /notifications/mark-read — the web's POST
   * /api/notifications: with an id array, mark those of the
   * CALLER'S OWN notifications read (ids belonging to anyone else
   * simply match nothing); with no array, mark every unread
   * notification of the caller read.
   */
  async markNotificationsRead(
    meId: string,
    notificationIds?: unknown,
  ): Promise<MarkNotificationsReadResponse> {
    const models = this.requireModels();
    if (Array.isArray(notificationIds)) {
      await models.notifications
        .updateMany(
          { _id: { $in: notificationIds }, recipientId: meId },
          { $set: { read: true } },
        )
        .exec();
    } else {
      await models.notifications
        .updateMany(
          { recipientId: meId, read: false },
          { $set: { read: true } },
        )
        .exec();
    }
    return { markedRead: true };
  }
}

import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type {
  LiveStatsResponse,
  TopArtistsResponse,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from '../library/watch-history.schema';
import {
  ArtistCache,
  type ArtistCacheDocument,
} from '../sync/artist-cache.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';

/** The web's live window: watches inside the last 10 minutes. */
const LIVE_WINDOW_MS = 10 * 60 * 1000;

/** The web's avatar cap on the live read. */
const LIVE_AVATAR_LIMIT = 3;

/** The web top-artists pipeline: top 20 themes fold into ≤6 artists. */
const TOP_THEMES_LIMIT = 20;
const TOP_ARTISTS_LIMIT = 6;

/** The web's hard-coded avatar fallbacks, verbatim. */
const FALLBACK_AVATARS = [
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Anya',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=Shinji',
];

interface StatsModels {
  users: Model<UserDocument>;
  history: Model<WatchHistoryDocument>;
  themes: Model<ThemeCacheDocument>;
  artists: Model<ArtistCacheDocument>;
}

/**
 * The web's stats reads (Slice S8) — `app/api/stats/live/route.ts`
 * and `app/api/stats/top-artists/route.ts` over the shared `users`,
 * `watchhistories`, `themecaches` and `artistcaches` collections.
 * Both are pure reads; nothing here writes.
 *
 * The models are OPTIONAL like everywhere else in this API: booted
 * without MONGODB_URI, every method answers 503 while /health
 * works (the top-artists guard still 401s tokenless first).
 */
@Injectable()
export class StatsService {
  constructor(
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(WatchHistory.name)
    private readonly historyModel?: Model<WatchHistoryDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(ArtistCache.name)
    private readonly artistModel?: Model<ArtistCacheDocument>,
  ) {}

  private requireModels(): StatsModels {
    if (
      !this.userModel ||
      !this.historyModel ||
      !this.themeModel ||
      !this.artistModel
    ) {
      throw new ServiceUnavailableException(
        'Stats unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      users: this.userModel,
      history: this.historyModel,
      themes: this.themeModel,
      artists: this.artistModel,
    };
  }

  /**
   * GET /stats/live — the web's live counters, quirks mirrored
   * deliberately (AGENTS.md rule 2):
   * - `activeUsers` is the TOTAL user count — countDocuments()
   *   with no filter; the web's name is a mislabel and stays one.
   * - `listeningNow` counts the distinct users with a watch in
   *   the last 10 minutes, PLUS `Math.floor(Math.random() * 5)`
   *   — the web's "live feel" noise term, ported as-is.
   * - `listeningAvatars` is up to 3 avatarUrls of those recent
   *   listeners (only users WITH an avatar stored), or the web's
   *   three hard-coded DiceBear URLs when there are none.
   */
  async getLiveStats(): Promise<LiveStatsResponse> {
    const models = this.requireModels();

    const activeUsers = await models.users.countDocuments().exec();

    const tenMinutesAgo = new Date(Date.now() - LIVE_WINDOW_MS);
    const recentUserIds = (await models.history
      .distinct('userId', { viewedAt: { $gt: tenMinutesAgo } })
      .exec()) as unknown[];

    const listeningNow =
      recentUserIds.length + Math.floor(Math.random() * 5);

    // The distinct values are ObjectIds at runtime; the filter is
    // assembled dynamically (the themes search precedent).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recentUsersFilter: any = {
      _id: { $in: recentUserIds },
      avatarUrl: { $ne: null },
    };
    const recentUsers = (await models.users
      .find(recentUsersFilter)
      .limit(LIVE_AVATAR_LIMIT)
      .select('avatarUrl')
      .lean()
      .exec()) as Array<{ avatarUrl: string | null }>;

    const listeningAvatars =
      recentUsers.length > 0
        ? recentUsers.map((u) => String(u.avatarUrl))
        : [...FALLBACK_AVATARS];

    return { activeUsers, listeningNow, listeningAvatars };
  }

  /**
   * GET /stats/top-artists — the caller's top artists by plays,
   * the web's pipeline step for step: aggregate the caller's
   * history into per-theme play counts (top 20), fold those into
   * artists via the themes' artistName (a theme with no artist
   * name contributes nothing), sum plays per artist, sort desc,
   * keep 6, then enrich each with its ArtistCache image by slug
   * ('' when the theme stored no slug; image null when no cache
   * row or no image). A caller with no history gets an empty list.
   *
   * One mechanical deviation: the web wraps the caller's id in
   * `new mongoose.Types.ObjectId(...)` for the $match; this API
   * passes the bare string like every other query here — Mongoose
   * casts it against the schema's ObjectId field identically.
   */
  async getTopArtists(userId: string): Promise<TopArtistsResponse> {
    const models = this.requireModels();

    const topThemes = (await models.history.aggregate([
      { $match: { userId } },
      { $group: { _id: '$themeId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: TOP_THEMES_LIMIT },
    ])) as Array<{ _id: unknown; count: number }>;

    if (topThemes.length === 0) {
      return { artists: [] };
    }

    const themeIds = topThemes.map((t) => t._id);
    // Same dynamic-filter precedent as the live read above.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const themeFilter: any = { _id: { $in: themeIds } };
    const themes = (await models.themes
      .find(themeFilter)
      .select('artistName artistSlugs')
      .lean()
      .exec()) as Array<{
      _id: unknown;
      artistName: string | null;
      artistSlugs?: string[];
    }>;

    // Plays fold per artist name, in first-seen order (the web's
    // Record preserves insertion order for string keys; a Map is
    // the exact equivalent, and the sort below is stable).
    const artistStats = new Map<
      string,
      { name: string; plays: number; slug: string }
    >();
    for (const t of topThemes) {
      const theme = themes.find(
        (th) => String(th._id) === String(t._id),
      );
      if (theme && theme.artistName) {
        const existing = artistStats.get(theme.artistName);
        if (existing) {
          existing.plays += t.count;
        } else {
          artistStats.set(theme.artistName, {
            name: theme.artistName,
            plays: t.count,
            slug: theme.artistSlugs?.[0] || '',
          });
        }
      }
    }

    const sortedArtists = [...artistStats.values()]
      .sort((a, b) => b.plays - a.plays)
      .slice(0, TOP_ARTISTS_LIMIT);

    const artistSlugs = sortedArtists.map((a) => a.slug).filter(Boolean);
    const artistCaches = await models.artists
      .find({ slug: { $in: artistSlugs } })
      .lean()
      .exec();

    return {
      artists: sortedArtists.map((a) => {
        const cache = artistCaches.find((c) => c.slug === a.slug);
        return { ...a, image: cache?.imageUrl || null };
      }),
    };
  }
}

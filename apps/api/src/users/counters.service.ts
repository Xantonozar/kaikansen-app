import {
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { User, type UserDocument } from '../auth/user.schema';
import { Rating, type RatingDocument } from '../library/rating.schema';
import {
  WatchHistory,
  type WatchHistoryDocument,
} from '../library/watch-history.schema';
import { Follow, type FollowDocument } from '../social/follow.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { computeProfileStats } from './profile-stats';

/** One stored counter that disagreed with the source of truth. */
export interface CounterCorrection {
  userId: string;
  username: string;
  field: 'totalFollowers' | 'totalFollowing' | 'totalRatings' | 'totalTime';
  from: number;
  to: number;
}

/** The recount report (internal tooling shape — not a contract). */
export interface CounterRecountReport {
  /** Users examined. */
  checked: number;
  /** Users whose stored counters were rewritten. */
  corrected: number;
  corrections: CounterCorrection[];
}

interface CountersModels {
  users: Model<UserDocument>;
  follows: Model<FollowDocument>;
  ratings: Model<RatingDocument>;
  history: Model<WatchHistoryDocument>;
  themes: Model<ThemeCacheDocument>;
}

type StoredCounters = {
  _id: Types.ObjectId | string;
  username: string;
  totalFollowers?: number | null;
  totalFollowing?: number | null;
  totalRatings?: number | null;
  totalTime?: number | null;
};

/**
 * Stored-counter repair (audit S3). The profile stats are served
 * TRUE by construction — computeProfileStats counts followers /
 * following live from the follows collection — but the user
 * documents' denormalised counters (totalFollowers,
 * totalFollowing, totalRatings, totalTime) are what OTHER
 * surfaces read (profile projections, the /users/:username/stats
 * route, the website itself), and any missed or double-applied
 * $inc on a write path drifts them permanently.
 *
 * recountCounters recomputes every counter from its source of
 * truth — follows for the follow counts, the ratings collection
 * for totalRatings, and the exact duration resolution
 * computeProfileStats uses for totalTime — and $sets only the
 * users whose stored values disagree, returning a per-field
 * correction report. It is operator-run on demand through
 * POST /internal/users/recount-counters (see
 * CountersController); nothing calls it automatically.
 */
@Injectable()
export class CountersService {
  constructor(
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(Follow.name)
    private readonly followModel?: Model<FollowDocument>,
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

  private requireModels(): CountersModels {
    if (
      !this.userModel ||
      !this.followModel ||
      !this.ratingModel ||
      !this.historyModel ||
      !this.themeModel
    ) {
      throw new ServiceUnavailableException(
        'Counter recount unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      users: this.userModel,
      follows: this.followModel,
      ratings: this.ratingModel,
      history: this.historyModel,
      themes: this.themeModel,
    };
  }

  /**
   * Recount one user (by id) or every user when no id is given.
   * Only disagreeing counters are written; the report lists
   * every field that changed.
   */
  async recountCounters(userId?: string): Promise<CounterRecountReport> {
    const models = this.requireModels();

    let targets: StoredCounters[];
    if (userId) {
      const user = (await models.users
        .findById(userId)
        .lean()
        .exec()) as StoredCounters | null;
      if (!user) {
        throw new NotFoundException('User not found');
      }
      targets = [user];
    } else {
      targets = (await models.users
        .find({})
        .lean()
        .exec()) as StoredCounters[];
    }

    const corrections: CounterCorrection[] = [];
    let corrected = 0;
    for (const user of targets) {
      const stats = await computeProfileStats(models, user);
      const totalRatings = await models.ratings
        .countDocuments({ userId: user._id })
        .exec();
      const truth = {
        totalFollowers: stats.followersCount,
        totalFollowing: stats.followingCount,
        totalRatings,
        totalTime: stats.totalListenedSeconds,
      };
      const drifted = (
        Object.entries(truth) as [CounterCorrection['field'], number][]
      ).filter(([field, value]) => (user[field] ?? 0) !== value);
      if (drifted.length === 0) continue;
      // Capture the report BEFORE the write — the targets are
      // the same objects the model returns, so writing first
      // would mutate the `from` values out from under the report.
      for (const [field, to] of drifted) {
        corrections.push({
          userId: String(user._id),
          username: user.username,
          field,
          from: user[field] ?? 0,
          to,
        });
      }
      await models.users
        .findByIdAndUpdate(user._id, { $set: truth })
        .exec();
      corrected++;
    }

    return { checked: targets.length, corrected, corrections };
  }
}

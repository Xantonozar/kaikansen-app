import type { Model, Types } from 'mongoose';
import type { ProfileStats } from '@kaikansen/contracts';
import type { RatingDocument } from '../library/rating.schema';
import type { WatchHistoryDocument } from '../library/watch-history.schema';
import type {
  ThemeCache,
  ThemeCacheDocument,
} from '../themes/theme-cache.schema';

/** The three read models the aggregates are computed from. */
export interface ProfileStatsModels {
  ratings: Model<RatingDocument>;
  history: Model<WatchHistoryDocument>;
  themes: Model<ThemeCacheDocument>;
}

/** The user fields the aggregates read (id + the stored counters). */
export interface ProfileStatsUser {
  _id: Types.ObjectId | string;
  totalFollowers?: number | null;
  totalFollowing?: number | null;
}

type RatingDoc = { score: number };
type HistoryDoc = { themeId: unknown; atEntryId: number | null };
type ThemeDoc = ThemeCache & { _id: unknown };

/**
 * The profile listening stats (owner-ordered for the Profile
 * design), computed identically for the own profile
 * (GET /auth/me) and the public profile (GET /users/:username) —
 * ONE routine so the two surfaces can never drift.
 *
 * Definitions (locked with the design):
 * - meanRating: the mean of the scores in the ratings the user
 *   GAVE (the `ratings` rows with their userId), rounded to
 *   1 decimal; null when they have rated nothing.
 * - themesListened: the number of DISTINCT themeIds across the
 *   user's `watchhistories` rows (repeat plays of one theme
 *   count once).
 * - totalListenedSeconds: the sum over EVERY history play of the
 *   played entry's catalogue duration, resolving the entry
 *   exactly as the history write path resolves it for the stored
 *   totalTime counter (LibraryService.applyWatchCounters, the
 *   web hook port): the entry whose atEntryId matches the row's,
 *   else the theme's first entry, else 90 seconds. A play whose
 *   theme no longer exists in the catalogue contributes 0 — it
 *   still counts toward themesListened.
 * - followersCount / followingCount: the user document's stored
 *   counters — the same values the profile and /users/:username/
 *   stats projections already serve (maintained by the follow
 *   write path), reused rather than recounted.
 *
 * Aggregates ONLY: no history or rating row ever leaves through
 * this routine. The reads load the user's own rating scores and
 * history (themeId, atEntryId) pairs — both are per-user sets,
 * and the theme join is batched over the distinct ids.
 */
export async function computeProfileStats(
  models: ProfileStatsModels,
  user: ProfileStatsUser,
): Promise<ProfileStats> {
  const [ratingDocs, historyDocs] = await Promise.all([
    models.ratings.find({ userId: user._id }).lean().exec() as Promise<
      RatingDoc[]
    >,
    models.history.find({ userId: user._id }).lean().exec() as Promise<
      HistoryDoc[]
    >,
  ]);

  const meanRating =
    ratingDocs.length > 0
      ? Math.round(
          (ratingDocs.reduce((sum, r) => sum + r.score, 0) /
            ratingDocs.length) *
            10,
        ) / 10
      : null;

  const distinctThemeIds = [
    ...new Set(historyDocs.map((h) => String(h.themeId))),
  ];

  let totalListenedSeconds = 0;
  if (distinctThemeIds.length > 0) {
    const themeDocs = (await models.themes
      .find({ _id: { $in: distinctThemeIds } })
      .lean()
      .exec()) as ThemeDoc[];
    const byId = new Map(themeDocs.map((t) => [String(t._id), t]));
    for (const row of historyDocs) {
      const theme = byId.get(String(row.themeId));
      if (!theme) {
        // The theme is gone from the catalogue: the play still
        // counts as a listened theme (above) but no duration can
        // be resolved for it.
        continue;
      }
      const entry =
        theme.entries?.find((e) => e.atEntryId === row.atEntryId) ??
        theme.entries?.[0];
      totalListenedSeconds += Number(entry?.duration) || 90;
    }
  }

  return {
    meanRating,
    themesListened: distinctThemeIds.length,
    totalListenedSeconds,
    followersCount: user.totalFollowers ?? 0,
    followingCount: user.totalFollowing ?? 0,
  };
}

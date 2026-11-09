import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { Follow, type FollowDocument } from './follow.schema';
import {
  Notification,
  type NotificationDocument,
} from './notification.schema';

/** The three follower-activity notification types. */
export type FollowerActivityType =
  | 'theme_rated'
  | 'theme_favorited'
  | 'comment';

/** Lean shapes of the documents as they come back from Mongoose. */
type FollowRow = { followerId?: unknown };
type NotificationRow = { recipientId?: unknown };

/**
 * Follower-activity notifications — an OWNER-APPROVED divergence
 * from the website (decided 2026-11-10).
 *
 * The web creates exactly one notification type: 'follow' (the
 * Follow post-save hook, ported into SocialService.followUser).
 * The other enum types are dead vocabulary there — 'rating_like'
 * and 'playlist_like' name actions that exist nowhere in the
 * product (still not created here), and 'theme_rated',
 * 'theme_favorited' and 'comment' name actions with no natural
 * recipient, because a theme has no owner and comments are flat.
 *
 * The owner's ruling gives those three a recipient after all:
 * when a user rates, favourites or comments on a theme, every
 * FOLLOWER of that user is notified of the activity. The hooks
 * live at the three action sites — LibraryService.setRating,
 * LibraryService.addFavorite, CommentsService.createComment —
 * and all of them funnel through notifyFollowers below, which
 * follows the follow hook's own discipline: the write is guarded
 * end to end, failures are logged and swallowed, and the user's
 * real action NEVER fails because a notification could not be
 * written.
 *
 * Anti-flood dedupe: a follower who already has an UNREAD
 * notification for the same (actor, type, entity) is skipped —
 * re-rating the same theme cannot stack unread duplicates. Once
 * the row is read, the next action notifies again.
 *
 * entityId is the theme's id for all three types (the thing the
 * activity is about; no per-action row id — a rating or comment
 * id — is what the mobile screen keys off). entityMeta carries
 * what the mobile Notifications screen's enrichment reads:
 * `themeTitle` (the theme's songTitle) on all three, plus the
 * numeric `score` for 'theme_rated'.
 *
 * The models are OPTIONAL like everywhere else in this API:
 * constructed without them (no database), notifyFollowers is a
 * silent no-op.
 */
@Injectable()
export class FollowerActivityService {
  constructor(
    @Optional()
    @InjectModel(Follow.name)
    private readonly followModel?: Model<FollowDocument>,
    @Optional()
    @InjectModel(Notification.name)
    private readonly notificationModel?: Model<NotificationDocument>,
  ) {}

  /**
   * Fan one activity out to the actor's followers. Resolves
   * silently in every failure mode — callers await it without a
   * try/catch of their own, exactly like the follow hook's
   * swallowed notification create.
   */
  async notifyFollowers(input: {
    actorId: string;
    type: FollowerActivityType;
    entityId: Types.ObjectId | string | null;
    entityMeta: Record<string, unknown>;
  }): Promise<void> {
    const { followModel, notificationModel } = this;
    if (!followModel || !notificationModel) {
      return;
    }
    try {
      const followRows = (await followModel
        .find({ followeeId: input.actorId })
        .select('followerId')
        .lean()
        .exec()) as FollowRow[];

      // Distinct followers, the actor themselves excluded even
      // if a self-follow row somehow exists in the data.
      const recipientIds = [
        ...new Set(followRows.map((f) => String(f.followerId))),
      ].filter((id) => id !== String(input.actorId));
      if (recipientIds.length === 0) {
        return;
      }

      const unread = (await notificationModel
        .find({
          recipientId: { $in: recipientIds },
          actorId: input.actorId,
          type: input.type,
          entityId: input.entityId ?? null,
          read: false,
        })
        .select('recipientId')
        .lean()
        .exec()) as NotificationRow[];
      const covered = new Set(
        unread.map((n) => String(n.recipientId)),
      );
      const fresh = recipientIds.filter((id) => !covered.has(id));
      if (fresh.length === 0) {
        return;
      }

      await notificationModel.insertMany(
        fresh.map((recipientId) => ({
          recipientId,
          actorId: input.actorId,
          type: input.type,
          entityId: input.entityId ?? null,
          entityMeta: input.entityMeta,
          read: false,
        })),
      );
    } catch (err) {
      // Mirrored from the follow hook: log and swallow — the
      // rating / favourite / comment that triggered this stands.
      console.error(
        'Failed to create follower activity notifications:',
        err,
      );
    }
  }
}

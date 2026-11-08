import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `follows` collection — one row per
 * follower → followee pair.
 *
 * Field-for-field port of the web app's Follow schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { followerId,
 * followeeId } + timestamps, unique on (followerId, followeeId) in
 * the web's index set.
 *
 * The web hangs THREE side effects off this model:
 *   post('save')            → $inc the follower's totalFollowing
 *                             and the followee's totalFollowers,
 *                             then create a 'follow' Notification
 *                             for the followee (failures swallowed);
 *   post('findOneAndDelete') → $inc both counters back down.
 * Following this codebase's established pattern (see
 * user.schema.ts), no Mongoose hooks are registered here — the
 * hook operations are ported into SocialService (followUser /
 * unfollowUser), which every follow write in this API goes
 * through. `autoIndex: false` as everywhere in this API.
 */

export type FollowDocument = HydratedDocument<Follow>;

@Schema({ collection: 'follows', timestamps: true, autoIndex: false })
export class Follow {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
  })
  followerId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
  })
  followeeId: Types.ObjectId;
}

export const FollowSchema = SchemaFactory.createForClass(Follow);

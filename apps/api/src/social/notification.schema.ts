import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `notifications` collection.
 *
 * Field-for-field port of the web app's Notification schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { recipientId,
 * actorId, type (enum), entityId (default null), entityMeta
 * (Mixed, default null), read (default false) } + timestamps.
 * The web's index set carries a 30-day TTL on createdAt —
 * documents expire a month after they are created (the index
 * itself already exists in production; `autoIndex: false` as
 * everywhere in this API, so it is not re-declared here).
 *
 * Of the six enum types, the web only ever CREATES 'follow' rows
 * (from the Follow post-save hook, ported into SocialService).
 * This API creates three more, as an OWNER-APPROVED divergence
 * (decided 2026-11-10): 'theme_rated', 'theme_favorited' and
 * 'comment' fan out to the ACTOR'S FOLLOWERS from the rating /
 * favourite / comment write paths — see
 * FollowerActivityService. 'rating_like' and 'playlist_like'
 * remain uncreated everywhere: the actions they name exist
 * nowhere in the product.
 */

export type NotificationDocument = HydratedDocument<Notification>;

export const NOTIFICATION_TYPES = [
  'follow',
  'theme_rated',
  'theme_favorited',
  'comment',
  'rating_like',
  'playlist_like',
] as const;

@Schema({
  collection: 'notifications',
  timestamps: true,
  autoIndex: false,
})
export class Notification {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
  })
  recipientId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
  })
  actorId: Types.ObjectId;

  @Prop({ type: String, enum: NOTIFICATION_TYPES, required: true })
  type: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  entityId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  entityMeta: unknown;

  @Prop({ type: Boolean, default: false })
  read: boolean;
}

export const NotificationSchema =
  SchemaFactory.createForClass(Notification);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Model for the app-only `chatpushtokens` collection (new,
 * additive — the website has no push tokens and never reads it).
 * One row per (device) Expo push token, owned by a userId. The
 * repo has no device/session model to hang tokens on (refresh
 * sessions live inside the shared users document, which must not
 * grow app-only fields), so tokens get their own collection.
 *
 * Rows are removed on: explicit unregister (mobile logout),
 * Expo's DeviceNotRegistered receipt (the device/app is gone),
 * and re-registration of the same token under another account
 * (the row is reassigned — a device has one signed-in account
 * at a time).
 */
@Schema({ collection: 'chatpushtokens', timestamps: true, autoIndex: false })
export class ChatPushToken {
  @Prop({ type: String, required: true })
  userId: string;

  /** Expo push token, e.g. ExponentPushToken[…]. */
  @Prop({ type: String, required: true })
  token: string;
}

export const ChatPushTokenSchema = SchemaFactory.createForClass(ChatPushToken);
export type ChatPushTokenDocument = HydratedDocument<ChatPushToken>;

/**
 * Indexes for this APP-ONLY collection (built by
 * ChatPushService's onModuleInit createIndexes):
 * - token UNIQUE — one row per device token; re-registration
 *   under another account reassigns the row instead of duping.
 * - userId — the per-recipient token lookup on every push.
 */
ChatPushTokenSchema.index({ token: 1 }, { unique: true });
ChatPushTokenSchema.index({ userId: 1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `watchhistories` collection — one row per
 * watch/listen event.
 *
 * Field-for-field port of the web app's WatchHistory schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { userId, themeId,
 * themeSlug, atEntryId, mode ('watch' | 'listen'), viewedAt } and —
 * unlike the other models — NO createdAt/updatedAt (the web schema
 * sets `timestamps: false`; `viewedAt` is the only clock).
 *
 * The web maintains counters through a post('save') hook on this
 * model (ThemeCache.totalWatches/totalListens $inc by mode, and
 * User.totalTime $inc by the played entry's duration). Following this
 * codebase's established pattern (see user.schema.ts), no Mongoose
 * hooks are registered here — the hook's exact operations are ported
 * into LibraryService (applyWatchCounters), which every history write
 * in this API goes through. `autoIndex: false` as everywhere here.
 */

export type WatchHistoryDocument = HydratedDocument<WatchHistory>;

@Schema({ collection: 'watchhistories', timestamps: false, autoIndex: false })
export class WatchHistory {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ThemeCache',
    required: true,
  })
  themeId: Types.ObjectId;

  @Prop({ type: String, required: true })
  themeSlug: string;

  @Prop({ type: Number, default: null })
  atEntryId: number | null;

  @Prop({ type: String, enum: ['watch', 'listen'], required: true })
  mode: string;

  @Prop({ type: Date, default: Date.now })
  viewedAt: Date;
}

export const WatchHistorySchema = SchemaFactory.createForClass(WatchHistory);

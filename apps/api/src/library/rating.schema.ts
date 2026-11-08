import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `ratings` collection — one user's 1–10 score
 * for one theme.
 *
 * Field-for-field port of the web app's Rating schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { userId, themeId,
 * themeSlug, score (min 1, max 10), mode ('watch' | 'listen') } +
 * timestamps, unique on (userId, themeId) in the web's index set.
 *
 * The web maintains the denormalised aggregates through a post('save')
 * hook on this model (re-aggregate the theme's ratings into
 * ThemeCache.avgRating/totalRatings; $inc User.totalRatings on a first
 * rating). Following this codebase's established pattern (see
 * user.schema.ts), no Mongoose hooks are registered here — the hook's
 * exact operations are ported into LibraryService
 * (syncRatingAggregates), which every rating write in this API goes
 * through. `autoIndex: false` as everywhere in this API.
 */

export type RatingDocument = HydratedDocument<Rating>;

@Schema({ collection: 'ratings', timestamps: true, autoIndex: false })
export class Rating {
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

  @Prop({ type: Number, required: true, min: 1, max: 10 })
  score: number;

  @Prop({ type: String, enum: ['watch', 'listen'], required: true })
  mode: string;
}

export const RatingSchema = SchemaFactory.createForClass(Rating);

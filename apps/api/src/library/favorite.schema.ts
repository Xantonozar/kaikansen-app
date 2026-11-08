import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `favorites` collection — a user's saved themes.
 *
 * Field-for-field port of the web app's Favorite schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { userId, themeId,
 * themeSlug } + timestamps, unique on (userId, themeId) in the web's
 * index set. The web model carries NO middleware hooks — saving or
 * unsaving a theme moves no counters anywhere — so this port has none
 * either; the counter logic for the library lives in the Rating and
 * WatchHistory ports. `autoIndex: false` as everywhere in this API:
 * the shared production collection already carries the web's indexes.
 */

export type FavoriteDocument = HydratedDocument<Favorite>;

@Schema({ collection: 'favorites', timestamps: true, autoIndex: false })
export class Favorite {
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
}

export const FavoriteSchema = SchemaFactory.createForClass(Favorite);

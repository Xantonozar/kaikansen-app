import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Write model for the shared `artistcaches` collection.
 *
 * Field-for-field port of the web app's ArtistCache schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`). The sync engine upserts by
 * `slug`, exactly as the web's seed engines do. `autoIndex: false` — this
 * backend never creates/syncs indexes on the shared production
 * collections. (The web schema marks `slug` unique; the index already
 * exists in production, and this API does not manage it.)
 */
export type ArtistCacheDocument = HydratedDocument<ArtistCache>;

@Schema({ collection: 'artistcaches', timestamps: true, autoIndex: false })
export class ArtistCache {
  @Prop({ type: String, required: true })
  slug: string;

  @Prop({ type: Number, required: true })
  animethemesId: number;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: [String] })
  aliases: string[];

  @Prop({ type: String, default: null })
  imageUrl: string | null;

  @Prop({ type: Number, default: 0 })
  totalThemes: number;

  @Prop({ type: Date, required: true })
  syncedAt: Date;
}

export const ArtistCacheSchema = SchemaFactory.createForClass(ArtistCache);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Write model for the shared `animecaches` collection.
 *
 * Field-for-field port of the web app's AnimeCache schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`). The web's seed scripts are
 * the only writers of this collection, and the sync engine in this API
 * is their successor — it upserts by `anilistId`, exactly as
 * `runSeedByAnime` does. As with the theme read model:
 * `autoIndex: false` — this backend never creates/syncs indexes on the
 * shared production collections.
 */
export type AnimeCacheDocument = HydratedDocument<AnimeCache>;

@Schema({ collection: 'animecaches', timestamps: true, autoIndex: false })
export class AnimeCache {
  @Prop({ type: Number, default: null })
  anilistId: number | null;

  @Prop({ type: Number, default: null })
  malId: number | null;

  @Prop({ type: String, default: null })
  kitsuId: string | null;

  @Prop({ type: String, required: true })
  titleRomaji: string;

  @Prop({ type: String, default: null })
  titleEnglish: string | null;

  @Prop({ type: String, default: null })
  titleNative: string | null;

  @Prop({ type: [String] })
  titleAlternative: string[];

  @Prop({ type: [String] })
  synonyms: string[];

  @Prop({
    type: String,
    enum: ['WINTER', 'SPRING', 'SUMMER', 'FALL'],
    default: null,
  })
  season: string | null;

  @Prop({ type: Number, default: null })
  seasonYear: number | null;

  @Prop({ type: [String] })
  genres: string[];

  @Prop({ type: String, default: null })
  coverImageLarge: string | null;

  @Prop({ type: String, default: null })
  coverImageMedium: string | null;

  @Prop({ type: String, default: null })
  bannerImage: string | null;

  @Prop({ type: String, default: null })
  atCoverImage: string | null;

  @Prop({ type: String, default: null })
  atGrillImage: string | null;

  @Prop({ type: [String] })
  studios: string[];

  @Prop({ type: [String] })
  series: string[];

  @Prop({ type: Number, default: null })
  totalEpisodes: number | null;

  @Prop({ type: String, default: null })
  status: string | null;

  @Prop({ type: Number, default: null })
  averageScore: number | null;

  @Prop({ type: Date, required: true })
  syncedAt: Date;
}

export const AnimeCacheSchema = SchemaFactory.createForClass(AnimeCache);

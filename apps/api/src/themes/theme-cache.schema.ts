import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Read model for the shared `themecaches` collection.
 *
 * Field-for-field port of the web app's ThemeCache schema
 * (ZadidSalman/Kaisen `lib/models/index.ts` — 36 declared fields +
 * createdAt/updatedAt from timestamps = the 38 fields of record).
 *
 * READ-ONLY BY DESIGN:
 * - none of the web schema's cross-model middleware hooks are registered;
 * - `autoIndex: false` — this backend never creates/syncs indexes on the
 *   shared production collection;
 * - ThemesService only ever calls find/findOne on this model.
 */

export type ThemeCacheDocument = HydratedDocument<ThemeCache>;

@Schema({ _id: false })
export class ThemeVideoSource {
  @Prop({ type: Number, required: true })
  resolution: number;

  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: String, default: null })
  source: string | null;

  @Prop({ type: String, default: 'video/webm' })
  mime: string;
}
export const ThemeVideoSourceSchema =
  SchemaFactory.createForClass(ThemeVideoSource);

@Schema({ _id: false })
export class ThemeEntry {
  @Prop({ type: Number, required: true })
  atEntryId: number;

  @Prop({ type: String, default: 'Standard' })
  version: string;

  @Prop({ type: String, default: null })
  episodes: string | null;

  @Prop({ type: Boolean, default: false })
  spoiler: boolean;

  @Prop({ type: Boolean, default: false })
  nsfw: boolean;

  @Prop({ type: [String] })
  tags: string[];

  @Prop({ type: [ThemeVideoSourceSchema] })
  videoSources: ThemeVideoSource[];

  @Prop({ type: String, default: null })
  videoUrl: string | null;

  @Prop({ type: String, default: null })
  audioUrl: string | null;

  @Prop({ type: Number, default: 90 })
  duration: number | null;
}
export const ThemeEntrySchema = SchemaFactory.createForClass(ThemeEntry);

@Schema({ collection: 'themecaches', timestamps: true, autoIndex: false })
export class ThemeCache {
  @Prop({ type: String, required: true })
  slug: string;

  @Prop({ type: Number, required: true })
  animethemesId: number;

  @Prop({ type: String, required: true })
  songTitle: string;

  @Prop({ type: String, default: null })
  artistName: string | null;

  @Prop({ type: [String] })
  allArtists: string[];

  @Prop({ type: [String] })
  artistSlugs: string[];

  @Prop({ type: [String] })
  artistRoles: string[];

  @Prop({ type: Number, default: null })
  anilistId: number | null;

  @Prop({ type: String, default: null })
  kitsuId: string | null;

  @Prop({ type: String, required: true })
  animeTitle: string;

  @Prop({ type: String, default: null })
  animeTitleEnglish: string | null;

  @Prop({ type: [String] })
  animeTitleAlternative: string[];

  @Prop({ type: String, enum: ['WINTER', 'SPRING', 'SUMMER', 'FALL'], default: null })
  animeSeason: string | null;

  @Prop({ type: Number, default: null })
  animeSeasonYear: number | null;

  @Prop({ type: String, default: null })
  animeCoverImage: string | null;

  @Prop({ type: String, default: null })
  animeCoverImageSmall: string | null;

  @Prop({ type: String, default: null })
  animeGrillImage: string | null;

  @Prop({ type: [String] })
  animeStudios: string[];

  @Prop({ type: [String] })
  animeSeries: string[];

  @Prop({ type: String, enum: ['OP', 'ED'], required: true })
  type: string;

  @Prop({ type: Number, required: true })
  sequence: number;

  @Prop({ type: [ThemeEntrySchema] })
  entries: ThemeEntry[];

  @Prop({ type: String, required: true })
  videoUrl: string;

  @Prop({ type: String, default: null })
  audioUrl: string | null;

  @Prop({ type: [String] })
  mood: string[];

  /** Voyage embedding (voyage-4-large). Null in the sampled production docs; excluded from API responses. */
  @Prop({ type: [Number], default: null })
  embedding: number[] | null;

  @Prop({ type: Number, default: 0 })
  avgRating: number;

  @Prop({ type: Number, default: 0 })
  totalRatings: number;

  @Prop({ type: Number, default: 0 })
  totalWatches: number;

  @Prop({ type: Number, default: 0 })
  totalListens: number;

  @Prop({ type: Number, default: 90 })
  duration: number;

  @Prop({ type: Date, required: true })
  syncedAt: Date;

  @Prop({ type: Boolean, default: false })
  isPopular: boolean;

  @Prop({ type: Number, default: null })
  popularRank: number | null;

  @Prop({ type: Date, default: null })
  featuredAt: Date | null;
}

export const ThemeCacheSchema = SchemaFactory.createForClass(ThemeCache);

/**
 * Perf problem 15 (B8) — season read index, declared AFTER the
 * factory in the web schema's own style (its
 * `ThemeCacheSchema.index(...)` block, lib/models/index.ts).
 * The season read (ThemesService.getSeasonThemes) filters
 * { animeSeason, animeSeasonYear } and sorts
 * { sequence: 1, avgRating: -1 }; the web declares only the
 * filter pair ({ animeSeason: 1, animeSeasonYear: 1 }), so its
 * sort runs in memory — this compound covers filter + sort.
 *
 * DECLARATION ONLY: `autoIndex: false` above (and no autoIndex
 * override in the module wiring, and nothing in this backend
 * calls syncIndexes/createIndexes) means Mongoose will NOT build
 * this index on deploy — by design, this backend never creates
 * indexes on the shared production collection. Creating it on
 * the live cluster is a follow-up for the guarded ensure route,
 * alongside the Atlas Search indexes; until then the declaration
 * records the intent and pins the query shape in tests.
 */
ThemeCacheSchema.index({
  animeSeason: 1,
  animeSeasonYear: 1,
  sequence: 1,
  avgRating: -1,
});

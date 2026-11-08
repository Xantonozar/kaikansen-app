import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Model for the shared `users` collection (Slice 2 — auth).
 *
 * Field-for-field port of the web app's User schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`), matching the fields the
 * 2026-11-07 database inspection verified on production documents:
 * username, displayName, email, passwordHash, avatarUrl, bio,
 * totalRatings, totalFollowers, totalFollowing, isPublic + timestamps.
 * (`totalTime` is declared on the web schema too; the sampled document
 * predates it. It is modelled here because the watch-history write
 * path increments it — see library/watch-history.schema.ts.)
 *
 * Deliberate differences from the web schema:
 * - `passwordHash` is `select: false` (the web queries it with
 *   `.select('+passwordHash')` on login — same behaviour here).
 * - `autoIndex: false` and NO cross-model middleware hooks: the web
 *   maintains denormalised counters (totalFollowers etc. on follow /
 *   unfollow etc.) through hooks in other models' operations. Auth
 *   itself only ever creates a user (counters start at 0, exactly as
 *   on web registration) and reads profiles back; the counter
 *   maintenance for ratings and watch history lives in the library
 *   module's service layer (Slice S1), ported hook-for-hook.
 *
 * The `anilist` sub-document below IS modelled (AniList login slice),
 * field-for-field as the web declares it — including
 * `completedMediaIds`, which the web's AniList sync fills; this API
 * does not write it yet. NOTE: `anilist.accessToken` is stored in
 * PLAINTEXT, exactly as the web stores it — mirrored deliberately;
 * hardening that storage is OPEN item O-05 (specs/DECISIONS.md).
 */

export type UserDocument = HydratedDocument<User>;

/**
 * The `anilist` sub-document — field-for-field the web's shape
 * (lib/models/index.ts). `accessToken` is the user's AniList OAuth
 * token, stored in plaintext as on the web (OPEN item O-05).
 */
@Schema({ _id: false })
export class AnilistLink {
  @Prop({ type: String })
  accessToken?: string;

  @Prop({ type: Number })
  userId?: number;

  @Prop({ type: String })
  username?: string;

  @Prop({ type: Date })
  syncedAt?: Date;

  @Prop({ type: [Number] })
  completedMediaIds?: number[];
}

export const AnilistLinkSchema = SchemaFactory.createForClass(AnilistLink);

@Schema({ collection: 'users', timestamps: true, autoIndex: false })
export class User {
  @Prop({ type: String, required: true })
  username: string;

  @Prop({ type: String, required: true })
  displayName: string;

  @Prop({ type: String, required: true })
  email: string;

  @Prop({ type: String, required: true, select: false })
  passwordHash: string;

  @Prop({ type: String, default: null })
  avatarUrl: string | null;

  @Prop({ type: String, default: '' })
  bio: string;

  @Prop({ type: Number, default: 0 })
  totalRatings: number;

  @Prop({ type: Number, default: 0 })
  totalFollowers: number;

  @Prop({ type: Number, default: 0 })
  totalFollowing: number;

  /**
   * Cumulative seconds watched/listened, maintained by the
   * watch-history write path (the web's WatchHistory post-save hook
   * $incs it by the played entry's duration). Not exposed on
   * UserProfile — the web's /api/users/me does not return it either.
   */
  @Prop({ type: Number, default: 0 })
  totalTime: number;

  @Prop({ type: Boolean, default: true })
  isPublic: boolean;

  @Prop({ type: AnilistLinkSchema, default: undefined })
  anilist?: AnilistLink;
}

export const UserSchema = SchemaFactory.createForClass(User);

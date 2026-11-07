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
 *
 * Deliberate omissions / differences from the web schema:
 * - `passwordHash` is `select: false` (the web queries it with
 *   `.select('+passwordHash')` on login — same behaviour here).
 * - The web's `anilist` sub-document is NOT modelled in this slice: the
 *   sampled production user doc carried no AniList fields, and AniList
 *   login/linking is a later slice. Documents that have it keep it —
 *   this schema simply doesn't read or write it.
 * - `autoIndex: false` and NO cross-model middleware hooks: the web
 *   maintains denormalised counters (totalFollowers etc. on follow /
 *   unfollow etc.) through hooks in other models' operations. Porting
 *   that counter maintenance is v1 work; this slice only ever creates
 *   a user (counters start at 0, exactly as on web registration) and
 *   reads profiles back.
 */

export type UserDocument = HydratedDocument<User>;

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

  @Prop({ type: Boolean, default: true })
  isPublic: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);

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
 * `completedMediaIds`, which the web's AniList sync fills. NOTE:
 * since the 2026-11-08 widening, THIS API's library sync stores
 * the combined COMPLETED + CURRENT (watching) id set in that
 * field — the name is the web's and stays for schema
 * compatibility (see AnilistLibraryClient's DEVIATION note).
 * NOTE: `anilist.accessToken` is stored in
 * PLAINTEXT, exactly as the web stores it — mirrored deliberately;
 * hardening that storage is OPEN item O-05 (specs/DECISIONS.md).
 *
 * THREE additive fields are NOT the web's: `passwordReset` and
 * `tokenVersion` exist only for this API's password-reset flow
 * (the web has no reset capability at all), and
 * `anilistEntriesCache` only for this API's AniList-entries read
 * (GET /library/anilist-entries — the web stores only the merged
 * media ids, never per-entry rows). They follow the same
 * additive pattern as the AniList sub-document: the web's models
 * neither read nor write them, and its delta saves leave them
 * untouched.
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

/**
 * The `passwordReset` sub-document — pending reset state for the
 * code-based password-reset flow. Only the HASH of the 6-digit
 * code is ever stored (bcrypt, like the password itself — a bare
 * fast hash of a 6-digit code would be brute-forced instantly if
 * the database leaked), with its expiry and the count of failed
 * verification attempts. The sub-document is cleared when the
 * code is used, when the attempt cap burns it, when it expires,
 * and whenever a fresh code replaces it.
 */
@Schema({ _id: false })
export class PasswordReset {
  @Prop({ type: String })
  codeHash?: string;

  @Prop({ type: Date })
  expiresAt?: Date;

  @Prop({ type: Number, default: 0 })
  attempts?: number;
}

export const PasswordResetSchema = SchemaFactory.createForClass(PasswordReset);

/**
 * One cached AniList list entry for GET /library/anilist-entries
 * — the wire entry plus its list status, stored verbatim from the
 * AniList GraphQL read (see AnilistLibraryClient.fetchLibraryEntries)
 * so a stale cache can be served while a refresh runs behind the
 * response, exactly like the stored completedMediaIds dance.
 */
@Schema({ _id: false })
export class AnilistCachedEntry {
  @Prop({ type: Number, required: true })
  mediaId: number;

  /** AniList list status: 'CURRENT' (watching) or 'COMPLETED'. */
  @Prop({ type: String, required: true })
  status: string;

  @Prop({ type: String, required: true })
  title: string;

  @Prop({ type: String, default: null })
  coverImage: string | null;

  @Prop({ type: String, default: null })
  format: string | null;

  @Prop({ type: Number, default: null })
  episodes: number | null;

  @Prop({ type: Number, default: 0 })
  progress: number;

  @Prop({ type: Number, default: null })
  score: number | null;
}

export const AnilistCachedEntrySchema =
  SchemaFactory.createForClass(AnilistCachedEntry);

/**
 * The `anilistEntriesCache` sub-document — the caller's last
 * fetched AniList Watching/Completed entries with their fetch
 * time. The 6-hour TTL and stale-while-revalidate behaviour live
 * in LibraryService.getAnilistEntries, mirroring the stored-ids
 * cache the web's library read established.
 */
@Schema({ _id: false })
export class AnilistEntriesCache {
  @Prop({ type: Date })
  syncedAt?: Date;

  @Prop({ type: [AnilistCachedEntrySchema], default: undefined })
  entries?: AnilistCachedEntry[];
}

export const AnilistEntriesCacheSchema =
  SchemaFactory.createForClass(AnilistEntriesCache);

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

  /**
   * Cached AniList Watching/Completed entries for
   * GET /library/anilist-entries (see AnilistEntriesCache above).
   * Additive and API-only: the web's models neither read nor
   * write it.
   */
  @Prop({ type: AnilistEntriesCacheSchema, default: undefined })
  anilistEntriesCache?: AnilistEntriesCache;

  /**
   * Pending password-reset state (see PasswordReset above).
   * `select: false` like passwordHash: only the reset flow loads
   * it, and only explicitly.
   */
  @Prop({ type: PasswordResetSchema, default: undefined, select: false })
  passwordReset?: PasswordReset;

  /**
   * Session generation counter for refresh-token revocation: the
   * value is minted into every token pair, and a password reset
   * increments it, so POST /auth/refresh rejects every refresh
   * token issued before the reset (AuthService.refresh compares
   * the claim against this field). Access tokens are unaffected —
   * they stay stateless and expire within 15 minutes.
   */
  @Prop({ type: Number, default: 0 })
  tokenVersion: number;
}

export const UserSchema = SchemaFactory.createForClass(User);

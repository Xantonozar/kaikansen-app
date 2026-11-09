import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Model for the shared `userranks` collection — a player's rank
 * points (RP), tier, streaks and lifetime/season stats.
 *
 * Field-for-field port of the web app's UserRank schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`). The values are
 * maintained by the web's `lib/rank-utils.ts` when a multiplayer
 * game ends; this API ports that maintenance verbatim (see
 * RankService) because the website's leaderboard and rank pages
 * read these documents — a mobile game must move them exactly
 * the way a web game does.
 *
 * Note `userId` here is a plain String (unlike most models in the
 * shared DB). The web's index set is { userId: 1 } unique,
 * { rp: -1 } and { 'season.seasonRP': -1 }; `autoIndex: false`
 * as everywhere in this API.
 */

export type UserRankDocument = HydratedDocument<UserRank>;

@Schema({ _id: false })
export class UserRankStats {
  @Prop({ type: Number, default: 0 })
  totalGames: number;

  @Prop({ type: Number, default: 0 })
  wins: number;

  @Prop({ type: Number, default: 0 })
  losses: number;

  @Prop({ type: Number, default: 0 })
  draws: number;

  @Prop({ type: Number, default: 0 })
  winRate: number;

  @Prop({ type: Number, default: 0 })
  peakRP: number;

  @Prop({
    type: String,
    enum: ['academy', 'genin', 'chunin', 'jonin', 'anbu', 'kage'],
    default: 'academy',
  })
  peakTier: string;
}
export const UserRankStatsSchema = SchemaFactory.createForClass(UserRankStats);

@Schema({ _id: false })
export class UserRankSeason {
  @Prop({ type: String, default: 'all-time' })
  seasonId: string;

  @Prop({ type: Number, default: 0 })
  seasonRP: number;

  @Prop({ type: Number, default: 0 })
  seasonWins: number;

  @Prop({ type: Number, default: 0 })
  seasonLosses: number;

  @Prop({ type: Number, default: null })
  seasonPlacement: number | null;
}
export const UserRankSeasonSchema =
  SchemaFactory.createForClass(UserRankSeason);

@Schema({ collection: 'userranks', timestamps: true, autoIndex: false })
export class UserRank {
  @Prop({ type: String, required: true, unique: true })
  userId: string;

  @Prop({ type: Number, default: 0 })
  rp: number;

  @Prop({
    type: String,
    enum: ['academy', 'genin', 'chunin', 'jonin', 'anbu', 'kage'],
    default: 'academy',
  })
  tier: string;

  @Prop({ type: Number, default: null })
  division: number | null;

  @Prop({ type: Number, default: 0 })
  tierFloor: number;

  @Prop({ type: Number, default: 0 })
  currentWinStreak: number;

  @Prop({ type: Number, default: 0 })
  longestWinStreak: number;

  // The subdocs MUST carry a default: Mongoose does not
  // instantiate a single nested subdocument declared without one,
  // so a rank doc created (or a legacy row hydrated) through this
  // schema otherwise has stats/season === undefined — and
  // RankService's first `stats.totalGames += 1` threw on every
  // finished game, silently killing all RP application (Bug 2,
  // multi-user matrix 2026-11-09; the throw was swallowed by the
  // scheduler's catch). `default: () => ({})` materialises the
  // subdoc with its own zeroed defaults in both cases.
  @Prop({ type: UserRankStatsSchema, default: () => ({}) })
  stats: UserRankStats;

  @Prop({ type: UserRankSeasonSchema, default: () => ({}) })
  season: UserRankSeason;
}

export const UserRankSchema = SchemaFactory.createForClass(UserRank);

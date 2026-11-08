import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Model for the shared `leaderboardsnapshots` collection — the
 * precomputed RP leaderboard the web's cron route
 * (app/api/cron/leaderboard-snapshot) refreshes and the web's
 * GET /api/leaderboard serves while it is fresh (≤ 15 minutes).
 *
 * Field-for-field port of the web app's LeaderboardSnapshot schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { scope, seasonId,
 * computedAt, entries[] } with `timestamps: false` (computedAt is
 * the only clock) and a unique { scope, seasonId } index on the
 * web. This API only READS the global/all-time snapshot (the cron
 * writer stays web-side, per the S4 note); `autoIndex: false` as
 * everywhere in this API.
 */

export type LeaderboardSnapshotDocument =
  HydratedDocument<LeaderboardSnapshot>;

@Schema({ _id: false })
export class LeaderboardSnapshotEntry {
  @Prop({ type: Number, required: true })
  rank: number;

  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  username: string;

  @Prop({ type: String, default: null })
  avatar: string | null;

  @Prop({ type: String, required: true })
  tier: string;

  @Prop({ type: Number, default: null })
  division: number | null;

  @Prop({ type: Number, required: true })
  rp: number;

  @Prop({ type: Number, required: true })
  wins: number;

  @Prop({ type: Number, required: true })
  winRate: number;

  @Prop({ type: Number, required: true })
  currentWinStreak: number;
}
export const LeaderboardSnapshotEntrySchema = SchemaFactory.createForClass(
  LeaderboardSnapshotEntry,
);

@Schema({
  collection: 'leaderboardsnapshots',
  timestamps: false,
  autoIndex: false,
})
export class LeaderboardSnapshot {
  @Prop({
    type: String,
    enum: ['global', 'weekly', 'monthly'],
    required: true,
  })
  scope: string;

  @Prop({ type: String, required: true })
  seasonId: string;

  @Prop({ type: Date, required: true })
  computedAt: Date;

  @Prop({ type: [LeaderboardSnapshotEntrySchema], default: [] })
  entries: LeaderboardSnapshotEntry[];
}

export const LeaderboardSnapshotSchema = SchemaFactory.createForClass(
  LeaderboardSnapshot,
);

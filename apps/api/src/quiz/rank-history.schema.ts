import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Model for the shared `rankhistories` collection — one row per
 * player per finished multiplayer game, written by the web's
 * rank maintenance (lib/rank-utils.ts `calculateAndApplyRP`).
 *
 * Field-for-field port of the web app's RankHistory schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { userId, roomId,
 * roomType, playedAt, placement, totalPlayers, rpBefore, rpAfter,
 * rpChange, streakBonus, winStreakAtTime, tierBefore, tierAfter,
 * promoted, demoted } and — notably — `timestamps: false`: the
 * row's only clock is `playedAt`. userId/roomId are plain Strings.
 *
 * The web's index is { userId: 1, playedAt: -1 }; `autoIndex:
 * false` as everywhere in this API.
 */

export type RankHistoryDocument = HydratedDocument<RankHistory>;

@Schema({ collection: 'rankhistories', timestamps: false, autoIndex: false })
export class RankHistory {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  roomId: string;

  @Prop({ type: String, enum: ['party', 'duel'], required: true })
  roomType: string;

  @Prop({ type: Date, required: true })
  playedAt: Date;

  @Prop({ type: Number, required: true })
  placement: number;

  @Prop({ type: Number, required: true })
  totalPlayers: number;

  @Prop({ type: Number, required: true })
  rpBefore: number;

  @Prop({ type: Number, required: true })
  rpAfter: number;

  @Prop({ type: Number, required: true })
  rpChange: number;

  @Prop({ type: Number, required: true })
  streakBonus: number;

  @Prop({ type: Number, required: true })
  winStreakAtTime: number;

  @Prop({ type: String, required: true })
  tierBefore: string;

  @Prop({ type: String, required: true })
  tierAfter: string;

  @Prop({ type: Boolean, default: false })
  promoted: boolean;

  @Prop({ type: Boolean, default: false })
  demoted: boolean;
}

export const RankHistorySchema = SchemaFactory.createForClass(RankHistory);

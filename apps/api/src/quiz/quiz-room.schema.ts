import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `quizrooms` collection — a multiplayer quiz
 * room as ONE document: settings, embedded players, embedded
 * rounds with per-player answers.
 *
 * Field-for-field port of the web app's QuizRoom schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`), including its
 * quirks:
 *
 * - `players[].userId` is a plain String (the host id, by contrast,
 *   is an ObjectId ref) — the web compares them as strings.
 * - `rounds[].answers[]` has NO `timedOut` field: the web's
 *   timeout route tries to write one and Mongoose strips it.
 *   Timed-out answers are the `autoLocked: true` rows written by
 *   its timer-end route. Mirrored — this API's server timer
 *   writes autoLocked rows too.
 * - `timerAuthority` is the web's Pusher-era timer-election token
 *   (the client whose timestamp matches runs the countdown and
 *   POSTs timer-end). This API's server owns the round timers
 *   (Socket.IO gateway), so nothing reads the field here; it is
 *   still stamped on round starts, exactly as the web stamps it,
 *   so documents stay shape-identical for the web app.
 *
 * Indexes on the web model: a 24h TTL on createdAt, { roomCode: 1 }
 * and a compound settings/status index. `autoIndex: false` as
 * everywhere in this API — the shared production collection
 * already carries them (and its TTL does this API's long-tail
 * room cleanup for free).
 */

export type QuizRoomDocument = HydratedDocument<QuizRoom>;

@Schema({ _id: false })
export class QuizRoomSettings {
  @Prop({ type: String, enum: ['random', 'watched', 'common'], required: true })
  poolMode: string;

  @Prop({ type: [String] })
  watchedPoolAnimeIds: string[];

  @Prop({ type: String, enum: ['anime', 'song', 'artist'], required: true })
  guessType: string;

  @Prop({ type: Number, required: true })
  roundCount: number;

  @Prop({ type: Number, required: true })
  maxPlayers: number;

  @Prop({ type: Number, default: 30 })
  timeLimitSeconds: number;
}
export const QuizRoomSettingsSchema =
  SchemaFactory.createForClass(QuizRoomSettings);

@Schema({ _id: false })
export class QuizRoomPlayer {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  username: string;

  @Prop({ type: String, default: null })
  avatar: string | null;

  @Prop({ type: Number, default: 0 })
  totalScore: number;

  @Prop({ type: Boolean, default: false })
  ready: boolean;

  @Prop({ type: Date, default: Date.now })
  joinedAt: Date;

  @Prop({ type: Date, default: Date.now })
  lastSeenAt: Date;
}
export const QuizRoomPlayerSchema =
  SchemaFactory.createForClass(QuizRoomPlayer);

@Schema({ _id: false })
export class QuizRoundAnswer {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String })
  submittedAnswer: string;

  @Prop({ type: Boolean, required: true })
  correct: boolean;

  @Prop({ type: Date, default: Date.now })
  answeredAt: Date;

  @Prop({ type: Number, required: true })
  secondsRemaining: number;

  @Prop({ type: Number, required: true })
  baseScore: number;

  @Prop({ type: Number, required: true })
  bonusScore: number;

  @Prop({ type: Number, required: true })
  totalScoreGained: number;

  @Prop({ type: Boolean, default: false })
  autoLocked: boolean;
}
export const QuizRoundAnswerSchema =
  SchemaFactory.createForClass(QuizRoundAnswer);

@Schema({ _id: false })
export class QuizRoomRound {
  @Prop({ type: Number, required: true })
  roundNumber: number;

  @Prop({ type: String, required: true })
  themeId: string;

  @Prop({ type: String, required: true })
  videoUrl: string;

  @Prop({ type: String, required: true })
  correctAnswer: string;

  @Prop({ type: [String] })
  alternateAnswers: string[];

  @Prop({ type: [String] })
  options: string[];

  @Prop({ type: Date, required: true })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  endedAt: Date | null;

  // Theme metadata for the reveal screen.
  @Prop({ type: String, default: null })
  animeTitle: string | null;

  @Prop({ type: String, default: null })
  animeTitleEnglish: string | null;

  @Prop({ type: String, default: null })
  coverImage: string | null;

  @Prop({ type: Number, default: null })
  malId: number | null;

  @Prop({ type: String, default: null })
  themeType: string | null;

  @Prop({ type: Number, default: null })
  themeSequence: number | null;

  @Prop({ type: String, default: null })
  songTitle: string | null;

  @Prop({ type: String, default: null })
  artistName: string | null;

  @Prop({ type: [QuizRoundAnswerSchema] })
  answers: QuizRoundAnswer[];

  @Prop({ type: String, default: null })
  firstCorrectUserId: string | null;
}
export const QuizRoomRoundSchema =
  SchemaFactory.createForClass(QuizRoomRound);

@Schema({ collection: 'quizrooms', timestamps: true, autoIndex: false })
export class QuizRoom {
  @Prop({ type: String, required: true, unique: true, uppercase: true })
  roomCode: string;

  @Prop({ type: String, enum: ['party', 'duel'], required: true })
  roomType: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  hostId: Types.ObjectId | null;

  @Prop({ type: QuizRoomSettingsSchema, required: true })
  settings: QuizRoomSettings;

  @Prop({
    type: String,
    enum: ['waiting', 'in_progress', 'ended'],
    default: 'waiting',
  })
  status: string;

  @Prop({ type: String, enum: ['invite', 'public'], required: true })
  matchmaking: string;

  @Prop({ type: Number, default: 0 })
  currentRound: number;

  @Prop({ type: [QuizRoomPlayerSchema] })
  players: QuizRoomPlayer[];

  @Prop({ type: Date, default: null })
  emptySince: Date | null;

  @Prop({ type: [String] })
  usedThemeIds: string[];

  @Prop({ type: [QuizRoomRoundSchema] })
  rounds: QuizRoomRound[];

  @Prop({ type: String, default: null })
  timerAuthority: string | null;
}

export const QuizRoomSchema = SchemaFactory.createForClass(QuizRoom);

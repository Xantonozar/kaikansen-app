import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `quizattempts` collection — one row per
 * answered SOLO quiz question.
 *
 * Field-for-field port of the web app's QuizAttempt schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { userId (nullable —
 * the web accepts anonymous attempts), themeSlug, atEntryId,
 * quizType ('title' | 'artist' | 'anime'), correct, timeTaken,
 * score, streak } + timestamps.
 *
 * The web's write path (POST /api/quiz/submit) stores a FULLY
 * client-computed attempt verbatim — the question endpoint even
 * ships the correct answer to the browser, so the web solo quiz is
 * a pure client-trust design. This API keeps the same persistence
 * shape and the same scoring formula, but computes the values
 * server-side (see SoloQuizService): the attempt rows it writes are
 * indistinguishable from the web's, only trustworthy.
 *
 * The web's index set is { userId: 1, createdAt: -1 },
 * { themeSlug: 1 } and { score: -1 }. `autoIndex: false` as
 * everywhere in this API: the shared production collection
 * already carries them.
 */

export type QuizAttemptDocument = HydratedDocument<QuizAttempt>;

@Schema({ collection: 'quizattempts', timestamps: true, autoIndex: false })
export class QuizAttempt {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    default: null,
  })
  userId: Types.ObjectId | null;

  @Prop({ type: String, required: true })
  themeSlug: string;

  @Prop({ type: Number, required: true })
  atEntryId: number;

  @Prop({ type: String, enum: ['title', 'artist', 'anime'], required: true })
  quizType: string;

  @Prop({ type: Boolean, required: true })
  correct: boolean;

  @Prop({ type: Number, required: true })
  timeTaken: number;

  @Prop({ type: Number, required: true })
  score: number;

  @Prop({ type: Number, default: 0 })
  streak: number;
}

export const QuizAttemptSchema = SchemaFactory.createForClass(QuizAttempt);

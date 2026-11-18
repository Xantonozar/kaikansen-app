import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { ChatMessage, ChatReportReason } from '@kaikansen/contracts';

/**
 * Model for the app-only `chatreports` collection (new,
 * additive). One row per user-filed report: who reported whom,
 * the reason, and — when the report is anchored to a message —
 * a FROZEN context snapshot (the reported message plus up to 5
 * surrounding messages, as contract DTOs) so a moderator sees
 * exactly what was reported even if the conversation is later
 * declined/deleted. Read only through the operator endpoint
 * (GET /chat/reports, ADMIN_USER_IDS env); there is no user
 * surface for reports beyond filing one.
 */
@Schema({ collection: 'chatreports', timestamps: true, autoIndex: false })
export class ChatReport {
  @Prop({ type: String, required: true })
  reporterId: string;

  @Prop({ type: String, required: true })
  reportedUserId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  conversationId: Types.ObjectId | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  messageId: Types.ObjectId | null;

  @Prop({ type: String, enum: ['spam', 'harassment', 'other'], required: true })
  reason: ChatReportReason;

  /** Frozen ChatMessage DTOs (empty for profile-level reports). */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  context: ChatMessage[];
}

export const ChatReportSchema = SchemaFactory.createForClass(ChatReport);
export type ChatReportDocument = HydratedDocument<ChatReport>;

/** Operator queue reads newest-first; reportedUserId supports repeat-offender lookups. */
ChatReportSchema.index({ createdAt: -1 });
ChatReportSchema.index({ reportedUserId: 1, createdAt: -1 });

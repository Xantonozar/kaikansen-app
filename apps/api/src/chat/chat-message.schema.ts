import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { ChatThemeSnapshot } from '@kaikansen/contracts';

/**
 * Model for the app-only `chatmessages` collection (new,
 * additive). One document per message. `readAt` is the single
 * read timestamp from the OTHER participant (a 1:1 thread has
 * exactly one possible reader per message); it is only ever set
 * in active conversations — request-state messages never carry
 * read state, so a request receiver's reads stay invisible.
 */
@Schema({ collection: 'chatmessages', timestamps: true, autoIndex: false })
export class ChatMessage {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ChatConversation',
    required: true,
  })
  conversationId: Types.ObjectId;

  /** Sender userId (plain string, like RankHistory/QuizRoomPlayer). */
  @Prop({ type: String, required: true })
  senderId: string;

  @Prop({ type: String, enum: ['text', 'theme'], required: true })
  type: string;

  @Prop({ type: String, default: null })
  text: string | null;

  /** Frozen theme card snapshot for type 'theme'; null otherwise. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  theme: ChatThemeSnapshot | null;

  /** When the other participant read this message (active conversations only). */
  @Prop({ type: Date, default: null })
  readAt: Date | null;

  /**
   * Client-generated send id (idempotency key), when the sender
   * supplied one. A re-send with the same (conversationId,
   * senderId, clientId) returns this message instead of creating
   * a duplicate — see the partial unique index below.
   */
  @Prop({ type: String, default: null })
  clientId: string | null;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);
export type ChatMessageDocument = HydratedDocument<ChatMessage>;

/**
 * Indexes for this APP-ONLY collection (built by ChatService's
 * onModuleInit createIndexes — see chat-conversation.schema.ts):
 * - (conversationId, _id) — the thread page shape (filter + sort).
 * - (conversationId, senderId, clientId) UNIQUE over string
 *   clientIds only — the send-idempotency key. Partial, not
 *   sparse, so messages without a clientId never collide.
 */
ChatMessageSchema.index({ conversationId: 1, _id: -1 });
/** Unread aggregation shape (per conversation, from one sender, after a read marker). */
ChatMessageSchema.index({ conversationId: 1, senderId: 1, createdAt: 1 });
ChatMessageSchema.index(
  { conversationId: 1, senderId: 1, clientId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientId: { $type: 'string' } },
  },
);

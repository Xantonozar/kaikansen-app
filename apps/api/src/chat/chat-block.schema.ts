import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Model for the app-only `chatblocks` collection (new, additive).
 * The API had no block concept anywhere before chat; a row means
 * `blockerId` has blocked `blockedId` for direct messages: the
 * pair's conversation (if any) is closed and the blocked user
 * cannot open a new one. One-directional rows; checks test both
 * directions where the pair is concerned.
 */
@Schema({ collection: 'chatblocks', timestamps: true, autoIndex: false })
export class ChatBlock {
  @Prop({ type: String, required: true })
  blockerId: string;

  @Prop({ type: String, required: true })
  blockedId: string;
}

export const ChatBlockSchema = SchemaFactory.createForClass(ChatBlock);
export type ChatBlockDocument = HydratedDocument<ChatBlock>;

/**
 * Indexes for this APP-ONLY collection (built by ChatService's
 * onModuleInit createIndexes — see chat-conversation.schema.ts):
 * the pair lookup runs in both directions, and the (blocker,
 * blocked) pair is unique so double-blocks stay one row.
 */
ChatBlockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
ChatBlockSchema.index({ blockedId: 1, blockerId: 1 });

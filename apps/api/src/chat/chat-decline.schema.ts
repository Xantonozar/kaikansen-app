import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Model for the app-only `chatdeclines` collection (new,
 * additive): DECLINE TOMBSTONES.
 *
 * Declining a message request deletes the conversation silently
 * — the sender is never told. Without a tombstone the sender
 * could immediately re-open a fresh request, making decline
 * useless against repeat requests. A tombstone records that
 * `declinerId` declined `requesterId` (the pair is keyed by
 * pairKey) at `createdAt`:
 *
 * - While the tombstone is FRESH (< 30 days), a re-opened
 *   conversation from the same requester is created hidden from
 *   the decliner (ChatConversation.hiddenFor): it works from the
 *   requester's side — messages save, no error, silence fully
 *   preserved — but never surfaces for the decliner (no inbox /
 *   requests rows, no counts, no socket events, thread 404s).
 * - After 30 days the tombstone is EXPIRED: the next open/send
 *   clears it and the conversation surfaces as a normal fresh
 *   request.
 * - The decliner engaging first (opening the conversation
 *   themselves, or accepting) clears the tombstone immediately.
 *
 * Expiry is lazy (checked on open/send), so no sweeper is
 * needed; stale rows are deleted when next touched.
 */
@Schema({ collection: 'chatdeclines', timestamps: true, autoIndex: false })
export class ChatDecline {
  /** `${lowUserId}:${highUserId}` — same key as the conversation. */
  @Prop({ type: String, required: true })
  pairKey: string;

  /** The user who declined (the request receiver). */
  @Prop({ type: String, required: true })
  declinerId: string;

  /** The user whose request was declined (the sender). */
  @Prop({ type: String, required: true })
  requesterId: string;
}

export const ChatDeclineSchema = SchemaFactory.createForClass(ChatDecline);
export type ChatDeclineDocument = HydratedDocument<ChatDecline>;

/** One tombstone per pair (built by ChatService's onModuleInit). */
ChatDeclineSchema.index({ pairKey: 1 }, { unique: true });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import type { ChatLastMessage } from '@kaikansen/contracts';

/**
 * Model for the app-only `chatconversations` collection (new
 * collection, additive — the website has no DM feature and never
 * reads it). One document per 1:1 pair: `participantIds` is the
 * sorted pair of userId strings and `pairKey` their joined form,
 * so a pair can only ever resolve to one record.
 *
 * DM policy is the requests model: a conversation created by a
 * sender the receiver does not follow starts as `request`
 * (requestedBy = the sender) until the receiver accepts, declines
 * (record + messages deleted, silently) or blocks (→ `blocked`).
 */
@Schema({ collection: 'chatconversations', timestamps: true, autoIndex: false })
export class ChatConversation {
  /** The pair of participant userIds, sorted ascending. */
  @Prop({ type: [String], required: true })
  participantIds: string[];

  /** `${lowUserId}:${highUserId}` — the pair lookup key. */
  @Prop({ type: String, required: true })
  pairKey: string;

  @Prop({
    type: String,
    enum: ['active', 'request', 'blocked'],
    default: 'active',
  })
  status: string;

  /** userId that initiated the conversation while it is/was a request; null when it started active. */
  @Prop({ type: String, default: null })
  requestedBy: string | null;

  /** userId that blocked the pair (status 'blocked'), else null. */
  @Prop({ type: String, default: null })
  blockedBy: string | null;

  /**
   * Decline-tombstone hiding: when a declined requester re-opens
   * the pair while their decline tombstone is fresh, the new
   * conversation is created with `hiddenFor` = the decliner's
   * userId. The conversation then works normally for the sender
   * but is invisible to that user (no lists, no counts, no socket
   * events, thread reads 404) until the tombstone expires or the
   * decliner engages. Null in every normal conversation.
   */
  @Prop({ type: String, default: null })
  hiddenFor: string | null;

  /** Denormalised last-message preview for the inbox row. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  lastMessage: ChatLastMessage | null;

  /**
   * Per-user read markers (participantIds[0] → readAtFirst,
   * participantIds[1] → readAtSecond): when that participant last
   * marked the conversation read. Unread counts are messages from
   * the other side created after the marker. Two flat fields
   * instead of a map so updates stay plain typed $sets.
   */
  @Prop({ type: Date, default: null })
  readAtFirst: Date | null;

  @Prop({ type: Date, default: null })
  readAtSecond: Date | null;

  /**
   * Who created the record (the opener of the first
   * openConversation call). Drives two rules: an EMPTY
   * conversation (no messages yet) is only visible to its
   * creator, and the daily first-contact limit counts records
   * created by the caller. Null on pre-field legacy rows.
   */
  @Prop({ type: String, default: null })
  createdBy: string | null;

  /**
   * Denormalised last-activity instant (creation, then every
   * committed send) — the inbox sort key. Declared and indexed
   * (below) so ordering stops depending on updatedAt, which
   * unrelated writes can move. Null on legacy rows; readers fall
   * back to lastMessage time, then updatedAt.
   */
  @Prop({ type: Date, default: null })
  lastActivityAt: Date | null;

  /**
   * Per-user conversation state, positional like the read
   * markers (participantIds[0] → *First, [1] → *Second):
   * - muted: no push for that user; their unread is excluded
   *   from badge counts.
   * - archived: hidden from that user's inbox until a new
   *   message arrives (any send clears both sides' flags).
   * - clearedAt (delete-for-me): that user sees only messages
   *   created after this instant; with no newer message the
   *   conversation is hidden for them. The other side is
   *   completely unaffected.
   */
  @Prop({ type: Boolean, default: false })
  mutedFirst: boolean;

  @Prop({ type: Boolean, default: false })
  mutedSecond: boolean;

  @Prop({ type: Boolean, default: false })
  archivedFirst: boolean;

  @Prop({ type: Boolean, default: false })
  archivedSecond: boolean;

  @Prop({ type: Date, default: null })
  clearedAtFirst: Date | null;

  @Prop({ type: Date, default: null })
  clearedAtSecond: Date | null;

  /**
   * Delete-for-me floor as a MESSAGE ID (the newest message that
   * existed when the user cleared): visibility is `_id > floor`.
   * IDs, unlike the clearedAt wall-clock stamp, cannot tie with a
   * message sent in the same millisecond — a timestamp floor
   * intermittently swallowed the first post-clear message.
   */
  @Prop({ type: String, default: null })
  clearedUpToIdFirst: string | null;

  @Prop({ type: String, default: null })
  clearedUpToIdSecond: string | null;
}

export const ChatConversationSchema =
  SchemaFactory.createForClass(ChatConversation);
export type ChatConversationDocument = HydratedDocument<ChatConversation>;

/**
 * Indexes for this APP-ONLY collection. Unlike the shared web
 * collections (where this backend never creates indexes), the
 * chat collections are owned by this API, and ChatService's
 * onModuleInit calls createIndexes() so these are really built
 * in prod:
 * - pairKey UNIQUE — one record per pair, enforced by the DB;
 *   openConversation's find-then-create race resolves against it.
 * - participantIds + updatedAt — the inbox list shape.
 */
ChatConversationSchema.index({ pairKey: 1 }, { unique: true });
ChatConversationSchema.index({ participantIds: 1, updatedAt: -1 });
/** Inbox shape after the deep-analysis fix pass: per-user rows ordered by last activity. */
ChatConversationSchema.index({ participantIds: 1, lastActivityAt: -1 });
/** Daily first-contact limit: count today's records by creator. */
ChatConversationSchema.index({ createdBy: 1, createdAt: -1 });

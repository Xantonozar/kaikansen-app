import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type {
  ChatBlockedListResponse,
  ChatConversationListResponse,
  ChatConversationMetaResponse,
  ChatConversationStateRequest,
  ChatConversationSummary,
  ChatCountsResponse,
  ChatMessage,
  ChatMessageListResponse,
  ChatOpenConversationResponse,
  ChatPeopleResponse,
  ChatPeopleSearchResponse,
  ChatPerson,
  ChatReportListResponse,
  ChatReportRecord,
  ChatReportRequest,
  ChatRequestListResponse,
  ChatSendMessageRequest,
  ChatThemeSnapshot,
  ChatUserSummary,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import { Follow, type FollowDocument } from '../social/follow.schema';
import { UserRank, type UserRankDocument } from '../quiz/user-rank.schema';
import {
  RankHistory,
  type RankHistoryDocument,
} from '../quiz/rank-history.schema';
import { ThemeCache, type ThemeCacheDocument } from '../themes/theme-cache.schema';
import { ladderStandingFor } from '../quiz/ladder-standing';
import {
  ChatConversation,
  type ChatConversationDocument,
} from './chat-conversation.schema';
import { ChatMessage as ChatMessageEntity, type ChatMessageDocument } from './chat-message.schema';
import { ChatBlock, type ChatBlockDocument } from './chat-block.schema';
import { ChatDecline, type ChatDeclineDocument } from './chat-decline.schema';
import { ChatReport, type ChatReportDocument } from './chat-report.schema';
import { ChatBroadcaster } from './chat-broadcaster';
import { ChatPresence } from './chat-presence';
import { ChatPushService } from './chat-push.service';
import { ChatMetrics } from './chat-metrics';

/** App rule (no web counterpart): a single text message is capped at 2000 chars. */
const MAX_TEXT_LENGTH = 2000;
const MESSAGE_PAGE_DEFAULT = 30;
const MESSAGE_PAGE_MAX = 50;
const PEOPLE_LIMIT = 20;
const QUIZ_ROOM_LOOKBACK = 25;
/** How long a decline tombstone keeps a re-request hidden (see chat-decline.schema.ts). */
const DECLINE_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Pending-request cap (deep analysis §2/§3): while a conversation
 * is in `request` state the requester may have at most this many
 * messages in it. The 4th send fails with a clear "waiting"
 * error. The requests screen copy states the same number.
 */
const REQUEST_MESSAGE_CAP = 3;
/**
 * Daily first-contact limit (deep analysis §3): how many NEW
 * conversations (records created by the caller) one account may
 * start per day. Brand-new accounts (< 7 days) get the strict
 * budget; established accounts the loose one. Enforced here in
 * the service so REST and socket opens share it (opens only
 * exist on REST today, but the rule belongs to the domain).
 */
const FIRST_CONTACT_LIMIT_NEW = 10;
const FIRST_CONTACT_LIMIT_ESTABLISHED = 50;
const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Inbox/requests page sizes for the cursor pagination contract.
 * The default stays at the old flat-cap size (100) so an
 * un-paginated caller sees exactly what it saw before; the
 * mobile app passes explicit smaller limits for load-more.
 */
const LIST_PAGE_DEFAULT = 100;
const LIST_PAGE_MAX = 100;
/** people() results are cached per user this long (deep analysis §4). */
const PEOPLE_CACHE_TTL_MS = 60_000;

/** Lean read shapes (the fields the chat reads actually touch). */
interface UserLean {
  _id: unknown;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isPublic?: boolean;
  totalFollowers?: number;
  createdAt?: Date;
}
interface ConversationLean {
  _id: unknown;
  participantIds: string[];
  pairKey: string;
  status: string;
  requestedBy: string | null;
  blockedBy: string | null;
  hiddenFor: string | null;
  lastMessage: ChatConversationSummary['lastMessage'];
  readAtFirst: Date | null;
  readAtSecond: Date | null;
  createdBy?: string | null;
  lastActivityAt?: Date | null;
  mutedFirst?: boolean;
  mutedSecond?: boolean;
  archivedFirst?: boolean;
  archivedSecond?: boolean;
  clearedAtFirst?: Date | null;
  clearedAtSecond?: Date | null;
  clearedUpToIdFirst?: string | null;
  clearedUpToIdSecond?: string | null;
  updatedAt: Date;
  createdAt: Date;
}
interface ReportLean {
  _id: unknown;
  reporterId: string;
  reportedUserId: string;
  conversationId: unknown;
  messageId: unknown;
  reason: ChatReportRecord['reason'];
  context: ChatMessage[];
  createdAt: Date;
}
interface MessageLean {
  _id: unknown;
  conversationId: unknown;
  senderId: string;
  type: string;
  text: string | null;
  theme: ChatThemeSnapshot | null;
  readAt: Date | null;
  clientId: string | null;
  createdAt: Date;
}
interface DeclineLean {
  _id: unknown;
  pairKey: string;
  declinerId: string;
  requesterId: string;
  createdAt: Date;
}

interface ChatModels {
  users: Model<UserDocument>;
  follows: Model<FollowDocument>;
  userRanks: Model<UserRankDocument>;
  rankHistories: Model<RankHistoryDocument>;
  themes: Model<ThemeCacheDocument>;
  conversations: Model<ChatConversationDocument>;
  messages: Model<ChatMessageDocument>;
  blocks: Model<ChatBlockDocument>;
  declines: Model<ChatDeclineDocument>;
  reports: Model<ChatReportDocument>;
}

/** Mongo duplicate-key error (unique index violation), driver-shaped. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * The user-to-user DM service (app-only feature; the website has
 * no chat). Transport-blind: realtime delivery goes through
 * ChatBroadcaster, presence reads through ChatPresence.
 *
 * Requests model (owner-approved design): opening a conversation
 * with a user who does NOT follow you creates it in `request`
 * state for them. Only the requester can send while it is a
 * request; the receiver's reads are never written to message
 * readAt and never emitted; declining deletes the record with no
 * event to the sender; blocking closes the pair for good.
 */
@Injectable()
export class ChatService implements OnModuleInit {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Optional()
    private readonly broadcaster?: ChatBroadcaster,
    @Optional()
    private readonly presence?: ChatPresence,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    @Optional()
    @InjectModel(Follow.name)
    private readonly followModel?: Model<FollowDocument>,
    @Optional()
    @InjectModel(UserRank.name)
    private readonly userRankModel?: Model<UserRankDocument>,
    @Optional()
    @InjectModel(RankHistory.name)
    private readonly rankHistoryModel?: Model<RankHistoryDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(ChatConversation.name)
    private readonly conversationModel?: Model<ChatConversationDocument>,
    @Optional()
    @InjectModel(ChatMessageEntity.name)
    private readonly messageModel?: Model<ChatMessageDocument>,
    @Optional()
    @InjectModel(ChatBlock.name)
    private readonly blockModel?: Model<ChatBlockDocument>,
    @Optional()
    @InjectModel(ChatDecline.name)
    private readonly declineModel?: Model<ChatDeclineDocument>,
    @Optional()
    @InjectModel(ChatReport.name)
    private readonly reportModel?: Model<ChatReportDocument>,
    @Optional()
    private readonly push?: ChatPushService,
    @Optional()
    private readonly metrics?: ChatMetrics,
  ) {}

  /** people() response cache, per user (60s — see people()). */
  private readonly peopleCache = new Map<
    string,
    { at: number; res: ChatPeopleResponse }
  >();
  /** Global suggested-users id list cache (60s, user-independent raw ids). */
  private suggestedIdsCache: { at: number; ids: string[] } | null = null;

  /**
   * Outcome of the boot-time index verification (deep analysis
   * §9): 'ok' when the load-bearing indexes are really there,
   * 'missing' when they are not (logged at ERROR — uniqueness
   * and idempotency silently degrade without them), 'unknown'
   * when verification could not run (no DB / no listIndexes).
   */
  chatIndexStatus: 'ok' | 'missing' | 'unknown' = 'unknown';

  /**
   * Builds the chat collections' indexes. Everywhere else this
   * backend declares indexes but never creates them — those
   * collections belong to the shared website DB. The chat
   * collections are app-only and owned by this API, so creating
   * their indexes at boot is both safe and required: the pairKey
   * UNIQUE index is what makes get-or-create race-safe, and the
   * message idempotency index is what makes re-sends dedupe.
   * Best-effort: a failure (e.g. pre-existing duplicate rows on a
   * future deploy) is logged, never fatal to boot.
   */
  async onModuleInit(): Promise<void> {
    const models = [
      this.conversationModel,
      this.messageModel,
      this.blockModel,
      this.declineModel,
      this.reportModel,
    ];
    for (const model of models) {
      if (!model || typeof model.createIndexes !== 'function') continue;
      try {
        await model.createIndexes();
      } catch (error) {
        this.logger.warn(
          `createIndexes failed for ${model.modelName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.verifyChatIndexes();
  }

  /**
   * Verifies the load-bearing indexes actually exist after
   * createIndexes (the fix pass's best-effort creation could
   * fail silently — e.g. pre-existing duplicate rows — leaving
   * pair uniqueness and send idempotency unenforced with only a
   * warning in the boot log). A miss is logged at ERROR level
   * and kept on `chatIndexStatus`. (Log-only by design: the
   * /health payload shape is a fixed contract.)
   */
  private async verifyChatIndexes(): Promise<void> {
    try {
      const convModel = this.conversationModel as unknown as {
        listIndexes?: () => Promise<Record<string, unknown>[]>;
      } | undefined;
      const msgModel = this.messageModel as unknown as {
        listIndexes?: () => Promise<Record<string, unknown>[]>;
      } | undefined;
      if (
        !convModel ||
        typeof convModel.listIndexes !== 'function' ||
        !msgModel ||
        typeof msgModel.listIndexes !== 'function'
      ) {
        this.chatIndexStatus = 'unknown';
        return;
      }
      const [convIndexes, msgIndexes] = await Promise.all([
        convModel.listIndexes(),
        msgModel.listIndexes(),
      ]);
      const hasIndex = (
        indexes: Record<string, unknown>[],
        keys: Record<string, number>,
      ) =>
        indexes.some((idx) => {
          const key = idx.key as Record<string, unknown> | undefined;
          return (
            !!key &&
            idx.unique === true &&
            Object.entries(keys).every(([k, v]) => key[k] === v)
          );
        });
      const pairOk = hasIndex(convIndexes, { pairKey: 1 });
      const idemOk = hasIndex(msgIndexes, {
        conversationId: 1,
        senderId: 1,
        clientId: 1,
      });
      if (pairOk && idemOk) {
        this.chatIndexStatus = 'ok';
        this.logger.log('chat indexes verified: pairKey + idempotency present');
      } else {
        this.chatIndexStatus = 'missing';
        this.logger.error(
          `chat index verification FAILED (pairKey unique: ${pairOk}, message idempotency unique: ${idemOk}) — chat uniqueness/idempotency are NOT enforced until this is fixed`,
        );
      }
    } catch (error) {
      this.chatIndexStatus = 'unknown';
      this.logger.warn(
        `chat index verification could not run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private requireModels(): ChatModels {
    if (
      !this.userModel ||
      !this.followModel ||
      !this.userRankModel ||
      !this.rankHistoryModel ||
      !this.themeModel ||
      !this.conversationModel ||
      !this.messageModel ||
      !this.blockModel ||
      !this.declineModel ||
      !this.reportModel
    ) {
      throw new ServiceUnavailableException(
        'Chat is unavailable — no database configured',
      );
    }
    return {
      users: this.userModel,
      follows: this.followModel,
      userRanks: this.userRankModel,
      rankHistories: this.rankHistoryModel,
      themes: this.themeModel,
      conversations: this.conversationModel,
      messages: this.messageModel,
      blocks: this.blockModel,
      declines: this.declineModel,
      reports: this.reportModel,
    };
  }

  /* ---------------- helpers ---------------- */

  static pairKeyFor(a: string, b: string): string {
    return [a, b].sort().join(':');
  }

  private otherOf(conv: ConversationLean, me: string): string {
    return conv.participantIds.find((id) => id !== me) ?? '';
  }

  /* -------- per-user (positional) conversation state -------- */

  private isFirst(conv: ConversationLean, me: string): boolean {
    return conv.participantIds[0] === me;
  }

  private mutedOf(conv: ConversationLean, me: string): boolean {
    return (this.isFirst(conv, me) ? conv.mutedFirst : conv.mutedSecond) ?? false;
  }

  private archivedOf(conv: ConversationLean, me: string): boolean {
    return (
      (this.isFirst(conv, me) ? conv.archivedFirst : conv.archivedSecond) ??
      false
    );
  }

  private clearedAtOf(conv: ConversationLean, me: string): Date | null {
    const value = this.isFirst(conv, me)
      ? conv.clearedAtFirst
      : conv.clearedAtSecond;
    return value ? new Date(value) : null;
  }

  /** The delete-for-me floor as a message id (see the schema note). */
  private clearedUpToIdOf(conv: ConversationLean, me: string): string | null {
    const value = this.isFirst(conv, me)
      ? conv.clearedUpToIdFirst
      : conv.clearedUpToIdSecond;
    return value ?? null;
  }

  /** Builds the positional $set fragment for one participant's state fields. */
  private stateSet(
    conv: ConversationLean,
    me: string,
    patch: {
      muted?: boolean;
      archived?: boolean;
      clearedAt?: Date;
      clearedUpToId?: string | null;
    },
  ): Record<string, unknown> {
    const suffix = this.isFirst(conv, me) ? 'First' : 'Second';
    const set: Record<string, unknown> = {};
    if (patch.muted !== undefined) set[`muted${suffix}`] = patch.muted;
    if (patch.archived !== undefined) set[`archived${suffix}`] = patch.archived;
    if (patch.clearedAt !== undefined) set[`clearedAt${suffix}`] = patch.clearedAt;
    if (patch.clearedUpToId !== undefined)
      set[`clearedUpToId${suffix}`] = patch.clearedUpToId;
    return set;
  }

  /** Who created the record (legacy rows: requestedBy is the best witness). */
  private creatorOf(conv: ConversationLean): string | null {
    return conv.createdBy ?? conv.requestedBy ?? null;
  }

  /**
   * Whether a conversation appears in `me`'s lists at all
   * (deep-analysis fix pass):
   * - EMPTY conversations (no message yet) are visible only to
   *   their creator — an accidental or malicious open must not
   *   surface as a request on the other side.
   * - A conversation the caller cleared (delete-for-me) stays
   *   hidden until a message newer than clearedAt exists.
   * (Blocked-status and tombstone-hidden filtering happens at
   * the query level in myConversations.)
   */
  private isListedFor(conv: ConversationLean, me: string): boolean {
    if (!conv.lastMessage) {
      const creator = this.creatorOf(conv);
      // Legacy rows with no attributable creator stay visible.
      return creator === null || creator === me;
    }
    // Delete-for-me revival keys off the last message's ID when
    // the floor was recorded as one (a same-millisecond timestamp
    // tie must not keep the thread hidden); rows cleared before
    // id floors existed fall back to the timestamp comparison.
    const clearedUpToId = this.clearedUpToIdOf(conv, me);
    if (clearedUpToId && conv.lastMessage.id) {
      return conv.lastMessage.id > clearedUpToId;
    }
    const clearedAt = this.clearedAtOf(conv, me);
    if (clearedAt && new Date(conv.lastMessage.createdAt) <= clearedAt) {
      return false;
    }
    return true;
  }

  /** The inbox sort key: denormalised activity, with legacy fallbacks. */
  private activityOf(conv: ConversationLean): number {
    // The sort key is the last MESSAGE's time — the value the
    // inbox row displays — so a scrambled or legacy updatedAt can
    // never reorder the inbox (the original read-reorder bug).
    // lastActivityAt is the denormalised mirror of that time
    // (indexed for query-side sorts) and covers conversations
    // that have no message yet.
    if (conv.lastMessage) return new Date(conv.lastMessage.createdAt).getTime();
    if (conv.lastActivityAt) return new Date(conv.lastActivityAt).getTime();
    return new Date(conv.updatedAt).getTime();
  }

  /**
   * Cursor pagination over an already-sorted list: `cursor` is
   * the id of the previous page's last row. An unknown cursor
   * (the row vanished meanwhile) restarts from the top — the
   * mobile lists dedupe by id when appending pages.
   */
  private paginate<T extends { _id: unknown }>(
    rows: T[],
    cursor?: string,
    limitParam?: string,
  ): { page: T[]; nextCursor: string | null } {
    const parsed = parseInt(limitParam ?? '', 10);
    const limit =
      Number.isNaN(parsed) || parsed < 1
        ? LIST_PAGE_DEFAULT
        : Math.min(parsed, LIST_PAGE_MAX);
    let start = 0;
    if (cursor) {
      const idx = rows.findIndex((r) => String(r._id) === cursor);
      if (idx >= 0) start = idx + 1;
    }
    const page = rows.slice(start, start + limit);
    const hasMore = start + page.length < rows.length;
    return {
      page,
      nextCursor:
        hasMore && page.length > 0 ? String(page[page.length - 1]._id) : null,
    };
  }

  /**
   * Id-shape guard, the playlists.service.ts convention: a
   * malformed ObjectId folds into the same 404 as a missing
   * record instead of CastError-ing into a 500.
   */
  private assertConversationId(conversationId: string): void {
    if (!conversationId || !Types.ObjectId.isValid(conversationId)) {
      throw new NotFoundException('Conversation not found');
    }
  }

  private async findConversation(
    models: ChatModels,
    conversationId: string,
  ): Promise<ConversationLean> {
    this.assertConversationId(conversationId);
    const conv = (await models.conversations
      .findById(conversationId)
      .lean()
      .exec()) as unknown as ConversationLean | null;
    if (!conv) throw new NotFoundException('Conversation not found');
    return conv;
  }

  /** True when a chatblocks row exists between the pair, in either direction. */
  private async pairIsBlocked(
    models: ChatModels,
    a: string,
    b: string,
  ): Promise<boolean> {
    const row = await models.blocks
      .findOne({
        $or: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      })
      .lean()
      .exec();
    return !!row;
  }

  /**
   * The shared gate for every participant-scoped operation.
   * Defense in depth on blocks: the conversation's own `blocked`
   * status AND the blocks collection are both consulted, so no
   * record — e.g. a duplicate left by a pre-index race — can be
   * used to bypass a block. Tombstone-hidden conversations 404
   * for the user they are hidden from (as if they did not exist),
   * except on the accept path, where engaging clears the hiding.
   */
  private async participantConversation(
    models: ChatModels,
    me: string,
    conversationId: string,
    opts?: { forAccept?: boolean },
  ): Promise<ConversationLean> {
    const conv = await this.findConversation(models, conversationId);
    if (!conv.participantIds.includes(me)) {
      throw new NotFoundException('Conversation not found');
    }
    if (conv.hiddenFor === me && !opts?.forAccept) {
      throw new NotFoundException('Conversation not found');
    }
    if (conv.status === 'blocked') {
      throw new ForbiddenException('This conversation is closed');
    }
    const other = this.otherOf(conv, me);
    if (other && (await this.pairIsBlocked(models, me, other))) {
      throw new ForbiddenException('This conversation is closed');
    }
    return conv;
  }

  private async blockedPairIds(
    models: ChatModels,
    me: string,
  ): Promise<Set<string>> {
    const rows = (await models.blocks
      .find({ $or: [{ blockerId: me }, { blockedId: me }] })
      .lean()
      .exec()) as { blockerId: string; blockedId: string }[];
    const ids = new Set<string>();
    for (const row of rows) {
      ids.add(row.blockerId === me ? row.blockedId : row.blockerId);
    }
    return ids;
  }

  /**
   * Batch-builds ChatUserSummary rows (identity + derived ladder,
   * + live presence unless told otherwise). Presence is a
   * conversation-partner surface only: people lists (New Chat)
   * pass includePresence: false so a stranger's online /
   * last-active state never leaves the API there.
   */
  async summariesFor(
    userIds: string[],
    opts?: { includePresence?: boolean },
  ): Promise<Map<string, ChatUserSummary>> {
    const models = this.requireModels();
    const includePresence = opts?.includePresence ?? true;
    const out = new Map<string, ChatUserSummary>();
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return out;
    const [users, ranks] = await Promise.all([
      models.users
        .find({ _id: { $in: unique } })
        .lean()
        .exec() as Promise<UserLean[]>,
      models.userRanks
        .find({ userId: { $in: unique } })
        .lean()
        .exec() as Promise<{ userId: string; rp?: number }[]>,
    ]);
    const rpById = new Map(ranks.map((r) => [r.userId, r.rp ?? 0]));
    for (const user of users) {
      const id = String(user._id);
      const rp = rpById.get(id) ?? 0;
      out.set(id, {
        id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl ?? null,
        rp,
        ladder: ladderStandingFor(rp),
        ...(includePresence
          ? {
              online: this.presence?.isOnline(id) ?? false,
              lastActiveAt: this.presence?.lastActiveAt(id) ?? null,
            }
          : {}),
      });
    }
    return out;
  }

  /**
   * Unread counts for a whole set of conversations in ONE
   * aggregated query: a $match $or of per-conversation clauses
   * (that pair, from the other side, after my read marker), then
   * a $group by conversationId. Replaces the old per-conversation
   * countDocuments loop, whose cost grew with the inbox size.
   */
  private async unreadCountsFor(
    models: ChatModels,
    convs: ConversationLean[],
    me: string,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (convs.length === 0) return counts;
    const clauses = convs.map((conv) => {
      const marker =
        conv.participantIds[0] === me ? conv.readAtFirst : conv.readAtSecond;
      // Delete-for-me floor: messages at/before my clearedAt are
      // gone for me, so they can never count as unread either.
      const clearedAt = this.clearedAtOf(conv, me);
      const floor =
        marker && clearedAt
          ? new Date(Math.max(new Date(marker).getTime(), clearedAt.getTime()))
          : (marker ?? clearedAt);
      const clause: Record<string, unknown> = {
        conversationId: conv._id,
        senderId: this.otherOf(conv, me),
      };
      if (floor) clause.createdAt = { $gt: new Date(floor) };
      return clause;
    });
    const rows = (await models.messages
      .aggregate([
        { $match: { $or: clauses } },
        { $group: { _id: '$conversationId', count: { $sum: 1 } } },
      ])
      .exec()) as { _id: unknown; count: number }[];
    for (const row of rows) counts.set(String(row._id), row.count);
    return counts;
  }

  private toSummary(
    conv: ConversationLean,
    me: string,
    summaries: Map<string, ChatUserSummary>,
    unreadCount = 0,
  ): ChatConversationSummary {
    const otherId = this.otherOf(conv, me);
    const other = summaries.get(otherId) ?? {
      id: otherId,
      username: 'unknown',
      displayName: 'Unknown',
      avatarUrl: null,
      rp: 0,
      ladder: ladderStandingFor(0),
      online: false,
      lastActiveAt: null,
    };
    const isIncomingRequest = conv.status === 'request' && conv.requestedBy !== me;
    return {
      id: String(conv._id),
      other,
      status: conv.status as ChatConversationSummary['status'],
      requestedBy: conv.requestedBy ?? null,
      lastMessage: conv.lastMessage ?? null,
      unreadCount: isIncomingRequest ? 0 : unreadCount,
      updatedAt: new Date(conv.updatedAt).toISOString(),
      muted: this.mutedOf(conv, me),
      archived: this.archivedOf(conv, me),
    };
  }

  /* ---------------- decline tombstones ---------------- */

  private async findTombstone(
    models: ChatModels,
    pairKey: string,
  ): Promise<DeclineLean | null> {
    return (await models.declines
      .findOne({ pairKey })
      .lean()
      .exec()) as unknown as DeclineLean | null;
  }

  private tombstoneExpired(tombstone: DeclineLean): boolean {
    return (
      Date.now() - new Date(tombstone.createdAt).getTime() >
      DECLINE_TOMBSTONE_MS
    );
  }

  private async clearTombstone(
    models: ChatModels,
    pairKey: string,
  ): Promise<void> {
    await models.declines.deleteOne({ pairKey }).exec();
  }

  /**
   * Applies tombstone expiry to a conversation the requester is
   * touching: if the pair's tombstone has expired, it is deleted
   * and a hidden conversation surfaces again (hiddenFor cleared)
   * as a normal fresh request. Returns true when the conversation
   * is CURRENTLY hidden from the other participant (fresh
   * tombstone) — sends into it must not emit events.
   */
  private async applyTombstoneExpiry(
    models: ChatModels,
    conv: ConversationLean,
  ): Promise<boolean> {
    if (!conv.hiddenFor) return false;
    const tombstone = await this.findTombstone(models, conv.pairKey);
    if (tombstone && !this.tombstoneExpired(tombstone)) return true;
    // Expired (or the tombstone is already gone): surface again.
    await models.conversations
      .updateOne({ _id: conv._id }, { $set: { hiddenFor: null } })
      .exec();
    conv.hiddenFor = null;
    if (tombstone) await this.clearTombstone(models, conv.pairKey);
    return false;
  }

  private messageDto(
    msg: MessageLean,
    status: string,
  ): ChatMessage {
    return {
      id: String(msg._id),
      conversationId: String(msg.conversationId),
      senderId: msg.senderId,
      type: msg.type as ChatMessage['type'],
      text: msg.text ?? null,
      theme: msg.theme ?? null,
      createdAt: new Date(msg.createdAt).toISOString(),
      // Request-state messages NEVER expose read state.
      readAt:
        status === 'active' && msg.readAt
          ? new Date(msg.readAt).toISOString()
          : null,
      ...(msg.clientId ? { clientId: msg.clientId } : {}),
    };
  }

  /* ---------------- inbox / requests ---------------- */

  /**
   * All of my listable conversations in one view ('inbox' =
   * not archived by me; 'archived' = only archived by me):
   * not blocked, not hidden from me by a decline tombstone, not
   * paired with someone a block row covers, and passing
   * isListedFor (empty conversations show only to their creator;
   * cleared conversations stay hidden until a newer message).
   * Sorted by denormalised last activity (activityOf) — NOT by
   * raw updatedAt, which read-marker writes also move in real
   * deployments unless they opt out of timestamps.
   */
  private async myConversations(
    models: ChatModels,
    me: string,
    view: 'inbox' | 'archived' = 'inbox',
  ): Promise<ConversationLean[]> {
    const blocked = await this.blockedPairIds(models, me);
    const convs = (await models.conversations
      .find({
        participantIds: me,
        status: { $ne: 'blocked' },
        hiddenFor: { $ne: me },
      })
      .lean()
      .exec()) as unknown as ConversationLean[];
    return convs
      .filter((c) => !blocked.has(this.otherOf(c, me)))
      .filter((c) => this.isListedFor(c, me))
      .filter((c) =>
        view === 'archived'
          ? this.archivedOf(c, me)
          : !this.archivedOf(c, me),
      )
      .sort((a, b) => this.activityOf(b) - this.activityOf(a));
  }

  /**
   * The badge counts, computed across ALL of the user's listed
   * conversations — never just the returned inbox page, or a
   * user with a deep inbox would see counts that stop at the
   * page window. Muted conversations' unread is excluded (mute
   * means "don't badge me"); empty requests never count (they
   * are not listed for the receiver at all).
   */
  async counts(me: string): Promise<ChatCountsResponse> {
    const models = this.requireModels();
    const convs = await this.myConversations(models, me);
    const active = convs.filter(
      (c) => c.status === 'active' && !this.mutedOf(c, me),
    );
    const unread = await this.unreadCountsFor(models, active, me);
    let totalUnread = 0;
    for (const count of unread.values()) totalUnread += count;
    return {
      requestCount: convs.filter(
        (c) => c.status === 'request' && c.requestedBy !== me,
      ).length,
      totalUnread,
    };
  }

  async listConversations(
    me: string,
    cursor?: string,
    limitParam?: string,
  ): Promise<ChatConversationListResponse> {
    const models = this.requireModels();
    const convs = await this.myConversations(models, me);
    const archived = await this.myConversations(models, me, 'archived');
    const unread = await this.unreadCountsFor(
      models,
      convs.filter((c) => c.status === 'active'),
      me,
    );
    let requestCount = 0;
    let totalUnread = 0;
    for (const conv of convs) {
      if (conv.status === 'request' && conv.requestedBy !== me) {
        requestCount += 1;
      }
      if (conv.status === 'active' && !this.mutedOf(conv, me)) {
        totalUnread += unread.get(String(conv._id)) ?? 0;
      }
    }
    // Incoming requests live on the requests screen, not the inbox.
    const rows = convs.filter(
      (c) => !(c.status === 'request' && c.requestedBy !== me),
    );
    const { page, nextCursor } = this.paginate(rows, cursor, limitParam);
    const summaries = await this.summariesFor(
      page.map((c) => this.otherOf(c, me)),
    );
    return {
      conversations: page.map((conv) =>
        this.toSummary(conv, me, summaries, unread.get(String(conv._id)) ?? 0),
      ),
      requestCount,
      totalUnread,
      archivedCount: archived.length,
      nextCursor,
    };
  }

  /** The caller's archived conversations (unarchive happens implicitly on any new message). */
  async listArchived(
    me: string,
    cursor?: string,
    limitParam?: string,
  ): Promise<ChatConversationListResponse> {
    const models = this.requireModels();
    const archived = await this.myConversations(models, me, 'archived');
    const badge = await this.counts(me);
    const unread = await this.unreadCountsFor(
      models,
      archived.filter((c) => c.status === 'active'),
      me,
    );
    const rows = archived.filter(
      (c) => !(c.status === 'request' && c.requestedBy !== me),
    );
    const { page, nextCursor } = this.paginate(rows, cursor, limitParam);
    const summaries = await this.summariesFor(
      page.map((c) => this.otherOf(c, me)),
    );
    return {
      conversations: page.map((conv) =>
        this.toSummary(conv, me, summaries, unread.get(String(conv._id)) ?? 0),
      ),
      requestCount: badge.requestCount,
      totalUnread: badge.totalUnread,
      archivedCount: archived.length,
      nextCursor,
    };
  }

  async listRequests(
    me: string,
    cursor?: string,
    limitParam?: string,
  ): Promise<ChatRequestListResponse> {
    const models = this.requireModels();
    const blocked = await this.blockedPairIds(models, me);
    const convs = (await models.conversations
      .find({
        participantIds: me,
        status: 'request',
        hiddenFor: { $ne: me },
      })
      .lean()
      .exec()) as unknown as ConversationLean[];
    const incoming = convs
      .filter((c) => c.requestedBy !== me)
      .filter((c) => !blocked.has(this.otherOf(c, me)))
      .filter((c) => this.isListedFor(c, me))
      .sort((a, b) => this.activityOf(b) - this.activityOf(a));
    const { page, nextCursor } = this.paginate(incoming, cursor, limitParam);
    const summaries = await this.summariesFor(
      page.map((c) => this.otherOf(c, me)),
    );
    return {
      requests: page.map((conv) => this.toSummary(conv, me, summaries, 0)),
      nextCursor,
    };
  }

  /**
   * Lightweight participant meta for the thread header — unlike
   * the messages endpoint this does NOT fail for a blocked
   * conversation, so the client can render the closed state
   * instead of an endless load error. Exposes no messages.
   */
  async conversationMeta(
    me: string,
    conversationId: string,
  ): Promise<ChatConversationMetaResponse> {
    const models = this.requireModels();
    const conv = await this.findConversation(models, conversationId);
    if (!conv.participantIds.includes(me) || conv.hiddenFor === me) {
      throw new NotFoundException('Conversation not found');
    }
    const summaries = await this.summariesFor([this.otherOf(conv, me)]);
    const otherId = this.otherOf(conv, me);
    const other = summaries.get(otherId) ?? {
      id: otherId,
      username: 'unknown',
      displayName: 'Unknown',
      avatarUrl: null,
      rp: 0,
      ladder: ladderStandingFor(0),
      online: false,
      lastActiveAt: null,
    };
    return {
      id: String(conv._id),
      status: conv.status as ChatConversationMetaResponse['status'],
      requestedBy: conv.requestedBy ?? null,
      other,
    };
  }

  /* ---------------- open / create ---------------- */

  async openConversation(
    me: string,
    otherId: string,
  ): Promise<ChatOpenConversationResponse> {
    const models = this.requireModels();
    if (!otherId || typeof otherId !== 'string') {
      throw new BadRequestException('userId is required');
    }
    if (otherId === me) {
      throw new BadRequestException('You cannot message yourself');
    }
    if (!Types.ObjectId.isValid(otherId)) {
      // Malformed ids fold into the plain 404 (playlists convention).
      throw new NotFoundException('User not found');
    }
    const other = (await models.users
      .findById(otherId)
      .lean()
      .exec()) as UserLean | null;
    if (!other) throw new NotFoundException('User not found');

    if (await this.pairIsBlocked(models, me, otherId)) {
      throw new ForbiddenException('You cannot message this user');
    }

    const pairKey = ChatService.pairKeyFor(me, otherId);
    const findExisting = async () =>
      (await models.conversations
        .findOne({ pairKey })
        .lean()
        .exec()) as unknown as ConversationLean | null;

    let existing = await findExisting();
    let created = false;
    if (!existing) {
      // Daily first-contact limit (service-level, so every
      // transport shares it): count records I created today.
      // Accounts younger than 7 days get the strict budget.
      const myDoc = (await models.users
        .findById(me)
        .lean()
        .exec()) as UserLean | null;
      const accountAgeMs = myDoc?.createdAt
        ? Date.now() - new Date(myDoc.createdAt).getTime()
        : Number.POSITIVE_INFINITY;
      const dailyLimit =
        accountAgeMs < NEW_ACCOUNT_MS
          ? FIRST_CONTACT_LIMIT_NEW
          : FIRST_CONTACT_LIMIT_ESTABLISHED;
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const createdToday = await models.conversations
        .countDocuments({
          createdBy: me,
          createdAt: { $gte: startOfDay },
        })
        .exec();
      if (createdToday >= dailyLimit) {
        throw new HttpException(
          'You have reached the daily limit for starting new conversations',
          429,
        );
      }
      // Requests model: the conversation starts as a request unless
      // the RECEIVER already follows the sender.
      const receiverFollowsSender = await models.follows
        .findOne({ followerId: otherId, followeeId: me })
        .lean()
        .exec();
      const status = receiverFollowsSender ? 'active' : 'request';
      // Decline tombstone: if the receiver declined me recently,
      // my re-opened conversation is created hidden from them (it
      // works from my side; silence is preserved). An expired
      // tombstone is cleared and the open proceeds normally.
      let hiddenFor: string | null = null;
      const tombstone = await this.findTombstone(models, pairKey);
      if (tombstone) {
        if (this.tombstoneExpired(tombstone)) {
          await this.clearTombstone(models, pairKey);
        } else if (
          tombstone.declinerId === otherId &&
          tombstone.requesterId === me
        ) {
          hiddenFor = otherId;
        }
      }
      try {
        existing = (await models.conversations.create({
          participantIds: [me, otherId].sort(),
          pairKey,
          status,
          requestedBy: receiverFollowsSender ? null : me,
          blockedBy: null,
          hiddenFor,
          lastMessage: null,
          createdBy: me,
          lastActivityAt: new Date(),
        })) as unknown as ConversationLean;
        created = true;
        this.metrics?.inc('opens');
        if (status === 'request') this.metrics?.inc('requests');
        // My people lists now carry a conversation with this user.
        this.peopleCache.delete(me);
      } catch (error) {
        // Race-safe get-or-create: two concurrent opens both saw
        // "no existing" — the pairKey UNIQUE index lets exactly
        // one create win; the loser re-reads the winner's record.
        if (!isDuplicateKeyError(error)) throw error;
        existing = await findExisting();
        if (!existing) throw error;
      }
    }

    if (existing.status === 'blocked') {
      throw new ForbiddenException('This conversation is closed');
    }

    if (existing.hiddenFor === me) {
      // The DECLINER is opening the pair themselves — engaging
      // clears the tombstone and the hiding, and the held request
      // is treated as accepted (they sought the conversation out).
      await models.conversations
        .updateOne(
          { _id: existing._id },
          { $set: { hiddenFor: null, status: 'active' } },
        )
        .exec();
      await this.clearTombstone(models, pairKey);
      existing = { ...existing, hiddenFor: null, status: 'active' };
    } else if (existing.hiddenFor) {
      // I'm the declined requester: an expired tombstone surfaces
      // the conversation again as a normal fresh request.
      await this.applyTombstoneExpiry(models, existing);
    }

    const summaries = await this.summariesFor([otherId]);
    const unread = await this.unreadCountsFor(models, [existing], me);
    return {
      conversation: this.toSummary(
        existing,
        me,
        summaries,
        unread.get(String(existing._id)) ?? 0,
      ),
      created,
    };
  }

  /* ---------------- messages ---------------- */

  async listMessages(
    me: string,
    conversationId: string,
    beforeParam?: string,
    limitParam?: string,
  ): Promise<ChatMessageListResponse> {
    const models = this.requireModels();
    const conv = await this.participantConversation(models, me, conversationId);
    const parsed = parseInt(limitParam ?? '', 10);
    const limit =
      Number.isNaN(parsed) || parsed < 1
        ? MESSAGE_PAGE_DEFAULT
        : Math.min(parsed, MESSAGE_PAGE_MAX);
    const filter: Record<string, unknown> = { conversationId: conv._id };
    // Delete-for-me: I only ever see messages past my clear
    // floor — the other side's view is untouched. The floor is a
    // message id when one was recorded (immune to same-ms ties);
    // older rows fall back to the clearedAt timestamp.
    const clearedUpToId = this.clearedUpToIdOf(conv, me);
    const clearedAt = this.clearedAtOf(conv, me);
    if (clearedUpToId) {
      filter._id = { $gt: clearedUpToId };
    } else if (clearedAt) {
      filter.createdAt = { $gt: clearedAt };
    }
    if (beforeParam) {
      // Cursor hardening: the cursor must be a real message OF
      // THIS conversation. A foreign or garbage cursor is a
      // client bug — fail loudly instead of silently returning
      // page 1 (which the thread would merge as duplicates).
      if (!Types.ObjectId.isValid(beforeParam)) {
        throw new BadRequestException('Invalid message cursor');
      }
      const before = (await models.messages
        .findById(beforeParam)
        .lean()
        .exec()) as unknown as MessageLean | null;
      if (!before || String(before.conversationId) !== String(conv._id)) {
        throw new BadRequestException('Invalid message cursor');
      }
      filter._id = {
        ...((filter._id as Record<string, unknown> | undefined) ?? {}),
        $lt: before._id,
      };
    }
    const docs = (await models.messages
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean()
      .exec()) as unknown as MessageLean[];
    const hasMore = docs.length > limit;
    const page = docs.slice(0, limit).reverse();
    const summaries = await this.summariesFor([this.otherOf(conv, me)]);
    const other = summaries.get(this.otherOf(conv, me)) ?? {
      id: this.otherOf(conv, me),
      username: 'unknown',
      displayName: 'Unknown',
      avatarUrl: null,
      rp: 0,
      ladder: ladderStandingFor(0),
      online: false,
      lastActiveAt: null,
    };
    return {
      messages: page.map((m) => this.messageDto(m, conv.status)),
      hasMore,
      status: conv.status as ChatMessageListResponse['status'],
      requestedBy: conv.requestedBy ?? null,
      other,
    };
  }

  async sendMessage(
    me: string,
    conversationId: string,
    body: ChatSendMessageRequest,
    clientIdArg?: string,
  ): Promise<ChatMessage> {
    const models = this.requireModels();
    const conv = await this.participantConversation(models, me, conversationId);
    if (conv.status === 'request' && conv.requestedBy !== me) {
      // The receiver has no composer until they accept.
      throw new ForbiddenException('Accept the request to reply');
    }
    const other = this.otherOf(conv, me);

    // Tombstone hiding: if this conversation is hidden from the
    // receiver by a fresh decline tombstone, my sends still save
    // (my side works normally — silence preserved) but emit NO
    // events. An expired tombstone surfaces the conversation
    // again, and this send then behaves like any fresh request.
    const hidden =
      conv.hiddenFor === other
        ? await this.applyTombstoneExpiry(models, conv)
        : false;

    // Send idempotency: a re-send carrying a clientId we already
    // stored (socket attempt + REST fallback, tap-to-retry after
    // a lost ack) returns the stored message instead of landing
    // twice.
    const clientId = clientIdArg ?? body.clientId ?? null;
    if (clientId) {
      const dupe = (await models.messages
        .findOne({ conversationId: conv._id, senderId: me, clientId })
        .lean()
        .exec()) as unknown as MessageLean | null;
      if (dupe) return this.messageDto(dupe, conv.status);
    }

    // Pending-request cap: while the conversation is a request,
    // the requester's messages are capped (the receiver has no
    // composer, so every stored message is the requester's).
    // Checked AFTER idempotency so a retry of an allowed message
    // still resolves instead of erroring.
    let priorMessageCount: number | null = null;
    if (conv.status === 'request') {
      priorMessageCount = await models.messages
        .countDocuments({ conversationId: conv._id })
        .exec();
      if (priorMessageCount >= REQUEST_MESSAGE_CAP) {
        this.metrics?.inc('sendFailures');
        throw new ForbiddenException(
          'Waiting for them to accept your request',
        );
      }
    }

    let text: string | null = null;
    let theme: ChatThemeSnapshot | null = null;
    if (body.type === 'text') {
      text = (body.text ?? '').trim();
      if (!text) throw new BadRequestException('Message text is required');
      if (text.length > MAX_TEXT_LENGTH) {
        throw new BadRequestException(
          `Message is too long — maximum ${MAX_TEXT_LENGTH} characters`,
        );
      }
    } else if (body.type === 'theme') {
      const slug = (body.themeSlug ?? '').trim();
      if (!slug) throw new BadRequestException('themeSlug is required');
      const doc = (await models.themes
        .findOne({ slug })
        .lean()
        .exec()) as {
        slug: string;
        songTitle: string;
        artistName: string | null;
        animeTitle: string;
        type: 'OP' | 'ED';
        sequence: number;
        animeCoverImage: string | null;
        animeCoverImageSmall: string | null;
      } | null;
      if (!doc) throw new NotFoundException(`Theme not found: ${slug}`);
      theme = {
        slug: doc.slug,
        songTitle: doc.songTitle,
        artistName: doc.artistName ?? null,
        animeTitle: doc.animeTitle,
        type: doc.type,
        sequence: doc.sequence,
        coverImage: doc.animeCoverImageSmall ?? doc.animeCoverImage ?? null,
      };
    } else {
      throw new BadRequestException('type must be text or theme');
    }

    const now = new Date();
    let created: MessageLean & { createdAt: Date };
    try {
      created = (await models.messages.create({
        conversationId: conv._id as Types.ObjectId,
        senderId: me,
        type: body.type,
        text,
        theme,
        readAt: null,
        clientId,
      })) as unknown as MessageLean & { createdAt: Date };
    } catch (error) {
      // Two in-flight sends with the same clientId raced: the
      // idempotency unique index let one win — return its copy.
      if (!clientId || !isDuplicateKeyError(error)) throw error;
      const winner = (await models.messages
        .findOne({ conversationId: conv._id, senderId: me, clientId })
        .lean()
        .exec()) as unknown as MessageLean | null;
      if (!winner) throw error;
      return this.messageDto(winner, conv.status);
    }
    const message = this.messageDto(
      { ...created, createdAt: created.createdAt ?? now },
      conv.status,
    );

    const lastMessage = {
      id: message.id,
      type: body.type,
      text,
      themeTitle: theme?.songTitle ?? null,
      themeArtist: theme?.artistName ?? null,
      senderId: me,
      createdAt: message.createdAt,
    };
    // Decline/block race gate: the lastMessage write doubles as
    // the commit point, gated on the conversation STILL existing
    // with a send-eligible status (a decline deletes it, a block
    // flips it). If the gate misses, the just-inserted message is
    // removed again — no orphan row, no socket event — and the
    // sender gets a clean failure instead of a phantom delivery.
    const gated = await models.conversations
      .findOneAndUpdate(
        {
          _id: conv._id,
          $or: [
            { status: 'active' },
            { status: 'request', requestedBy: me },
          ],
        },
        {
          $set: {
            lastMessage,
            lastActivityAt: now,
            updatedAt: now,
            // Any new message un-archives the conversation for
            // BOTH sides (archive hides until the next message).
            archivedFirst: false,
            archivedSecond: false,
            ...(conv.participantIds[0] === me
              ? { readAtFirst: now }
              : { readAtSecond: now }),
          },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (!gated) {
      await models.messages.deleteOne({ _id: created._id }).exec();
      this.metrics?.inc('sendFailures');
      throw new ForbiddenException('This conversation is closed');
    }

    this.metrics?.inc('sends');
    if (!hidden) {
      this.broadcaster?.emitToUser(other, 'chat:message', {
        ...message,
        ...(clientId ? { clientId } : {}),
      });
      // Push discovery (fire-and-forget; the push service applies
      // the mute/online/cooldown rules and never throws).
      if (this.push) {
        const sender = (await models.users
          .findById(me)
          .lean()
          .exec()) as UserLean | null;
        void this.push.notifyNewMessage({
          recipientId: other,
          conversationId: String(conv._id),
          kind: conv.status === 'request' ? 'request' : 'active',
          muted: this.mutedOf(conv, other),
          senderUsername: sender?.username ?? 'someone',
          messageType: body.type,
          isFirstMessage: priorMessageCount === 0,
        });
      }
    }
    return message;
  }

  async markRead(
    me: string,
    conversationId: string,
  ): Promise<{ markedRead: true }> {
    const models = this.requireModels();
    const conv = await this.participantConversation(models, me, conversationId);
    const now = new Date();
    if (conv.status === 'active') {
      const other = this.otherOf(conv, me);
      await models.messages
        .updateMany(
          { conversationId: conv._id, senderId: other, readAt: null },
          { $set: { readAt: now } },
        )
        .exec();
      this.broadcaster?.emitToUser(other, 'chat:read', {
        conversationId: String(conv._id),
        readerId: me,
        readAt: now.toISOString(),
      });
      // Self-device sync: my OTHER devices learn I read this, so
      // their badges/inboxes clear live instead of on next fetch.
      // A distinct event name — 'chat:read' semantics stay
      // strictly "the other participant read my messages".
      this.broadcaster?.emitToUser(me, 'chat:read-sync', {
        conversationId: String(conv._id),
        readerId: me,
        readAt: now.toISOString(),
      });
    }
    // In request state the receiver's marker still advances (their
    // own lists stay sane) but NO readAt is written and NO event is
    // emitted — the sender must not learn the request was read.
    // { timestamps: false }: a read-marker write must NOT bump the
    // conversation's updatedAt — reading is not activity, and the
    // inbox must never reorder because someone opened a thread.
    await models.conversations
      .updateOne(
        { _id: conv._id },
        {
          $set:
            conv.participantIds[0] === me
              ? { readAtFirst: now }
              : { readAtSecond: now },
        },
        { timestamps: false },
      )
      .exec();
    return { markedRead: true };
  }

  /* ---------------- request actions ---------------- */

  async acceptRequest(
    me: string,
    conversationId: string,
  ): Promise<ChatConversationSummary> {
    const models = this.requireModels();
    const conv = await this.participantConversation(models, me, conversationId, {
      forAccept: true,
    });
    if (conv.status !== 'request' || conv.requestedBy === me) {
      throw new BadRequestException('This conversation is not a request to you');
    }
    await models.conversations
      .updateOne(
        { _id: conv._id },
        { $set: { status: 'active', hiddenFor: null } },
      )
      .exec();
    // Accepting engages with the sender: any decline tombstone
    // for the pair is cleared.
    await this.clearTombstone(models, conv.pairKey);
    const requester = conv.requestedBy as string;
    this.metrics?.inc('accepts');
    this.broadcaster?.emitToUser(requester, 'chat:request-accepted', {
      conversationId: String(conv._id),
    });
    const summaries = await this.summariesFor([this.otherOf(conv, me)]);
    const unread = await this.unreadCountsFor(
      models,
      [{ ...conv, status: 'active' }],
      me,
    );
    return this.toSummary(
      { ...conv, status: 'active', hiddenFor: null },
      me,
      summaries,
      unread.get(String(conv._id)) ?? 0,
    );
  }

  async declineRequest(
    me: string,
    conversationId: string,
  ): Promise<{ declined: true }> {
    const models = this.requireModels();
    const conv = await this.participantConversation(models, me, conversationId);
    if (conv.status !== 'request' || conv.requestedBy === me) {
      throw new BadRequestException('This conversation is not a request to you');
    }
    await models.messages.deleteMany({ conversationId: conv._id }).exec();
    await models.conversations.deleteOne({ _id: conv._id }).exec();
    // Decline tombstone: remember the decline (30 days) so a
    // re-request from the same sender is created hidden instead
    // of resurfacing — see chat-decline.schema.ts. Replace any
    // older tombstone for the pair so the window restarts.
    await models.declines.deleteOne({ pairKey: conv.pairKey }).exec();
    await models.declines.create({
      pairKey: conv.pairKey,
      declinerId: me,
      requesterId: conv.requestedBy as string,
    });
    this.metrics?.inc('declines');
    // Silent by design: no socket event, no notification — the
    // sender is never told the request was declined.
    return { declined: true };
  }

  async blockUser(
    me: string,
    otherId: string,
  ): Promise<{ blocked: true }> {
    const models = this.requireModels();
    if (!otherId || otherId === me) {
      throw new BadRequestException('A different userId is required');
    }
    if (!Types.ObjectId.isValid(otherId)) {
      throw new NotFoundException('User not found');
    }
    const other = await models.users.findById(otherId).lean().exec();
    if (!other) throw new NotFoundException('User not found');
    const existing = await models.blocks
      .findOne({ blockerId: me, blockedId: otherId })
      .lean()
      .exec();
    if (!existing) {
      await models.blocks.create({ blockerId: me, blockedId: otherId });
    }
    const pairKey = ChatService.pairKeyFor(me, otherId);
    // updateMany, not updateOne: EVERY record for the pair closes
    // (a duplicate left by a pre-index race must not survive as a
    // block bypass — and the send/read gate also consults the
    // blocks collection itself, defense in depth).
    await models.conversations
      .updateMany(
        { pairKey },
        { $set: { status: 'blocked', blockedBy: me } },
      )
      .exec();
    this.metrics?.inc('blocks');
    this.peopleCache.delete(me);
    return { blocked: true };
  }

  /**
   * Removes MY block on a user. Semantics (chosen for the
   * deep-analysis fix pass): the block row is deleted; the pair's
   * conversation, if it was closed BY ME, reopens as `active`
   * when it has any messages — history is precious and the block
   * never deleted it — and is deleted outright when it is still
   * empty (nothing to reopen). If the other side ALSO blocked
   * me, their row stands: the pair gate keeps the conversation
   * closed regardless of its status field. Idempotent.
   */
  async unblockUser(
    me: string,
    otherId: string,
  ): Promise<{ unblocked: true }> {
    const models = this.requireModels();
    if (!otherId || otherId === me) {
      throw new BadRequestException('A different userId is required');
    }
    if (!Types.ObjectId.isValid(otherId)) {
      throw new NotFoundException('User not found');
    }
    await models.blocks
      .deleteOne({ blockerId: me, blockedId: otherId })
      .exec();
    const pairKey = ChatService.pairKeyFor(me, otherId);
    const conv = (await models.conversations
      .findOne({ pairKey })
      .lean()
      .exec()) as unknown as ConversationLean | null;
    if (conv && conv.status === 'blocked' && conv.blockedBy === me) {
      const messageCount = await models.messages
        .countDocuments({ conversationId: conv._id })
        .exec();
      if (messageCount > 0) {
        await models.conversations
          .updateOne(
            { _id: conv._id },
            { $set: { status: 'active', blockedBy: null } },
          )
          .exec();
      } else {
        await models.conversations.deleteOne({ _id: conv._id }).exec();
      }
    }
    this.metrics?.inc('unblocks');
    return { unblocked: true };
  }

  /** The users I have blocked, newest first (blocked-users settings screen). */
  async listBlockedUsers(me: string): Promise<ChatBlockedListResponse> {
    const models = this.requireModels();
    const rows = (await models.blocks
      .find({ blockerId: me })
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as unknown as {
      blockedId: string;
      createdAt: Date;
    }[];
    const summaries = await this.summariesFor(
      rows.map((r) => r.blockedId),
      { includePresence: false },
    );
    const users: ChatBlockedListResponse['users'] = [];
    for (const row of rows) {
      const summary = summaries.get(row.blockedId);
      if (!summary) continue;
      users.push({
        ...summary,
        blockedAt: new Date(row.createdAt).toISOString(),
      });
    }
    return { users };
  }

  /* ---------------- per-user conversation state ---------------- */

  /** Sets the caller's mute/archive flags on one conversation; returns the fresh summary. */
  async setConversationState(
    me: string,
    conversationId: string,
    body: ChatConversationStateRequest,
  ): Promise<ChatConversationSummary> {
    const models = this.requireModels();
    const conv = await this.participantConversation(models, me, conversationId);
    const patch: { muted?: boolean; archived?: boolean } = {};
    if (typeof body?.muted === 'boolean') patch.muted = body.muted;
    if (typeof body?.archived === 'boolean') patch.archived = body.archived;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Nothing to update');
    }
    // timestamps:false — state changes are not conversation
    // activity and must never reorder anyone's inbox.
    await models.conversations
      .updateOne(
        { _id: conv._id },
        { $set: this.stateSet(conv, me, patch) },
        { timestamps: false },
      )
      .exec();
    const fresh: ConversationLean = {
      ...conv,
      ...(patch.muted !== undefined
        ? {
            [this.isFirst(conv, me) ? 'mutedFirst' : 'mutedSecond']:
              patch.muted,
          }
        : {}),
      ...(patch.archived !== undefined
        ? {
            [this.isFirst(conv, me) ? 'archivedFirst' : 'archivedSecond']:
              patch.archived,
          }
        : {}),
    };
    const summaries = await this.summariesFor([this.otherOf(conv, me)]);
    const unread = await this.unreadCountsFor(models, [fresh], me);
    return this.toSummary(
      fresh,
      me,
      summaries,
      unread.get(String(conv._id)) ?? 0,
    );
  }

  /**
   * Delete-for-me: stamps my clear floor — the id of the newest
   * message right now (plus the clearedAt wall-clock stamp, kept
   * for reference). From now on I see only messages with a
   * greater id, and the conversation stays out of my lists until
   * one exists. The other participant's history is untouched.
   */
  async clearConversation(
    me: string,
    conversationId: string,
  ): Promise<{ cleared: true }> {
    const models = this.requireModels();
    const conv = await this.participantConversation(models, me, conversationId);
    await models.conversations
      .updateOne(
        { _id: conv._id },
        {
          $set: this.stateSet(conv, me, {
            clearedAt: new Date(),
            clearedUpToId: conv.lastMessage?.id ?? null,
          }),
        },
        { timestamps: false },
      )
      .exec();
    return { cleared: true };
  }

  /* ---------------- reports ---------------- */

  private reportDto(row: ReportLean): ChatReportRecord {
    return {
      id: String(row._id),
      reporterId: row.reporterId,
      reportedUserId: row.reportedUserId,
      conversationId: row.conversationId ? String(row.conversationId) : null,
      messageId: row.messageId ? String(row.messageId) : null,
      reason: row.reason,
      context: row.context ?? [],
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  /**
   * Files a report. With a messageId, the context snapshot is
   * frozen NOW (the reported message + up to 5 surrounding
   * messages); with only a conversationId, the last 5 messages;
   * with neither, no context. The reporter must participate in
   * the conversation — reports are not a way to read strangers'
   * threads.
   */
  async reportUser(
    me: string,
    body: ChatReportRequest,
  ): Promise<ChatReportRecord> {
    const models = this.requireModels();
    const reportedUserId = body?.reportedUserId;
    if (!reportedUserId || typeof reportedUserId !== 'string') {
      throw new BadRequestException('reportedUserId is required');
    }
    if (reportedUserId === me) {
      throw new BadRequestException('You cannot report yourself');
    }
    if (!Types.ObjectId.isValid(reportedUserId)) {
      throw new NotFoundException('User not found');
    }
    const reported = await models.users.findById(reportedUserId).lean().exec();
    if (!reported) throw new NotFoundException('User not found');
    const reason = body?.reason;
    if (reason !== 'spam' && reason !== 'harassment' && reason !== 'other') {
      throw new BadRequestException('reason must be spam, harassment or other');
    }

    let context: ChatMessage[] = [];
    let conversationId: string | null = null;
    let messageId: string | null = null;
    if (body.conversationId) {
      this.assertConversationId(body.conversationId);
      const conv = await this.findConversation(models, body.conversationId);
      if (!conv.participantIds.includes(me) || conv.hiddenFor === me) {
        throw new NotFoundException('Conversation not found');
      }
      conversationId = String(conv._id);
      if (body.messageId) {
        if (!Types.ObjectId.isValid(body.messageId)) {
          throw new BadRequestException('Invalid messageId');
        }
        const target = (await models.messages
          .findById(body.messageId)
          .lean()
          .exec()) as unknown as MessageLean | null;
        if (!target || String(target.conversationId) !== String(conv._id)) {
          throw new BadRequestException('Invalid messageId');
        }
        messageId = String(target._id);
        const beforeFilter: Record<string, unknown> = {
          conversationId: conv._id,
          _id: { $lt: target._id },
        };
        const afterFilter: Record<string, unknown> = {
          conversationId: conv._id,
          _id: { $gt: target._id },
        };
        const [beforeDesc, afterAsc] = await Promise.all([
          models.messages
            .find(beforeFilter)
            .sort({ _id: -1 })
            .limit(2)
            .lean()
            .exec() as unknown as Promise<MessageLean[]>,
          models.messages
            .find(afterFilter)
            .sort({ _id: 1 })
            .limit(3)
            .lean()
            .exec() as unknown as Promise<MessageLean[]>,
        ]);
        const window = [
          ...beforeDesc.reverse(),
          target,
          ...afterAsc,
        ];
        context = window.map((m) => this.messageDto(m, conv.status));
      } else {
        const recent = (await models.messages
          .find({ conversationId: conv._id })
          .sort({ _id: -1 })
          .limit(5)
          .lean()
          .exec()) as unknown as MessageLean[];
        context = recent
          .reverse()
          .map((m) => this.messageDto(m, conv.status));
      }
    }

    const created = (await models.reports.create({
      reporterId: me,
      reportedUserId,
      conversationId: conversationId
        ? new Types.ObjectId(conversationId)
        : null,
      messageId: messageId ? new Types.ObjectId(messageId) : null,
      reason,
      context,
    })) as unknown as ReportLean;
    this.metrics?.inc('reports');
    return this.reportDto(created);
  }

  /**
   * Operator read for the report queue: newest 50. Gated by the
   * ADMIN_USER_IDS env (comma-separated user ids; empty = the
   * queue is readable by NOBODY — reports still accumulate for
   * direct DB inspection).
   */
  async listReports(me: string): Promise<ChatReportListResponse> {
    const models = this.requireModels();
    const admins = (process.env.ADMIN_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!admins.includes(me)) {
      throw new ForbiddenException('Not an operator');
    }
    const rows = (await models.reports
      .find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
      .exec()) as unknown as ReportLean[];
    return { reports: rows.map((r) => this.reportDto(r)) };
  }

  /* ---------------- realtime support ---------------- */

  /** Distinct other-participant ids across a user's open conversations (presence fan-out). */
  async conversationPartnerIds(userId: string): Promise<string[]> {
    const models = this.requireModels();
    // Bounded projection: presence fan-out runs on every connect/
    // disconnect and only needs the participant pairs.
    const convs = (await models.conversations
      .find({
        participantIds: userId,
        status: { $ne: 'blocked' },
        hiddenFor: { $ne: userId },
      })
      .select('participantIds')
      .lean()
      .exec()) as unknown as ConversationLean[];
    return [...new Set(convs.map((c) => this.otherOf(c, userId)))];
  }

  /** Relays a typing signal — active conversations only, participants only. */
  async relayTyping(
    me: string,
    conversationId: string,
    typing: boolean,
  ): Promise<void> {
    const models = this.requireModels();
    if (!conversationId || !Types.ObjectId.isValid(conversationId)) return;
    const conv = (await models.conversations
      .findById(conversationId)
      .lean()
      .exec()) as unknown as ConversationLean | null;
    if (!conv || !conv.participantIds.includes(me)) return;
    if (conv.status !== 'active') return;
    if (conv.hiddenFor) return;
    this.broadcaster?.emitToUser(this.otherOf(conv, me), 'chat:typing', {
      conversationId: String(conv._id),
      typing,
    });
  }

  /* ---------------- people ---------------- */

  private async peopleRows(
    models: ChatModels,
    me: string,
    userIds: string[],
    withConvPrecomputed?: Set<string>,
  ): Promise<ChatPerson[]> {
    // No presence on people rows (privacy: see contracts ChatPerson).
    const summaries = await this.summariesFor(userIds, {
      includePresence: false,
    });
    // hasConversation needs only the pairs, not full conversation
    // documents. Callers building several sections pass the set
    // in (computed ONCE) instead of re-scanning my conversations
    // per section — people() used to run this query per call.
    let withConv = withConvPrecomputed;
    if (!withConv) {
      const convs = (await models.conversations
        .find({
          participantIds: me,
          status: { $ne: 'blocked' },
          hiddenFor: { $ne: me },
        })
        .select('participantIds')
        .lean()
        .exec()) as unknown as ConversationLean[];
      withConv = new Set(convs.map((c) => this.otherOf(c, me)));
    }
    const rows: ChatPerson[] = [];
    for (const id of userIds) {
      const summary = summaries.get(id);
      if (!summary) continue;
      const { online: _online, lastActiveAt: _lastActiveAt, ...person } =
        summary;
      rows.push({ ...person, hasConversation: withConv.has(id) });
    }
    return rows;
  }

  async people(me: string): Promise<ChatPeopleResponse> {
    // 60s per-user cache: the New Chat screen's sections change
    // slowly (quiz rooms end, follows change), and the uncached
    // build costs several scans. Opening/blocking a conversation
    // invalidates the caller's entry immediately (see
    // openConversation/blockUser), so hasConversation never lies
    // about the caller's own actions.
    const cached = this.peopleCache.get(me);
    if (cached && Date.now() - cached.at < PEOPLE_CACHE_TTL_MS) {
      return cached.res;
    }
    const res = await this.buildPeople(me);
    this.peopleCache.set(me, { at: Date.now(), res });
    return res;
  }

  private async buildPeople(me: string): Promise<ChatPeopleResponse> {
    const models = this.requireModels();
    const blocked = await this.blockedPairIds(models, me);
    // The hasConversation pair set, computed once for both sections.
    const myConvs = (await models.conversations
      .find({
        participantIds: me,
        status: { $ne: 'blocked' },
        hiddenFor: { $ne: me },
      })
      .select('participantIds')
      .lean()
      .exec()) as unknown as ConversationLean[];
    const withConv = new Set(myConvs.map((c) => this.otherOf(c, me)));

    // FROM YOUR QUIZ ROOMS — durable source: RankHistory rows are
    // written per player per finished multiplayer game with a
    // shared roomId, so grouping my recent rooms' rows by roomId
    // reconstructs exactly who I played with.
    const myHistory = (await models.rankHistories
      .find({ userId: me })
      .sort({ playedAt: -1 })
      .limit(200)
      .select('roomId')
      .lean()
      .exec()) as { roomId: string }[];
    const roomOrder: string[] = [];
    for (const row of myHistory) {
      if (!roomOrder.includes(row.roomId)) roomOrder.push(row.roomId);
      if (roomOrder.length >= QUIZ_ROOM_LOOKBACK) break;
    }
    const quizRoomIds: string[] = [];
    if (roomOrder.length > 0) {
      // NOTE: RankHistory is a SHARED collection — no roomId
      // index may be added for chat's sake (repo rule). The
      // query is bounded instead: at most QUIZ_ROOM_LOOKBACK
      // room ids, needed fields only.
      const rows = (await models.rankHistories
        .find({ roomId: { $in: roomOrder } })
        .select('roomId userId')
        .lean()
        .exec()) as { roomId: string; userId: string }[];
      const byRoom = new Map<string, string[]>();
      for (const row of rows) {
        const list = byRoom.get(row.roomId) ?? [];
        if (row.userId !== me && !list.includes(row.userId)) {
          list.push(row.userId);
        }
        byRoom.set(row.roomId, list);
      }
      for (const roomId of roomOrder) {
        for (const id of byRoom.get(roomId) ?? []) {
          if (!quizRoomIds.includes(id) && !blocked.has(id)) {
            quizRoomIds.push(id);
          }
        }
        if (quizRoomIds.length >= PEOPLE_LIMIT) break;
      }
      quizRoomIds.splice(PEOPLE_LIMIT);
    }

    // SUGGESTED — followees first (newest follows first), then
    // other public users by follower count; deterministic.
    const seen = new Set<string>([me, ...quizRoomIds, ...blocked]);
    const suggestedIds: string[] = [];
    const followees = (await models.follows
      .find({ followerId: me })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean()
      .exec()) as { followeeId: unknown }[];
    for (const f of followees) {
      const id = String(f.followeeId);
      if (!seen.has(id)) {
        seen.add(id);
        suggestedIds.push(id);
      }
      if (suggestedIds.length >= PEOPLE_LIMIT) break;
    }
    if (suggestedIds.length < PEOPLE_LIMIT) {
      // The global public-user tail is user-independent, so its
      // raw id list is cached for 60s instead of re-sorting the
      // public user set on every New Chat open (deep analysis
      // §4); the per-user seen/blocked filtering still runs
      // against the cached ids on every call.
      let otherIds: string[];
      if (
        this.suggestedIdsCache &&
        Date.now() - this.suggestedIdsCache.at < PEOPLE_CACHE_TTL_MS
      ) {
        otherIds = this.suggestedIdsCache.ids;
      } else {
        const others = (await models.users
          .find({ isPublic: true })
          .sort({ totalFollowers: -1, username: 1 })
          .limit(100)
          .lean()
          .exec()) as UserLean[];
        otherIds = others.map((user) => String(user._id));
        this.suggestedIdsCache = { at: Date.now(), ids: otherIds };
      }
      for (const id of otherIds) {
        if (!seen.has(id)) {
          seen.add(id);
          suggestedIds.push(id);
        }
        if (suggestedIds.length >= PEOPLE_LIMIT) break;
      }
    }

    return {
      quizRoomPeople: await this.peopleRows(models, me, quizRoomIds, withConv),
      suggested: await this.peopleRows(models, me, suggestedIds, withConv),
    };
  }

  async searchPeople(
    me: string,
    queryParam?: string,
  ): Promise<ChatPeopleSearchResponse> {
    const models = this.requireModels();
    const q = (queryParam ?? '').trim();
    if (q.length < 2) {
      throw new BadRequestException('Query too short — minimum 2 characters');
    }
    const blocked = await this.blockedPairIds(models, me);
    // Mirrors the web user-search semantics (social searchUsers):
    // every query word must be a case-insensitive substring of the
    // username or the display name; public accounts only.
    const words = q.split(/\s+/).filter(Boolean);
    const conditions = words.map((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        $or: [
          { username: { $regex: escaped, $options: 'i' } },
          { displayName: { $regex: escaped, $options: 'i' } },
        ],
      };
    });
    const filter: Record<string, unknown> = { isPublic: true };
    if (conditions.length > 0) filter.$and = conditions;
    const docs = (await models.users
      .find(filter)
      .limit(50)
      .lean()
      .exec()) as UserLean[];
    const ids = docs
      .map((d) => String(d._id))
      .filter((id) => id !== me && !blocked.has(id))
      .slice(0, PEOPLE_LIMIT);
    return { query: q, users: await this.peopleRows(models, me, ids) };
  }
}

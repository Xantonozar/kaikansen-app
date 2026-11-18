import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  ChatPushToken,
  type ChatPushTokenDocument,
} from './chat-push-token.schema';
import { ChatPresence } from './chat-presence';
import { ChatMetrics } from './chat-metrics';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Active-conversation pushes for one (recipient, conversation) at most once per 30s. */
const PUSH_COOLDOWN_MS = 30_000;
/** Expo accepts at most 100 push messages per request. */
const EXPO_CHUNK_SIZE = 100;
/** Android notification channel the mobile app creates at registration time. */
export const CHAT_PUSH_CHANNEL_ID = 'chat-messages';

export interface PushDecisionInput {
  /** The recipient muted this conversation (never pushes). */
  muted: boolean;
  /** The recipient currently holds a live chat socket. */
  recipientOnline: boolean;
  kind: 'active' | 'request';
  /** True when this is the first message ever in the conversation. */
  isFirstMessage: boolean;
  /** When the last push for this (recipient, conversation) went out, if any. */
  lastPushAt: number | null;
  now: number;
}

export interface PushDecision {
  send: boolean;
  /** Machine-readable skip reason ('ok' when sending). */
  reason: 'ok' | 'muted' | 'recipient-online' | 'request-not-first' | 'cooldown';
}

export interface NewMessagePush {
  recipientId: string;
  conversationId: string;
  kind: 'active' | 'request';
  muted: boolean;
  senderUsername: string;
  messageType: 'text' | 'theme';
  isFirstMessage: boolean;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  channelId: string;
  data: { kind: 'chat-message' | 'chat-request'; conversationId: string };
}

function isExpoPushToken(token: string): boolean {
  return (
    token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')
  );
}

/**
 * Chat push notifications via the Expo Push Service (plain
 * fetch — no SDK dependency server-side). Deep analysis §1: chat
 * previously had NO discovery path with the app closed.
 *
 * Privacy rules, enforced here and in the copy:
 * - Notification bodies NEVER contain message text. Active
 *   conversations read "New message from @user" (theme shares:
 *   "♪ @user shared a theme"); requests read "@user sent you a
 *   message request".
 * - Muted conversations never push.
 * - A recipient with a live chat socket is in the app already —
 *   no push (the socket + badge are the surface there).
 * - Requests push at most once per conversation (on the first
 *   message); active conversations coalesce to one push per
 *   (recipient, conversation) per 30 seconds.
 *
 * Unconfigured safety: with no tokens stored nothing is sent;
 * EXPO_ACCESS_TOKEN is optional (Expo accepts unauthenticated
 * sends for tokens owned by the project in most setups) — its
 * absence never breaks the send path, and every failure is
 * logged and swallowed: push must never fail a message send.
 */
@Injectable()
export class ChatPushService implements OnModuleInit {
  private readonly logger = new Logger(ChatPushService.name);
  private readonly lastPushAt = new Map<string, number>();

  constructor(
    @Optional()
    @InjectModel(ChatPushToken.name)
    private readonly tokenModel?: Model<ChatPushTokenDocument>,
    @Optional()
    private readonly presence?: ChatPresence,
    @Optional()
    private readonly metrics?: ChatMetrics,
  ) {}

  /** Builds the app-only push-token indexes (see chat-push-token.schema.ts). */
  async onModuleInit(): Promise<void> {
    if (!this.tokenModel || typeof this.tokenModel.createIndexes !== 'function') {
      return;
    }
    try {
      await this.tokenModel.createIndexes();
    } catch (error) {
      this.logger.warn(
        `createIndexes failed for ${this.tokenModel.modelName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The pure push decision — exported for unit tests. */
  static decide(input: PushDecisionInput): PushDecision {
    if (input.muted) return { send: false, reason: 'muted' };
    if (input.recipientOnline) {
      return { send: false, reason: 'recipient-online' };
    }
    if (input.kind === 'request' && !input.isFirstMessage) {
      return { send: false, reason: 'request-not-first' };
    }
    if (
      input.kind === 'active' &&
      input.lastPushAt !== null &&
      input.now - input.lastPushAt < PUSH_COOLDOWN_MS
    ) {
      return { send: false, reason: 'cooldown' };
    }
    return { send: true, reason: 'ok' };
  }

  /** Registers (or reassigns) a device token for a user. Idempotent. */
  async registerToken(userId: string, token: string): Promise<void> {
    if (!token || typeof token !== 'string' || !isExpoPushToken(token)) {
      throw new BadRequestException('A valid Expo push token is required');
    }
    if (!this.tokenModel) return;
    const existing = (await this.tokenModel
      .findOne({ token })
      .lean()
      .exec()) as { _id: unknown; userId: string } | null;
    if (existing) {
      if (existing.userId !== userId) {
        // One signed-in account per device: the token moves.
        await this.tokenModel
          .updateOne({ _id: existing._id }, { $set: { userId } })
          .exec();
      }
      return;
    }
    await this.tokenModel.create({ userId, token });
  }

  /** Removes one device token for a user (logout). Idempotent. */
  async unregisterToken(userId: string, token: string): Promise<void> {
    if (!this.tokenModel || !token) return;
    await this.tokenModel.deleteOne({ userId, token }).exec();
  }

  /** Removes a token whoever owns it (Expo says the device is gone). */
  private async dropToken(token: string): Promise<void> {
    if (!this.tokenModel) return;
    await this.tokenModel.deleteMany({ token }).exec();
  }

  private async tokensFor(userId: string): Promise<string[]> {
    if (!this.tokenModel) return [];
    const rows = (await this.tokenModel
      .find({ userId })
      .lean()
      .exec()) as { token: string }[];
    return rows.map((r) => r.token).filter(isExpoPushToken);
  }

  /**
   * The send-time entry point (called fire-and-forget by
   * ChatService after a message commits). Never throws.
   */
  async notifyNewMessage(input: NewMessagePush): Promise<void> {
    try {
      const now = Date.now();
      const key = `${input.recipientId}:${input.conversationId}`;
      const decision = ChatPushService.decide({
        muted: input.muted,
        recipientOnline: this.presence?.isOnline(input.recipientId) ?? false,
        kind: input.kind,
        isFirstMessage: input.isFirstMessage,
        lastPushAt: this.lastPushAt.get(key) ?? null,
        now,
      });
      if (!decision.send) return;
      const tokens = await this.tokensFor(input.recipientId);
      if (tokens.length === 0) return;
      const isRequest = input.kind === 'request';
      const message: Omit<ExpoPushMessage, 'to'> = {
        title: isRequest ? 'Message request' : 'New message',
        body: isRequest
          ? `@${input.senderUsername} sent you a message request`
          : input.messageType === 'theme'
            ? `♪ @${input.senderUsername} shared a theme`
            : `New message from @${input.senderUsername}`,
        sound: 'default',
        channelId: CHAT_PUSH_CHANNEL_ID,
        data: {
          kind: isRequest ? 'chat-request' : 'chat-message',
          conversationId: input.conversationId,
        },
      };
      await this.sendToTokens(tokens, message);
      this.lastPushAt.set(key, now);
      this.metrics?.inc('pushesSent');
    } catch (error) {
      this.logger.warn(
        `push notify failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * POSTs the messages to Expo in chunks and processes the
   * tickets: a DeviceNotRegistered receipt deletes the token so
   * dead devices stop costing sends.
   */
  private async sendToTokens(
    tokens: string[],
    payload: Omit<ExpoPushMessage, 'to'>,
  ): Promise<void> {
    const accessToken = process.env.EXPO_ACCESS_TOKEN;
    for (let i = 0; i < tokens.length; i += EXPO_CHUNK_SIZE) {
      const chunk = tokens
        .slice(i, i + EXPO_CHUNK_SIZE)
        .map((to) => ({ to, ...payload }));
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(accessToken
            ? { Authorization: `Bearer ${accessToken}` }
            : {}),
        },
        body: JSON.stringify(chunk),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: { status?: string; details?: { error?: string } }[];
      } | null;
      const tickets = json?.data ?? [];
      for (let j = 0; j < tickets.length; j += 1) {
        if (tickets[j]?.details?.error === 'DeviceNotRegistered') {
          await this.dropToken(chunk[j].to);
          this.metrics?.inc('pushTokensDropped');
        }
      }
    }
  }
}

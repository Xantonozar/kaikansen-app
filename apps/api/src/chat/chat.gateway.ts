import { Optional } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type {
  ChatPresenceEvent,
  ChatSendAck,
  ChatSendEvent,
  ChatTypingEvent,
} from '@kaikansen/contracts';
import { AuthService, type TokenPayload } from '../auth/auth.service';
import { ChatBroadcaster } from './chat-broadcaster';
import { ChatPresence } from './chat-presence';
import { ChatService } from './chat.service';
import { ChatMetrics } from './chat-metrics';
import { ChatRateLimiter, PartnerIdsCache } from './chat-rate-limit';

/**
 * Socket rate limits (deep analysis §3). Guards never run for
 * socket events, so the gateway enforces the same numbers the
 * REST throttler uses (chat-throttle.ts): sends 60/min per
 * user; typing relays 30/min per user per conversation (typing
 * is a high-frequency, low-value event — excess is dropped
 * silently rather than erroring).
 */
const SOCKET_SEND_LIMIT = 60;
const SOCKET_TYPING_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

/** Socket.IO channel carrying one user's chat events. */
export function userChannel(userId: string): string {
  return `chat-user-${userId}`;
}

interface AuthedSocket extends Socket {
  data: Socket['data'] & { user?: TokenPayload };
}

/**
 * The chat gateway — shares the default Socket.IO namespace with
 * the quiz gateway (clients hold one connection per feature,
 * mirroring the mobile clients). Authentication is identical to
 * the quiz gateway: the access token rides the handshake and is
 * verified with the same AuthService; an unverifiable handshake
 * is disconnected before any event is served.
 *
 * Client → server:
 * - chat:send    ChatSendEvent → ack ChatSendAck (the saved
 *   message, with the client's optimistic clientId echoed back
 *   on the copy delivered to the receiver)
 * - chat:typing  ChatTypingEvent (no ack; relayed only inside
 *   active conversations — request receivers never see typing
 *   from themselves leak, and requesters never see the
 *   receiver's)
 *
 * Server → client (per-user channel `chat-user-<userId>`):
 * - chat:message            the ChatMessage (with clientId when set)
 * - chat:read               ChatReadEvent (active conversations only)
 * - chat:typing             ChatTypingEvent from the other participant
 * - chat:presence           ChatPresenceEvent for conversation partners
 * - chat:request-accepted   { conversationId }
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly sendLimiter = new ChatRateLimiter(
    SOCKET_SEND_LIMIT,
    RATE_WINDOW_MS,
  );
  private readonly typingLimiter = new ChatRateLimiter(
    SOCKET_TYPING_LIMIT,
    RATE_WINDOW_MS,
  );
  /** Presence fan-out partner sets, cached 30s per user (see chat-rate-limit.ts). */
  private readonly partnerCache = new PartnerIdsCache(30_000);

  constructor(
    @Optional()
    private readonly chatService?: ChatService,
    @Optional()
    private readonly authService?: AuthService,
    @Optional()
    private readonly broadcaster?: ChatBroadcaster,
    @Optional()
    private readonly presence?: ChatPresence,
    @Optional()
    private readonly metrics?: ChatMetrics,
  ) {}

  afterInit(server: Server) {
    this.broadcaster?.register((userId, event, payload) => {
      server.to(userChannel(userId)).emit(event, payload);
    });
  }

  handleConnection(client: AuthedSocket) {
    const token = this.extractToken(client);
    const payload = token ? this.authService?.verifyAccessToken(token) : null;
    if (!payload) {
      client.disconnect(true);
      return;
    }
    client.data.user = payload;
    this.metrics?.inc('socketConnects');
    void client.join(userChannel(payload.userId));
    const cameOnline = this.presence?.add(payload.userId, client.id) ?? false;
    if (cameOnline) {
      void this.notifyPresence(payload.userId, true);
    }
  }

  handleDisconnect(client: AuthedSocket) {
    const user = client.data.user;
    if (!user) return;
    this.metrics?.inc('socketDisconnects');
    const wentOffline = this.presence?.remove(user.userId, client.id) ?? false;
    if (wentOffline) {
      void this.notifyPresence(user.userId, false);
    }
  }

  /** Tells everyone who shares an open conversation with this user that their presence flipped. */
  private async notifyPresence(userId: string, online: boolean) {
    if (!this.chatService || !this.broadcaster) return;
    try {
      // Partner sets change rarely; a 30s cache keeps connect/
      // disconnect flapping (reconnect storms, multi-device) from
      // re-scanning the user's conversations on every flip.
      let partners = this.partnerCache.get(userId);
      if (!partners) {
        partners = await this.chatService.conversationPartnerIds(userId);
        this.partnerCache.set(userId, partners);
      }
      const event: ChatPresenceEvent = { userId, online };
      for (const partner of partners) {
        this.broadcaster.emitToUser(partner, 'chat:presence', event);
      }
    } catch {
      // Presence fan-out is best-effort; a failure must not break
      // the connection lifecycle.
    }
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as { token?: unknown } | undefined;
    if (typeof auth?.token === 'string' && auth.token.length > 0) {
      return auth.token;
    }
    const header = client.handshake.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length);
    }
    return null;
  }

  private user(client: AuthedSocket): TokenPayload {
    return client.data.user as TokenPayload;
  }

  @SubscribeMessage('chat:send')
  async onSend(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: ChatSendEvent,
  ): Promise<ChatSendAck> {
    if (!this.chatService) {
      return { ok: false, error: 'Chat is unavailable' };
    }
    const userId = this.user(client).userId;
    if (!this.sendLimiter.allow(userId)) {
      this.metrics?.inc('socketSendFailures');
      return {
        ok: false,
        error: 'You are sending messages too fast — slow down for a moment',
      };
    }
    try {
      const message = await this.chatService.sendMessage(
        userId,
        payload.conversationId,
        payload,
        payload.clientId,
      );
      return { ok: true, message };
    } catch (error) {
      this.metrics?.inc('socketSendFailures');
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not send message',
      };
    }
  }

  @SubscribeMessage('chat:typing')
  onTyping(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() payload: ChatTypingEvent,
  ): void {
    if (!this.chatService || !payload?.conversationId) return;
    const userId = this.user(client).userId;
    if (
      !this.typingLimiter.allow(`${userId}:${payload.conversationId}`)
    ) {
      return; // Excess typing is dropped, never errored.
    }
    void this.chatService.relayTyping(
      userId,
      payload.conversationId,
      !!payload.typing,
    );
  }
}

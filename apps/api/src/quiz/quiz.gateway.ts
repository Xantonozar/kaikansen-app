import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Optional } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import type {
  CreateRoomRequest,
  PublicRoomRequest,
  QuizRoomAck,
} from '@kaikansen/contracts';
import { AuthService, type TokenPayload } from '../auth/auth.service';
import {
  QuizRoomsService,
  RoomActionError,
} from './quiz-rooms.service';
import { RoomBroadcaster } from './room-broadcaster';

/** Socket.IO channel name for a room (the web: presence-quiz-room-<id>). */
export function roomChannel(roomId: string): string {
  return `quiz-room-${roomId}`;
}

interface AuthedSocket extends Socket {
  data: Socket['data'] & { user?: TokenPayload };
}

/**
 * The multiplayer quiz gateway (Slice S4) — this API's OWN
 * Socket.IO transport for the web's room protocol (Gate 2: the
 * website keeps Pusher; the two transports never share rooms).
 *
 * Protocol: clients emit `room:*` events with an ack callback;
 * every ack is a QuizRoomAck mirroring the web REST route's body
 * ({ success, … } / { success: false, error }). Server broadcasts
 * reuse the web's Pusher event names and payload shapes
 * (room:player-joined / -left / -ready, room:settings-updated,
 * room:round-started, room:player-answered, room:round-ended,
 * room:rank-updated, room:closed) on the `quiz-room-<roomId>`
 * Socket.IO room.
 *
 * Client → server events:
 * - room:create        { roomType, poolMode, guessType, roundCount, maxPlayers?, matchmaking }
 * - room:join          { roomCode }
 * - room:public        { roomType, poolMode, guessType, maxPlayers? }
 * - room:list-public   {} — the lobby's open public rooms (Slice 5;
 *   this API's own addition, the web has no room list)
 * - room:subscribe     { roomId } — reattach after (re)connect; members only
 * - room:leave         { roomId }
 * - room:ready         { roomId } — toggles ready (duels auto-start)
 * - room:update-settings { roomId, settings }
 * - room:start         { roomId }
 * - room:next          { roomId, expectedRound? }
 * - room:answer        { roomId, roundNumber, submittedAnswer }
 * - room:heartbeat     { roomId }
 * - room:rematch       { roomId } — play-again vote on an ended room
 *   (owner feature, 2026-11-12; unanimity restarts the game in
 *   the same room — see QuizRoomsService.voteRematch)
 * - room:round-ready   { roomId, roundNumber, state } — the
 *   client's per-round audio report (F4, 2026-11-12): its round
 *   audio is 'playing' or 'failed'; the round's startedAt is
 *   stamped once every current member has reported (bounded)
 *
 * Authentication: the access token rides the handshake
 * (`auth.token`, or an `Authorization: Bearer …` header) and is
 * verified with the same AuthService as the REST guard; an
 * unverifiable handshake is disconnected before any event is
 * served. There are no anonymous sockets (every web room route
 * requires a session too).
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class QuizGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    @Optional()
    private readonly roomsService?: QuizRoomsService,
    @Optional()
    private readonly authService?: AuthService,
    @Optional()
    private readonly broadcaster?: RoomBroadcaster,
  ) {}

  afterInit(server: Server) {
    this.broadcaster?.register((roomId, event, payload) => {
      server.to(roomChannel(roomId)).emit(event, payload);
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

  /**
   * Runs a room action and shapes the ack: RoomActionError →
   * the web-shaped failure body; success → the service's ack.
   * On success the socket joins the room channel (when the ack
   * carries a roomId) so broadcasts reach it.
   */
  private async run(
    client: AuthedSocket,
    action: () => Promise<QuizRoomAck>,
    joinChannel = true,
  ): Promise<QuizRoomAck> {
    try {
      const ack = await action();
      const roomId = ack.roomId ?? ack.room?.roomId;
      if (joinChannel && ack.success && roomId) {
        await client.join(roomChannel(roomId));
      }
      return ack;
    } catch (error) {
      if (error instanceof RoomActionError) {
        return { success: false, error: error.message, ...error.extra };
      }
      console.error('Quiz gateway error:', error);
      return { success: false, error: 'Internal Server Error' };
    }
  }

  @SubscribeMessage('room:create')
  create(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: CreateRoomRequest,
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.createRoom(this.user(client).userId, body),
    );
  }

  @SubscribeMessage('room:join')
  join(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomCode?: string },
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.joinByCode(this.user(client).userId, body?.roomCode ?? ''),
    );
  }

  @SubscribeMessage('room:public')
  publicMatchmaking(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: PublicRoomRequest,
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.publicMatchmaking(this.user(client).userId, body),
    );
  }

  @SubscribeMessage('room:list-public')
  listPublic(
    @ConnectedSocket() client: AuthedSocket,
  ): Promise<QuizRoomAck> {
    return this.run(
      client,
      () => this.roomsService!.listPublicRooms(),
      false,
    );
  }

  @SubscribeMessage('room:subscribe')
  subscribe(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string },
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.getRoomStateForMember(
        this.user(client).userId,
        body?.roomId ?? '',
      ),
    );
  }

  @SubscribeMessage('room:leave')
  async leave(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string },
  ): Promise<QuizRoomAck> {
    const ack = await this.run(
      client,
      () => this.roomsService!.leaveRoom(this.user(client).userId, body?.roomId ?? ''),
      false,
    );
    if (ack.success && body?.roomId) {
      await client.leave(roomChannel(body.roomId));
    }
    return ack;
  }

  @SubscribeMessage('room:ready')
  ready(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string },
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.toggleReady(this.user(client).userId, body?.roomId ?? ''),
    );
  }

  @SubscribeMessage('room:update-settings')
  updateSettings(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string; settings?: Record<string, unknown> },
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.updateSettings(
        this.user(client).userId,
        body?.roomId ?? '',
        (body?.settings ?? {}) as Record<string, unknown>,
      ),
    );
  }

  @SubscribeMessage('room:start')
  start(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string },
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.startGame(this.user(client).userId, body?.roomId ?? ''),
    );
  }

  @SubscribeMessage('room:next')
  next(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string; expectedRound?: number },
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.nextRound(
        this.user(client).userId,
        body?.roomId ?? '',
        body?.expectedRound,
      ),
    );
  }

  @SubscribeMessage('room:answer')
  answer(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody()
    body: { roomId?: string; roundNumber?: number; submittedAnswer?: string },
  ): Promise<QuizRoomAck> {
    return this.run(
      client,
      () =>
        this.roomsService!.submitAnswer(
          this.user(client).userId,
          body?.roomId ?? '',
          body?.roundNumber as number,
          body?.submittedAnswer ?? '',
        ),
      false,
    );
  }

  @SubscribeMessage('room:rematch')
  rematch(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string },
  ): Promise<QuizRoomAck> {
    return this.run(client, () =>
      this.roomsService!.voteRematch(this.user(client).userId, body?.roomId ?? ''),
    );
  }

  @SubscribeMessage('room:round-ready')
  roundReady(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody()
    body: { roomId?: string; roundNumber?: number; state?: string },
  ): Promise<QuizRoomAck> {
    return this.run(
      client,
      () =>
        this.roomsService!.reportRoundReady(
          this.user(client).userId,
          body?.roomId ?? '',
          body?.roundNumber as number,
          body?.state as 'playing' | 'failed',
        ),
      false,
    );
  }

  @SubscribeMessage('room:heartbeat')
  heartbeat(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId?: string },
  ): Promise<QuizRoomAck> {
    return this.run(
      client,
      () => this.roomsService!.heartbeat(this.user(client).userId, body?.roomId ?? ''),
      false,
    );
  }
}

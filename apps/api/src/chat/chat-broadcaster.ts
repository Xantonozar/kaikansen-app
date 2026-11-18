import { Injectable } from '@nestjs/common';

/**
 * The seam between the chat service and the Socket.IO gateway
 * (mirrors the quiz RoomBroadcaster). Services stay
 * transport-blind: they call `emitToUser`, and the gateway
 * registers the actual Socket.IO emitter when it boots, routing
 * to the per-user channel `chat-user-<userId>` every authed chat
 * socket joins on connect.
 *
 * Until a gateway registers (unit tests, no-DB boots), emissions
 * are dropped silently.
 */
@Injectable()
export class ChatBroadcaster {
  private emitter: (
    userId: string,
    event: string,
    payload: unknown,
  ) => void = () => undefined;

  register(emitter: (userId: string, event: string, payload: unknown) => void) {
    this.emitter = emitter;
  }

  emitToUser(userId: string, event: string, payload: unknown) {
    try {
      this.emitter(userId, event, payload);
    } catch {
      // A broadcast failure must never fail the mutation that
      // caused it.
    }
  }
}

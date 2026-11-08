import { Injectable } from '@nestjs/common';

/**
 * The seam between the quiz services and the Socket.IO gateway.
 *
 * On the web, room mutations broadcast through Pusher
 * (`pusherServer.trigger('presence-quiz-room-<id>', …)`). Here the
 * services stay transport-blind: they call `emitToRoom`, and the
 * gateway registers the actual Socket.IO emitter when it boots.
 * Events use the web's Pusher event names verbatim ('room:…') so
 * the protocol vocabulary is unchanged — only the transport moved.
 *
 * Until a gateway registers (unit tests, no-DB boots), emissions
 * are dropped silently — the web's cleanup util does the same
 * with its safeTrigger wrapper.
 */
@Injectable()
export class RoomBroadcaster {
  private emitter: (
    roomId: string,
    event: string,
    payload: unknown,
  ) => void = () => undefined;

  register(emitter: (roomId: string, event: string, payload: unknown) => void) {
    this.emitter = emitter;
  }

  emitToRoom(roomId: string, event: string, payload: unknown) {
    try {
      this.emitter(roomId, event, payload);
    } catch {
      // A broadcast failure must never fail the mutation that
      // caused it — the web's safeTrigger swallows Pusher errors
      // the same way.
    }
  }
}

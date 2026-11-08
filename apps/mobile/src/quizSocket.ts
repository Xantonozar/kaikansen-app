import { io, type Socket } from 'socket.io-client';
import type { QuizRoomAck } from '@kaikansen/contracts';
import { apiBaseUrl, fixtureMode } from './api';
import {
  getAccessToken,
  notifySessionExpired,
  refreshAccessToken,
} from './session';

/**
 * Multiplayer quiz transport (Slice M4) — a single shared Socket.IO
 * connection to the API's quiz gateway (S4), which lives on the same
 * origin as the REST API. The gateway verifies the access token from
 * the handshake (`auth.token`) and disconnects unverifiable sockets
 * before serving any event, so:
 *
 * - the socket is created lazily by the lobby/room screens and is
 *   handed the CURRENT access token on every (re)connect attempt —
 *   socket.io's auth callback runs per attempt, reads the in-memory
 *   token from session.ts, and silently refreshes first when it is
 *   gone, mirroring api.ts's 401 dance;
 * - a server-initiated disconnect (the gateway's answer to a stale
 *   token) triggers ONE guarded refresh + manual reconnect — the
 *   client library never auto-reconnects those on its own;
 * - when the refresh fails the session-expired path runs, exactly
 *   like a failed REST refresh (the provider signs the user out).
 *
 * Room actions are emits with ack callbacks; every ack is the
 * gateway's QuizRoomAck ({ success: true, … } / { success: false,
 * error }). `emitRoomEvent` races each ack against a timeout so a
 * dead connection surfaces as an error instead of a hung button.
 *
 * Ownership: the lobby connects the socket, then hands it to the
 * room screen via markRoomOwnership before navigating; the room
 * screen owns teardown (leave + disconnect) from there. A lobby
 * unmount WITHOUT ownership simply disconnects.
 */

export type QuizSocketStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

const ACK_TIMEOUT_MS = 15_000;
/** The gateway drops players after 45s without one (web cadence). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

let socket: Socket | null = null;
let connectInFlight: Promise<Socket> | null = null;
/** Bumped on teardown so a creation that resolves late cannot leak. */
let generation = 0;
let status: QuizSocketStatus = 'disconnected';
let statusError: string | null = null;
let ownedRoomId: string | null = null;
let authRetryAt = 0;

type StatusListener = (status: QuizSocketStatus, error: string | null) => void;
const statusListeners = new Set<StatusListener>();

function setStatus(next: QuizSocketStatus, error: string | null = null): void {
  status = next;
  statusError = error;
  for (const listener of statusListeners) listener(next, error);
}

export function subscribeQuizSocketStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener(status, statusError);
  return () => {
    statusListeners.delete(listener);
  };
}

export function getQuizSocketStatus(): QuizSocketStatus {
  return status;
}

/**
 * Connect (or reuse) the shared socket. Resolves with the socket as
 * soon as it exists — connection progress is reported through the
 * status subscription, and emitRoomEvent's ack timeout covers emits
 * into a not-yet-connected socket (socket.io queues them; the
 * timeout rejects if they never land). Rejects only when there is
 * nothing to connect with: fixture mode, or no session at all.
 */
export function ensureQuizSocket(): Promise<Socket> {
  if (fixtureMode || !apiBaseUrl) {
    return Promise.reject(
      new Error(
        'Multiplayer is not available in demo mode — connect the app to the API to play.',
      ),
    );
  }
  if (socket) {
    if (!socket.connected && status !== 'connecting') {
      setStatus('connecting');
      socket.connect();
    }
    return Promise.resolve(socket);
  }
  // Concurrent callers (lobby mount racing the room mount) share one
  // creation — otherwise the second socket would orphan the first.
  if (!connectInFlight) {
    connectInFlight = createQuizSocket().finally(() => {
      connectInFlight = null;
    });
  }
  return connectInFlight;
}

async function createQuizSocket(): Promise<Socket> {
  const gen = generation;
  if (!getAccessToken()) {
    const fresh = await refreshAccessToken();
    if (!fresh) throw new Error('Log in to play multiplayer.');
  }

  setStatus('connecting');
  const created = io(apiBaseUrl!, {
    // Runs on EVERY (re)connect attempt, so a rotated access token
    // is picked up without rebuilding the socket.
    auth: (cb) => {
      const token = getAccessToken();
      if (token) {
        cb({ token });
      } else {
        void refreshAccessToken().then((fresh) => cb({ token: fresh ?? '' }));
      }
    },
    transports: ['websocket'],
    reconnectionAttempts: 10,
    timeout: 15_000,
  });
  if (gen !== generation) {
    // Teardown ran while this socket was being created (the screen
    // that asked for it is gone) — do not leak a live connection.
    created.disconnect();
    throw new Error('Connection was cancelled.');
  }
  socket = created;

  created.on('connect', () => setStatus('connected'));
  created.on('disconnect', (reason) => {
    if (created !== socket) return;
    setStatus('disconnected');
    // The gateway disconnects sockets whose token it cannot verify;
    // socket.io does not auto-reconnect a server-initiated drop, so
    // refresh once and reconnect manually (rate-limited so a dead
    // session cannot spin).
    if (reason === 'io server disconnect' && Date.now() - authRetryAt > 5_000) {
      authRetryAt = Date.now();
      void refreshAccessToken().then((fresh) => {
        if (created !== socket) return;
        if (fresh) {
          created.connect();
        } else {
          notifySessionExpired();
        }
      });
    }
  });
  created.on('connect_error', (err) => {
    if (created !== socket) return;
    setStatus('error', err.message || 'Could not reach the quiz server.');
  });
  return created;
}

/** The shared socket, or null when none was ever created. */
export function getQuizSocket(): Socket | null {
  return socket;
}

/**
 * Emit a room action and await its QuizRoomAck. Acks that never
 * arrive (dead connection, server stall) reject after the timeout
 * so callers can show the failure instead of spinning forever.
 */
export function emitRoomEvent(
  event: string,
  payload: Record<string, unknown>,
): Promise<QuizRoomAck> {
  const current = socket;
  if (!current) {
    return Promise.reject(new Error('Multiplayer is not connected.'));
  }
  return new Promise<QuizRoomAck>((resolve, reject) => {
    current
      .timeout(ACK_TIMEOUT_MS)
      .emit(event, payload, (err: Error | null, ack?: QuizRoomAck) => {
        if (err) {
          reject(new Error('The quiz server took too long to answer.'));
        } else if (!ack) {
          reject(new Error('The quiz server sent an empty reply.'));
        } else {
          resolve(ack);
        }
      });
  });
}

/**
 * Subscribe to a server broadcast; returns the unsubscribe. All
 * listeners a screen registers must be removed on unmount — the
 * shared socket outlives screens during the lobby → room handoff.
 */
export function onRoomEvent(
  event: string,
  handler: (payload: never) => void,
): () => void {
  const current = socket;
  if (!current) return () => undefined;
  current.on(event, handler as (payload: unknown) => void);
  return () => {
    current.off(event, handler as (payload: unknown) => void);
  };
}

/** Lobby → room handoff: the room screen owns the socket from here. */
export function markRoomOwnership(roomId: string): void {
  ownedRoomId = roomId;
}

export function roomOwnership(): string | null {
  return ownedRoomId;
}

export function clearRoomOwnership(): void {
  ownedRoomId = null;
}

/** Tear the shared socket down (room exit, stray lobby unmount). */
export function disconnectQuizSocket(): void {
  generation += 1;
  connectInFlight = null;
  if (!socket) {
    ownedRoomId = null;
    return;
  }
  const current = socket;
  socket = null;
  ownedRoomId = null;
  current.removeAllListeners();
  current.disconnect();
  setStatus('disconnected');
}

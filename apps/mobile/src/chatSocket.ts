import { io, type Socket } from 'socket.io-client';
import type {
  ChatMessage,
  ChatPresenceEvent,
  ChatReadEvent,
  ChatSendAck,
  ChatSendEvent,
  ChatTypingEvent,
} from '@kaikansen/contracts';
import { apiBaseUrl, fixtureMode } from './api';
import { getAccessToken, refreshAccessToken } from './session';

/**
 * Chat socket client — a module-level singleton like quizSocket
 * (one socket per signed-in session, shared by the inbox and the
 * thread screens). The server authenticates the handshake exactly
 * like the quiz gateway (auth-callback with the current access
 * token, one refresh-and-retry on connect_error), joins the
 * socket to the caller's `chat-user-<id>` channel, and pushes:
 *
 *   chat:message            a message landed in one of my conversations
 *   chat:read               the other side read my messages (active convs)
 *   chat:typing             the other side is typing (active convs)
 *   chat:presence           a conversation partner came/went
 *   chat:request-accepted   a request I sent was accepted
 *
 * Sends go through 'chat:send' with an ack; the thread screen
 * falls back to the REST send when the socket path fails.
 *
 * RECONNECT SURVIVAL: subscriptions live in a module-level
 * registry, NOT on a socket instance. Handlers are wired onto
 * whatever socket instance is current through a single dispatcher
 * per event, and re-wired when an instance is replaced — so a
 * screen that mounted before a network outage keeps receiving
 * events after it. Reconnection is unbounded (capped attempts
 * used to strand every mounted screen on a dead socket); the
 * manager's 'reconnect' is fanned out as a synthetic event so
 * screens can catch up on what they missed (onChatReconnect).
 */

type Handler = (payload: never) => void;

/** Synthetic event name for the manager's reconnect fan-out. */
const RECONNECT_EVENT = '__chat_reconnect';

const subscribers = new Map<string, Set<Handler>>();
const wiredEvents = new Set<string>();
let socket: Socket | null = null;
let connectPromise: Promise<Socket> | null = null;
let reconnectManager: Socket['io'] | null = null;

function dispatch(event: string, payload: unknown): void {
  const set = subscribers.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    (handler as (p: unknown) => void)(payload);
  }
}

/** Attaches the single dispatcher for an event to a socket instance (idempotent per instance). */
function wireEvent(client: Socket, event: string): void {
  if (event === RECONNECT_EVENT || wiredEvents.has(event)) return;
  wiredEvents.add(event);
  client.on(event, (payload: unknown) => dispatch(event, payload));
}

function createSocket(): Socket {
  let authRetried = false;
  const client = io(apiBaseUrl, {
    transports: ['websocket'],
    // Never give up: a chat client that stops retrying after a
    // tunnel/elevator dead zone silently stops being realtime.
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    auth: (cb) => {
      const token = getAccessToken();
      if (token) {
        cb({ token });
        return;
      }
      void refreshAccessToken().then((fresh) => cb({ token: fresh ?? '' }));
    },
  });
  wiredEvents.clear();
  for (const event of subscribers.keys()) wireEvent(client, event);
  // io() caches Managers per URL, so guard against stacking a
  // second 'reconnect' listener on a shared manager.
  if (reconnectManager !== client.io) {
    reconnectManager = client.io;
    client.io.on('reconnect', () => dispatch(RECONNECT_EVENT, undefined));
  }
  client.on('connect_error', (err) => {
    if (!authRetried && /unauthorized/i.test(err.message)) {
      authRetried = true;
      void refreshAccessToken().then(() => client.connect());
    }
  });
  return client;
}

export function ensureChatSocket(): Promise<Socket> {
  if (fixtureMode) {
    return Promise.reject(new Error('Chat is unavailable in fixture mode.'));
  }
  if (!socket) socket = createSocket();
  const client = socket;
  if (client.connected) return Promise.resolve(client);
  if (connectPromise) return connectPromise;

  connectPromise = new Promise<Socket>((resolve, reject) => {
    let authErrorTolerated = false;
    const cleanup = () => {
      connectPromise = null;
      client.off('connect', onConnect);
      client.off('connect_error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(client);
    };
    const onError = (err: Error) => {
      // The first unauthorized error is followed by the
      // refresh-and-retry in createSocket — keep waiting for it.
      if (!authErrorTolerated && /unauthorized/i.test(err.message)) {
        authErrorTolerated = true;
        return;
      }
      cleanup();
      reject(err);
    };
    client.on('connect', onConnect);
    client.on('connect_error', onError);
  });
  return connectPromise;
}

/**
 * Subscribes to a chat event; returns the unsubscribe. The
 * subscription is instance-independent: it survives socket
 * replacement and reconnection. Best-effort: a socket that never
 * connects simply never fires.
 */
export function onChatEvent<T>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  let set = subscribers.get(event);
  if (!set) {
    set = new Set();
    subscribers.set(event, set);
  }
  set.add(handler as Handler);
  if (socket) wireEvent(socket, event);
  void ensureChatSocket().catch(() => {
    // Offline / signed out: screens still work over REST.
  });
  return () => {
    set.delete(handler as Handler);
  };
}

/** Fires when the socket reconnects after a drop (not on the first connect). */
export function onChatReconnect(handler: () => void): () => void {
  return onChatEvent(RECONNECT_EVENT, handler as (p: never) => void);
}

export const onChatMessage = (h: (m: ChatMessage & { clientId?: string }) => void) =>
  onChatEvent('chat:message', h);
export const onChatRead = (h: (e: ChatReadEvent) => void) =>
  onChatEvent('chat:read', h);
/** My OWN read, echoed back for my other devices (self-device sync). */
export const onChatReadSync = (h: (e: ChatReadEvent) => void) =>
  onChatEvent('chat:read-sync', h);
export const onChatTyping = (h: (e: ChatTypingEvent) => void) =>
  onChatEvent('chat:typing', h);
export const onChatPresence = (h: (e: ChatPresenceEvent) => void) =>
  onChatEvent('chat:presence', h);
export const onChatRequestAccepted = (
  h: (e: { conversationId: string }) => void,
) => onChatEvent('chat:request-accepted', h);

/** Sends over the socket; resolves with the server ack (never rejects — failures come back as { ok: false }). */
export async function emitChatSend(
  payload: ChatSendEvent,
): Promise<ChatSendAck> {
  try {
    const client = await ensureChatSocket();
    return await client
      .timeout(15000)
      .emitWithAck('chat:send', payload) as ChatSendAck;
  } catch {
    return { ok: false, error: 'Could not send. Check your connection.' };
  }
}

/** Fire-and-forget typing relay. */
export function emitChatTyping(payload: ChatTypingEvent): void {
  if (!socket?.connected) return;
  socket.emit('chat:typing', payload);
}

export function disconnectChatSocket(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  connectPromise = null;
  wiredEvents.clear();
}

/* ------------------------------------------------------------------ */
/* Session keying (deep-analysis fix pass)                             */
/*                                                                     */
/* The chat socket belongs to ONE authenticated user. The auth         */
/* layer reports the current user id here on every session change:     */
/* a change (another account, or null on sign-out / expiry) tears      */
/* the old socket down, so events and sends can never leak across      */
/* accounts; the next ensureChatSocket() builds a fresh socket for     */
/* the new session. Subscriptions survive — they live in the           */
/* module registry, not on the socket instance.                        */
/* ------------------------------------------------------------------ */

let boundUserId: string | null = null;

export function setChatSocketUser(userId: string | null): void {
  if (userId === boundUserId) return;
  boundUserId = userId;
  if (socket) disconnectChatSocket();
}

/** The user id the socket layer is currently keyed to (test seam). */
export function getChatSocketUser(): string | null {
  return boundUserId;
}

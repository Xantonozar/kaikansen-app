import type {
  ChatConversationSummary,
  ChatLastMessage,
  ChatMessage,
  ChatPresenceEvent,
  ChatUserSummary,
} from '@kaikansen/contracts';
import { formatRp, ladderLabel } from './rankUtil';

/**
 * Pure chat helpers (no React, no I/O) — the thread/inbox logic
 * the chat screens share, unit-tested in chatLogic.test.ts:
 * inbox previews + time ladders, the optimistic-send state
 * machine, read-receipt application, and day grouping.
 */

/** Client-side delivery state of one of MY messages. */
export type LocalMessageStatus = 'sending' | 'sent' | 'read' | 'failed';

/** A chat message as held by the thread screen (server shape + local send state). */
export interface LocalMessage extends ChatMessage {
  /** Optimistic-send reconciliation id (echoed by the server on delivery). */
  clientId?: string;
  /** Set only while the message is a local optimistic/failed bubble. */
  localStatus?: LocalMessageStatus;
}

/** Inbox row preview: text verbatim; themes as "♪ Title — Artist" (the mock). */
export function messagePreview(last: ChatLastMessage | null): string {
  if (!last) return '';
  if (last.type === 'theme') {
    const title = last.themeTitle ?? 'Theme';
    return last.themeArtist ? `♪ ${title} — ${last.themeArtist}` : `♪ ${title}`;
  }
  return last.text ?? '';
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The inbox time ladder from the mock: "2m", "1h", "Yesterday",
 * weekday ("Mon") inside a week, then the plain date.
 */
export function formatInboxTime(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff === 0) {
    const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h`;
  }
  if (dayDiff < 7) {
    return then.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return then.toLocaleDateString();
}

/** Day-divider label: "Today", "Yesterday", else the plain date. */
export function dayLabel(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  return then.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: then.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/** "14:02" — the thread's per-group timestamp (24h, local). */
export function timeOfDay(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const hh = String(then.getHours()).padStart(2, '0');
  const mm = String(then.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** "<Rank> · <RP> RP" — the New Chat row's second line. */
export function rankRpLine(person: {
  ladder: ChatUserSummary['ladder'];
  rp: number;
}): string {
  return `${ladderLabel(person.ladder.rank)} · ${formatRp(person.rp)}`;
}

/** Header second line word: the gateway's truthful presence vocabulary. */
export function presenceWord(other: ChatUserSummary): string {
  if (other.online) return 'Online';
  if (other.lastActiveAt) return 'Active recently';
  return 'Offline';
}

/** "<Rank> · Online" — the conversation header's second line. */
export function headerLine(other: ChatUserSummary): string {
  return `${ladderLabel(other.ladder.rank)} · ${presenceWord(other)}`;
}

/**
 * The delivery state to render under one of my messages, or null
 * for the other side's messages (no captions there). A pending
 * local state wins; a server message is 'read' once readAt is set,
 * else 'sent'. Request-state messages never carry readAt (the API
 * withholds it), so they can only ever show 'sent'.
 */
export function deliveryStatus(
  msg: LocalMessage,
  meId: string,
): LocalMessageStatus | null {
  if (msg.senderId !== meId) return null;
  if (msg.localStatus) return msg.localStatus;
  return msg.readAt ? 'read' : 'sent';
}

/** Appends a message (initial load page merge + optimistic sends). */
export function appendLocal(
  list: LocalMessage[],
  msg: LocalMessage,
): LocalMessage[] {
  return [...list, msg];
}

/** Swaps an optimistic bubble for its saved server copy (matched by clientId). */
export function resolveLocal(
  list: LocalMessage[],
  clientId: string,
  server: ChatMessage,
): LocalMessage[] {
  return list.map((m) =>
    m.clientId === clientId ? { ...server, clientId } : m,
  );
}

/** Marks an optimistic bubble as failed (tap-to-retry state). */
export function failLocal(
  list: LocalMessage[],
  clientId: string,
): LocalMessage[] {
  return list.map((m) =>
    m.clientId === clientId ? { ...m, localStatus: 'failed' as const } : m,
  );
}

/** Re-arms a failed bubble for another send attempt (same clientId). */
export function retryLocal(
  list: LocalMessage[],
  clientId: string,
): LocalMessage[] {
  return list.map((m) =>
    m.clientId === clientId ? { ...m, localStatus: 'sending' as const } : m,
  );
}

/**
 * Merges a realtime 'chat:message' delivery: an echo of my own
 * optimistic send (same clientId) resolves that bubble; a message
 * already present (by id) is dropped; anything else appends.
 */
export function applyIncoming(
  list: LocalMessage[],
  incoming: ChatMessage & { clientId?: string },
): LocalMessage[] {
  if (incoming.clientId) {
    const idx = list.findIndex((m) => m.clientId === incoming.clientId);
    if (idx >= 0) {
      const next = [...list];
      next[idx] = { ...incoming, clientId: incoming.clientId };
      return next;
    }
  }
  if (list.some((m) => m.id === incoming.id)) return list;
  return [...list, incoming];
}

/**
 * Applies a 'chat:read' receipt: every message NOT sent by the
 * reader, created at or before the receipt instant and not yet
 * read, gains readAt. (The reader is always the other side, so
 * this marks MY messages read.)
 */
export function applyReadReceipt(
  list: LocalMessage[],
  readerId: string,
  readAt: string,
): LocalMessage[] {
  const at = new Date(readAt).getTime();
  return list.map((m) => {
    if (m.senderId === readerId || m.readAt) return m;
    if (new Date(m.createdAt).getTime() > at) return m;
    return { ...m, readAt };
  });
}

/**
 * Merges a freshly fetched newest page into the held list
 * (reconnect catch-up): server copies win by id, messages the
 * page does not cover (older pages) are kept, and the result is
 * in thread order. Missed messages appear without the user
 * leaving and re-entering the thread.
 */
export function mergeCatchUp(
  list: LocalMessage[],
  page: ChatMessage[],
): LocalMessage[] {
  const byId = new Map<string, LocalMessage>();
  for (const m of list) byId.set(m.id, m);
  for (const m of page) byId.set(m.id, { ...m });
  return [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Patches one inbox row from a realtime 'chat:message' payload
 * instead of refetching the whole list: the row's preview,
 * timestamp and unread count update and the row moves to the
 * top (the list is newest-first). `handled: false` means the
 * conversation is not in the list (brand-new conversation or
 * request) — the caller falls back to a refetch for that case.
 */
export function applyInboxMessage(
  rows: ChatConversationSummary[],
  msg: ChatMessage,
): { rows: ChatConversationSummary[]; handled: boolean; unreadDelta: number } {
  const idx = rows.findIndex((r) => r.id === msg.conversationId);
  if (idx < 0) return { rows, handled: false, unreadDelta: 0 };
  const row = rows[idx];
  const unreadDelta = msg.senderId === row.other.id ? 1 : 0;
  const updated: ChatConversationSummary = {
    ...row,
    lastMessage: {
      id: msg.id,
      type: msg.type,
      text: msg.text,
      themeTitle: msg.theme?.songTitle ?? null,
      themeArtist: msg.theme?.artistName ?? null,
      senderId: msg.senderId,
      createdAt: msg.createdAt,
    },
    updatedAt: msg.createdAt,
    unreadCount: row.unreadCount + unreadDelta,
  };
  return {
    rows: [updated, ...rows.filter((_, i) => i !== idx)],
    handled: true,
    unreadDelta,
  };
}

/** Flips one inbox row's presence dot from a 'chat:presence' payload. */
export function applyInboxPresence(
  rows: ChatConversationSummary[],
  event: ChatPresenceEvent,
): ChatConversationSummary[] {
  if (!rows.some((r) => r.other.id === event.userId)) return rows;
  return rows.map((r) =>
    r.other.id === event.userId
      ? { ...r, other: { ...r.other, online: event.online } }
      : r,
  );
}

/** Marks one inbox row active after a 'chat:request-accepted' payload. */
export function applyInboxAccepted(
  rows: ChatConversationSummary[],
  conversationId: string,
): ChatConversationSummary[] {
  if (!rows.some((r) => r.id === conversationId)) return rows;
  return rows.map((r) =>
    r.id === conversationId ? { ...r, status: 'active' as const } : r,
  );
}

export type ThreadItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'message'; key: string; message: LocalMessage };

/** Flattens messages into render items with a day divider before each new day. */
export function buildThreadItems(
  messages: LocalMessage[],
  now: Date,
): ThreadItem[] {
  const items: ThreadItem[] = [];
  let lastDay = '';
  for (const message of messages) {
    const day = dayLabel(message.createdAt, now);
    if (day !== lastDay) {
      items.push({ type: 'day', key: `day-${day}-${message.id}`, label: day });
      lastDay = day;
    }
    items.push({
      type: 'message',
      key: message.clientId ?? message.id,
      message,
    });
  }
  return items;
}

/** True when this message ends its sender group (timestamp shown under it): last of a run from the same sender. */
export function isGroupEnd(
  messages: LocalMessage[],
  index: number,
): boolean {
  const current = messages[index];
  const next = messages[index + 1];
  if (!next) return true;
  if (next.senderId !== current.senderId) return true;
  // A new day starts a new group too.
  return (
    new Date(next.createdAt).toDateString() !==
    new Date(current.createdAt).toDateString()
  );
}

/**
 * Where a tapped chat push notification leads (deep-analysis fix
 * pass). The API's push data payload is `{ kind, conversationId }`
 * — a message push opens its conversation; a request push opens
 * the requests screen (the request may be one of several, and the
 * requests screen is where Accept lives). Anything unrecognised
 * routes nowhere (null) rather than somewhere wrong. Pure so the
 * mapping is unit-tested; chatPush.ts does the navigating.
 */
export function chatPushRoute(
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data || typeof data !== 'object') return null;
  if (data.kind === 'chat-request') return '/chat/requests';
  if (
    data.kind === 'chat-message' &&
    typeof data.conversationId === 'string' &&
    data.conversationId.length > 0
  ) {
    return `/chat/${data.conversationId}`;
  }
  return null;
}

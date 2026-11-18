import { useEffect, useSyncExternalStore } from 'react';
import { fixtureMode } from './api';
import { getAccessToken } from './session';
import { fetchChatCounts } from './chatApi';
import {
  onChatMessage,
  onChatRead,
  onChatReadSync,
  onChatReconnect,
  onChatRequestAccepted,
} from './chatSocket';

/**
 * Unread-chat count for the Home header's chat button badge —
 * the notificationsStore pattern (module-level state +
 * useSyncExternalStore). The count is the API's totalUnread:
 * unread messages across ACTIVE conversations (requests surface
 * through the inbox's Message-requests row instead, so a stranger's
 * first message never inflates the header). refreshChatUnread
 * refetches it from the lightweight /chat/counts endpoint (never
 * the whole inbox list); the inbox screen also sets it exactly
 * from the list response it already holds. A failed refresh keeps
 * the previous count.
 *
 * LIVE: once the hook is mounted (the app header), the store
 * subscribes to chat socket events and refreshes the count
 * (debounced) — a message arriving while the user sits on Home
 * moves the badge without any navigation.
 */

let unread = 0;
let refreshPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: number): void {
  if (next === unread) return;
  unread = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return unread;
}

export function setChatUnread(count: number): void {
  emit(Math.max(0, count));
}

/** The current badge count (imperative read for lifecycle code + tests). */
export function getChatUnread(): number {
  return unread;
}

/**
 * Session teardown (logout / expiry / account switch): the badge
 * must never carry one account's unread into another's session.
 */
export function resetChatUnread(): void {
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  refreshPromise = null;
  emit(0);
}

export async function refreshChatUnread(): Promise<void> {
  if (fixtureMode || !getAccessToken()) {
    emit(0);
    return;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetchChatCounts();
      emit(res.totalUnread);
    } catch {
      // Keep the last known count.
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

let liveStarted = false;
let liveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLiveRefresh(): void {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    void refreshChatUnread();
  }, 400);
}

/** Starts the socket-driven badge refresh (idempotent). */
export function startChatUnreadLive(): void {
  if (liveStarted || fixtureMode) return;
  liveStarted = true;
  onChatMessage(() => scheduleLiveRefresh());
  onChatRead(() => scheduleLiveRefresh());
  onChatRequestAccepted(() => scheduleLiveRefresh());
  // Self-device read sync: I read on another device → my badge
  // here clears without waiting for the next fetch.
  onChatReadSync(() => scheduleLiveRefresh());
  // Anything missed while the socket was down is caught up on
  // reconnect (the counts endpoint is the source of truth).
  onChatReconnect(() => scheduleLiveRefresh());
}

export function useChatUnread(): number {
  useEffect(() => {
    startChatUnreadLive();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

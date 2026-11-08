import { useSyncExternalStore } from 'react';
import { fixtureMode } from './api';
import { getAccessToken } from './session';
import { fetchNotifications } from './socialApi';

/**
 * Unread-notification count for the header bell badge (Slice M5) —
 * module-level state (the session.ts / favoritesStore.ts pattern)
 * with a useSyncExternalStore binding, so the bell, the drawer row
 * and the notifications screen all read one number.
 *
 * The count is derived from GET /notifications (the caller's 50 most
 * recent). refreshUnreadCount refetches it — the header calls it on
 * mount and on route changes; the notifications screen keeps it
 * exact incrementally via setUnreadCount / decrementUnread as it
 * marks rows read, so no refetch is needed on the way back. A failed
 * refresh keeps the previous count rather than flickering to zero.
 * Signed-out and fixture mode are always zero: there is nobody to
 * notify (fixture mode's client resolves an empty list anyway).
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

export function setUnreadCount(count: number): void {
  emit(Math.max(0, count));
}

export function decrementUnread(by = 1): void {
  emit(Math.max(0, unread - by));
}

export async function refreshUnreadCount(): Promise<void> {
  if (fixtureMode || !getAccessToken()) {
    emit(0);
    return;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetchNotifications();
      emit(res.notifications.filter((n) => !n.read).length);
    } catch {
      // Keep the last known count — a badge is a hint, not an error surface.
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export function useUnreadNotifications(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

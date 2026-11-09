import { useSyncExternalStore } from 'react';
import * as WebBrowser from 'expo-web-browser';

/**
 * The AniList handoff's shared state (DESIGN.md §6.3,
 * layout-fidelity Slice 4). The waiting screen is a route the
 * auth provider pushes while the browser consent is in flight;
 * this module is the small contract between them (same external-
 * store pattern as downloads.ts / favoritesStore.ts):
 *
 * - The provider calls beginAnilistHandoff(intent) and pushes
 *   /anilist-handoff before starting the auth session, then
 *   endAnilistHandoff() when it settles and pops the screen —
 *   but only if the screen is still mounted (screenMounted).
 * - The screen's Cancel calls cancelAnilistHandoff(), which
 *   dismisses the browser auth session for real
 *   (WebBrowser.dismissAuthSession) and marks the flow cancelled;
 *   the provider checks the mark when the flow resolves and
 *   treats a post-cancel resolution as a dismissal, so a link
 *   code is never POSTed after the user cancelled.
 * - If the screen unmounts while a flow is still active (the
 *   user backed out in the window before the browser opened),
 *   the unmount itself marks the flow cancelled.
 *
 * §6.3's other states need no state here: returned-success is the
 * callers' existing success path (the provider pops the handoff
 * and the session lands as before) and returned-failure is the
 * callers' existing inline error + retry (AuthForm's message,
 * Settings'/the drawer's link error).
 */

export type AnilistHandoffIntent = 'login' | 'link';

interface AnilistHandoffState {
  active: boolean;
  intent: AnilistHandoffIntent | null;
  cancelled: boolean;
  screenMounted: boolean;
}

const IDLE: AnilistHandoffState = {
  active: false,
  intent: null,
  cancelled: false,
  screenMounted: false,
};

let state: AnilistHandoffState = IDLE;
const listeners = new Set<() => void>();

function emit(next: Partial<AnilistHandoffState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AnilistHandoffState {
  return state;
}

/**
 * Mark a flow as in flight. Returns false when one is already
 * running — the caller then runs its flow without driving the
 * screen (the first flow owns it).
 */
export function beginAnilistHandoff(intent: AnilistHandoffIntent): boolean {
  if (state.active) return false;
  emit({ active: true, intent, cancelled: false });
  return true;
}

export function endAnilistHandoff(): void {
  emit({ active: false, intent: null });
}

export function anilistHandoffCancelled(): boolean {
  return state.cancelled;
}

export function isAnilistHandoffScreenMounted(): boolean {
  return state.screenMounted;
}

/** The handoff screen registers its mount state here. */
export function setAnilistHandoffScreenMounted(mounted: boolean): void {
  if (!mounted && state.active) {
    // Backed out mid-flow: the flow's resolution is discarded.
    emit({ screenMounted: false, cancelled: true });
    return;
  }
  emit({ screenMounted: mounted });
}

/** The screen's Cancel: dismiss the browser session + mark. */
export function cancelAnilistHandoff(): void {
  emit({ cancelled: true });
  WebBrowser.dismissAuthSession();
}

export function useAnilistHandoff(): AnilistHandoffState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

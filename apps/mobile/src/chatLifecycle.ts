import { AppState } from 'react-native';
import { fixtureMode } from './api';
import { getAccessToken } from './session';
import { ensureChatSocket, setChatSocketUser } from './chatSocket';
import { refreshChatUnread, resetChatUnread } from './chatUnreadStore';
import { hydrateChatOutbox, resetChatOutbox } from './chatOutbox';
import { registerChatPush, unregisterChatPush } from './chatPush';

/**
 * Chat session lifecycle (deep-analysis fix pass) — one place
 * that ties chat's module-level state to the AUTH session:
 *
 *   handleChatSessionUser(userId) runs on EVERY session change
 *   (sign-in, sign-out, expiry, account switch — the AuthProvider
 *   effect keys on the user id, so all of them funnel here):
 *     - user id changed → the chat socket is re-keyed
 *       (setChatSocketUser tears the old account's socket down);
 *     - signed OUT (null) → push token unregistered (while the
 *       session can still authenticate the DELETE), badge reset,
 *       outbox + drafts cleared;
 *     - signed IN → outbox rehydrated from disk, push registered
 *       (silently unless the explicit-sign-in prompt was armed —
 *       see below), badge refreshed.
 *
 *   initChatLifecycle() runs once at provider mount: AppState
 *   'active' (app foregrounded) refreshes the badge counts and
 *   nudges the socket back to health — the multi-device polish
 *   for reads/sends that happened on another device or the web.
 *
 * PERMISSION TIMING: the OS push prompt is only ever shown on an
 * explicit sign-in (login/register/AniList), armed via
 * armChatPushPrompt() immediately before the call. A cold-start
 * session restore registers silently when permission already
 * exists and never prompts.
 */

let pushPromptArmed = false;

/** Arms the one-shot push-permission prompt for an explicit sign-in. */
export function armChatPushPrompt(): void {
  pushPromptArmed = true;
}

export async function handleChatSessionUser(
  userId: string | null,
): Promise<void> {
  setChatSocketUser(userId);
  if (fixtureMode) return;
  if (!userId) {
    pushPromptArmed = false;
    // Best-effort: the explicit logout path unregisters while
    // the access token is still valid (auth.tsx); on the expiry
    // path the token is already gone and the row dies later via
    // Expo's DeviceNotRegistered cleanup.
    void unregisterChatPush();
    resetChatUnread();
    resetChatOutbox();
    return;
  }
  const prompt = pushPromptArmed;
  pushPromptArmed = false;
  await hydrateChatOutbox();
  void registerChatPush({ prompt });
  void refreshChatUnread();
}

let lifecycleStarted = false;

/** AppState foreground refresh + socket health nudge (provider mount, once). */
export function initChatLifecycle(): void {
  if (lifecycleStarted || fixtureMode) return;
  lifecycleStarted = true;
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    if (!getAccessToken()) return;
    void refreshChatUnread();
    // Reconnect/health nudge: ensure resolves immediately when
    // the socket is already connected.
    void ensureChatSocket().catch(() => undefined);
  });
}

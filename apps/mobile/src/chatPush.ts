import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { fixtureMode } from './api';
import { registerPushToken, unregisterPushToken } from './chatApi';
import { chatPushRoute } from './chatLogic';
import { plainStorage } from './storage';

/**
 * Chat push notifications (deep-analysis fix pass) — the mobile
 * half. The API owns the sending (generic, body-free payloads);
 * this module owns the device side:
 *
 *   - registerChatPush: permission (asked in context — see
 *     chatLifecycle's armChatPushPrompt: the prompt fires on an
 *     explicit sign-in, never cold at app start; a session
 *     RESTORE with permission already granted registers
 *     silently), Expo push token → POST /chat/push-token.
 *   - unregisterChatPush: DELETE on logout, best-effort BEFORE
 *     the session tokens are dropped.
 *   - Taps route through chatPushRoute (chatLogic): a message
 *     push opens its conversation; a request push opens the
 *     requests screen.
 *   - Foreground pushes show NO banner: the chat socket is the
 *     foreground surface (the thread/inbox update live); a
 *     banner on top of the open thread would double-report.
 *
 * Real delivery needs an EAS/FCM-configured build (the push
 * credentials live outside the repo); every failure here is
 * swallowed by design — chat must work fully without push.
 */

const TOKEN_KEY = 'kaikansen.chatPushToken';
/** Must match the API's CHAT_PUSH_CHANNEL_ID. */
const CHANNEL_ID = 'chat-messages';

let currentToken: string | null = null;
let handlerInstalled = false;

function installForegroundHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Chat messages',
      importance: Notifications.AndroidImportance.HIGH,
    });
  } catch {
    // Channel creation is cosmetic; delivery still works.
  }
}

/**
 * Registers this device for chat pushes. `prompt: true` may ask
 * for permission (explicit sign-in only); otherwise registration
 * proceeds only when permission was already granted. Returns the
 * registered token, or null when push stays off.
 */
export async function registerChatPush(options: {
  prompt: boolean;
}): Promise<string | null> {
  if (fixtureMode || Platform.OS === 'web') return null;
  installForegroundHandler();
  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted' && options.prompt) {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return null;
    await ensureAndroidChannel();
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = tokenResponse.data;
    if (!token) return null;
    await registerPushToken(token);
    currentToken = token;
    await plainStorage.set(TOKEN_KEY, token).catch(() => undefined);
    return token;
  } catch {
    return null;
  }
}

/** Unregisters this device (logout). Best-effort; never throws. */
export async function unregisterChatPush(): Promise<void> {
  try {
    const token =
      currentToken ?? (await plainStorage.get(TOKEN_KEY).catch(() => null));
    if (token) await unregisterPushToken(token);
  } catch {
    // The token row also dies server-side on DeviceNotRegistered;
    // a failed unregister must never block sign-out.
  }
  currentToken = null;
  await plainStorage.remove(TOKEN_KEY).catch(() => undefined);
}

function routeFromResponse(
  response: Notifications.NotificationResponse | null,
): void {
  if (!response) return;
  const data = response.notification.request.content.data as
    | Record<string, unknown>
    | undefined;
  const route = chatPushRoute(data);
  if (route) router.push(route as never);
}

/**
 * Tap routing (root layout): handles both the tap that LAUNCHED
 * the app (cold start) and taps while it runs.
 */
export function useChatPushTapRouting(): void {
  useEffect(() => {
    if (fixtureMode || Platform.OS === 'web') return;
    installForegroundHandler();
    let cancelled = false;
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!cancelled) routeFromResponse(response);
    });
    const subscription =
      Notifications.addNotificationResponseReceivedListener(routeFromResponse);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);
}

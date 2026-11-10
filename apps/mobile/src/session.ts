/**
 * In-memory session plumbing shared by the API client (api.ts) and the
 * AuthProvider (auth.tsx).
 *
 * The ACCESS token lives only here, in memory — never persisted. The
 * REFRESH token lives in secure storage (storage.ts); the AuthProvider
 * owns it and registers the routine that exchanges it for a fresh pair,
 * so api.ts can silently refresh once on a 401 without importing React
 * or the auth screens.
 */

let accessToken: string | null = null;
let refreshHandler: (() => Promise<string | null>) | null = null;
let expiredHandler: (() => void) | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/* ------------------------------------------------------------------ */
/* Cache scope (perf problem 5)                                        */
/*                                                                     */
/* The response cache (apiCache.ts) keys entries by the session's      */
/* user id so one account is never served another's data. The id is    */
/* registered here by the AuthProvider — the same plumbing pattern     */
/* as the refresh handler above — because apiCache must not import     */
/* React or the auth screens. When the id CHANGES (a login as a        */
/* different account, or a sign-out), the registered listener clears   */
/* the whole cache: the previous scope's entries are unreachable.      */
/* ------------------------------------------------------------------ */

let sessionUserId: string | null = null;
let userScopeListener: ((userId: string | null) => void) | null = null;

/** The cache scope: the signed-in user id, or 'anon' signed out. */
export function getSessionScope(): string {
  return sessionUserId ?? 'anon';
}

export function setSessionUserId(userId: string | null): void {
  if (userId === sessionUserId) return;
  sessionUserId = userId;
  userScopeListener?.(userId);
}

export function registerUserScopeListener(
  listener: ((userId: string | null) => void) | null,
): void {
  userScopeListener = listener;
}

export function registerRefreshHandler(
  handler: (() => Promise<string | null>) | null,
): void {
  refreshHandler = handler;
}

export function registerSessionExpiredHandler(
  handler: (() => void) | null,
): void {
  expiredHandler = handler;
}

/** Runs the provider's refresh routine; null when it cannot refresh. */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshHandler) return null;
  try {
    return await refreshHandler();
  } catch {
    return null;
  }
}

/** Called when a refresh attempt failed: drop the token, tell the provider. */
export function notifySessionExpired(): void {
  accessToken = null;
  expiredHandler?.();
}

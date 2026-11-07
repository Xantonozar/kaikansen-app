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

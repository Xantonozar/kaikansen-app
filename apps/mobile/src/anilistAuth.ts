import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import type { AuthTokens } from '@kaikansen/contracts';

/**
 * Native AniList OAuth round-trip (live mode only).
 *
 * The API owns the OAuth exchange: the app asks it for an authorize
 * URL (authApi.fetchAnilistAuthorizeUrl), opens that URL in an
 * expo-web-browser auth session, and AniList lands on the API's GET
 * /auth/anilist/callback, which 302s back into the app at
 * kaikansen://auth with the outcome in the URL FRAGMENT:
 *
 * - state login/absent → #accessToken=…&refreshToken=…&userId=…
 * - state=link         → #code=…&state=link (nothing exchanged; the
 *   signed-in app POSTs the code to /auth/anilist/link itself)
 * - any failure        → #error=auth_failed | exchange_failed | internal_error
 *
 * Native only: on web there is no auth-session redirect back into a
 * custom scheme, so callers keep the placeholder behaviour there
 * (and in fixture mode, where no API exists at all).
 */

/** The redirect the auth session listens for — the app scheme + /auth. */
export const ANILIST_REDIRECT_URL = 'kaikansen://auth';

/** The user closed the auth session before AniList answered. */
export class AnilistDismissedError extends Error {
  constructor() {
    super('AniList was cancelled before it finished.');
    this.name = 'AnilistDismissedError';
  }
}

/** AniList (or the API callback) reported a failure in the fragment. */
export class AnilistFlowError extends Error {
  /** The API's fragment error code, when one was supplied. */
  readonly code: string | null;

  constructor(code: string | null) {
    super('AniList sign-in failed. Please try again.');
    this.name = 'AnilistFlowError';
    this.code = code;
  }
}

export type AnilistRedirect =
  | { kind: 'tokens'; tokens: AuthTokens }
  | { kind: 'code'; code: string };

/** Parse the fragment of the URL the auth session returned with. */
export function parseAnilistRedirect(url: string): AnilistRedirect {
  const hashIndex = url.indexOf('#');
  const params = new URLSearchParams(
    hashIndex >= 0 ? url.slice(hashIndex + 1) : '',
  );

  const error = params.get('error');
  if (error) throw new AnilistFlowError(error);

  const code = params.get('code');
  if (code) return { kind: 'code', code };

  const accessToken = params.get('accessToken');
  const refreshToken = params.get('refreshToken');
  if (accessToken && refreshToken) {
    return { kind: 'tokens', tokens: { accessToken, refreshToken } };
  }

  // A success redirect with neither a code nor a token pair is not
  // something the API should ever send — treat it as a failed flow
  // rather than half-establishing a session.
  throw new AnilistFlowError(null);
}

/**
 * Open the authorize URL in an auth session and parse what comes
 * back. Throws AnilistDismissedError when the user bails out and
 * AnilistFlowError when the redirect carries an error. Must not be
 * called on web (guarded here as well as at the call sites).
 */
export async function openAnilistFlow(
  authorizeUrl: string,
): Promise<AnilistRedirect> {
  if (Platform.OS === 'web') {
    throw new AnilistFlowError(null);
  }
  const result = await WebBrowser.openAuthSessionAsync(
    authorizeUrl,
    ANILIST_REDIRECT_URL,
  );
  if (result.type !== 'success') {
    // 'cancel' | 'dismiss' | 'locked' — no redirect came back.
    throw new AnilistDismissedError();
  }
  return parseAnilistRedirect(result.url);
}

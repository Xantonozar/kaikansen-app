import type {
  AnilistLinkRequest,
  AnilistLinkResponse,
  AnilistUrlResponse,
  AuthResponse,
  AuthTokens,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  UserProfile,
} from '@kaikansen/contracts';
import { apiBaseUrl } from './api';

/**
 * Plain-fetch client for the API's /auth endpoints (Slice 2). These
 * calls deliberately do NOT go through api.ts's authenticated fetch:
 * register/login/refresh are how a session is created, and refresh is
 * what the 401-retry path itself calls — routing it through the retry
 * would recurse. Error bodies are the API's ApiErrorResponse; the
 * server message (the web-parity string) is surfaced verbatim.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (
      body !== null &&
      typeof body === 'object' &&
      'message' in body &&
      typeof (body as { message: unknown }).message === 'string'
    ) {
      message = (body as { message: string }).message;
    }
  } catch {
    // Non-JSON error body — keep the generic message.
  }
  return new ApiError(res.status, message);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export function registerAccount(body: RegisterRequest): Promise<AuthResponse> {
  return postJson<AuthResponse>('/auth/register', body);
}

export function loginAccount(body: LoginRequest): Promise<AuthResponse> {
  return postJson<AuthResponse>('/auth/login', body);
}

export function refreshTokens(refreshToken: string): Promise<AuthTokens> {
  const body: RefreshRequest = { refreshToken };
  return postJson<AuthTokens>('/auth/refresh', body);
}

export async function fetchMe(accessToken: string): Promise<UserProfile> {
  const res = await fetch(`${apiBaseUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as UserProfile;
}

/* ------------------------------------------------------------------ */
/* AniList OAuth                                                       */
/* ------------------------------------------------------------------ */

/**
 * The AniList authorize URL to open in an auth-session browser.
 * `state` is forwarded verbatim by the API into the authorize URL and
 * echoed back by AniList to the API's GET callback, where it switches
 * the redirect home: `login` comes back with session tokens, `link`
 * comes back with the raw authorization code (see anilistAuth.ts).
 */
export async function fetchAnilistAuthorizeUrl(
  state: 'login' | 'link',
): Promise<string> {
  const res = await fetch(
    `${apiBaseUrl}/auth/anilist/url?state=${state}`,
  );
  if (!res.ok) throw await toApiError(res);
  const body = (await res.json()) as AnilistUrlResponse;
  return body.url;
}

/**
 * Link an AniList account to the signed-in user. The authorization
 * code comes from the state=link redirect; the call itself carries
 * the caller's access token, which is what binds the AniList account
 * to THIS Kaikansen account. Answers 409 (ApiError.status) when the
 * AniList account already belongs to a different user.
 */
export async function linkAnilistAccount(
  code: string,
  accessToken: string,
): Promise<AnilistLinkResponse> {
  const body: AnilistLinkRequest = { code };
  const res = await fetch(`${apiBaseUrl}/auth/anilist/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as AnilistLinkResponse;
}

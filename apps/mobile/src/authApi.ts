import type {
  AnilistLinkRequest,
  AnilistLinkResponse,
  AnilistUrlResponse,
  AuthResponse,
  AuthTokens,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  ResetPasswordRequest,
  ResetPasswordResponse,
  UserProfile,
} from '@kaikansen/contracts';
import { apiBaseUrl, fetchWithDeadline, REQUEST_DEADLINE_MS } from './api';

/**
 * Plain-fetch client for the API's /auth endpoints (Slice 2). These
 * calls deliberately do NOT go through api.ts's authenticated fetch:
 * register/login/refresh are how a session is created, and refresh is
 * what the 401-retry path itself calls — routing it through the retry
 * would recurse. Error bodies are the API's ApiErrorResponse; the
 * server message (the web-parity string) is surfaced verbatim.
 *
 * Perf problem 13B: every call here rides api.ts's fetchWithDeadline
 * at the LONG class — these are the calls that legitimately ride a
 * waking server (boot-time session restore = refresh + /auth/me)
 * and the refresh inside apiFetch's 401 retry gets its own clock
 * here, separate from either attempt's.
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
  const res = await fetchWithDeadline(
    `${apiBaseUrl}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    REQUEST_DEADLINE_MS.LONG,
  );
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

/**
 * Server-side logout (POST /auth/logout): revokes the caller's
 * refresh sessions on the API, so the stored refresh token dies
 * everywhere. The auth provider calls this BEST-EFFORT before
 * clearing the local session — a network failure must never trap
 * the user in a half-logged-in state, so callers swallow errors.
 */
export async function logoutSession(accessToken: string): Promise<void> {
  const res = await fetchWithDeadline(
    `${apiBaseUrl}/auth/logout`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    REQUEST_DEADLINE_MS.LONG,
  );
  if (!res.ok) throw await toApiError(res);
}

/* ------------------------------------------------------------------ */
/* Password reset (code-based — a new API capability)                  */
/* ------------------------------------------------------------------ */

/**
 * Starts a password reset. The API answers the same generic 200
 * whether or not the account exists, so a resolution here only
 * means "the request was accepted" — never that an email went to
 * a real account. Only call in live mode: demo mode has no API and
 * cannot send email (the screen says so instead of calling this).
 */
export function requestPasswordReset(
  body: ForgotPasswordRequest,
): Promise<ForgotPasswordResponse> {
  return postJson<ForgotPasswordResponse>('/auth/forgot-password', body);
}

/**
 * Completes a password reset with the emailed 6-digit code.
 * Rejects with an ApiError (400) carrying the API's generic
 * invalid/expired-code message on any code failure.
 */
export function resetPasswordWithCode(
  body: ResetPasswordRequest,
): Promise<ResetPasswordResponse> {
  return postJson<ResetPasswordResponse>('/auth/reset-password', body);
}

export async function fetchMe(accessToken: string): Promise<UserProfile> {
  const res = await fetchWithDeadline(
    `${apiBaseUrl}/auth/me`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    REQUEST_DEADLINE_MS.LONG,
  );
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
  const res = await fetchWithDeadline(
    `${apiBaseUrl}/auth/anilist/url?state=${state}`,
    undefined,
    REQUEST_DEADLINE_MS.LONG,
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
  const res = await fetchWithDeadline(
    `${apiBaseUrl}/auth/anilist/link`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    },
    REQUEST_DEADLINE_MS.LONG,
  );
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as AnilistLinkResponse;
}

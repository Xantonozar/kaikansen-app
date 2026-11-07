import type {
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

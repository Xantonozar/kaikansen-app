import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  UserProfile,
} from '@kaikansen/contracts';
import { plainStorage } from './storage';

/**
 * Fixture-mode auth (Slice 2): when no API is configured
 * (EXPO_PUBLIC_API_URL unset) there is nothing to authenticate against,
 * so auth runs against a clearly-labelled LOCAL DEMO account stored in
 * AsyncStorage on this device only. It exists so the auth UI can be
 * exercised end to end; the screens label it as demo mode, the tokens
 * are obvious fakes, and no network call is ever made. The moment an
 * API URL is configured, none of this is used.
 */

const ACCOUNT_KEY = 'kaikansen.demoAccount.v1';

export const DEMO_ACCESS_TOKEN = 'demo-access-token';
export const DEMO_REFRESH_TOKEN = 'demo-refresh-token';

interface DemoAccount {
  username: string;
  email: string;
  /** Stored in plain local storage BY DESIGN — a device-local demo, not a credential. */
  password: string;
  profile: UserProfile;
}

async function loadAccount(): Promise<DemoAccount | null> {
  const raw = await plainStorage.get(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DemoAccount;
  } catch {
    return null;
  }
}

function demoSession(profile: UserProfile): AuthResponse {
  return {
    accessToken: DEMO_ACCESS_TOKEN,
    refreshToken: DEMO_REFRESH_TOKEN,
    user: profile,
  };
}

export async function demoRegister(
  input: RegisterRequest,
): Promise<AuthResponse> {
  const username = input.username.toLowerCase();
  const email = input.email.toLowerCase();
  const existing = await loadAccount();
  if (existing && (existing.email === email || existing.username === username)) {
    // Same message the API (and web) answers a duplicate with.
    throw new Error('User already exists');
  }
  const profile: UserProfile = {
    id: 'demo-user',
    username,
    displayName: input.displayName?.trim() || input.username,
    email,
    avatarUrl:
      'https://api.dicebear.com/7.x/adventurer/svg?seed=Lucky&backgroundColor=b6e3f4',
    bio: '',
    totalRatings: 0,
    totalFollowers: 0,
    totalFollowing: 0,
    isPublic: true,
  };
  const account: DemoAccount = {
    username,
    email,
    password: input.password,
    profile,
  };
  await plainStorage.set(ACCOUNT_KEY, JSON.stringify(account));
  return demoSession(profile);
}

export async function demoLogin(input: LoginRequest): Promise<AuthResponse> {
  const account = await loadAccount();
  if (
    !account ||
    account.email !== input.email.toLowerCase() ||
    account.password !== input.password
  ) {
    // Same message the API (and web) answers bad credentials with.
    throw new Error('Invalid credentials');
  }
  return demoSession(account.profile);
}

/** The demo profile, for restoring a demo session on app start. */
export async function demoProfile(): Promise<UserProfile | null> {
  const account = await loadAccount();
  return account?.profile ?? null;
}

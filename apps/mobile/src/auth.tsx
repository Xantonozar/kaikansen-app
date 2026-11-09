import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import type {
  AuthResponse,
  RegisterRequest,
  UserProfile,
} from '@kaikansen/contracts';
import { fixtureMode } from './api';
import {
  ApiError,
  fetchAnilistAuthorizeUrl,
  fetchMe,
  linkAnilistAccount,
  loginAccount,
  refreshTokens,
  registerAccount,
} from './authApi';
import {
  AnilistDismissedError,
  AnilistFlowError,
  openAnilistFlow,
  type AnilistRedirect,
} from './anilistAuth';
import {
  anilistHandoffCancelled,
  beginAnilistHandoff,
  endAnilistHandoff,
  isAnilistHandoffScreenMounted,
  type AnilistHandoffIntent,
} from './anilistHandoff';
import {
  DEMO_ACCESS_TOKEN,
  DEMO_REFRESH_TOKEN,
  demoLogin,
  demoProfile,
  demoRegister,
} from './demoAuth';
import {
  getAccessToken,
  registerRefreshHandler,
  registerSessionExpiredHandler,
  setAccessToken,
} from './session';
import { secureGet, secureRemove, secureSet } from './storage';

/**
 * Session state for the app (Slice 2).
 *
 * - The refresh token is the only persisted credential; it lives in
 *   secure storage (storage.ts). The access token is memory-only
 *   (session.ts) and attached to API calls by api.ts.
 * - On start, a stored refresh token is exchanged for a fresh pair
 *   (the API rotates) and /auth/me restores the profile. Any failure
 *   lands signed-out, with the stored token dropped.
 * - On a 401 mid-session, api.ts asks the registered handler here for
 *   one silent refresh; if that fails the provider is told the session
 *   expired and signs out.
 * - In fixture mode (no API configured) everything runs against the
 *   local demo store instead (demoAuth.ts) and `demoMode` is true so
 *   the UI can label it honestly.
 */

const REFRESH_KEY = 'kaikansen.refreshToken';

/**
 * Run one AniList browser round-trip behind the §6.3 handoff
 * screen (Slice 4): the waiting route is pushed before the auth
 * session opens and popped when it settles, and a cancel on that
 * screen (or backing out of it) turns whatever the browser
 * eventually answers into a dismissal — the result is discarded
 * BEFORE any token is stored or any link code is POSTed. Web
 * never reaches here (the callers keep the placeholder there),
 * and a second concurrent flow runs bare: the first owns the
 * screen. See src/anilistHandoff.ts for the state contract.
 */
async function withAnilistHandoff(
  intent: AnilistHandoffIntent,
  run: () => Promise<AnilistRedirect>,
): Promise<AnilistRedirect> {
  if (Platform.OS === 'web') return run();
  const began = beginAnilistHandoff(intent);
  if (began) router.push('/anilist-handoff');
  try {
    if (began && anilistHandoffCancelled()) {
      throw new AnilistDismissedError();
    }
    const result = await run();
    if (began && anilistHandoffCancelled()) {
      throw new AnilistDismissedError();
    }
    return result;
  } finally {
    if (began) {
      endAnilistHandoff();
      if (isAnilistHandoffScreenMounted()) router.back();
    }
  }
}

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: AuthStatus;
  user: UserProfile | null;
  demoMode: boolean;
  /**
   * AniList username linked to the current account, when known.
   * Session-local only: GET /auth/me does not expose the linked
   * AniList account, so this is set by a successful link in this
   * session and is null again after an app restart (the link itself
   * persists server-side regardless).
   */
  anilistUsername: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  /** Live mode, native only — the full AniList OAuth round-trip. */
  loginWithAnilist: () => Promise<void>;
  /** Live mode, native only — resolves with the linked AniList username. */
  linkAnilist: () => Promise<string>;
  logout: () => Promise<void>;
  /**
   * Replace the session profile with a fresher copy (Slice M5 — the
   * Settings profile edit saves through PATCH /auth/me and hands the
   * response here, so the header, drawer and Settings reflect the
   * new name/avatar without a re-login).
   */
  updateUser: (profile: UserProfile) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [anilistUsername, setAnilistUsername] = useState<string | null>(null);
  const refreshTokenRef = useRef<string | null>(null);

  const applySession = useCallback(async (res: AuthResponse) => {
    refreshTokenRef.current = res.refreshToken;
    setAccessToken(res.accessToken);
    await secureSet(REFRESH_KEY, res.refreshToken);
    setUser(res.user);
    setStatus('signedIn');
  }, []);

  const clearSession = useCallback(async () => {
    refreshTokenRef.current = null;
    setAccessToken(null);
    await secureRemove(REFRESH_KEY);
    setUser(null);
    setAnilistUsername(null);
    setStatus('signedOut');
  }, []);

  /** Exchange the stored refresh token for a fresh pair (rotation-aware). */
  const doRefresh = useCallback(async (): Promise<string | null> => {
    const stored = refreshTokenRef.current ?? (await secureGet(REFRESH_KEY));
    if (!stored) return null;
    if (fixtureMode) {
      // Demo sessions never expire server-side (there is no server):
      // the demo marker simply re-issues the demo access token.
      if (stored !== DEMO_REFRESH_TOKEN) return null;
      refreshTokenRef.current = stored;
      setAccessToken(DEMO_ACCESS_TOKEN);
      return DEMO_ACCESS_TOKEN;
    }
    try {
      const pair = await refreshTokens(stored);
      refreshTokenRef.current = pair.refreshToken;
      setAccessToken(pair.accessToken);
      await secureSet(REFRESH_KEY, pair.refreshToken);
      return pair.accessToken;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    registerRefreshHandler(doRefresh);
    registerSessionExpiredHandler(() => {
      void clearSession();
    });
    return () => {
      registerRefreshHandler(null);
      registerSessionExpiredHandler(null);
    };
  }, [doRefresh, clearSession]);

  /* Restore the session once on mount. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await secureGet(REFRESH_KEY);
      if (cancelled) return;
      if (!stored) {
        setStatus('signedOut');
        return;
      }
      refreshTokenRef.current = stored;
      if (fixtureMode) {
        const profile =
          stored === DEMO_REFRESH_TOKEN ? await demoProfile() : null;
        if (cancelled) return;
        if (profile) {
          setAccessToken(DEMO_ACCESS_TOKEN);
          setUser(profile);
          setStatus('signedIn');
        } else {
          await secureRemove(REFRESH_KEY);
          setStatus('signedOut');
        }
        return;
      }
      const fresh = await doRefresh();
      if (cancelled) return;
      if (fresh) {
        try {
          const profile = await fetchMe(fresh);
          if (cancelled) return;
          setUser(profile);
          setStatus('signedIn');
          return;
        } catch {
          // Fall through to a clean sign-out.
        }
      }
      if (!cancelled) await clearSession();
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: doRefresh/clearSession are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = fixtureMode
        ? await demoLogin({ email, password })
        : await loginAccount({ email, password });
      await applySession(res);
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterRequest) => {
      const res = fixtureMode
        ? await demoRegister(input)
        : await registerAccount(input);
      await applySession(res);
    },
    [applySession],
  );

  /**
   * AniList login (live mode, native): the API's GET callback answers
   * the auth session with a token pair but no profile, so the session
   * is established through the same pieces the password flow and the
   * start-up restore use — refresh token into secure storage, access
   * token into memory (session.ts), profile hydrated via /auth/me.
   */
  const loginWithAnilist = useCallback(async () => {
    const authorizeUrl = await fetchAnilistAuthorizeUrl('login');
    const result = await withAnilistHandoff('login', () =>
      openAnilistFlow(authorizeUrl),
    );
    if (result.kind !== 'tokens') {
      throw new AnilistFlowError(null);
    }
    refreshTokenRef.current = result.tokens.refreshToken;
    setAccessToken(result.tokens.accessToken);
    await secureSet(REFRESH_KEY, result.tokens.refreshToken);
    try {
      const profile = await fetchMe(result.tokens.accessToken);
      setUser(profile);
      setStatus('signedIn');
    } catch {
      await clearSession();
      throw new Error('AniList sign-in failed. Please try again.');
    }
  }, [clearSession]);

  /**
   * AniList linking (live mode, native, signed-in): with state=link
   * the redirect home carries the authorization code instead of
   * tokens; the code is POSTed to /auth/anilist/link with the current
   * access token, which is what binds the link to this account.
   * Resolves with the linked AniList username.
   */
  const linkAnilist = useCallback(async (): Promise<string> => {
    const token = getAccessToken();
    if (!token) {
      throw new Error('Your session has expired. Please log in again.');
    }
    let code: string;
    try {
      const authorizeUrl = await fetchAnilistAuthorizeUrl('link');
      const result = await withAnilistHandoff('link', () =>
        openAnilistFlow(authorizeUrl),
      );
      if (result.kind !== 'code') throw new AnilistFlowError(null);
      code = result.code;
    } catch (e: unknown) {
      if (e instanceof AnilistDismissedError) {
        throw new Error('AniList linking was cancelled.');
      }
      if (e instanceof AnilistFlowError) {
        throw new Error('AniList linking failed. Please try again.');
      }
      throw e;
    }
    try {
      const res = await linkAnilistAccount(code, token);
      setAnilistUsername(res.anilist.username);
      return res.anilist.username;
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409) {
        throw new Error(
          'That AniList account is already linked to a different Kaikansen account.',
        );
      }
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    await clearSession();
  }, [clearSession]);

  const updateUser = useCallback((profile: UserProfile) => {
    setUser(profile);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      demoMode: fixtureMode,
      anilistUsername,
      login,
      register,
      loginWithAnilist,
      linkAnilist,
      logout,
      updateUser,
    }),
    [
      status,
      user,
      anilistUsername,
      login,
      register,
      loginWithAnilist,
      linkAnilist,
      logout,
      updateUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

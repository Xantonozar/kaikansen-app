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
import type {
  AuthResponse,
  RegisterRequest,
  UserProfile,
} from '@kaikansen/contracts';
import { fixtureMode } from './api';
import { fetchMe, loginAccount, refreshTokens, registerAccount } from './authApi';
import {
  DEMO_ACCESS_TOKEN,
  DEMO_REFRESH_TOKEN,
  demoLogin,
  demoProfile,
  demoRegister,
} from './demoAuth';
import {
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

type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: AuthStatus;
  user: UserProfile | null;
  demoMode: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserProfile | null>(null);
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

  const logout = useCallback(async () => {
    await clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, demoMode: fixtureMode, login, register, logout }),
    [status, user, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

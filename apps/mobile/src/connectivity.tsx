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
import NetInfo from './netInfo';
import { connectivityFromSample, type ConnectivityStatus } from './offline';

/**
 * Connectivity (offline screen, owner-approved design 2026-11-11) —
 * the app's first connectivity detection, and the gate's inputs.
 *
 * PROVIDER SHAPE: `ConnectivityProvider` sits in the root layout
 * INSIDE the playback provider (it reads the session for the
 * never-interrupt-playback rule) and OUTSIDE the navigators, so
 * every surface — including the signed-in cold start, where the
 * auth restore itself is stuck behind a dead network — is covered
 * by one subscription. Detection is NetInfo's event stream folded
 * through the pure `connectivityFromSample` (offline.ts): only
 * `isConnected === false` is offline; `null` samples never move
 * the state, so the first paint (status `unknown`) can never flash
 * the takeover.
 *
 * "CAN SERVE": surfaces declare servability through
 * `useServableSurface(servable)` — a screen whose problem-5 cache
 * read painted real content (Home's `wasCacheServed` posture) or
 * whose data is device-local claims it while mounted and releases
 * on blur/unmount. The gate folds the claims with two structural
 * signals it reads itself: the device-local routes below, and the
 * playback session — an active session (downloaded/local media
 * above all) makes ANY surface servable, so playback is never
 * interrupted (spec §3). A surface that claims nothing is cold:
 * launch/restore offline, or a cold network screen with nothing
 * cached — the takeover case.
 *
 * RETRY: `retry()` re-checks connectivity with NetInfo.fetch()
 * (spec §5) and folds the sample in; if the device is back, the
 * status flips and the gate dismisses itself — the blocked surface
 * underneath never unmounted, so its own focus/load machinery
 * re-runs its load as connectivity returns. If still offline,
 * nothing changes and no error text appears anywhere.
 */

/**
 * Routes that serve entirely from the device — no network read is
 * on their critical path, so the takeover never covers them.
 * (Downloads is additionally an exempt ROUTE in offline.ts: it is
 * the takeover's destination. The player route serves the local
 * session/downloads queue; Library renders its device-local
 * segments — Offline above all — from the downloads store;
 * Settings is local preferences.)
 */
const LOCAL_SERVABLE_ROUTES: ReadonlySet<string> = new Set([
  '/downloads',
  '/library',
  '/settings',
  '/player',
]);

export function isLocalServableRoute(pathname: string): boolean {
  return LOCAL_SERVABLE_ROUTES.has(pathname);
}

interface ConnectivityContextValue {
  status: ConnectivityStatus;
  /** Servability claims registry (see useServableSurface). */
  claimServable: (id: symbol, servable: boolean) => void;
  releaseServable: (id: symbol) => void;
  /** The live claim set, folded by the gate. */
  claims: ReadonlyMap<symbol, boolean>;
  /** Spec §5: re-check connectivity now (NetInfo.fetch). */
  retry: () => Promise<void>;
}

const ConnectivityContext = createContext<ConnectivityContextValue | null>(
  null,
);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectivityStatus>('unknown');
  const statusRef = useRef(status);
  statusRef.current = status;
  const [claims, setClaims] = useState<ReadonlyMap<symbol, boolean>>(
    () => new Map(),
  );

  useEffect(
    () =>
      NetInfo.addEventListener((state) => {
        setStatus((prev) => connectivityFromSample(prev, state.isConnected));
      }),
    [],
  );

  const retry = useCallback(async () => {
    try {
      const state = await NetInfo.fetch();
      setStatus((prev) => connectivityFromSample(prev, state.isConnected));
    } catch {
      // A failed re-check settles nothing — the posture stands
      // (still offline stays offline; no error surfaces anywhere).
    }
  }, []);

  const claimServable = useCallback((id: symbol, servable: boolean) => {
    setClaims((prev) => {
      if (prev.get(id) === servable) return prev;
      const next = new Map(prev);
      next.set(id, servable);
      return next;
    });
  }, []);

  const releaseServable = useCallback((id: symbol) => {
    setClaims((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo<ConnectivityContextValue>(
    () => ({ status, claimServable, releaseServable, claims, retry }),
    [status, claimServable, releaseServable, claims, retry],
  );

  return (
    <ConnectivityContext.Provider value={value}>
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivity(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) {
    throw new Error('useConnectivity must be used within ConnectivityProvider');
  }
  return ctx;
}

/**
 * Declare that the calling surface can serve the user offline.
 * Screens call this with their live servability (e.g. Home passes
 * its cache-served flag): the claim holds while the screen is
 * FOCUSED (expo-router's useFocusEffect pattern — call from inside
 * a useFocusEffect callback) and is released on blur/unmount, so a
 * claim never outlives the surface that made it.
 */
export function useServableClaim(): {
  claim: (servable: boolean) => void;
  release: () => void;
} {
  const { claimServable, releaseServable } = useConnectivity();
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol('servable-claim');
  const id = idRef.current;
  const claim = useCallback(
    (servable: boolean) => claimServable(id, servable),
    [claimServable, id],
  );
  const release = useCallback(() => releaseServable(id), [releaseServable, id]);
  return { claim, release };
}

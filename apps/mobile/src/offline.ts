/**
 * Offline decision logic (offline screen, owner-approved design
 * 2026-11-11) — the PURE half of the connectivity feature. The
 * impure half (src/connectivity.tsx) owns the NetInfo subscription
 * and this module's numbers; everything decidable lives here and
 * unit-tests directly (offline.test.ts), the repo convention.
 *
 * State vocabulary:
 * - `unknown` — no definitive NetInfo event yet (the first paint,
 *   or every event so far carried `isConnected: null`). The
 *   takeover must NEVER show from `unknown` — no first-paint flash
 *   (spec §4).
 * - `online` / `offline` — definitive. Offline ⟺ the sample's
 *   `isConnected === false` OR its `isInternetReachable === false`
 *   (fix batch 2026-11-11: reachability closes the captive-portal
 *   blind spot — connected to Wi-Fi whose internet is dead or
 *   gated is offline). A sample signals online when its
 *   `isConnected === true` and its reachability is not `false`.
 *   `null` (unknown) on either leg NEVER moves state by itself —
 *   the same conservatism as before: no first-paint flash, no
 *   false takeovers, no erased states.
 *
 * "Can serve" — whether the current surface can honestly serve the
 * user with no network. Surfaces say so out loud through
 * OfflineServableContext (connectivity.tsx); the signals that feed
 * it: screens whose data came from the problem-5 app cache (the
 * `wasCacheServed` marker in apiCache.ts — a cache-served screen
 * shows real content), the device-local surfaces (Downloads,
 * Library, Settings, the player), and the playback session itself
 * (an active session — downloaded/local media above all — is never
 * interrupted, spec §3). A surface that has said nothing cannot
 * serve: cold surfaces (first paint, nothing painted yet) are
 * exactly the takeover case — launch/restore offline, or a cold
 * network screen with nothing cached.
 *
 * Exemptions (never takeover, whatever they claim): the pre-auth
 * surfaces (login / register / forgot-password / AniList handoff —
 * the gate mounts INSIDE the signed-in drawer shell, so these are
 * structurally unreachable; the list is belt-and-braces for the
 * pure function) and the Downloads screen itself, the takeover's
 * own destination.
 */

export type ConnectivityStatus = 'unknown' | 'online' | 'offline';

/**
 * One NetInfo sample's two signals (fix batch 2026-11-11):
 * `isConnected` (a network interface is up) and
 * `isInternetReachable` (the internet actually answers through
 * it). Either may be `null` = unknown.
 */
export interface ConnectivitySample {
  isConnected: boolean | null | undefined;
  isInternetReachable?: boolean | null | undefined;
}

/**
 * Fold one NetInfo sample into the status. Definitive readings:
 * - OFFLINE when `isConnected === false` (no interface) OR
 *   `isInternetReachable === false` (interface up, internet
 *   dead/gated — the captive-portal case).
 * - ONLINE when `isConnected === true` and reachability is not
 *   `false` (true, or null — a connected interface with unknown
 *   reachability is the long-standing online reading; a later
 *   `false` reachability still moves it offline).
 * Anything else (both legs null/unknown, or a bare `false`
 * reachability riding on an unknown connection that is already
 * offline) keeps the previous status — a null blip never erases
 * a known state, and `unknown` never moves on guesses.
 */
export function connectivityFromSample(
  previous: ConnectivityStatus,
  sample: ConnectivitySample,
): ConnectivityStatus {
  const { isConnected, isInternetReachable } = sample;
  if (isConnected === false || isInternetReachable === false) {
    // A bare reachability `false` with connectivity unknown and
    // no prior state is not definitive on its own — NetInfo can
    // report it transiently before the interface settles. Only
    // fold it once connectivity is known or a state exists.
    if (
      isConnected == null &&
      isInternetReachable === false &&
      previous === 'unknown'
    ) {
      return previous;
    }
    return 'offline';
  }
  if (isConnected === true) return 'online';
  return previous;
}

/** Routes the takeover never covers (see the header note). */
export const OFFLINE_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  '/login',
  '/register',
  '/forgot-password',
  '/anilist-handoff',
  '/downloads',
]);

export interface OfflineGateInput {
  connectivity: ConnectivityStatus;
  /** Current route pathname (expo-router `usePathname`). */
  pathname: string;
  /**
   * The current surface says it can serve the user offline
   * (cache-served data on screen, a device-local surface, or an
   * active playback session). Default posture is false: a surface
   * that has not claimed servability is a cold surface.
   */
  surfaceCanServe: boolean;
}

/**
 * The takeover decision — show the offline screen only when ALL
 * hold: connectivity is definitively offline, the route is not
 * exempt, and the surface cannot serve. Anything else (unknown
 * connectivity, an exempt route, an honest surface) leaves the
 * app exactly as it is.
 */
export function shouldShowOfflineScreen(input: OfflineGateInput): boolean {
  if (input.connectivity !== 'offline') return false;
  if (OFFLINE_EXEMPT_ROUTES.has(input.pathname)) return false;
  return !input.surfaceCanServe;
}

/**
 * The saved-themes chip line (design: "24 themes saved on this
 * device"). The count is the downloads store's real on-device
 * count (completed records whose file is present — the Downloads
 * screen's own headline definition). 0 reads honestly and 1 is
 * singular, per spec §2.
 */
export function savedThemesLabel(count: number): string {
  if (count <= 0) return 'No themes saved on this device yet';
  if (count === 1) return '1 theme saved on this device';
  return `${count} themes saved on this device`;
}

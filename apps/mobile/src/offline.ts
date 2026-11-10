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
 * - `online` / `offline` — definitive: NetInfo said
 *   `isConnected === true` / `=== false`. ONLY `false` is offline
 *   (spec §4 — `null` is not).
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
 * Fold one NetInfo `isConnected` sample into the status. `null`
 * (and `undefined`) samples are NOT definitive: the previous
 * status stands — an unknown first paint stays unknown, and a
 * known state is never erased by a null blip.
 */
export function connectivityFromSample(
  previous: ConnectivityStatus,
  isConnected: boolean | null | undefined,
): ConnectivityStatus {
  if (isConnected === true) return 'online';
  if (isConnected === false) return 'offline';
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

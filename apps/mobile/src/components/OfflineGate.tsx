import { usePathname } from 'expo-router';
import { useConnectivity, isLocalServableRoute } from '../connectivity';
import { usePlaybackSession } from '../playback-context';
import { shouldShowOfflineScreen } from '../offline';
import { OfflineScreen } from './OfflineScreen';

/**
 * Offline gate (offline screen, owner-approved design 2026-11-11) —
 * the takeover's render decision, mounted by the drawer layout as
 * an overlay above the navigator content and the mini player.
 *
 * The decision itself is the pure `shouldShowOfflineScreen`
 * (offline.ts); this component only gathers its inputs:
 * - connectivity + servability claims from ConnectivityProvider;
 * - the pathname (exempt routes, device-local routes);
 * - the playback session — an ACTIVE session is servable anywhere,
 *   so playback (downloaded/local media above all) is never
 *   interrupted (spec §3), and its surfaces (theme detail playing
 *   inline, the player route) keep serving under it.
 *
 * When the decision is false this renders nothing and the app is
 * exactly as it was. When true, the OfflineScreen covers the
 * shell; the covered content stays MOUNTED underneath, so
 * reconnect dismissal (or a tab switch from the screen's own nav)
 * simply uncovers the user where they were.
 */
export function OfflineGate() {
  const { status, claims } = useConnectivity();
  const pathname = usePathname();
  const { session } = usePlaybackSession();

  const claimServable = [...claims.values()].some(Boolean);
  const surfaceCanServe =
    claimServable || session.active || isLocalServableRoute(pathname);

  if (!shouldShowOfflineScreen({ connectivity: status, pathname, surfaceCanServe })) {
    return null;
  }
  return <OfflineScreen />;
}

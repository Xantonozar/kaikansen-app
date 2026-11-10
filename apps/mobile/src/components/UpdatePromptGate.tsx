import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePathname } from 'expo-router';
import { useConnectivity, isLocalServableRoute } from '../connectivity';
import { usePlaybackSession } from '../playback-context';
import { shouldShowOfflineScreen } from '../offline';
import { shouldShowUpdatePrompt } from '../appUpdate';
import { useUpdate } from '../appUpdateRuntime';
import { UpdateCard } from './UpdateCard';
import { spacing } from '../theme';

/**
 * Update prompt gate (release readiness, 2026-11-11) — the shell
 * overlay that presents the update card, mounted in the drawer
 * layout beside the OfflineGate.
 *
 * PRIORITY (spec §3, pinned by shouldShowUpdatePrompt's test):
 * the offline takeover OUTRANKS this prompt. The gate folds the
 * exact same inputs the OfflineGate folds — connectivity +
 * servability claims, the pathname's device-local routes, the
 * playback session — and while the takeover would show, this
 * renders nothing. The update state itself is untouched, so the
 * card simply appears when the takeover clears (reconnect, or
 * navigating to a servable surface). Below the takeover, the
 * card floats above the content at the shell's top edge.
 *
 * When the update machine is idle/checking this renders nothing
 * and the app is exactly as it was.
 */
export function UpdatePromptGate() {
  const { status, claims } = useConnectivity();
  const pathname = usePathname();
  const { session } = usePlaybackSession();
  const { state, pressUpdate, pressLater } = useUpdate();

  const styles = useMemo(() => createStyles(), []);

  const claimServable = [...claims.values()].some(Boolean);
  const surfaceCanServe =
    claimServable || session.active || isLocalServableRoute(pathname);
  const takeoverShowing = shouldShowOfflineScreen({
    connectivity: status,
    pathname,
    surfaceCanServe,
  });

  if (!shouldShowUpdatePrompt(takeoverShowing)) return null;
  if (
    state.phase !== 'available' &&
    state.phase !== 'required' &&
    state.phase !== 'downloading' &&
    state.phase !== 'installing' &&
    state.phase !== 'error'
  ) {
    return null;
  }

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <UpdateCard
        state={state}
        onUpdate={pressUpdate}
        onLater={pressLater}
      />
    </View>
  );
}

const createStyles = () =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      top: spacing.screenEdge,
      left: spacing.screenEdge,
      right: spacing.screenEdge,
      zIndex: 40,
    },
  });

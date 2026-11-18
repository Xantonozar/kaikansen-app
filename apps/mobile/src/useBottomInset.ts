import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { overlayBottomInset, tabBottomInset } from './bottomInset';
import { usePlaybackSlowSession } from './playback-context';

/**
 * The hooks behind src/bottomInset.ts — what a screen actually
 * calls for its primary scroll container's paddingBottom:
 *
 *   const bottomInset = useTabBottomInset();
 *   <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}>
 *
 * Both hooks read the mini player's visibility from the
 * provider's SLOW channel (PlaybackSlowSessionValue
 * .miniPlayerVisible — the mini player's own render gate), so
 * subscribing screens re-render when playback starts/stops,
 * never on progress ticks.
 */

/** Tab screens: pill nav clearance (+ mini player block while a
    session is loaded) + gap. */
export function useTabBottomInset(): number {
  const { miniPlayerVisible } = usePlaybackSlowSession();
  const insets = useSafeAreaInsets();
  return tabBottomInset({
    miniPlayerVisible,
    safeAreaBottom: insets.bottom,
  });
}

/** Pushed screens: only the overlay mini player floats there. */
export function useOverlayBottomInset(): number {
  const { miniPlayerVisible } = usePlaybackSlowSession();
  return overlayBottomInset({ miniPlayerVisible });
}

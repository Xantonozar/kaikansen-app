import { useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Pause, Play, SkipForward } from 'lucide-react-native';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { usePlaybackSession } from '../playback-context';

/** Tab routes — the mini player reaches these through the TabBar
    mount; the drawer overlay must skip them (no double render). */
const TAB_ROUTES: ReadonlySet<string> = new Set([
  '/',
  '/quiz',
  '/social',
  '/library',
]);

/** Routes the bar never floats over: the full player itself, and
    quiz play (solo run + multiplayer room, waiting and in-game —
    the design law keeps game screens clean). */
const HIDDEN_ROUTES: readonly string[] = ['/player', '/quiz/solo', '/quiz/room'];

/**
 * Mini player (Lavender Dusk handoff §4) — the floating white bar
 * from the finalized mocks: surface card, a thin mauve progress
 * line on its top edge, rounded cover thumb, title + artist, and
 * the mauveDeep pause/play disc. The whole bar opens the player
 * route with the live session (slug / mode / entry — the same
 * params the route already accepts).
 *
 * Two mounts, one component (see app/(drawer)/_layout.tsx and
 * src/components/TabBar.tsx):
 * - `tabBar`: in-flow above the tab row, on tab screens.
 * - `overlay`: absolutely positioned at the bottom of pushed
 *   screens, gated off tab routes by pathname.
 *
 * Hidden when nothing is loaded (no active session, no resolvable
 * source, nothing to present), on the player route, and during
 * quiz play. No close button — the design has none. The Next
 * button (Slice 2.5) is always drawn, as the mock draws it: it
 * skips through the session's real queue, and at the end of the
 * queue (or in a single-track session) it renders disabled —
 * reduced opacity, not pressable — rather than disappearing.
 */
export function MiniPlayer({
  placement,
}: {
  placement: 'tabBar' | 'overlay';
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const pathname = usePathname();
  const { session, playback, nowPlaying, hasNext, next } =
    usePlaybackSession();

  if (!session.active || !nowPlaying || playback.unavailable) return null;
  if (HIDDEN_ROUTES.includes(pathname)) return null;
  if (placement === 'overlay' && TAB_ROUTES.has(pathname)) return null;

  const entryId =
    session.entry?.atEntryId ?? session.entryIdOverride ?? null;

  const openPlayer = () => {
    if (!session.slug) return;
    router.push({
      pathname: '/player',
      params: {
        slug: session.slug,
        mode: session.mode,
        ...(entryId != null ? { entry: String(entryId) } : {}),
      },
    });
  };

  return (
    <Pressable
      onPress={openPlayer}
      accessibilityRole="button"
      accessibilityLabel={`Now playing: ${nowPlaying.title}. Open the player`}
      style={({ pressed }) => [
        styles.card,
        placement === 'overlay' ? styles.cardOverlay : styles.cardInBar,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${playback.fraction * 100}%` },
          ]}
        />
      </View>
      {nowPlaying.cover ? (
        <Image source={{ uri: nowPlaying.cover }} style={styles.cover} />
      ) : (
        <View style={[styles.cover, styles.coverEmpty]} />
      )}
      <View style={styles.textCol}>
        <Text style={styles.title} numberOfLines={1}>
          {nowPlaying.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {nowPlaying.artist}
        </Text>
      </View>
      <Pressable
        onPress={playback.toggleMain}
        accessibilityRole="button"
        accessibilityLabel={
          playback.ended ? 'Replay' : playback.isPlaying ? 'Pause' : 'Play'
        }
        style={({ pressed }) => [
          styles.disc,
          pressed && styles.pressed,
        ]}
      >
        {playback.buffering ? (
          <ActivityIndicator size="small" color={theme.onAccent} />
        ) : playback.isPlaying ? (
          <Pause size={20} color={theme.onAccent} strokeWidth={2} />
        ) : (
          <Play size={20} color={theme.onAccent} strokeWidth={2} />
        )}
      </Pressable>
      <Pressable
        onPress={next}
        disabled={!hasNext}
        accessibilityRole="button"
        accessibilityLabel="Next track"
        accessibilityState={{ disabled: !hasNext }}
        style={({ pressed }) => [
          styles.nextButton,
          !hasNext && styles.nextDisabled,
          pressed && styles.pressed,
        ]}
      >
        <SkipForward size={22} color={theme.text} strokeWidth={2} />
      </Pressable>
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 5,
    },
    cardInBar: {
      marginHorizontal: spacing.md,
      marginTop: spacing.sm,
      marginBottom: spacing.sm,
    },
    cardOverlay: {
      position: 'absolute',
      left: spacing.md,
      right: spacing.md,
      bottom: spacing.md + 2,
    },
    progressTrack: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      backgroundColor: theme.raised,
    },
    progressFill: {
      height: 3,
      backgroundColor: theme.secondary,
    },
    cover: {
      width: 44,
      height: 44,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
    },
    coverEmpty: {
      backgroundColor: theme.raised,
    },
    textCol: {
      flex: 1,
    },
    title: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    artist: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: 1,
    },
    disc: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    nextButton: {
      width: 40,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: -spacing.xs,
    },
    nextDisabled: {
      opacity: 0.3,
    },
    pressed: {
      opacity: 0.85,
    },
  });

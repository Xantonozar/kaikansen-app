import { memo, useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { VideoView } from 'expo-video';
import { Pause, Play, RotateCcw } from 'lucide-react-native';
import type { PlaybackSlow } from '../usePlayback';
import { radii, spacing, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { AppImage } from './AppImage';
import { DetailListenProgress } from './DetailProgress';

/**
 * Theme Detail — the LISTEN backend (perf problem 12 split).
 *
 * A separate component with its own mount: the page mounts this
 * ONLY while the mode is 'listen' (see detailPlayer
 * .mountedDetailBackends), never alongside the Watch backend.
 * The engine/session lives in the provider, so this component
 * mounting or unmounting can not restart the track or lose the
 * position — it renders whatever the shared engine currently
 * holds, through the engine's SLOW channel (progress ticks are
 * consumed inside DetailListenProgress, not here).
 *
 * The card is the page's original listen hero, moved verbatim:
 * the design's lavender card holding the centred square artwork
 * with the play/pause disc hanging off its bottom-right corner,
 * then the progress half (waveform + time row).
 *
 * ⚠️ UNTOUCHABLE — THE HIDDEN-VIDEO AUDIO FALLBACK: this
 * component owns the listen path's hidden surface mount. When
 * the listen chain reaches a VIDEO file as an audio candidate
 * (detailPlayer.hiddenVideoCandidate — the chain's last resort),
 * it plays through the expo-video player bound below with NO
 * visible surface (the 1×1, opacity-0 style), sound only,
 * exactly as before the split. The surface stays mounted for the
 * whole listen claim, whatever candidate is live — rendering,
 * unhiding, reordering or dropping that candidate is a spec
 * violation.
 */
export const DetailListenHero = memo(function DetailListenHero({
  playback,
  cover,
  waveHeights,
}: {
  /** The engine's slow channel (stable across progress ticks). */
  playback: PlaybackSlow;
  cover: string | null;
  /** Decorative waveform bar heights, seeded by the theme slug
      (computed once by the page — see waveBarHeights there). */
  waveHeights: readonly number[];
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.listenCard}>
      {/* The hidden video surface (see the header's UNTOUCHABLE
          note): always mounted while listening, never visible. */}
      <VideoView
        player={playback.surfacePlayer}
        style={styles.hiddenSurface}
        nativeControls={false}
      />
      <View style={styles.listenArtWrap}>
        {cover ? (
          <AppImage source={cover} style={styles.listenArt} />
        ) : (
          <View style={[styles.listenArt, styles.coverEmpty]} />
        )}
        <Pressable
          onPress={playback.toggleMain}
          accessibilityRole="button"
          accessibilityLabel={
            playback.ended ? 'Replay' : playback.isPlaying ? 'Pause' : 'Play'
          }
          style={({ pressed }) => [styles.listenFab, pressed && styles.pressed]}
        >
          {playback.buffering ? (
            <ActivityIndicator color={theme.onAccent} />
          ) : playback.ended ? (
            <RotateCcw size={22} color={theme.onAccent} strokeWidth={2} />
          ) : playback.isPlaying ? (
            <Pause
              size={22}
              color={theme.onAccent}
              fill={theme.onAccent}
              strokeWidth={2}
            />
          ) : (
            <Play
              size={22}
              color={theme.onAccent}
              fill={theme.onAccent}
              strokeWidth={2}
            />
          )}
        </Pressable>
      </View>
      <DetailListenProgress
        waveHeights={waveHeights}
        seekToRatio={playback.seekToRatio}
      />
    </View>
  );
});

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    listenCard: {
      // The Listen mock's card (measured from
      // kaikansen-detail-listen-mini-realimg.png): ≈10pt side
      // insets, cardLg radius, ≈20pt padding, accentContainer fill.
      marginHorizontal: 10,
      marginTop: spacing.md,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.cardLg,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.xl,
      paddingBottom: spacing.xl,
    },
    listenArtWrap: {
      alignSelf: 'center',
      width: 96,
      height: 96,
    },
    listenArt: {
      width: 96,
      height: 96,
      borderRadius: radii.base,
      backgroundColor: theme.surface,
    },
    coverEmpty: {
      backgroundColor: theme.raised,
    },
    listenFab: {
      // Measured: the ≈52pt disc's centre sits ≈9pt right and
      // ≈17.5pt below the artwork's bottom-right corner — it hangs
      // off the corner over the waveform zone.
      position: 'absolute',
      right: -35,
      bottom: -43,
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 6,
      elevation: 6,
    },
    hiddenSurface: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
    },
    pressed: {
      opacity: 0.85,
    },
  });

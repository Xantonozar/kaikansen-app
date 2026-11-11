import { memo, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { VideoView } from 'expo-video';
import { Pause, Play, RotateCcw } from 'lucide-react-native';
import type { PlaybackSlow } from '../usePlayback';
import { radii, spacing, typeStyles, type Theme } from '../theme';
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
 * BUFFER PACKAGE (2026-11-11 evening): while the claim waits
 * on its prepare download (the whole .ogg fetched resumably
 * into the cache instead of streamed — see src/detailAudio.ts),
 * the hero shows the transfer's HONEST byte-% under the artwork
 * (from the engine slow channel's prepareProgress) instead of a
 * bare spinner lying about "buffering". The caption exists only
 * while a total is known and the transfer is still fetching;
 * once the file lands and plays, it is gone.
 *
 * ⚠️ UNTOUCHABLE — THE HIDDEN-VIDEO AUDIO FALLBACK: when the
 * listen chain reaches a VIDEO file as an audio candidate
 * (detailPlayer.hiddenVideoCandidate — the chain's last resort),
 * it plays through expo-video with NO visible surface, sound
 * only, exactly as before the split. Since the 2026-11-11
 * restructure that surface is THIS hero's own hidden VideoView
 * (the pre-fix shape again — 1×1, opacity 0, mounted with the
 * listen hero): the fallback keeps playing through it,
 * invisible, and the engine's surface-readiness gate NEVER
 * applies to it (gate rule (c): sound-only candidates play
 * without waiting for any frame) — rendering, unhiding,
 * reordering or dropping that candidate is a spec violation.
 * The hero's unmount detaches under the same discipline as the
 * watch hero's (engine pauses synchronously; the next surface's
 * resume is first-frame-gated on the watch side).
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

  /* Surface discipline (2026-11-11 restructure): unmounting
     detaches — the engine pauses the player synchronously, so
     the binding never moves mid-play. */
  const detachRef = useRef(playback.surfaceDetach);
  detachRef.current = playback.surfaceDetach;
  useEffect(
    () => () => detachRef.current({ resume: true }),
    [],
  );

  /* Buffer package: the prepare download's honest % (see the
     header) — only while the engine is in its loading state
     BECAUSE of the wait: transfer still fetching, total known.
     A null fraction (server gave no total) shows no number at
     all rather than a fabricated one. */
  const prepare = playback.prepareProgress;
  const prepareLabel =
    playback.buffering &&
    prepare !== null &&
    prepare.status === 'fetching' &&
    prepare.fraction !== null
      ? `Downloading audio… ${Math.floor(prepare.fraction * 100)}%`
      : null;

  return (
    <View style={styles.listenCard}>
      {/* The hidden surface the fallback plays through
          (UNTOUCHABLE — see the header): this hero's own, 1×1
          opacity 0, never visible, never gated. */}
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
      {prepareLabel !== null ? (
        <Text style={styles.prepareLabel}>{prepareLabel}</Text>
      ) : null}
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
      position: 'relative',
      marginHorizontal: 10,
      marginTop: spacing.md,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.cardLg,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.xl,
      paddingBottom: spacing.xl,
    },
    // The fallback's hidden surface (UNTOUCHABLE — header):
    // 1×1, fully transparent, pinned out of the way.
    hiddenSurface: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: 1,
      height: 1,
      opacity: 0,
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
    pressed: {
      opacity: 0.85,
    },
    prepareLabel: {
      ...typeStyles.caption,
      color: theme.secondary,
      textAlign: 'center',
      marginTop: spacing.md,
    },
  });

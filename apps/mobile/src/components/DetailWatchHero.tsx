import { memo, useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Maximize, Pause, Play, RotateCcw } from 'lucide-react-native';
import type { VideoSource } from '@kaikansen/contracts';
import { watchArtworkUnderPlayer } from '../mediaEngine';
import type { PlaybackSlow } from '../usePlayback';
import { spacing, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { AppImage } from './AppImage';
import { DetailStripProgress } from './DetailProgress';
import { WatchQualityPicker } from './WatchQualityPicker';

/**
 * Theme Detail — the WATCH backend (perf problem 12 split).
 *
 * A separate component with its own mount: the page mounts this
 * ONLY while the mode is 'watch' (see detailPlayer
 * .mountedDetailBackends), never alongside the Listen backend.
 * The engine/session lives in the provider, so this component
 * mounting or unmounting can not restart the track or lose the
 * position — it renders whatever the shared engine currently
 * holds, through the engine's SLOW channel (its props change on
 * slow events only; progress ticks are consumed inside
 * DetailStripProgress, not here).
 *
 * Everything inside is the page's original watch hero, moved
 * verbatim:
 * - the artwork-under-player window (problem 7's
 *   watchArtworkUnderPlayer rule, untouched) until the current
 *   source's frames render;
 * - the control strip inside the hero's bottom edge: play/pause
 *   disc, the progress half (DetailStripProgress), the quality
 *   picker and fullscreen;
 * - the W2 degradation: when the engine has fallen back to the
 *   audio chain, the artwork replaces the video area (the page's
 *   surface is hidden by style in that state — audio only) and
 *   the honest note under the hero is the page's.
 *
 * SINGLE-OWNER SURFACE (2026-11-11 fix): this component mounts
 * NO video surface. The page owns the one surface for the whole
 * hero zone (see detailPlayer.detailSurfaceVisible) — on
 * Android a player moved between views can go permanently
 * video-dead, so the binding never moves; this hero renders the
 * chrome AROUND it (its container paints above the surface: the
 * artwork-under window shows through the transparent spacer
 * until frames land, then unmounts and the video shows). The
 * fullscreen button fires the onFullscreen prop — the page's
 * surface owns the ref.
 */
export const DetailWatchHero = memo(function DetailWatchHero({
  playback,
  cover,
  videoSources,
  onFullscreen,
}: {
  /** The engine's slow channel (stable across progress ticks). */
  playback: PlaybackSlow;
  cover: string | null;
  videoSources: readonly VideoSource[] | null | undefined;
  /** Fullscreen for the page-owned surface (its ref is the page's). */
  onFullscreen: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  /* The inline player's control strip — lives INSIDE the hero,
     along its bottom edge (the design rule: the hero card IS the
     player; controls sit in the card, not in a separate
     surface). Play/pause (replay once ended), the progress half,
     fullscreen in watch mode. */
  const playerStrip = (
    <View style={styles.playerStrip}>
      <Pressable
        onPress={playback.toggleMain}
        accessibilityRole="button"
        accessibilityLabel={
          playback.ended ? 'Replay' : playback.isPlaying ? 'Pause' : 'Play'
        }
        style={({ pressed }) => [styles.stripButton, pressed && styles.pressed]}
      >
        {playback.ended ? (
          <RotateCcw size={18} color={theme.onAccent} strokeWidth={2} />
        ) : playback.isPlaying ? (
          <Pause size={18} color={theme.onAccent} strokeWidth={2} />
        ) : (
          <Play size={18} color={theme.onAccent} strokeWidth={2} />
        )}
      </Pressable>
      <DetailStripProgress seekToRatio={playback.seekToRatio} />
      {!playback.audioFallback && (
        <>
          {/* Perf problem 7: the quality picker (self-hides for
              single-source entries). Its pill is the Player's
              white-glass chip — over the strip's dark card it
              reads as the design's resolution chip. */}
          <WatchQualityPicker
            sources={videoSources ?? []}
            activeUrl={playback.url}
            onPick={playback.switchQuality}
          />
          <Pressable
            onPress={onFullscreen}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Fullscreen"
            style={styles.stripIconButton}
          >
            <Maximize size={18} color={theme.text} strokeWidth={2} />
          </Pressable>
        </>
      )}
    </View>
  );

  if (playback.audioFallback) {
    /* W2 degradation: every video candidate failed, so the
       engine is playing the audio chain (the .ogg) — the media
       area shows the theme's artwork instead of a dead black
       frame (the page's surface is hidden by style in this
       state, audio only) and the honest note sits under the
       hero. The strip keeps working: play/pause and seek drive
       the audio. */
    return (
      <View style={styles.heroPlayer}>
        {cover ? (
          <AppImage source={cover} style={styles.heroVideo} />
        ) : (
          <View style={[styles.heroVideo, styles.coverEmpty]} />
        )}
        {playback.buffering && (
          <View style={styles.heroCenter}>
            <ActivityIndicator color={theme.accent} size="large" />
          </View>
        )}
        {playerStrip}
      </View>
    );
  }

  return (
    <View style={styles.heroPlayer}>
      {/* Perf problem 7: the anime artwork sits UNDER the video
          surface until frames render (initial load and across a
          quality switch) — the hero never sits black while a
          source loads. Once frames render the video covers it
          (the surface's own canvas takes over). */}
      {watchArtworkUnderPlayer({
        hasArtwork: !!cover,
        framesRendered: playback.framesRendered,
      }) && cover ? (
        <AppImage
          source={cover}
          style={styles.heroArtworkUnder}
          resizeMode="cover"
        />
      ) : null}
      {/* The 16:9 stage the page's surface fills: the surface
          itself is page-owned (single-owner rule — see the
          header) and sits UNDER this container, absolutely
          positioned over the hero zone; this transparent spacer
          holds the box it overlays, and the artwork-under window
          above shows through it until frames render. */}
      <View style={styles.heroSpacer} />
      {playback.buffering && (
        <View style={styles.heroCenter}>
          <ActivityIndicator color={theme.accent} size="large" />
        </View>
      )}
      {playerStrip}
    </View>
  );
});

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    heroPlayer: {
      position: 'relative',
      // NO background fill: this container paints ABOVE the
      // page-owned surface (a later sibling in the hero zone),
      // so an opaque fill here would cover the video. The black
      // comes from the surface's own style and, in W2, the
      // artwork box below.
    },
    heroVideo: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: '#000',
    },
    // The transparent 16:9 stage the page's surface overlays
    // (single-owner rule): holds the hero box in flow while the
    // absolutely-positioned surface fills it from beneath.
    heroSpacer: {
      width: '100%',
      aspectRatio: 16 / 9,
    },
    // Watch artwork-under-player (perf problem 7): absolutely
    // fills heroPlayer's 16:9 canvas, covering the page-owned
    // surface beneath the hero until the source's frames render
    // (then it unmounts and the video shows — the same pixels
    // the old under-player layering produced).
    heroArtworkUnder: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      aspectRatio: 16 / 9,
    },
    coverEmpty: {
      backgroundColor: theme.raised,
    },
    heroCenter: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playerStrip: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: withOpacity(theme.background, 0.72),
      zIndex: 4,
    },
    stripButton: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stripIconButton: {
      width: 38,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: {
      opacity: 0.85,
    },
  });

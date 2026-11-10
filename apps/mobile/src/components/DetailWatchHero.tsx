import { memo, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { VideoView } from 'expo-video';
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
 * - the textureView surface (a surfaceView can attach late
 *   inside the ScrollView and stay black — see the original
 *   note, kept below);
 * - the control strip inside the hero's bottom edge: play/pause
 *   disc, the progress half (DetailStripProgress), the quality
 *   picker and fullscreen;
 * - the W2 degradation: when the engine has fallen back to the
 *   audio chain, the visible surface is replaced by the artwork
 *   and the video surface stays mounted but HIDDEN (audio only)
 *   — the honest note under the hero is the page's.
 */
export const DetailWatchHero = memo(function DetailWatchHero({
  playback,
  cover,
  videoSources,
}: {
  /** The engine's slow channel (stable across progress ticks). */
  playback: PlaybackSlow;
  cover: string | null;
  videoSources: readonly VideoSource[] | null | undefined;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const videoRef = useRef<VideoView>(null);

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
            onPress={() => {
              void videoRef.current?.enterFullscreen();
            }}
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
       frame, with the player surface hidden (audio only) and
       the honest note under the hero. The strip keeps working:
       play/pause and seek drive the audio. */
    return (
      <View style={styles.heroPlayer}>
        <VideoView
          player={playback.surfacePlayer}
          style={styles.hiddenSurface}
          nativeControls={false}
        />
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
      {/* textureView, not the default surfaceView: this hero
          mounts conditionally (on the Watch tap) inside a
          ScrollView, where a SurfaceView can attach after
          playback starts and stay black; a TextureView
          composites like a normal view and reliably shows the
          frames. */}
      <VideoView
        ref={videoRef}
        player={playback.surfacePlayer}
        style={styles.heroVideo}
        contentFit="contain"
        nativeControls={false}
        surfaceType="textureView"
      />
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
      backgroundColor: '#000',
    },
    heroVideo: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: '#000',
    },
    // Watch artwork-under-player (perf problem 7): absolutely
    // fills heroPlayer's 16:9 canvas, behind the VideoView.
    heroArtworkUnder: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      aspectRatio: 16 / 9,
    },
    hiddenSurface: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
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

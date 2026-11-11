import { memo, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { VideoView } from 'expo-video';
import { Maximize, Pause, Play, RotateCcw } from 'lucide-react-native';
import type { VideoSource } from '@kaikansen/contracts';
import { playingResolution, watchArtworkUnderPlayer } from '../mediaEngine';
import type { PlaybackSlow } from '../usePlayback';
import { radii, spacing, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { AppImage } from './AppImage';
import { DetailStripProgress } from './DetailProgress';

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
 * Everything inside is the page's watch hero:
 * - the WATCH SURFACE (2026-11-11 restructure — see below),
 * - the artwork-under-player window (problem 7's
 *   watchArtworkUnderPlayer rule, untouched) until the current
 *   source's frames render;
 * - the control strip inside the hero's bottom edge: play/pause
 *   disc, the progress half (DetailStripProgress), the STATIC
 *   resolution label and fullscreen (owner ruling 2026-11-11
 *   17:01: quality is FIXED at the best available — the chain
 *   starts highest and falls back only on failure; there is no
 *   picker and no switching, the chip only NAMES what's playing
 *   via mediaEngine.playingResolution, omitted when unknowable);
 * - the W2 degradation: when the engine has fallen back to the
 *   audio chain, the artwork replaces the video area (the
 *   surface renders hidden in that state — audio only) and the
 *   honest note under the hero is the page's.
 *
 * THE WATCH SURFACE (2026-11-11 restructure — regression-driven):
 * this hero mounts the watch VideoView itself again, exactly as
 * the pre-fix problem-12 shape did (the structure the owner
 * confirms WORKED in the field): born visible, in-flow 16:9,
 * textureView, never hidden-styled in its live form, never
 * restyled — it unmounts wholesale with the backend. The interim
 * single always-mounted page surface (style flipping
 * hidden↔visible) shipped in 1.0.0/1.0.1 and the field reports
 * indict it (audio fine; video dead or dying seconds in). Two
 * disciplines make the rebind safe now: this component's unmount
 * cleanup calls the engine's surfaceDetach (the player pauses
 * synchronously — never playing while unbound), and the
 * surface's onFirstFrameRender feeds the engine's
 * surface-readiness gate, so a watch play/resume only reaches
 * the player once THIS surface has rendered a frame for it.
 * W2 renders the surface with the hidden style (the pre-fix
 * shape): the degradation starts from an engine ERROR, never
 * mid-play, so no live rebind happens there either.
 * Fullscreen rides this surface's own ref via onFullscreenRef.
 */
export const DetailWatchHero = memo(function DetailWatchHero({
  playback,
  cover,
  videoSources,
  onFullscreenRef,
}: {
  /** The engine's slow channel (stable across progress ticks). */
  playback: PlaybackSlow;
  cover: string | null;
  videoSources: readonly VideoSource[] | null | undefined;
  /** Fullscreen registration: this hero owns the watch surface
      now (2026-11-11 restructure), so it hands its surface ref
      up for the page's fullscreen action. */
  onFullscreenRef?: (ref: VideoView | null) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const videoRef = useRef<VideoView>(null);

  /* Surface discipline (2026-11-11 restructure): unmounting
     detaches — the engine pauses the player synchronously and
     forgets this surface's readiness, so the binding never moves
     mid-play and the next surface's resume waits for its first
     frame. The ref indirection keeps the cleanup bound to the
     LATEST detach callback without re-registering per render. */
  const detachRef = useRef(playback.surfaceDetach);
  detachRef.current = playback.surfaceDetach;
  useEffect(() => {
    onFullscreenRef?.(videoRef.current);
    return () => {
      onFullscreenRef?.(null);
      detachRef.current({ resume: true });
    };
    // Mount/unmount only — the detach must fire exactly once,
    // when this surface leaves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* The static resolution label (owner ruling 2026-11-11: fixed
     best quality, NO switching): names the source ACTUALLY
     playing via the pure playingResolution match; a fallback
     URL or a local file matches nothing and the label is
     omitted — never guessed. */
  const resolution = playingResolution(videoSources ?? [], playback.url);

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
          {/* The static resolution label (owner ruling
              2026-11-11: quality FIXED at the best available —
              no picker, no switching). The white-glass pill over
              the strip's dark card reads as the design's
              resolution chip; it only NAMES what's playing. */}
          {resolution !== null && (
            <View style={styles.resChip}>
              <View style={styles.resDot} />
              <Text style={styles.resChipText}>{resolution}p</Text>
            </View>
          )}
          <Pressable
            onPress={() => void videoRef.current?.enterFullscreen()}
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
       frame (the surface stays mounted but hidden — the pre-fix
       shape; the degradation only ever starts from an engine
       error, never mid-play) and the honest note sits under
       the hero. The strip keeps working: play/pause and seek
       drive the audio. */
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
          surface until frames render — the hero never sits black
          while a source loads. Once frames render the video covers
          it (the surface's own canvas takes over). (The
          quality-switch artwork window of the switcher era is
          gone with the switcher — owner ruling 2026-11-11: fixed
          best quality.) */}
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
      {/* The watch surface (2026-11-11 restructure): born
          visible, in-flow 16:9 — textureView, not the default
          surfaceView: this hero mounts conditionally (on the
          Watch tap) inside a ScrollView, where a SurfaceView can
          attach after playback starts and stay black; a
          TextureView composites like a normal view and reliably
          shows the frames. Its first rendered frame feeds the
          engine's surface-readiness gate. */}
      <VideoView
        ref={videoRef}
        player={playback.surfacePlayer}
        style={styles.heroVideo}
        contentFit="contain"
        nativeControls={false}
        surfaceType="textureView"
        onFirstFrameRender={() =>
          playback.notifySurfaceFirstFrame({ visible: true })
        }
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
      // The hero's black stage (pre-fix shape): the surface's
      // own canvas plus this fill paint the 16:9 box while a
      // source loads; W2's artwork box covers it.
      backgroundColor: '#000',
    },
    heroVideo: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: '#000',
    },
    // The hidden W2 surface: mounted so the player stays bound
    // while the audio chain plays, never visible (the pre-fix
    // shape — 1×1, fully transparent, out of the way).
    hiddenSurface: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
    },
    // Watch artwork-under-player (perf problem 7): absolutely
    // fills heroPlayer's 16:9 canvas UNDER the video surface
    // until the source's frames render (then it unmounts and
    // the video shows).
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
    // The static resolution label (owner ruling 2026-11-11:
    // fixed best quality, no switcher): the Player page's
    // white-glass chip shape — presentational only.
    resChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radii.pill,
      backgroundColor: 'rgba(255,255,255,0.16)',
    },
    resDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.success,
    },
    resChipText: {
      color: '#FFF',
      fontSize: 11,
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

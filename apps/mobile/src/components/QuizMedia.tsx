import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
  Text,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import { Music2, Volume2, VolumeX } from 'lucide-react-native';
import { isPlausibleUrl } from '../playback';
import { radii, spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * The quiz player core (Slice M4) — tries the candidates in order
 * and plays the first that loads, falling through on error; the
 * last failure sticks (`failed`). Sound starts ON (guessing needs
 * the audio) with a mute toggle; a new `mediaKey` restarts from
 * the first candidate and autoplays; leaving the screen pauses the
 * player (the hook releases it on unmount), so no clip leaks over
 * other screens.
 */
function useQuizMediaPlayer(
  candidates: (string | null)[],
  mediaKey: string,
) {
  const sources = useMemo(
    () => candidates.filter(isPlausibleUrl),
    [candidates],
  );
  const [sourceIndex, setSourceIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);

  // A new question/round restarts from the first candidate.
  useEffect(() => {
    setSourceIndex(0);
    setFailed(false);
  }, [mediaKey]);

  const url = sources[sourceIndex] ?? null;

  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
  });
  const { status } = useEvent(player, 'statusChange', {
    status: player.status,
  });

  const loadedRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!url || loadedRef.current === `${mediaKey}:${url}`) return;
    loadedRef.current = `${mediaKey}:${url}`;
    void player
      .replaceAsync(url)
      .then(() => {
        if (mountedRef.current) player.play();
      })
      .catch(() => {
        // Load failures also surface via statusChange; nothing to do.
      });
  }, [url, mediaKey, player]);

  useEventListener(player, 'statusChange', ({ status: next }) => {
    if (next !== 'error') return;
    // Fall through the candidate list; the last failure sticks.
    if (sourceIndex + 1 < sources.length) {
      loadedRef.current = null;
      setSourceIndex(sourceIndex + 1);
    } else {
      setFailed(true);
    }
  });

  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  // Stop sound the moment the screen is left.
  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        // Player already released — nothing to stop.
      }
    };
  }, [player]);

  return { player, status, url, sourceIndex, failed, muted, toggleMute };
}

/**
 * Embedded quiz media (Slice M4) — the question's theme clip, played
 * inline on the quiz screens (the player screen's expo-video
 * patterns, shrunk to a card).
 *
 * Default mode (legacy): the first candidate renders on the visible
 * video surface (watch); when it fails, later candidates play
 * behind the cover artwork (listen) — a round stays answerable even
 * when every candidate fails, with the failure stated on the card
 * instead of swallowed. A mute toggle sits on the corner.
 *
 * `audioOnly` mode (owner ruling, 2026-11-09 — quiz questions are
 * AUDIO-ONLY: the visible video and even the cover art give the
 * anime away on sight): the visible surface and the cover are never
 * rendered. Callers pass audio candidates only, which play behind
 * a neutral tile (music-note glyph, "Playing..." state); failure
 * keeps the same honest note as the default mode.
 */
export function QuizMedia({
  candidates,
  coverImage,
  mediaKey,
  audioOnly = false,
}: {
  candidates: (string | null)[];
  coverImage: string | null;
  mediaKey: string;
  audioOnly?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { player, status, url, sourceIndex, failed, muted, toggleMute } =
    useQuizMediaPlayer(candidates, mediaKey);

  const watchSurface = !audioOnly && sourceIndex === 0 && url !== null;
  const buffering = url !== null && !failed && status === 'loading';

  if (audioOnly) {
    return (
      <View style={styles.wrap}>
        <View style={styles.audioTile}>
          {buffering ? (
            <ActivityIndicator color={theme.accent} size="large" />
          ) : (
            <>
              <Music2 size={30} color={theme.muted} strokeWidth={1.8} />
              {!failed && url !== null && (
                <Text style={styles.audioTileText}>Playing...</Text>
              )}
            </>
          )}
        </View>
        {url !== null && (
          <VideoView
            player={player}
            style={styles.hiddenSurface}
            nativeControls={false}
          />
        )}
        {url !== null && !failed && (
          <Pressable
            onPress={toggleMute}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute theme' : 'Mute theme'}
            style={styles.muteButton}
          >
            {muted ? (
              <VolumeX size={17} color={theme.text} strokeWidth={2} />
            ) : (
              <Volume2 size={17} color={theme.text} strokeWidth={2} />
            )}
          </Pressable>
        )}
        {(failed || url === null) && (
          <View style={styles.noteBar}>
            <Text style={styles.note}>
              {url === null && !failed
                ? 'No playable media for this theme — you can still answer.'
                : 'This theme could not be played — you can still answer.'}
            </Text>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {watchSurface ? (
        <VideoView
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls={false}
        />
      ) : (
        <>
          {coverImage ? (
            <Image source={{ uri: coverImage }} style={styles.artwork} />
          ) : (
            <View style={[styles.artwork, styles.artworkPlaceholder]} />
          )}
          {url !== null && (
            <VideoView
              player={player}
              style={styles.hiddenSurface}
              nativeControls={false}
            />
          )}
        </>
      )}
      {buffering && (
        <View style={styles.overlayCenter}>
          <ActivityIndicator color={theme.accent} size="large" />
        </View>
      )}
      {url !== null && !failed && (
        <Pressable
          onPress={toggleMute}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={muted ? 'Unmute theme' : 'Mute theme'}
          style={styles.muteButton}
        >
          {muted ? (
            <VolumeX size={17} color={theme.text} strokeWidth={2} />
          ) : (
            <Volume2 size={17} color={theme.text} strokeWidth={2} />
          )}
        </Pressable>
      )}
      {(failed || url === null) && (
        <View style={styles.noteBar}>
          <Text style={styles.note}>
            {url === null && !failed
              ? 'No playable media for this theme — you can still answer.'
              : 'This theme could not be played — you can still answer.'}
          </Text>
        </View>
      )}
    </View>
  );
}

export type QuizAudioPhase = 'buffering' | 'playing' | 'failed' | 'empty';

export interface QuizAudioState {
  phase: QuizAudioPhase;
  muted: boolean;
  toggleMute: () => void;
}

/**
 * Headless quiz audio (owner ruling, 2026-11-09) — the solo
 * question screen's player: no surface, no artwork, nothing
 * visible at all; the hidden question clip plays while the screen
 * composes its own chrome (countdown ring, status line, mute
 * button) from the reported state. Playback state is reported via
 * `onStateChange` whenever the phase or mute changes.
 */
export function QuizAudioOnly({
  candidates,
  mediaKey,
  onStateChange,
}: {
  candidates: (string | null)[];
  mediaKey: string;
  onStateChange?: (state: QuizAudioState) => void;
}) {
  const { player, status, url, failed, muted, toggleMute } =
    useQuizMediaPlayer(candidates, mediaKey);

  const phase: QuizAudioPhase = failed
    ? 'failed'
    : url === null
      ? 'empty'
      : status === 'loading' || status === 'idle'
        ? 'buffering'
        : 'playing';

  const reportRef = useRef(onStateChange);
  reportRef.current = onStateChange;
  useEffect(() => {
    reportRef.current?.({ phase, muted, toggleMute });
  }, [phase, muted, toggleMute]);

  if (url === null) return null;
  return (
    <VideoView
      player={player}
      style={hiddenSurfaceStyle}
      nativeControls={false}
    />
  );
}

const hiddenSurfaceStyle = {
  position: 'absolute' as const,
  width: 1,
  height: 1,
  opacity: 0,
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      position: 'relative',
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      overflow: 'hidden',
    },
    video: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: '#000',
    },
    artwork: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: theme.surface,
    },
    artworkPlaceholder: {
      backgroundColor: theme.raised,
    },
    audioTile: {
      width: '100%',
      aspectRatio: 16 / 9,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
    },
    audioTileText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    hiddenSurface: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
    },
    overlayCenter: {
      ...StyleSheet.absoluteFill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    muteButton: {
      position: 'absolute',
      top: spacing.sm,
      right: spacing.sm,
      width: 34,
      height: 34,
      borderRadius: radii.sm,
      backgroundColor: withOpacity(theme.background, 0.62),
      alignItems: 'center',
      justifyContent: 'center',
    },
    noteBar: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      backgroundColor: theme.surface,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
    },
  });

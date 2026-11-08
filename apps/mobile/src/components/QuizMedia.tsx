import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Volume2, VolumeX } from 'lucide-react-native';
import { isPlausibleUrl } from '../playback';
import { radii, spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * Embedded quiz media (Slice M4) — the question's theme clip, played
 * inline on the quiz screens (the player screen's expo-video
 * patterns, shrunk to a card). Candidates are tried in order: the
 * first renders on the visible video surface (watch); when it fails,
 * later candidates play behind the cover artwork (listen) — a round
 * stays answerable even when every candidate fails, with the failure
 * stated on the card instead of swallowed. A mute toggle sits on the
 * corner; guessing needs the audio, so sound starts ON.
 *
 * `mediaKey` identifies the question/round: a new key reloads the
 * first candidate and autoplays. Leaving the screen pauses the
 * player (the hook releases it on unmount), so no clip leaks over
 * other screens.
 */
export function QuizMedia({
  candidates,
  coverImage,
  mediaKey,
}: {
  candidates: (string | null)[];
  coverImage: string | null;
  mediaKey: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

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
  const watchSurface = sourceIndex === 0 && url !== null;

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

  const buffering = url !== null && !failed && status === 'loading';

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
          onPress={() => setMuted((m) => !m)}
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

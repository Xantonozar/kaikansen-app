import { memo, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePlaybackProgress } from '../playback-context';
import { seekRatioForTap, wavePlayedBars } from '../detailPlayer';
import { formatTime } from '../playback';
import { spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * Theme Detail progress components (perf problem 12) — the ONLY
 * parts of the detail page that re-render on progress ticks.
 *
 * Each component consumes the provider's progress channel
 * (usePlaybackProgress: { progress, fraction } and nothing else)
 * and owns its own seek bar width, so a tick re-renders exactly
 * these small subtrees — the page body, the heroes' slow chrome
 * and everything below the hero never see a tick (they read the
 * slow channel, whose identity is stable across ticks). The seek
 * callback they fire is the engine's slow seekToRatio, passed in
 * as a prop (a stable useCallback in the engine).
 *
 * Layout values are the page's originals, moved verbatim — the
 * v7 layout does not change.
 */

/**
 * The Watch strip's progress half: tap-to-seek track (fill +
 * knob) and the "current / duration" label. Rendered as a
 * fragment inside the strip's row, between the play/pause disc
 * and the quality/fullscreen controls (which are slow chrome and
 * live in DetailWatchHero).
 */
export const DetailStripProgress = memo(function DetailStripProgress({
  seekToRatio,
}: {
  seekToRatio: (ratio: number) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { progress, fraction } = usePlaybackProgress();
  const [barWidth, setBarWidth] = useState(0);

  const onSeek = (locationX: number) => {
    const ratio = seekRatioForTap(locationX, barWidth);
    if (ratio !== null) seekToRatio(ratio);
  };

  return (
    <>
      <Pressable
        onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
        onPress={(e) => onSeek(e.nativeEvent.locationX)}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek"
        style={styles.stripSeekHit}
      >
        <View style={styles.seekTrack}>
          <View style={[styles.seekFill, { width: `${fraction * 100}%` }]} />
          <View style={[styles.seekKnob, { left: `${fraction * 100}%` }]} />
        </View>
      </Pressable>
      <Text style={styles.stripTime}>
        {formatTime(progress.current)} / {formatTime(progress.duration)}
      </Text>
    </>
  );
});

/**
 * The Listen hero's progress half: the waveform row (decorative
 * bars, real played split — heights are computed once by the
 * page from the theme slug; only the COLOUR split is progress)
 * and the time row (current time, tap-to-seek track, duration).
 */
export const DetailListenProgress = memo(function DetailListenProgress({
  waveHeights,
  seekToRatio,
}: {
  waveHeights: readonly number[];
  seekToRatio: (ratio: number) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { progress, fraction } = usePlaybackProgress();
  const [barWidth, setBarWidth] = useState(0);

  const onSeek = (locationX: number) => {
    const ratio = seekRatioForTap(locationX, barWidth);
    if (ratio !== null) seekToRatio(ratio);
  };
  const playedBars = wavePlayedBars(fraction, waveHeights.length);

  return (
    <>
      <View style={styles.waveRow}>
        {waveHeights.map((height, i) => (
          <View
            key={i}
            style={[
              styles.waveBar,
              {
                height,
                backgroundColor:
                  i < playedBars
                    ? theme.accent
                    : withOpacity(theme.accent, 0.22),
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.listenTimeRow}>
        <Text style={styles.listenTime}>{formatTime(progress.current)}</Text>
        <Pressable
          onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
          onPress={(e) => onSeek(e.nativeEvent.locationX)}
          accessibilityRole="adjustable"
          accessibilityLabel="Seek"
          style={styles.listenSeekHit}
        >
          <View style={styles.listenTrack}>
            <View
              style={[styles.listenFill, { width: `${fraction * 100}%` }]}
            />
          </View>
        </Pressable>
        <Text style={styles.listenTime}>{formatTime(progress.duration)}</Text>
      </View>
    </>
  );
});

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    stripSeekHit: {
      flex: 1,
      paddingVertical: spacing.sm,
    },
    seekTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.raised,
      justifyContent: 'center',
    },
    seekFill: {
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.accent,
    },
    seekKnob: {
      position: 'absolute',
      width: 12,
      height: 12,
      borderRadius: 6,
      marginLeft: -6,
      backgroundColor: theme.accent,
    },
    stripTime: {
      ...typeStyles.mono,
      color: theme.text,
    },
    waveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4.5,
      height: 28,
      // Mock: artwork bottom → waveform band ≈33pt.
      marginTop: 33,
    },
    waveBar: {
      width: 5,
      borderRadius: 2.5,
    },
    listenTimeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.sm,
    },
    listenTime: {
      ...typeStyles.bodySmall,
      color: theme.text,
    },
    listenSeekHit: {
      flex: 1,
      paddingVertical: spacing.sm,
    },
    listenTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: withOpacity(theme.accent, 0.22),
    },
    listenFill: {
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.accent,
    },
  });

import { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { usePosterCardWidth } from '../layout';

/**
 * Season poster card (DESIGN.md §7.1), compact treatment (approved
 * mockup v1): responsive width (~35% of the window, clamped 120–168),
 * 3/4 portrait art at radius md, a translucent season chip overlaid
 * top-right (format per P-15: "SEASON YEAR"), then a single-line song
 * title and artist/anime line under the art. Used by the Home season
 * rail.
 */
export function PosterCard({
  item,
  onPress,
}: {
  item: ThemeSummary;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const width = usePosterCardWidth();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = item.animeCoverImage ?? item.animeCoverImageSmall;
  const chip =
    item.animeSeason && item.animeSeasonYear
      ? `${item.animeSeason} ${item.animeSeasonYear}`
      : item.type;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { width },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.art}>
        {cover ? (
          <Image source={{ uri: cover }} style={styles.image} />
        ) : (
          <View style={[styles.image, styles.placeholder]} />
        )}
        <View style={styles.chip}>
          <Text style={styles.chipText}>{chip}</Text>
        </View>
      </View>
      <Text style={styles.song} numberOfLines={1}>
        {item.songTitle}
      </Text>
      <Text style={styles.anime} numberOfLines={1}>
        {item.animeTitle}
      </Text>
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  card: {},
  pressed: {
    opacity: 0.75,
  },
  art: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: theme.surface,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    backgroundColor: theme.raised,
  },
  chip: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    backgroundColor: withOpacity(theme.background, 0.72),
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccentContainer,
  },
  song: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    marginTop: spacing.sm,
  },
  anime: {
    ...typeStyles.caption,
    color: theme.muted,
    marginTop: 2,
  },
});

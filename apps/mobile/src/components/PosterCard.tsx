import { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * Season poster card (DESIGN.md §7.1): 160px wide, 3/4 portrait, radius 24,
 * season chip overlaid (format per P-15: "SEASON YEAR"), song title under
 * the art. Used by the Home season rail.
 */
export function PosterCard({
  item,
  onPress,
}: {
  item: ThemeSummary;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = item.animeCoverImage ?? item.animeCoverImageSmall;
  const chip =
    item.animeSeason && item.animeSeasonYear
      ? `${item.animeSeason} ${item.animeSeasonYear}`
      : item.type;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
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
      <Text style={styles.song} numberOfLines={2}>
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
  card: {
    width: 160,
  },
  pressed: {
    opacity: 0.75,
  },
  art: {
    width: 160,
    aspectRatio: 3 / 4,
    borderRadius: radii.cardLg,
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
    left: spacing.sm,
    backgroundColor: theme.accentContainer,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: {
    ...typeStyles.caption,
    color: theme.onAccentContainer,
  },
  song: {
    ...typeStyles.body,
    color: theme.text,
    marginTop: spacing.sm,
  },
  anime: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    marginTop: 2,
  },
});

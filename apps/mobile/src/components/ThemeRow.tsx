import { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Star } from 'lucide-react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * Theme row (DESIGN.md §7.2) — the shared list unit for Popular Themes,
 * search results and later library/playlist surfaces: cover thumbnail,
 * song title, anime · artist line, OP/ED marker (ED in tertiary), and the
 * aggregate rating where the web shows it.
 */
export function ThemeRow({
  item,
  onPress,
}: {
  item: ThemeSummary;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = item.animeCoverImageSmall ?? item.animeCoverImage;
  const artist = item.artistName ?? item.allArtists.join(', ');

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {cover ? (
        <Image source={{ uri: cover }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.placeholder]} />
      )}
      <View style={styles.main}>
        <Text style={styles.song} numberOfLines={1}>
          {item.songTitle}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {item.animeTitle}
          {artist ? ` · ${artist}` : ''}
        </Text>
      </View>
      <View style={styles.side}>
        <Text
          style={[
            styles.type,
            { color: item.type === 'ED' ? theme.tertiary : theme.accent },
          ]}
        >
          {item.type} {item.sequence}
        </Text>
        {item.totalRatings > 0 && (
          <View style={styles.rating}>
            <Star size={11} color={theme.muted} strokeWidth={2} />
            <Text style={styles.ratingText}>{item.avgRating.toFixed(1)}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 56,
  },
  pressed: {
    opacity: 0.7,
  },
  thumb: {
    width: 44,
    height: 56,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  placeholder: {
    backgroundColor: theme.raised,
  },
  main: {
    flex: 1,
    gap: 2,
  },
  song: {
    ...typeStyles.body,
    color: theme.text,
  },
  meta: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  side: {
    alignItems: 'flex-end',
    gap: 4,
  },
  type: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
  },
  rating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  ratingText: {
    ...typeStyles.caption,
    color: theme.muted,
  },
});

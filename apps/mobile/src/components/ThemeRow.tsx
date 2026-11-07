import { useMemo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Play } from 'lucide-react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';

/**
 * Theme row — the shared list unit for Popular Themes and search
 * results. Compact/icon-led treatment (approved mockup v1): a dense
 * two-line row (song title, anime · artist), the OP/ED badge (ED in
 * tertiary), and a single icon action tile. The tile is a play glyph
 * wired to the row's own press — opening the theme is the only action
 * this read-path slice has; save/plus states do not exist in the data
 * yet, so no dead affordance is drawn for them. The aggregate rating
 * lives on the detail screen's fact card, not in rows (mockup v1).
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
        <Pressable
          onPress={onPress}
          hitSlop={7}
          accessibilityRole="button"
          accessibilityLabel={`Play ${item.songTitle}`}
          style={({ pressed }) => [
            styles.action,
            pressed && styles.pressed,
          ]}
        >
          <Play size={15} color={theme.muted} strokeWidth={2} />
        </Pressable>
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
    paddingVertical: 6,
    minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  pressed: {
    opacity: 0.7,
  },
  thumb: {
    width: 42,
    height: 52,
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
    fontSize: 13,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  meta: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  side: {
    alignItems: 'flex-end',
    gap: 4,
  },
  type: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    letterSpacing: 0.3,
  },
  action: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

import { useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Bookmark, Play, X } from 'lucide-react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { ThemeRowMenu } from './ThemeRowMenu';

/**
 * Theme row — the shared list unit for Popular Themes, search results
 * and the Library. Compact/icon-led treatment (approved mockup v1): a
 * dense two-line row (song title, anime · artist), the OP/ED badge
 * (ED in tertiary), and a cluster of small icon tiles on the right.
 * The aggregate rating lives on the detail screen's fact card, not in
 * rows (mockup v1).
 *
 * Actions are opt-in per screen, so a screen only ever draws controls
 * it has wired (Slice M2):
 * - the play tile targets onPlay when given (Library rows open the
 *   player) and falls back to the row's own onPress (the pre-M2
 *   behaviour on Home/Search — opening the theme);
 * - the bookmark tile renders only with onToggleSave, filled accent
 *   when the theme is saved, and spins while that slug's toggle is in
 *   flight (state comes from the shared favorites store);
 * - the remove (×) tile renders only with onRemove (playlist owner).
 * An optional `detail` caption sits under the meta line (watch
 * history's mode · relative time). An optional `durationText`
 * ("1:30") leads the right-side tile row — the playlist design's
 * row anatomy (duration + save + play); screens pass it only when
 * the item's duration is known.
 * - the ⋮ menu tile (design law #8, Slice 5) closes the tile row —
 *   duration + … + ⋮ per the design's row anatomy — and opens the
 *   shared ThemeRowMenu (Play / View theme / Save / Add to playlist /
 *   Download, all wired). It renders unless `menu={false}`.
 */
export function ThemeRow({
  item,
  onPress,
  onPlay,
  saved,
  savePending,
  onToggleSave,
  onRemove,
  detail,
  metaText,
  durationText,
  menu = true,
}: {
  item: ThemeSummary;
  onPress?: () => void;
  onPlay?: () => void;
  saved?: boolean;
  savePending?: boolean;
  onToggleSave?: () => void;
  onRemove?: () => void;
  detail?: string;
  /**
   * Replacement for the default "anime · artist" meta line — the
   * Artist detail design shows the ANIME title alone on its rows.
   */
  metaText?: string;
  durationText?: string;
  menu?: boolean;
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
        {/* Design law #9: long titles wrap (2 lines), never
            ellipsis-truncate next to the row's chips/tiles. */}
        <Text style={styles.song} numberOfLines={2}>
          {item.songTitle}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {metaText ?? (
            <>
              {item.animeTitle}
              {artist ? ` · ${artist}` : ''}
            </>
          )}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      <View style={styles.side}>
        <View style={styles.typeChip}>
          <Text
            style={[
              styles.type,
              { color: item.type === 'ED' ? theme.tertiary : theme.accent },
            ]}
          >
            {item.type} {item.sequence}
          </Text>
        </View>
        <View style={styles.tiles}>
          {durationText ? (
            <Text style={styles.duration}>{durationText}</Text>
          ) : null}
          {onRemove && (
            <Pressable
              onPress={onRemove}
              hitSlop={7}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.songTitle} from playlist`}
              style={({ pressed }) => [
                styles.action,
                pressed && styles.pressed,
              ]}
            >
              <X size={14} color={theme.muted} strokeWidth={2} />
            </Pressable>
          )}
          {onToggleSave && (
            <Pressable
              onPress={onToggleSave}
              hitSlop={7}
              accessibilityRole="button"
              accessibilityLabel={
                saved ? `Unsave ${item.songTitle}` : `Save ${item.songTitle}`
              }
              accessibilityState={{ selected: !!saved }}
              style={({ pressed }) => [
                styles.action,
                pressed && styles.pressed,
              ]}
            >
              {savePending ? (
                <ActivityIndicator size="small" color={theme.muted} />
              ) : (
                <Bookmark
                  size={15}
                  color={saved ? theme.accent : theme.muted}
                  fill={saved ? theme.accent : 'transparent'}
                  strokeWidth={2}
                />
              )}
            </Pressable>
          )}
          <Pressable
            onPress={onPlay ?? onPress}
            hitSlop={7}
            accessibilityRole="button"
            accessibilityLabel={`Play ${item.songTitle}`}
            style={({ pressed }) => [
              styles.action,
              pressed && styles.pressed,
            ]}
          >
            <Play size={15} color={theme.accent} fill={theme.accent} strokeWidth={2} />
          </Pressable>
          {menu && (
            <ThemeRowMenu item={item} onPlay={onPlay} onOpen={onPress} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  row: {
    // Lavender Dusk rows: white cards, not hairline-separated lines.
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    minHeight: 56,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.card,
    marginBottom: spacing.sm,
  },
  pressed: {
    opacity: 0.7,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
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
    fontSize: 14,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  meta: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  detail: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  side: {
    alignItems: 'flex-end',
    gap: 4,
  },
  tiles: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  duration: {
    ...typeStyles.caption,
    color: theme.muted,
    marginRight: spacing.xs,
  },
  typeChip: {
    backgroundColor: theme.accentContainer,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  type: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    letterSpacing: 0.3,
  },
  action: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

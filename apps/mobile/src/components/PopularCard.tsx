import { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppImage } from './AppImage';
import { themeCoverForSlot } from '../imageVariants';
import { Heart, Play } from 'lucide-react-native';
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

/**
 * Popular Themes card — ported from the website's ThemeListRow
 * (kaisen-src/app/components/theme/ThemeListRow.tsx) for the Home
 * Popular list: a soft accent-container card at radius cardLg with a
 * larger rounded thumbnail, song title + artist, a circular accent
 * play button, and a heart favourite toggle (accent-filled when
 * saved, muted-filled when not — the web's heart treatment). No rank
 * numbers, no OP/ED badge, no download button (owner's call,
 * 2026-11-08).
 *
 * The heart is the favorites affordance for this list: it is wired to
 * the same shared favorites store the old bookmark tile used
 * (optimistic toggle + rollback + per-slug pending), so behaviour is
 * unchanged — only the icon and its home moved. Home-specific: the
 * shared ThemeRow keeps its bookmark treatment on Search/Library/
 * Playlist/Profile, untouched by this port.
 */
export function PopularCard({
  item,
  onPress,
  onPlay,
  saved,
  savePending,
  onToggleSave,
}: {
  item: ThemeSummary;
  onPress?: () => void;
  onPlay?: () => void;
  saved?: boolean;
  savePending?: boolean;
  onToggleSave?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  // Row thumbnail: the SMALL cover variant (perf problem 11).
  const cover = themeCoverForSlot(item, 'row');
  const artist = item.artistName ?? item.allArtists.join(', ');
  const subtitle = artist || item.animeTitle;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      {cover ? (
        <AppImage source={cover} style={styles.thumb} recyclingKey={item.slug} />
      ) : (
        <View style={[styles.thumb, styles.placeholder]} />
      )}
      <View style={styles.main}>
        {/* Song titles wrap (polish-pass law #9): the audit
            flagged truncation here; the artist line below still
            truncates, as the mocks draw it. */}
        <Text style={styles.song} numberOfLines={2}>
          {item.songTitle}
        </Text>
        {subtitle ? (
          <Text style={styles.artist} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onPlay ?? onPress}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Play ${item.songTitle}`}
        style={({ pressed }) => [
          styles.playButton,
          pressed && styles.pressed,
        ]}
      >
        <Play
          size={15}
          color={theme.accent}
          fill={theme.accent}
          strokeWidth={2}
        />
      </Pressable>
      {onToggleSave && (
        <Pressable
          onPress={onToggleSave}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={
            saved
              ? `Unfavourite ${item.songTitle}`
              : `Favourite ${item.songTitle}`
          }
          accessibilityState={{ selected: !!saved }}
          style={({ pressed }) => [
            styles.heartButton,
            pressed && styles.pressed,
          ]}
        >
          {savePending ? (
            <ActivityIndicator size="small" color={theme.muted} />
          ) : (
            <Heart
              size={20}
              color={saved ? theme.accent : theme.muted}
              fill={saved ? theme.accent : 'transparent'}
              strokeWidth={2}
            />
          )}
        </Pressable>
      )}
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.cardLg,
    // Lavender Dusk glass (design law #3), measured from Home v3 in
    // Slice 6: the Popular rows are FROSTED — white at 65% over the
    // lavender page, defined by a soft hairline. RN has no backdrop
    // blur in this stack, so the measured translucency value is the
    // treatment (the handoff pack's accepted implementation); the
    // dark theme's surface takes the same 65% over its background.
    backgroundColor: withOpacity(theme.surface, 0.65),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  pressed: {
    opacity: 0.75,
  },
  thumb: {
    width: 60,
    height: 60,
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
    fontFamily: fontFamilies.display,
    fontSize: 15,
    color: theme.text,
  },
  artist: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: withOpacity(theme.accent, 0.15),
    alignItems: 'center',
    justifyContent: 'center',
  },
  heartButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

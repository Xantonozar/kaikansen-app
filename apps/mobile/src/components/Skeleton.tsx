import { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { radii, spacing, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { usePosterCardWidth } from '../layout';

/**
 * Loading skeletons (owner's lazy-loading order, 2026-11-10) —
 * Lavender Dusk-toned placeholder blocks shaped like the content
 * they stand in for, so a section's slot holds its size and shape
 * while its data is in flight and the layout never jumps when the
 * real content lands. Static blocks in the theme's own tones
 * (raised lavender on the page, surface cards with the shared
 * hairline) — the same tones the real components use for their
 * image placeholders.
 */
export function SkeletonBlock({
  width,
  height,
  radius = radii.base,
  tone = 'raised',
  style,
}: {
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  tone?: 'raised' | 'surface' | 'container';
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const backgroundColor =
    tone === 'surface'
      ? theme.surface
      : tone === 'container'
        ? theme.accentContainer
        : theme.raised;
  return (
    <View
      style={[
        { width, height, borderRadius: radius, backgroundColor },
        style,
      ]}
    />
  );
}

/** Poster-card skeleton — the Home season rail's card shape. */
export function SkeletonPosterCard() {
  const width = usePosterCardWidth();
  return (
    <SkeletonBlock
      width={width}
      height={Math.round(width / 0.74)}
      radius={radii.cardLg}
    />
  );
}

/**
 * Theme-row skeleton — the Library rows' white card: 52pt thumb,
 * two text bars, the play-disc circle, in ThemeRow's own frame
 * (padding, radius, bottom margin).
 */
export function SkeletonThemeRow() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.rowCard}>
      <SkeletonBlock width={52} height={52} radius={radii.md} />
      <View style={styles.rowMain}>
        <SkeletonBlock width="62%" height={13} radius={6} />
        <SkeletonBlock width="38%" height={11} radius={5} />
      </View>
      <SkeletonBlock width={32} height={32} radius={radii.pill} />
    </View>
  );
}

/**
 * Popular-row skeleton — Home's Popular card shape: 60pt thumb,
 * two text bars, the 36pt play/heart circles, in PopularCard's
 * frosted frame. Home spaces the rows itself (its list gap).
 */
export function SkeletonPopularRow() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.popularCard}>
      <SkeletonBlock width={60} height={60} radius={radii.md} />
      <View style={styles.rowMain}>
        <SkeletonBlock width="58%" height={14} radius={6} />
        <SkeletonBlock width="36%" height={11} radius={5} />
      </View>
      <SkeletonBlock width={36} height={36} radius={radii.pill} />
    </View>
  );
}

/**
 * Feed-row skeleton — one Friends Activity row: 40pt avatar, two
 * sentence bars, the 40pt thumb and 32pt play disc (the feed card
 * itself is the screen's own frame; this is only the row).
 */
export function SkeletonFeedRow() {
  return (
    <View style={feedRowStyles.row}>
      <SkeletonBlock width={40} height={40} radius={radii.pill} />
      <View style={feedRowStyles.main}>
        <SkeletonBlock width="72%" height={12} radius={6} />
        <SkeletonBlock width="44%" height={11} radius={5} />
      </View>
      <SkeletonBlock width={40} height={40} radius={radii.base} />
      <SkeletonBlock width={32} height={32} radius={radii.pill} />
    </View>
  );
}

const feedRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  main: {
    flex: 1,
    gap: 6,
  },
});

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    rowCard: {
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
    popularCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radii.cardLg,
      backgroundColor: withOpacity(theme.surface, 0.65),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    rowMain: {
      flex: 1,
      gap: 6,
    },
  });

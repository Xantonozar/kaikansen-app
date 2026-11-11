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

/**
 * Person-row skeleton — one Network row: the 44pt avatar
 * circle, two text bars and the follow pill, in the Network
 * card's own row frame (16pt padding — the screen's rows).
 */
export function SkeletonPersonRow() {
  return (
    <View style={personRowStyles.row}>
      <SkeletonBlock width={44} height={44} radius={radii.pill} />
      <View style={personRowStyles.main}>
        <SkeletonBlock width="46%" height={13} radius={6} />
        <SkeletonBlock width="30%" height={11} radius={5} />
      </View>
      <SkeletonBlock width={64} height={28} radius={radii.pill} />
    </View>
  );
}

const personRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  main: {
    flex: 1,
    gap: 6,
  },
});

/**
 * Leaderboard-row skeleton — one board row card: position bar,
 * the 44pt avatar circle, two text bars, the 44pt rank-icon
 * tile and the RP bar, in RankRow's board frame (surface card,
 * card radius, the row's own padding).
 */
export function SkeletonRankRow() {
  const theme = useTheme();
  const styles = useMemo(() => createRankRowStyles(theme), [theme]);
  return (
    <View style={styles.boardRow}>
      <SkeletonBlock width={16} height={16} radius={5} />
      <SkeletonBlock width={44} height={44} radius={radii.pill} />
      <View style={styles.main}>
        <SkeletonBlock width="52%" height={14} radius={6} />
        <SkeletonBlock width="34%" height={11} radius={5} />
      </View>
      <SkeletonBlock width={44} height={44} radius={radii.base} />
      <SkeletonBlock width={30} height={15} radius={6} />
    </View>
  );
}

const createRankRowStyles = (theme: Theme) =>
  StyleSheet.create({
    boardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    main: {
      flex: 1,
      gap: 6,
    },
  });

/**
 * Notification-row skeleton — one Notifications row: the actor
 * avatar circle, two text bars (the sentence + its time line),
 * in the list's own row frame (14pt padding, row gap).
 */
export function SkeletonNotificationRow() {
  return (
    <View style={notificationRowStyles.row}>
      <SkeletonBlock width={40} height={40} radius={radii.pill} />
      <View style={notificationRowStyles.main}>
        <SkeletonBlock width="82%" height={13} radius={6} />
        <SkeletonBlock width="30%" height={11} radius={5} />
      </View>
    </View>
  );
}

const notificationRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: 14,
  },
  main: {
    flex: 1,
    gap: 6,
    paddingTop: 2,
  },
});

/**
 * Room-row skeleton — one Quiz Lobby public-room row: the 40pt
 * host avatar, two text bars (room title + host line) and the
 * Join pill, in the lobby card's row frame.
 */
export function SkeletonRoomRow() {
  return (
    <View style={roomRowStyles.row}>
      <SkeletonBlock width={40} height={40} radius={radii.pill} />
      <View style={roomRowStyles.main}>
        <SkeletonBlock width="56%" height={13} radius={6} />
        <SkeletonBlock width="34%" height={11} radius={5} />
      </View>
      <SkeletonBlock width={56} height={30} radius={radii.pill} />
    </View>
  );
}

const roomRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  main: {
    flex: 1,
    gap: 6,
  },
});

/**
 * Ladder-row skeleton — one Rank Ladder row: the rank-icon tile,
 * two text bars (rank name + threshold line) and the standing
 * chip — the ladder list's row anatomy, for the page-load state.
 */
export function SkeletonLadderRow() {
  const theme = useTheme();
  const styles = useMemo(() => createLadderRowStyles(theme), [theme]);
  return (
    <View style={styles.row}>
      <SkeletonBlock width={44} height={44} radius={radii.base} />
      <View style={styles.main}>
        <SkeletonBlock width="48%" height={14} radius={6} />
        <SkeletonBlock width="30%" height={11} radius={5} />
      </View>
      <SkeletonBlock width={52} height={24} radius={radii.pill} />
    </View>
  );
}

const createLadderRowStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      marginBottom: spacing.sm,
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

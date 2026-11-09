import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { RankLeaderboardEntry } from '@kaikansen/contracts';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { Avatar } from './Avatar';
import { formatRp, tierLabel, tierLine } from '../rankUtil';

/**
 * One RP leaderboard row. Two geometries:
 *
 * - `standard` (default): the quiz hub preview row — position,
 *   avatar, display name over its tier line, and the RP figure
 *   right; the signed-in user's row is tinted with the lavender
 *   container and carries the YOU pill.
 * - `board`: the full Leaderboard screen's rows, re-measured
 *   against that screen's Stitch HTML (px-4/py-2.5 full-bleed
 *   rows in the unpadded grouped card, 32px avatars, 12px RP,
 *   tier in the mauve secondary, the viewer's row as an INSET
 *   rounded card with the accent border). The board shows the
 *   username (the mock's bold line; the Notifications slice set
 *   the same precedent) and the plain tier name. `onPress` makes
 *   the row tappable (the board routes to the user's profile).
 */
export function RankRow({
  position,
  entry,
  isYou,
  bordered = false,
  variant = 'standard',
  onPress,
}: {
  position: number;
  entry: RankLeaderboardEntry;
  isYou: boolean;
  bordered?: boolean;
  variant?: 'standard' | 'board';
  onPress?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const board = variant === 'board';
  const name = board ? entry.username : entry.displayName || entry.username;

  const rowStyle = board
    ? [
        styles.boardRow,
        bordered && !isYou && styles.boardRowBordered,
        isYou && styles.boardRowYou,
      ]
    : [
        styles.row,
        bordered && !isYou && styles.rowBordered,
        isYou && styles.rowYou,
      ];

  const inner = (
    <>
      <Text
        style={
          board
            ? [styles.boardPosition, isYou && styles.boardAccentText]
            : styles.position
        }
      >
        {position}
      </Text>
      <View
        style={
          board
            ? isYou
              ? styles.boardAvatarYou
              : styles.boardAvatar
            : undefined
        }
      >
        <Avatar
          url={entry.avatarUrl}
          name={name}
          seed={entry.username}
          size={board ? 32 : 40}
        />
      </View>
      <View style={board ? styles.boardMain : styles.main}>
        <View style={board ? styles.boardNameRow : styles.nameRow}>
          <Text
            style={
              board
                ? [styles.boardName, isYou && styles.boardAccentText]
                : styles.name
            }
            numberOfLines={1}
          >
            {name}
          </Text>
          {isYou && (
            <View style={board ? styles.boardYouPill : styles.youPill}>
              <Text style={board ? styles.boardYouText : styles.youText}>
                YOU
              </Text>
            </View>
          )}
        </View>
        <Text
          style={board ? styles.boardTier : styles.tier}
          numberOfLines={1}
        >
          {board ? tierLabel(entry.tier) : tierLine(entry.tier, entry.division)}
        </Text>
      </View>
      <Text
        style={
          board
            ? [styles.boardRp, isYou && styles.boardAccentText]
            : styles.rp
        }
      >
        {formatRp(entry.rp)}
      </Text>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`View ${name}'s profile`}
        style={rowStyle}
      >
        {inner}
      </Pressable>
    );
  }
  return <View style={rowStyle}>{inner}</View>;
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm + 2,
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.sm,
    },
    rowBordered: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowYou: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.base,
    },
    position: {
      ...typeStyles.mono,
      color: theme.muted,
      width: 22,
      textAlign: 'center',
    },
    main: {
      flex: 1,
      gap: 1,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    name: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.text,
      flexShrink: 1,
    },
    youPill: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    youText: {
      ...typeStyles.caption,
      color: theme.onAccent,
    },
    tier: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    rp: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.text,
    },
    /* Board variant — the Leaderboard screen's HTML values. */
    boardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: spacing.lg,
    },
    boardRowBordered: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      // The HTML's pale divide (#F0EBF0): the border token at
      // 0.6, the Notifications slice's treatment for grouped
      // card hairlines.
      borderBottomColor: withOpacity(theme.border, 0.6),
    },
    boardRowYou: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.base,
      borderWidth: 1,
      // The HTML's accent-at-10% inset border.
      borderColor: withOpacity(theme.accent, 0.1),
      marginHorizontal: 6,
      marginVertical: 2,
      paddingHorizontal: spacing.md,
    },
    boardPosition: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.text,
      width: 20,
    },
    boardAvatar: {
      marginLeft: spacing.sm,
    },
    boardAvatarYou: {
      marginLeft: 6,
    },
    boardMain: {
      flex: 1,
      marginLeft: spacing.md,
      gap: 1,
    },
    boardNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    boardName: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.text,
      flexShrink: 1,
    },
    boardYouPill: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    boardYouText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 10,
      color: theme.onAccent,
    },
    boardTier: {
      ...typeStyles.caption,
      color: theme.secondary,
    },
    boardRp: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.text,
    },
    boardAccentText: {
      color: theme.accent,
    },
  });

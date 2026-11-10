import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { RankLeaderboardEntry } from '@kaikansen/contracts';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { Avatar } from './Avatar';
import { formatRp, ladderLabel, standingOf } from '../rankUtil';
import { RankIcon } from './RankIcon';

/**
 * One RP leaderboard row. Two geometries:
 *
 * - `standard` (default): the quiz hub preview row — position,
 *   avatar, display name over its ladder-rank line, the rank
 *   icon chip and the RP figure right; the signed-in user's
 *   row is tinted with the lavender container and carries the
 *   YOU pill.
 * - `board`: the full Leaderboard screen's rows, per the
 *   owner-approved rank mock (2026-11-10): each row is its OWN
 *   white card — position, avatar LEFT, username over the
 *   ladder-rank name line, the rank icon chip (a pale tile,
 *   ~44px) RIGHT of the name block, then the bold RP figure.
 *   The anatomy is owner-confirmed: avatar never moves to the
 *   card, the icon never leaves the right side. The viewer's
 *   row keeps its lavender tint + YOU pill. The board shows
 *   the username (the mock's bold line). `onPress` makes the
 *   row tappable (the board routes to the user's profile).
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
  const standing = standingOf(entry);

  const rowStyle = board
    ? [styles.boardRow, isYou && styles.boardRowYou]
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
      <Avatar
        url={entry.avatarUrl}
        name={name}
        seed={entry.username}
        size={board ? 44 : 40}
      />
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
          {ladderLabel(standing.rank)}
        </Text>
      </View>
      <RankIcon rank={standing.rank} size={board ? 44 : 36} />
      <Text
        style={
          board
            ? [styles.boardRp, isYou && styles.boardAccentText]
            : styles.rp
        }
      >
        {board ? entry.rp.toLocaleString('en-US') : formatRp(entry.rp)}
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
    /* Board variant — the approved rank mock's row cards. */
    boardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    boardRowYou: {
      backgroundColor: theme.accentContainer,
    },
    boardPosition: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 16,
      color: theme.accent,
      width: 22,
      textAlign: 'center',
    },
    boardMain: {
      flex: 1,
      gap: 1,
    },
    boardNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    boardName: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
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
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    boardRp: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
      color: theme.text,
    },
    boardAccentText: {
      color: theme.accent,
    },
  });

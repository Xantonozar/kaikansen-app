import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { RankLeaderboardEntry } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { Avatar } from './Avatar';
import { formatRp, tierLine } from '../rankUtil';

/**
 * One RP leaderboard row (quiz hub preview + the leaderboard
 * screen): position, avatar, name over its tier line, and the RP
 * figure right. The signed-in user's row is tinted with the
 * lavender container and carries the YOU pill, as drawn in the
 * Lavender Dusk mocks. `bordered` draws the hairline the
 * leaderboard card separates its rows with.
 */
export function RankRow({
  position,
  entry,
  isYou,
  bordered = false,
}: {
  position: number;
  entry: RankLeaderboardEntry;
  isYou: boolean;
  bordered?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const name = entry.displayName || entry.username;

  return (
    <View
      style={[
        styles.row,
        bordered && !isYou && styles.rowBordered,
        isYou && styles.rowYou,
      ]}
    >
      <Text style={styles.position}>{position}</Text>
      <Avatar url={entry.avatarUrl} name={name} seed={entry.username} size={40} />
      <View style={styles.main}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {isYou && (
            <View style={styles.youPill}>
              <Text style={styles.youText}>YOU</Text>
            </View>
          )}
        </View>
        <Text style={styles.tier} numberOfLines={1}>
          {tierLine(entry.tier, entry.division)}
        </Text>
      </View>
      <Text style={styles.rp}>{formatRp(entry.rp)}</Text>
    </View>
  );
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
  });

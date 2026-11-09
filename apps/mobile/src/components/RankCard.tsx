import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Medal } from 'lucide-react-native';
import type { UserRankProfile } from '@kaikansen/contracts';
import { radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import {
  divisionChip,
  formatRp,
  tierLabel,
  tierProgress,
} from '../rankUtil';

/**
 * The Lavender Dusk rank card (quiz hub, top) — medal in a
 * lavender disc, tier name + division chip, the RP total, a
 * progress bar through the current tier and the right-aligned
 * "N RP to <next tier>" line. At Kage the next-target line and
 * the bar's remainder simply complete: tier + RP only.
 */
/**
 * The rank card's loading state (design polish pass): the same
 * card shell with muted placeholder shapes where the medal disc,
 * tier/RP lines and progress bar will land. Callers render this
 * while /rank/me is in flight instead of letting the card vanish
 * (the fidelity audit's Quiz Hub / Profile delta).
 */
export function RankCardSkeleton() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.card} accessibilityLabel="Loading your rank">
      <View style={styles.headRow}>
        <View style={[styles.disc, styles.skeletonDisc]} />
        <View style={styles.nameBlock}>
          <View style={[styles.skeletonBar, styles.skeletonTier]} />
          <View style={[styles.skeletonBar, styles.skeletonRp]} />
        </View>
      </View>
      <View style={styles.barTrack} />
    </View>
  );
}

export function RankCard({ profile }: { profile: UserRankProfile }) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const progress = tierProgress(profile.rp, profile.tier);
  const chip = divisionChip(profile.division);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View style={styles.disc}>
          <Medal size={20} color={theme.accent} strokeWidth={2} />
        </View>
        <View style={styles.nameBlock}>
          <View style={styles.tierRow}>
            <Text style={styles.tierName}>{tierLabel(profile.tier)}</Text>
            {chip && (
              <View style={styles.chip}>
                <Text style={styles.chipText}>{chip}</Text>
              </View>
            )}
          </View>
          <Text style={styles.rpText}>{formatRp(profile.rp)}</Text>
        </View>
        {progress.nextTier && (
          <Text style={styles.toNext}>
            {progress.toNext.toLocaleString('en-US')} RP to{' '}
            {tierLabel(progress.nextTier)}
          </Text>
        )}
      </View>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${Math.round(progress.fraction * 100)}%` },
          ]}
        />
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.lg,
      gap: spacing.md,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    disc: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    nameBlock: {
      flex: 1,
      gap: 2,
    },
    tierRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    tierName: {
      ...typeStyles.heading,
      color: theme.text,
    },
    chip: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    chipText: {
      ...typeStyles.caption,
      color: theme.onAccentContainer,
    },
    rpText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    toNext: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'right',
    },
    skeletonDisc: {
      backgroundColor: theme.accentContainer,
    },
    skeletonBar: {
      height: 12,
      borderRadius: 6,
      backgroundColor: theme.raised,
    },
    skeletonTier: {
      width: '45%',
    },
    skeletonRp: {
      width: '30%',
    },
    barTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.accentContainer,
      overflow: 'hidden',
    },
    barFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: theme.accent,
    },
  });

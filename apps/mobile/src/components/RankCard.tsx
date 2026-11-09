import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Medal } from 'lucide-react-native';
import type { UserRankProfile } from '@kaikansen/contracts';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../theme';
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

/**
 * The quiz RESULTS rank card (Quiz Results mock, solo §6.25) —
 * the same profile source and rank helpers as RankCard, drawn to
 * the results layout: medal disc + tier name / RP total, the
 * progress bar, and the "N RP to <next tier>" caption
 * right-aligned UNDER the bar. The results mock draws the tier
 * name alone, so there is no division chip here. The sage
 * "+N RP" pill at the head row's right renders ONLY when
 * `gainedRp` is a real positive gain the just-finished session
 * granted (multiplayer rooms award RP via room:rank-updated);
 * solo runs award no RP, so solo passes nothing and the pill
 * stays hidden.
 */
export function RankResultCard({
  profile,
  gainedRp,
}: {
  profile: UserRankProfile;
  gainedRp?: number;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createResultStyles(theme), [theme]);
  const progress = tierProgress(profile.rp, profile.tier);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <View style={styles.disc}>
          <Medal size={20} color={theme.accent} strokeWidth={2} />
        </View>
        <View style={styles.nameBlock}>
          <Text style={styles.tierName}>{tierLabel(profile.tier)}</Text>
          <Text style={styles.rpText}>{formatRp(profile.rp)}</Text>
        </View>
        {gainedRp != null && gainedRp > 0 && (
          <View style={styles.gainPill}>
            <Text style={styles.gainPillText}>
              +{gainedRp.toLocaleString('en-US')} RP
            </Text>
          </View>
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
      {progress.nextTier && (
        <Text style={styles.toNext}>
          {progress.toNext.toLocaleString('en-US')} RP to{' '}
          {tierLabel(progress.nextTier)}
        </Text>
      )}
    </View>
  );
}

/**
 * The PROFILE rank card (Profile §6.15) — same profile source
 * and rank helpers as RankCard, drawn to the Profile mock's own
 * measurements, which differ from the Quiz Hub card's (36px
 * medal disc, 16px card radius, square division chip,
 * medium-weight RP line, semibold next-tier line in the head
 * row): each surface follows its own mock — the RankResultCard
 * precedent above.
 */
export function RankProfileCard({ profile }: { profile: UserRankProfile }) {
  const theme = useTheme();
  const styles = useMemo(() => createProfileStyles(theme), [theme]);
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

const createProfileStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.surface,
      // The Profile mock's cards are rounded-2xl (16) — radii.md,
      // not the radii.card the Quiz Hub card sits at.
      borderRadius: radii.md,
      padding: spacing.lg,
      gap: 10,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    disc: {
      width: 36,
      height: 36,
      borderRadius: 18,
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
      gap: 6,
    },
    tierName: {
      ...typeStyles.display,
      fontSize: 16,
      color: theme.text,
    },
    chip: {
      backgroundColor: theme.accentContainer,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    chipText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 10,
      color: theme.onAccentContainer,
    },
    rpText: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.muted,
    },
    toNext: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.muted,
      textAlign: 'right',
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

const createResultStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.lg,
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
    tierName: {
      ...typeStyles.heading,
      fontSize: 16,
      color: theme.text,
    },
    rpText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    gainPill: {
      backgroundColor: theme.successContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
    },
    gainPillText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.success,
    },
    barTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.accentContainer,
      overflow: 'hidden',
      marginTop: spacing.md,
    },
    barFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: theme.accent,
    },
    toNext: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'right',
      marginTop: spacing.md,
    },
  });

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

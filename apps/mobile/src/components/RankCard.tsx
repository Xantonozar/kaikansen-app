import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UserRankProfile } from '@kaikansen/contracts';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { formatRp, ladderLabel, standingOf } from '../rankUtil';
import { RankIcon } from './RankIcon';

/**
 * The Quiz Hub rank card (approved rank mock, 2026-11-10): the
 * rank's icon tile (84px pale square) at the left, "YOUR RANK"
 * eyebrow, the ladder rank's name large, the RP total STACKED
 * under it (the mockups stack it — where the Stitch HTML put it
 * right-aligned, the mockups rule), the progress bar toward
 * the ladder target and the "N RP to <target>" line under it.
 * The hub draws the "Rank card only" footer below the bar —
 * that line is the hub screen's own; this card ends at the
 * to-next line. At Pirate King the bar completes and the
 * to-next line goes away.
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
  const standing = standingOf(profile);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <RankIcon rank={standing.rank} size={84} tileRadius={20} />
        <View style={styles.nameBlock}>
          <Text style={styles.eyebrow}>YOUR RANK</Text>
          <Text style={styles.rankName}>{ladderLabel(standing.rank)}</Text>
          <Text style={styles.rpText}>{formatRp(profile.rp)}</Text>
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.round(standing.fraction * 100)}%` },
              ]}
            />
          </View>
          {standing.nextRank && (
            <Text style={styles.toNext}>
              {standing.toNext.toLocaleString('en-US')} RP to{' '}
              {ladderLabel(standing.nextRank)}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * The quiz RESULTS rank card (Quiz Results mock, solo §6.25) —
 * the same profile source as RankCard, drawn to the results
 * layout: the rank's icon tile + rank name / RP total, the
 * progress bar, and the "N RP to <target>" caption
 * right-aligned UNDER the bar. The RP pill at the head row's
 * right renders ONLY when `gainedRp` is a real change the
 * just-finished session granted: sage "+N RP" for a gain
 * (multiplayer rooms via room:rank-updated; solo runs since
 * the owner's 2026-11-16 solo-RP order, which superseded the
 * old solo-never-shows-a-pill rule), danger "−N RP" for a
 * loss (solo's under-5 tiers and multiplayer's negative
 * placements alike). Zero or absent stays hidden.
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
  const standing = standingOf(profile);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <RankIcon rank={standing.rank} size={44} />
        <View style={styles.nameBlock}>
          <Text style={styles.tierName}>{ladderLabel(standing.rank)}</Text>
          <Text style={styles.rpText}>{formatRp(profile.rp)}</Text>
        </View>
        {gainedRp != null && gainedRp > 0 && (
          <View style={styles.gainPill}>
            <Text style={styles.gainPillText}>
              +{gainedRp.toLocaleString('en-US')} RP
            </Text>
          </View>
        )}
        {gainedRp != null && gainedRp < 0 && (
          <View style={styles.lossPill}>
            <Text style={styles.lossPillText}>
              −{Math.abs(gainedRp).toLocaleString('en-US')} RP
            </Text>
          </View>
        )}
      </View>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${Math.round(standing.fraction * 100)}%` },
          ]}
        />
      </View>
      {standing.nextRank && (
        <Text style={styles.toNext}>
          {standing.toNext.toLocaleString('en-US')} RP to{' '}
          {ladderLabel(standing.nextRank)}
        </Text>
      )}
    </View>
  );
}

/**
 * The PROFILE QUIZ RANK card (approved rank mock, 2026-11-10) —
 * a standalone white card on the own-Profile screen: the
 * rank's icon tile (60px since the Profile compact pass,
 * 2026-11-12 — it was 84px), "QUIZ RANK" eyebrow, "Jonin ·
 * 5,340 RP" as one line, the progress bar with the "N RP to
 * <target>" line UNDER it, and the "View full ladder ›" link
 * at the card's bottom-left (the mockup's placement) opening
 * /quiz/ladder. The whole card is the press target as well.
 * At Pirate King the to-next line goes away; the link stays.
 * Its Texts carry the Profile screen's 1.15 font-scaling cap.
 */
export function RankProfileCard({
  profile,
  onOpenLadder,
}: {
  profile: UserRankProfile;
  onOpenLadder: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createProfileStyles(theme), [theme]);
  const standing = standingOf(profile);

  return (
    <Pressable
      onPress={onOpenLadder}
      accessibilityRole="button"
      accessibilityLabel={`Quiz rank ${ladderLabel(standing.rank)}, ${formatRp(profile.rp)}. View the full rank ladder`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.headRow}>
        <RankIcon rank={standing.rank} size={60} tileRadius={16} />
        <View style={styles.nameBlock}>
          <Text style={styles.eyebrow} maxFontSizeMultiplier={1.15}>
            QUIZ RANK
          </Text>
          <Text style={styles.rankLine} maxFontSizeMultiplier={1.15}>
            {ladderLabel(standing.rank)} · {formatRp(profile.rp)}
          </Text>
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.round(standing.fraction * 100)}%` },
              ]}
            />
          </View>
          {standing.nextRank && (
            <Text style={styles.toNext} maxFontSizeMultiplier={1.15}>
              {standing.toNext.toLocaleString('en-US')} RP to{' '}
              {ladderLabel(standing.nextRank)}
            </Text>
          )}
        </View>
      </View>
      <Text style={styles.ladderLink} maxFontSizeMultiplier={1.15}>
        View full ladder ›
      </Text>
    </Pressable>
  );
}

const createProfileStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.surface,
      // The approved Profile mock's cards sit at radii.card (24)
      // like the screen's other cards. Padding lg since the
      // Profile compact pass (2026-11-12).
      borderRadius: radii.card,
      padding: spacing.lg,
      gap: spacing.lg,
    },
    pressed: {
      opacity: 0.85,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
    },
    nameBlock: {
      flex: 1,
      gap: 6,
    },
    eyebrow: {
      fontFamily: fontFamilies.sectionLabel,
      fontSize: 11,
      letterSpacing: 1,
      color: theme.secondary,
    },
    rankLine: {
      fontFamily: fontFamilies.display,
      fontSize: 18,
      color: theme.text,
    },
    toNext: {
      ...typeStyles.bodySmall,
      fontSize: 11,
      color: theme.muted,
    },
    ladderLink: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.accent,
    },
    barTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.accentContainer,
      overflow: 'hidden',
    },
    barFill: {
      height: '100%',
      borderRadius: 3,
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
    lossPill: {
      backgroundColor: theme.dangerContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 1,
    },
    lossPillText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.danger,
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
      padding: spacing.xl,
      gap: spacing.md,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
    },
    disc: {
      // The skeleton's placeholder for the icon tile.
      width: 84,
      height: 84,
      borderRadius: 20,
      backgroundColor: theme.accentContainer,
    },
    nameBlock: {
      flex: 1,
      gap: 6,
    },
    eyebrow: {
      fontFamily: fontFamilies.sectionLabel,
      fontSize: 12,
      letterSpacing: 1,
      color: theme.secondary,
    },
    rankName: {
      fontFamily: fontFamilies.display,
      fontSize: 30,
      color: theme.text,
    },
    rpText: {
      ...typeStyles.body,
      fontSize: 15,
      color: theme.muted,
    },
    toNext: {
      ...typeStyles.bodySmall,
      color: theme.muted,
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
      marginTop: 2,
    },
    barFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: theme.accent,
    },
  });

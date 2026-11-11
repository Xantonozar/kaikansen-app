import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Check, ChevronLeft, Lock } from 'lucide-react-native';
import type { UserRankProfile } from '@kaikansen/contracts';
import { cacheKeyFor, fixtureMode, subscribeCache } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { fetchMyRank } from '../../../src/socialApi';
import { RankIcon } from '../../../src/components/RankIcon';
import { SkeletonLadderRow } from '../../../src/components/Skeleton';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import {
  LADDER,
  formatRp,
  ladderLabel,
  standingOf,
} from '../../../src/rankUtil';

/**
 * The plum of the approved rank designs (mockups + Stitch
 * HTML): the ladder header card and the leaderboard's pinned
 * card sit on the icons' own deep plum, #3D2436 — a design
 * colour of this surface family, not a Lavender Dusk theme
 * token (the theme has no equivalent; the value is the
 * designs', measured in rank-ladder-stitch.html).
 */
const PLUM = '#3D2436';
const PLUM_BAR_TRACK = 'rgba(247, 242, 247, 0.22)';
const PLUM_BAR_FILL = '#D8A7C0';
const PLUM_SUB = 'rgba(247, 242, 247, 0.75)';

/**
 * Rank Ladder (owner-approved design, 2026-11-10): the full
 * 24-rank ladder. Header: back arrow + "Rank Ladder" +
 * "24 ranks · quiz multiplayer RP". Then the dark plum
 * your-rank card — icon tile, "YOUR RANK", the rank name, the
 * RP stacked under it, the progress bar, "N RP to <target>",
 * and the footer "Earn RP in multiplayer quiz matches". Then
 * all 24 rows in ladder order: icon, name, "N RP · <anime>",
 * a sage ✓ disc for every reached rank, the current rank's
 * row highlighted pale with the mauve YOU pill, and unreached
 * rows dimmed with a solid grey lock.
 *
 * Standing comes from GET /rank/me; signed-out (or demo) the
 * screen still draws the ladder with no standing: no header
 * card, no YOU row, every row locked.
 */
export default function LadderScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const [myRank, setMyRank] = useState<UserRankProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    if (!signedIn) {
      setMyRank(null);
      setLoading(false);
      return;
    }
    try {
      setMyRank(await fetchMyRank());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your rank.');
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /* Silent swap (perf problem 5): a background revalidation of
     the USER-cached /rank/me replaces the standing in place. */
  useEffect(() => {
    if (fixtureMode || !signedIn) return;
    return subscribeCache<UserRankProfile>(cacheKeyFor('/rank/me'), (fresh) =>
      setMyRank(fresh),
    );
  }, [signedIn]);

  const standing = myRank ? standingOf(myRank) : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <ChevronLeft size={26} color={theme.text} strokeWidth={2.25} />
        </Pressable>
        <View style={styles.headerTexts}>
          <Text style={styles.title}>Rank Ladder</Text>
          <Text style={styles.subtitle}>24 ranks · quiz multiplayer RP</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          {loading ? (
            /* Ladder's initial load (skeleton sweep): the
               rank-row shapes the list below renders — the
               below-fold rows live under it regardless. */
            <View style={styles.rows}>
              {[0, 1, 2, 3].map((i) => (
                <SkeletonLadderRow key={i} />
              ))}
            </View>
          ) : error ? (
            <View style={styles.stateBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                onPress={() => void load()}
                accessibilityRole="button"
                accessibilityLabel="Retry loading your rank"
                style={styles.retryLink}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : myRank && standing ? (
            <View style={styles.youCard}>
              <View style={styles.youHead}>
                <RankIcon rank={standing.rank} size={92} tileRadius={20} />
                <View style={styles.youMain}>
                  <Text style={styles.youEyebrow}>YOUR RANK</Text>
                  <Text style={styles.youName}>
                    {ladderLabel(standing.rank)}
                  </Text>
                  <Text style={styles.youRp}>{formatRp(myRank.rp)}</Text>
                  <View style={styles.youBarTrack}>
                    <View
                      style={[
                        styles.youBarFill,
                        {
                          width: `${Math.round(standing.fraction * 100)}%`,
                        },
                      ]}
                    />
                  </View>
                  {standing.nextRank && (
                    <Text style={styles.youToNext}>
                      {standing.toNext.toLocaleString('en-US')} RP to{' '}
                      {ladderLabel(standing.nextRank)}
                    </Text>
                  )}
                </View>
              </View>
              <Text style={styles.youFooter}>
                Earn RP in multiplayer quiz matches
              </Text>
            </View>
          ) : (
            <Text style={styles.signedOutNote}>
              {fixtureMode
                ? 'Demo mode — sign in with the live API to see your standing.'
                : 'Sign in to see your standing on the ladder.'}
            </Text>
          )}

          <View style={styles.rows}>
            {LADDER.map((info, i) => {
              const isYou = standing !== null && standing.index === i;
              const state = isYou
                ? 'you'
                : standing !== null && i <= standing.index
                  ? 'reached'
                  : 'locked';
              return (
                <View
                  key={info.rank}
                  style={[
                    styles.row,
                    isYou && styles.rowYou,
                    state === 'locked' && styles.rowLocked,
                  ]}
                  accessibilityLabel={
                    isYou
                      ? `${info.label}, ${info.min.toLocaleString('en-US')} RP, your current rank`
                      : state === 'reached'
                        ? `${info.label}, ${info.min.toLocaleString('en-US')} RP, reached`
                        : `${info.label}, ${info.min.toLocaleString('en-US')} RP, locked`
                  }
                >
                  <RankIcon rank={info.rank} size={52} />
                  <View style={styles.rowMain}>
                    <Text
                      style={[
                        styles.rowName,
                        state === 'locked' && styles.rowNameLocked,
                      ]}
                      numberOfLines={1}
                    >
                      {info.label}
                    </Text>
                    <Text
                      style={[
                        styles.rowMeta,
                        state === 'locked' && styles.rowMetaLocked,
                      ]}
                      numberOfLines={1}
                    >
                      {info.min.toLocaleString('en-US')} RP · {info.source}
                    </Text>
                  </View>
                  {isYou ? (
                    <View style={styles.youPill}>
                      <Text style={styles.youPillText}>YOU</Text>
                    </View>
                  ) : state === 'reached' ? (
                    <View style={styles.checkDisc}>
                      <Check
                        size={15}
                        color={theme.onAccent}
                        strokeWidth={3}
                      />
                    </View>
                  ) : (
                    <Lock size={22} color={theme.muted} strokeWidth={2} />
                  )}
                </View>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
    },
    backHit: {
      width: 36,
      height: 36,
      marginLeft: -4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTexts: {
      gap: 1,
    },
    title: {
      fontFamily: fontFamilies.display,
      fontSize: 24,
      letterSpacing: -0.5,
      color: theme.text,
    },
    subtitle: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    scroll: {
      flex: 1,
    },
    content: {
      paddingHorizontal: spacing.xl,
      paddingBottom: spacing.xxxl,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      gap: spacing.xl,
    },
    spin: {
      paddingVertical: spacing.xxl,
    },
    stateBox: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xl,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.secondary,
      textAlign: 'center',
    },
    retryLink: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    retryText: {
      ...typeStyles.bodySmall,
      color: theme.accent,
    },
    signedOutNote: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
      paddingVertical: spacing.md,
    },
    youCard: {
      backgroundColor: PLUM,
      borderRadius: radii.card,
      padding: spacing.xl,
      gap: spacing.lg,
    },
    youHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
    },
    youMain: {
      flex: 1,
      gap: 5,
    },
    youEyebrow: {
      fontFamily: fontFamilies.sectionLabel,
      fontSize: 11,
      letterSpacing: 1.2,
      color: PLUM_BAR_FILL,
    },
    youName: {
      fontFamily: fontFamilies.display,
      fontSize: 30,
      color: '#F7F2F7',
    },
    youRp: {
      ...typeStyles.body,
      fontSize: 15,
      color: PLUM_SUB,
    },
    youBarTrack: {
      height: 8,
      borderRadius: 4,
      backgroundColor: PLUM_BAR_TRACK,
      overflow: 'hidden',
      marginTop: 3,
    },
    youBarFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: PLUM_BAR_FILL,
    },
    youToNext: {
      ...typeStyles.bodySmall,
      color: PLUM_SUB,
    },
    youFooter: {
      ...typeStyles.bodySmall,
      color: withOpacity('#F7F2F7', 0.65),
    },
    rows: {
      gap: spacing.md + 2,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
    },
    rowYou: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.md,
      paddingVertical: spacing.md,
    },
    rowLocked: {
      opacity: 0.62,
    },
    rowMain: {
      flex: 1,
      gap: 2,
    },
    rowName: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 16,
      color: theme.text,
    },
    rowNameLocked: {
      color: theme.muted,
    },
    rowMeta: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    rowMetaLocked: {
      color: withOpacity(theme.muted, 0.85),
    },
    youPill: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
    },
    youPillText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      color: theme.onAccent,
    },
    checkDisc: {
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: theme.success,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });

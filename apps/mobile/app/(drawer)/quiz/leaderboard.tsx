import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type {
  RankLeaderboardEntry,
  UserRankProfile,
} from '@kaikansen/contracts';
import { cacheKeyFor, fixtureMode, subscribeCache } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import {
  fetchMyRank,
  fetchRankLeaderboard,
} from '../../../src/socialApi';
import { RankRow } from '../../../src/components/RankRow';
import { RankIcon } from '../../../src/components/RankIcon';
import { SkeletonRankRow } from '../../../src/components/Skeleton';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';
import {
  planBoardLoad,
  rememberBoard,
} from '../../../src/leaderboardMemory';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { formatRp, ladderLabel, standingOf } from '../../../src/rankUtil';

/** The approved rank designs' deep plum (see ladder.tsx). */
const PLUM = '#3D2436';
const PLUM_SUB = 'rgba(247, 242, 247, 0.75)';

/**
 * Leaderboard — the owner-approved rank design (2026-11-10),
 * with the WEEKLY board made real by the fix batch
 * (2026-11-11): back header, the "All-time" / "Weekly" mauve
 * pills (BOTH live segments now), each ranked row as its OWN
 * white card (position, avatar LEFT, name + ladder-rank line,
 * rank icon chip RIGHT, RP figure — the owner-confirmed
 * anatomy), and the pinned DARK PLUM your-rank card at the
 * bottom: rank icon tile LEFT (NO avatar — the owner's
 * "Prev one was better" ruling), "Your rank #N" + "Rank ·
 * N RP", and the YOU pill. Rows tap through to the player's
 * public profile.
 *
 * Data is GET /rank/leaderboard (the web's /api/leaderboard
 * port: top 100 by RP) plus GET /rank/me for the caller's
 * standing. The Weekly segment fetches `?scope=weekly`: rows
 * whose `rp` is the week's RP (RankHistory sums since Monday
 * 00:00 Asia/Dhaka) while every row's ladder/tier still derives
 * from LIFETIME RP — RankRow draws exactly that, unchanged.
 * The pinned card always speaks lifetime: position and figure
 * come from the ACTIVE board's rows when the caller is on it,
 * but the rank line is the caller's lifetime standing either
 * way; on Weekly a caller outside the week's top 100 gets the
 * card without a position, the same honest posture as all-time.
 *
 * An empty week is an honest empty state ("No games finished
 * this week yet") — the tab is enabled, never faked.
 *
 * Polish batch (2026-11-11): the rows ride a FlatList (the
 * board can hold 100) with the pills + Weekly caption as list
 * header chrome and board-shaped skeleton rows while loading;
 * the Weekly scope carries its one-line caption ("RP earned
 * this week · resets Monday 00:00") so the week's figures are
 * never mistaken for lifetime RP.
 *
 * Speed addendum (2026-11-11): the last loaded board per scope
 * is remembered in session memory (src/leaderboardMemory.ts) —
 * a revisit paints it instantly while the fetch refreshes
 * behind it; a failed refresh against a remembered board is
 * silent (the remembered rows stay), a cold failure keeps the
 * error state. The fetch ALWAYS runs (Weekly freshness).
 */
export default function LeaderboardScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const [scope, setScope] = useState<'all-time' | 'weekly'>('all-time');
  const [entries, setEntries] = useState<RankLeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [myRank, setMyRank] = useState<UserRankProfile | null>(null);

  const load = useCallback(async () => {
    /* Paint-first (owner addendum, 2026-11-11): a remembered
       board for this scope paints instantly and the fetch
       refreshes behind it; first-ever visits keep the
       skeleton. Weekly's no-cache freshness rule stands —
       the fetch ALWAYS runs; memory is paint-first only. */
    const plan = planBoardLoad(scope);
    setEntries(plan.paint);
    setError(null);
    try {
      const res = await fetchRankLeaderboard(scope);
      setEntries(res.leaderboard);
      rememberBoard(scope, res.leaderboard);
    } catch (e) {
      /* A failure against a remembered board keeps it silently
         (no error state); a cold failure keeps today's error. */
      if (plan.showErrorOnFailure) {
        setError(
          e instanceof Error ? e.message : 'Could not load the leaderboard.',
        );
      }
    }
    if (signedIn) {
      try {
        setMyRank(await fetchMyRank());
      } catch {
        setMyRank(null);
      }
    } else {
      setMyRank(null);
    }
  }, [signedIn, scope]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /* Silent swaps (perf problem 5): background revalidations of
     the USER-cached rank reads replace the painted copies. */
  useEffect(() => {
    if (fixtureMode) return;
    const offBoard = subscribeCache(
      cacheKeyFor('/rank/leaderboard'),
      (fresh: { leaderboard: RankLeaderboardEntry[] }) => {
        setEntries(fresh.leaderboard);
      },
    );
    const offMine = signedIn
      ? subscribeCache(
          cacheKeyFor('/rank/me'),
          (fresh: UserRankProfile) => setMyRank(fresh),
        )
      : () => {};
    return () => {
      offBoard();
      offMine();
    };
  }, [signedIn]);

  const myPosition = useMemo(() => {
    if (!entries || !myRank) return null;
    const idx = entries.findIndex((e) => e.userId === myRank.userId);
    return idx >= 0 ? idx + 1 : null;
  }, [entries, myRank]);

  /** The caller's figure on the ACTIVE board (weekly: their
   *  week's RP from their row; all-time: their lifetime RP). */
  const myBoardEntry = useMemo(() => {
    if (!entries || !myRank) return null;
    return entries.find((e) => e.userId === myRank.userId) ?? null;
  }, [entries, myRank]);

  const myStanding = myRank ? standingOf(myRank) : null;

  // The drawer navigator shows no header, so the screen clears the
  // status bar / notch itself — the sibling drawer screens' pattern
  // (season, anime, artist): SafeAreaView with the top edge. This
  // screen shipped with a plain View root, so its header collided
  // with the status bar — the same defect Search had (owner report
  // 2026-11-10). Bottom needs no edge: the scroll content already
  // pads itself (styles.content).
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <ChevronLeft size={26} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>Leaderboard</Text>
      </View>

      {/* The rows ride a FlatList (polish batch): up to 100
          board cards virtualise instead of painting at once.
          The pills, the Weekly caption and every state (loading
          skeletons, error, empty) are the list's header, so the
          chrome above the rows is pixel-identical to the old
          ScrollView layout; the pin card stays pinned below. */}
      <FlatList
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        data={entries ?? []}
        keyExtractor={(entry) => entry.userId}
        ItemSeparatorComponent={() => <View style={styles.rowGap} />}
        renderItem={({ item: entry, index: i }) => (
          <View style={styles.column}>
            <RankRow
              variant="board"
              position={i + 1}
              entry={entry}
              isYou={myRank !== null && entry.userId === myRank.userId}
              onPress={() => router.push(`/user/${entry.username}`)}
            />
          </View>
        )}
        ListHeaderComponent={
          <View style={styles.column}>
          {/* The timeframe segments — both live (fix batch
              2026-11-11): the active board wears the mauve
              filled pill, the idle one the pale surface pill. */}
          <View
            style={styles.pillRow}
            accessibilityLabel={`Timeframe: ${scope === 'weekly' ? 'this week' : 'all time'}.`}
          >
            <Pressable
              onPress={() => setScope('all-time')}
              accessibilityRole="button"
              accessibilityState={{ selected: scope === 'all-time' }}
              accessibilityLabel="All-time leaderboard"
              style={[
                styles.pill,
                scope === 'all-time' ? styles.pillActive : styles.pillIdle,
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  scope === 'all-time'
                    ? styles.pillTextActive
                    : styles.pillTextIdle,
                ]}
              >
                All-time
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setScope('weekly')}
              accessibilityRole="button"
              accessibilityState={{ selected: scope === 'weekly' }}
              accessibilityLabel="Weekly leaderboard"
              style={[
                styles.pill,
                scope === 'weekly' ? styles.pillActive : styles.pillIdle,
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  scope === 'weekly'
                    ? styles.pillTextActive
                    : styles.pillTextIdle,
                ]}
              >
                Weekly
              </Text>
            </Pressable>
          </View>

          {scope === 'weekly' && (
            <Text style={styles.caption}>
              RP earned this week · resets Monday 00:00
            </Text>
          )}

          {entries === null && !error ? (
            <View style={styles.rows}>
              {[0, 1, 2, 3, 4].map((i) => (
                <SkeletonRankRow key={i} />
              ))}
            </View>
          ) : error ? (
            <View style={styles.stateBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                onPress={() => void load()}
                accessibilityRole="button"
                accessibilityLabel="Retry loading the leaderboard"
                style={styles.retryLink}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : entries && entries.length > 0 ? null : (
            <Text style={styles.emptyText}>
              {fixtureMode
                ? 'No rankings in demo mode.'
                : scope === 'weekly'
                  ? 'No games finished this week yet — be the first to earn RP this week.'
                  : 'No ranked players yet — play a quiz game to earn RP.'}
            </Text>
          )}
          </View>
        }
      />

      {myRank && myStanding && (
        <View style={styles.pinWrap}>
          <View style={styles.pinCard}>
            <RankIcon rank={myStanding.rank} size={64} tileRadius={16} />
            <View style={styles.pinMain}>
              <Text style={styles.pinTitle}>
                {myPosition
                  ? `Your rank #${myPosition}`
                  : 'Your rank'}
              </Text>
              <Text style={styles.pinSub}>
                {scope === 'weekly' && myBoardEntry
                  ? `${ladderLabel(myStanding.rank)} · ${formatRp(myBoardEntry.rp)} this week`
                  : `${ladderLabel(myStanding.rank)} · ${formatRp(myRank.rp)}`}
              </Text>
            </View>
            <View style={styles.pinYouPill}>
              <Text style={styles.pinYouText}>YOU</Text>
            </View>
          </View>
        </View>
      )}
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
      // This screen's HTML canvas is px-5 (20px), not the
      // shared 16px edge — the header, content and pin wrap
      // all carry the 20px inset (Room-waiting precedent).
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
    },
    backHit: {
      // The HTML's p-1 / -ml-1 bare arrow: a 36px hit area
      // nudged 4px left, 26px chevron.
      width: 36,
      height: 36,
      marginLeft: -4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      fontFamily: fontFamilies.display,
      fontSize: 24,
      letterSpacing: -0.5,
      color: theme.text,
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
    },
    /* The approved design's pills: the mauve filled pill for
       the real board, a pale surface pill for the disabled
       Weekly. */
    pillRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginBottom: spacing.lg,
    },
    pill: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    pillActive: {
      backgroundColor: theme.accent,
    },
    pillIdle: {
      backgroundColor: theme.surface,
    },
    pillText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
    },
    pillTextActive: {
      color: theme.onAccent,
    },
    pillTextIdle: {
      color: theme.muted,
    },
    rows: {
      gap: spacing.md,
    },
    rowGap: {
      height: spacing.md,
    },
    caption: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginBottom: spacing.lg,
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
    emptyText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
      paddingVertical: spacing.xl,
    },
    pinWrap: {
      paddingHorizontal: spacing.xl,
      paddingBottom: spacing.xxl,
      paddingTop: spacing.sm,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH + spacing.xl * 2,
      alignSelf: 'center',
    },
    pinCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      // The approved design's dark plum card (not a theme
      // token — see the file header).
      backgroundColor: PLUM,
      borderRadius: radii.card,
      padding: spacing.lg,
    },
    pinMain: {
      flex: 1,
      gap: 2,
    },
    pinTitle: {
      fontFamily: fontFamilies.display,
      fontSize: 17,
      letterSpacing: -0.3,
      color: '#F7F2F7',
    },
    pinSub: {
      ...typeStyles.bodySmall,
      color: PLUM_SUB,
    },
    pinYouPill: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
    },
    pinYouText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      color: theme.onAccent,
    },
  });

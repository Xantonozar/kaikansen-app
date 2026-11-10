import { useCallback, useMemo, useState } from 'react';
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
import { ChevronLeft } from 'lucide-react-native';
import type {
  RankLeaderboardEntry,
  UserRankProfile,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import {
  fetchMyRank,
  fetchRankLeaderboard,
} from '../../../src/socialApi';
import { RankRow } from '../../../src/components/RankRow';
import { RankIcon } from '../../../src/components/RankIcon';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';
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
 * Leaderboard — rebuilt to the owner-approved rank design
 * (2026-11-10): back header, the "All-time" mauve pill beside
 * the muted "Weekly · soon" pill, each ranked row as its OWN
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
 * standing.
 *
 * ⚠️ WEEKLY IS NOT REAL — flagged for the owner. The mock
 * selects "Weekly", but no weekly board exists anywhere in
 * this system: GET /rank/leaderboard takes no period
 * parameter; the shared snapshot schema's scope enum ALLOWS
 * 'weekly'/'monthly', yet the web's cron writer and
 * leaderboard route both hardcode scope 'global' / seasonId
 * 'all-time', so a weekly snapshot is never written; UserRank
 * carries no weekly RP field (its season block is the
 * all-time season); and `rankhistories` — the only rows a
 * weekly sum could come from — are read by nothing on the
 * web or here. The control therefore renders as drawn but
 * with "All time" as the active segment and "Weekly"
 * DISABLED: all-time data is never presented under a Weekly
 * label. Building a weekly board is a new API read + a
 * product decision, not a restyle.
 *
 * The pinned card needs the caller's position, which only
 * exists when they land inside the served top 100; a
 * signed-in caller outside it gets the card without a
 * position, and a signed-out caller gets no card at all.
 */
export default function LeaderboardScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const [entries, setEntries] = useState<RankLeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [myRank, setMyRank] = useState<UserRankProfile | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchRankLeaderboard();
      setEntries(res.leaderboard);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not load the leaderboard.',
      );
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
  }, [signedIn]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const myPosition = useMemo(() => {
    if (!entries || !myRank) return null;
    const idx = entries.findIndex((e) => e.userId === myRank.userId);
    return idx >= 0 ? idx + 1 : null;
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

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          {/* The approved design's pills — Weekly is disabled
              because no weekly board exists (see the header
              comment); All-time is the real, active pill. */}
          <View
            style={styles.pillRow}
            accessibilityLabel="Timeframe: all time. Weekly rankings are not tracked yet."
          >
            <View
              style={[styles.pill, styles.pillActive]}
              accessibilityState={{ selected: true }}
            >
              <Text style={[styles.pillText, styles.pillTextActive]}>
                All-time
              </Text>
            </View>
            <Pressable
              disabled
              accessibilityRole="button"
              accessibilityState={{ disabled: true, selected: false }}
              accessibilityLabel="Weekly — not available yet"
              style={[styles.pill, styles.pillIdle]}
            >
              <Text style={[styles.pillText, styles.pillTextIdle]}>
                Weekly · soon
              </Text>
            </Pressable>
          </View>

          {entries === null && !error ? (
            <ActivityIndicator color={theme.accent} style={styles.spin} />
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
          ) : entries && entries.length > 0 ? (
            <View style={styles.rows}>
              {entries.map((entry, i) => (
                <RankRow
                  key={entry.userId}
                  variant="board"
                  position={i + 1}
                  entry={entry}
                  isYou={myRank !== null && entry.userId === myRank.userId}
                  onPress={() => router.push(`/user/${entry.username}`)}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.emptyText}>
              {fixtureMode
                ? 'No rankings in demo mode.'
                : 'No ranked players yet — play a quiz game to earn RP.'}
            </Text>
          )}
        </View>
      </ScrollView>

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
                {ladderLabel(myStanding.rank)} · {formatRp(myRank.rp)}
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
      opacity: 0.7,
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

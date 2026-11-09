import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft, Medal } from 'lucide-react-native';
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
import { CONTENT_MAX_WIDTH } from '../../../src/layout';
import {
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { formatRp, tierLabel, tierProgress } from '../../../src/rankUtil';

/**
 * Leaderboard (layout-fidelity slice) — the Lavender Dusk board
 * from the design set: back header, the ranked rows in one white
 * card (the caller's row tinted with its YOU pill), and the
 * pinned mauve "Your rank" card at the bottom.
 *
 * Data is GET /rank/leaderboard (the web's /api/leaderboard port:
 * top 100 by RP) plus GET /rank/me for the caller's standing.
 * The design's Weekly/All-time toggle is NOT built: neither the
 * web board nor this API carries a period parameter — the board
 * is all-time, exactly like the web's "Global Rankings" page.
 * The pinned card needs the caller's position, which only
 * exists when they land inside the served top 100; a signed-in
 * caller outside it gets the card without a position, and a
 * signed-out caller gets no card at all.
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

  const myProgress = myRank
    ? tierProgress(myRank.rp, myRank.tier)
    : null;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>Leaderboard</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
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
            <View style={styles.card}>
              {entries.map((entry, i) => (
                <RankRow
                  key={entry.userId}
                  position={i + 1}
                  entry={entry}
                  isYou={myRank !== null && entry.userId === myRank.userId}
                  bordered={i < entries.length - 1}
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

      {myRank && (
        <View style={styles.pinWrap}>
          <View style={styles.pinCard}>
            <View style={styles.pinMain}>
              <Text style={styles.pinTitle}>
                {myPosition
                  ? `Your rank #${myPosition}`
                  : 'Your rank'}
              </Text>
              <Text style={styles.pinSub}>
                {formatRp(myRank.rp)}
                {myProgress?.nextTier
                  ? ` · ${myProgress.toNext.toLocaleString('en-US')} RP to ${tierLabel(myProgress.nextTier)}`
                  : ' · Top tier'}
              </Text>
            </View>
            <View style={styles.pinDisc}>
              <Medal size={20} color={theme.onAccent} strokeWidth={2} />
            </View>
          </View>
        </View>
      )}
    </View>
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
      gap: spacing.md,
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
    },
    backHit: {
      // Bare arrow (design polish pass): the mock's back is an
      // untiled chevron; the 44px box is only the hit area.
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.display,
      color: theme.text,
    },
    scroll: {
      flex: 1,
    },
    content: {
      padding: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xxxl,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.cardLg,
      padding: spacing.sm,
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
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.lg,
      paddingTop: spacing.sm,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH + spacing.screenEdge * 2,
      alignSelf: 'center',
    },
    pinCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.accent,
      borderRadius: radii.cardLg,
      padding: spacing.lg,
    },
    pinMain: {
      flex: 1,
      gap: 2,
    },
    pinTitle: {
      ...typeStyles.heading,
      color: theme.onAccent,
    },
    pinSub: {
      ...typeStyles.bodySmall,
      color: withOpacity(theme.onAccent, 0.85),
    },
    pinDisc: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: withOpacity(theme.onAccent, 0.18),
      alignItems: 'center',
      justifyContent: 'center',
    },
  });

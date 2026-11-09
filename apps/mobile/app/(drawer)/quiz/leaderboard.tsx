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
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { formatRp, tierLabel, tierProgress } from '../../../src/rankUtil';

/**
 * Leaderboard — rebuilt against the screen's Stitch mock/HTML:
 * back header, the Weekly/All-time segmented control, the
 * ranked rows full-bleed in one grouped white card (the
 * caller's row inset-tinted with its YOU pill), and the pinned
 * mauve "Your rank" card at the bottom. Rows tap through to
 * the player's public profile.
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
          {/* Segmented control, the mock's geometry — Weekly is
              disabled because no weekly board exists (see the
              header comment); All time is the real, active
              segment. */}
          <View
            style={styles.segmentTrack}
            accessibilityLabel="Timeframe: all time. Weekly rankings are not tracked yet."
          >
            <Pressable
              disabled
              accessibilityRole="button"
              accessibilityState={{ disabled: true, selected: false }}
              accessibilityLabel="Weekly — not available yet"
              style={[styles.segment, styles.segmentDisabled]}
            >
              <Text style={[styles.segmentText, styles.segmentTextIdle]}>
                Weekly
              </Text>
            </Pressable>
            <View
              style={[styles.segment, styles.segmentActive]}
              accessibilityState={{ selected: true }}
            >
              <Text style={[styles.segmentText, styles.segmentTextActive]}>
                All time
              </Text>
            </View>
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
            <View style={styles.card}>
              {entries.map((entry, i) => (
                <RankRow
                  key={entry.userId}
                  variant="board"
                  position={i + 1}
                  entry={entry}
                  isYou={myRank !== null && entry.userId === myRank.userId}
                  bordered={i < entries.length - 1}
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
              <Medal size={22} color={theme.onAccent} strokeWidth={2} />
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
    segmentTrack: {
      flexDirection: 'row',
      alignItems: 'center',
      // The HTML's pale track (#EFE8EE): the raised token is
      // the closest measured Lavender Dusk tone.
      backgroundColor: theme.raised,
      borderRadius: radii.pill,
      padding: 4,
      marginBottom: spacing.lg,
    },
    segment: {
      flex: 1,
      paddingVertical: 6,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segmentActive: {
      backgroundColor: theme.accent,
    },
    segmentDisabled: {
      opacity: 0.55,
    },
    segmentText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
    },
    segmentTextIdle: {
      color: theme.secondary,
    },
    segmentTextActive: {
      color: theme.onAccent,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.cardLg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      // Rows are full-bleed (their own px-4) with hairlines
      // spanning the card; the viewer's row is inset inside.
      overflow: 'hidden',
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
      backgroundColor: theme.accent,
      // The HTML's rounded-2xl (16) at p-4 (16).
      borderRadius: radii.md,
      padding: spacing.lg,
    },
    pinMain: {
      flex: 1,
      gap: 2,
    },
    pinTitle: {
      fontFamily: fontFamilies.display,
      fontSize: 18,
      letterSpacing: -0.3,
      color: theme.onAccent,
    },
    pinSub: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: withOpacity(theme.onAccent, 0.85),
    },
    pinDisc: {
      width: 40,
      height: 40,
      borderRadius: 20,
      // The HTML's white/15 disc with a white/10 rim.
      backgroundColor: withOpacity(theme.onAccent, 0.15),
      borderWidth: 1,
      borderColor: withOpacity(theme.onAccent, 0.1),
      alignItems: 'center',
      justifyContent: 'center',
    },
  });

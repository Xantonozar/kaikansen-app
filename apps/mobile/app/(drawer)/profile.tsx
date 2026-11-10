import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Bell,
  ChevronRight,
  Download,
  History,
  Pencil,
  RefreshCw,
  Settings as SettingsIcon,
  Star,
} from 'lucide-react-native';
import type { ProfileStats, UserRankProfile } from '@kaikansen/contracts';
import { cacheKeyFor, fixtureMode, subscribeCache } from '../../src/api';
import { useAuth } from '../../src/auth';
import { fetchMe } from '../../src/authApi';
import { Avatar } from '../../src/components/Avatar';
import { RankProfileCard } from '../../src/components/RankCard';
import { getAccessToken } from '../../src/session';
import { fetchMyRank } from '../../src/socialApi';
import {
  hasPaintableStats,
  paintableNumbers,
  readProfileStatsCache,
  writeProfileStatsCache,
  type CachedProfileStatsNumbers,
} from '../../src/profileStatsCache';
import {
  formatCount,
  formatHoursListened,
  formatMeanRating,
  formatThemesListened,
} from '../../src/profileStats';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Own Profile — the owner's FINAL design (approved 2026-11-10,
 * kaikansen-profile-v2-candidate): ONE hero card holding the
 * centered identity (avatar with a pencil badge, name, @handle),
 * the inline "N Followers · N Following" line ABOVE a full-width
 * Edit Profile pill — then the divided listening-stats card
 * (Mean Rating · Themes Listened · Hours Listened), the
 * standalone QUIZ RANK card (the approved rank mock's placement
 * — icon tile, "Jonin · N RP", bar, "View full ladder ›",
 * opening /quiz/ladder; it supersedes the earlier hero-embedded
 * rank row), the five-row menu card, and Log Out. No banner, no
 * AniList-connected pill.
 *
 * Data: identity + stats ride GET /auth/me (the session profile,
 * refreshed on mount so the aggregates are current — register /
 * login payloads carry no stats); the rank row rides
 * GET /rank/me. The stats are the API's ProfileStats aggregates:
 * meanRating is the mean of the scores the user GAVE (null →
 * "—"), themesListened counts distinct history themes, hours are
 * totalListenedSeconds / 3600. Followers/Following tap through
 * to the Network screen for the user's own account. The avatar
 * (and its pencil badge) and the Edit Profile pill all open the
 * Edit Profile screen, where the avatar picker lives.
 *
 * Instant paint (perf problem 4): the last stats the app saved
 * for this account (src/profileStatsCache) paint the moment the
 * screen opens; the /auth/me refresh behind them swaps the fresh
 * values in silently and re-saves them. A record the app's own
 * listen/rate actions marked dirty paints only its follow
 * counts — the stats wait for the fetch rather than show
 * numbers the app knows are stale. A cold open (no record)
 * behaves exactly as before: dashes until the session profile
 * carries stats.
 *
 * Menu targets (unchanged): Listening History opens the Library
 * on its Recent segment, My Ratings the public own-profile
 * screen (where the ratings list lives), AniList Sync the
 * Settings AniList rows (link state + action). A failed
 * satellite read degrades to a dash or a hidden rank row, never
 * a fabricated number.
 */
export default function OwnProfileScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status, user, logout, updateUser } = useAuth();
  const signedIn = status === 'signedIn' && user !== null;

  const [rank, setRank] = useState<UserRankProfile | null>(null);
  const [rankLoading, setRankLoading] = useState(false);
  /** The instant-paint cache snapshot for this account (perf 4). */
  const [cachedNumbers, setCachedNumbers] =
    useState<CachedProfileStatsNumbers | null>(null);
  const [cachedHasStats, setCachedHasStats] = useState(false);

  const userId = user?.id;
  const username = user?.username;

  /* Silent swap (perf problem 5): a background revalidation of
     the USER-cached /rank/me replaces the rank card in place.
     The stats themselves keep painting from the problem-4 store
     (profileStatsCache) — untouched by this job. */
  useEffect(() => {
    if (!signedIn || fixtureMode) return;
    return subscribeCache<UserRankProfile>(cacheKeyFor('/rank/me'), (fresh) =>
      setRank(fresh),
    );
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setRankLoading(true);
    fetchMyRank()
      .then((r) => live && setRank(r))
      .catch(() => live && setRank(null))
      .finally(() => live && setRankLoading(false));
    // Instant paint: load the saved stats for this account. The
    // refresh below swaps the fresh values in when they land.
    if (username) {
      readProfileStatsCache(username)
        .then((entry) => {
          if (!live) return;
          setCachedNumbers(paintableNumbers(entry));
          setCachedHasStats(hasPaintableStats(entry));
        })
        .catch(() => {});
    }
    // Refresh the session profile so the hero counts and the
    // listening stats are current (the login payload predates
    // them). A failure keeps the session copy — the stats just
    // render their dash state.
    const token = fixtureMode ? null : getAccessToken();
    if (token) {
      fetchMe(token)
        .then((profile) => {
          if (live && profile.id === userId) updateUser(profile);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // Re-read when the signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Keep the cache current: every session profile that carries
  // stats re-saves them (and un-dirties the record after the
  // app's own listen/rate actions marked it).
  const sessionStats = user?.stats;
  useEffect(() => {
    if (!username || !sessionStats) return;
    void writeProfileStatsCache(username, sessionStats);
  }, [username, sessionStats]);

  const onLogout = async () => {
    await logout();
    router.replace('/(tabs)');
  };

  const menuRow = (
    Icon: typeof Bell,
    label: string,
    onPress: () => void,
    last = false,
  ) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.menuRow,
        !last && styles.menuRowDivider,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.menuIcon}>
        <Icon size={18} color={theme.onAccentContainer} strokeWidth={2} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
      <ChevronRight size={16} color={theme.muted} strokeWidth={2} />
    </Pressable>
  );

  const stat = (label: string, value: string, divided = false) => (
    <View style={[styles.statBlock, divided && styles.statBlockDivided]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );

  const stats = user?.stats;
  const followers =
    stats?.followersCount ??
    cachedNumbers?.followersCount ??
    user?.totalFollowers ??
    0;
  const following =
    stats?.followingCount ??
    cachedNumbers?.followingCount ??
    user?.totalFollowing ??
    0;
  // The stats card's display source: the fresh session stats
  // when they exist, else the cache paint (only when the record
  // carries paintable stats — a dirty record's stats are
  // known-stale and keep the dash state until the fetch lands).
  const statsForCard: ProfileStats | undefined =
    stats ??
    (cachedHasStats && cachedNumbers
      ? { ...cachedNumbers }
      : undefined);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Text style={styles.title}>Profile</Text>
        <Pressable
          onPress={() => router.push('/settings')}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Open settings"
          style={styles.backHit}
        >
          <View style={styles.gearCircle}>
            <SettingsIcon size={20} color={theme.muted} strokeWidth={1.75} />
          </View>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {!signedIn || !user ? (
          <>
            <Text style={styles.note}>You’re not signed in.</Text>
            <Pressable
              onPress={() => router.replace('/login')}
              style={styles.primary}
              accessibilityRole="button"
            >
              <Text style={styles.primaryLabel}>Log in</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.heroCard}>
              <Pressable
                onPress={() => router.push('/edit-profile')}
                accessibilityRole="button"
                accessibilityLabel="Edit profile picture"
                style={({ pressed }) => [
                  styles.avatarWrap,
                  pressed && styles.pressed,
                ]}
              >
                <Avatar
                  url={user.avatarUrl}
                  name={user.displayName || user.username}
                  seed={user.id}
                  size={84}
                />
                <View style={styles.pencilBadge}>
                  <Pencil size={13} color={theme.onAccent} strokeWidth={2.25} />
                </View>
              </Pressable>

              <Text style={styles.displayName} numberOfLines={1}>
                {user.displayName || user.username}
              </Text>
              <Text style={styles.handle}>@{user.username}</Text>

              <View style={styles.socialRow}>
                <Pressable
                  onPress={() =>
                    router.push(`/network/${user.username}?tab=followers`)
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`${followers} followers`}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <Text style={styles.socialText}>
                    <Text style={styles.socialNumber}>
                      {formatCount(followers)}
                    </Text>{' '}
                    Followers
                  </Text>
                </Pressable>
                <Text style={styles.socialDot}>·</Text>
                <Pressable
                  onPress={() =>
                    router.push(`/network/${user.username}?tab=following`)
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`${following} following`}
                  style={({ pressed }) => pressed && styles.pressed}
                >
                  <Text style={styles.socialText}>
                    <Text style={styles.socialNumber}>
                      {formatCount(following)}
                    </Text>{' '}
                    Following
                  </Text>
                </Pressable>
              </View>

              <Pressable
                onPress={() => router.push('/edit-profile')}
                accessibilityRole="button"
                accessibilityLabel="Edit profile"
                style={({ pressed }) => [
                  styles.editPill,
                  pressed && styles.pressed,
                ]}
              >
                <Pencil
                  size={15}
                  color={theme.onAccentContainer}
                  strokeWidth={2}
                />
                <Text style={styles.editPillText}>Edit Profile</Text>
              </Pressable>

            </View>

            <View style={styles.statsCard}>
              {stat(
                'Mean Rating',
                statsForCard ? formatMeanRating(statsForCard) : '—',
              )}
              {stat(
                'Themes Listened',
                statsForCard ? formatThemesListened(statsForCard) : '—',
                true,
              )}
              {stat(
                'Hours Listened',
                statsForCard ? formatHoursListened(statsForCard) : '—',
                true,
              )}
            </View>

            {rank ? (
              <RankProfileCard
                profile={rank}
                onOpenLadder={() => router.push('/quiz/ladder')}
              />
            ) : rankLoading ? (
              <View
                style={styles.rankSkeletonCard}
                accessibilityLabel="Loading your rank"
              >
                <View style={styles.rankSkeletonDisc} />
                <View style={styles.rankSkeletonLines}>
                  <View style={styles.rankSkeletonBar} />
                  <View style={styles.rankSkeletonBarShort} />
                </View>
              </View>
            ) : null}

            <View style={styles.menuCard}>
              {menuRow(History, 'Listening History', () =>
                router.push('/(drawer)/(tabs)/library?segment=recent'),
              )}
              {menuRow(Star, 'My Ratings', () =>
                router.push(`/user/${user.username}`),
              )}
              {menuRow(Download, 'Downloads', () =>
                router.push('/downloads'),
              )}
              {menuRow(Bell, 'Notifications', () =>
                router.push('/notifications'),
              )}
              {menuRow(
                RefreshCw,
                'AniList Sync',
                () => router.push('/settings'),
                true,
              )}
            </View>

            <Pressable
              onPress={() => void onLogout()}
              accessibilityRole="button"
              accessibilityLabel="Log out"
              style={({ pressed }) => [
                styles.logout,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.logoutLabel}>Log Out</Text>
            </Pressable>
          </>
        )}
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
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    backHit: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    gearCircle: {
      // The mock's gear sits in a plain WHITE circle — surface
      // fill, fully round, hairline edge. 40px disc (w-10 h-10).
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      // The mock's screen title is text-2xl bold (24) — the
      // display face at 24, not the 18px section heading.
      ...typeStyles.display,
      fontSize: 24,
      letterSpacing: -0.5,
      color: theme.text,
      flex: 1,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    heroCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.xl,
      marginTop: spacing.sm,
      alignItems: 'center',
    },
    avatarWrap: {
      // Hosts the pencil badge at the avatar's bottom-right.
      position: 'relative',
    },
    pencilBadge: {
      position: 'absolute',
      right: 0,
      bottom: 2,
      width: 26,
      height: 26,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
      borderWidth: 2,
      borderColor: theme.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    displayName: {
      ...typeStyles.display,
      fontSize: 22,
      color: theme.text,
      marginTop: spacing.md,
      textAlign: 'center',
    },
    handle: {
      ...typeStyles.body,
      fontSize: 14,
      color: theme.muted,
      marginTop: 2,
      textAlign: 'center',
    },
    socialRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    socialText: {
      ...typeStyles.body,
      fontSize: 15,
      color: theme.muted,
    },
    socialNumber: {
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    socialDot: {
      ...typeStyles.body,
      fontSize: 15,
      color: theme.muted,
    },
    editPill: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      alignSelf: 'stretch',
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      minHeight: 44,
      marginTop: spacing.lg,
    },
    editPillText: {
      ...typeStyles.body,
      fontSize: 15,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    /* The rank card's loading shell (RankProfileCard's shape:
       an icon tile beside two lines). */
    rankSkeletonCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.xl,
      marginTop: 14,
    },
    rankSkeletonDisc: {
      width: 84,
      height: 84,
      borderRadius: 20,
      backgroundColor: theme.raised,
    },
    rankSkeletonLines: {
      flex: 1,
      gap: spacing.sm,
    },
    rankSkeletonBar: {
      width: '70%',
      height: 14,
      borderRadius: 7,
      backgroundColor: theme.raised,
    },
    rankSkeletonBarShort: {
      width: '45%',
      height: 10,
      borderRadius: 5,
      backgroundColor: theme.raised,
    },
    statsCard: {
      flexDirection: 'row',
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingVertical: 18,
      paddingHorizontal: spacing.sm,
      marginTop: 14,
    },
    statBlock: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
    },
    statBlockDivided: {
      // The mock's vertical hairlines between stat columns.
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: theme.border,
    },
    statValue: {
      ...typeStyles.display,
      fontSize: 24,
      color: theme.text,
    },
    statLabel: {
      ...typeStyles.bodySmall,
      fontSize: 13,
      color: theme.muted,
    },
    menuCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      // No horizontal padding on the card: the mock's rows carry
      // their own padding and its hairlines run full-bleed.
      overflow: 'hidden',
      marginTop: 14,
    },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    menuRowDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    menuIcon: {
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    menuLabel: {
      ...typeStyles.body,
      fontSize: 15,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      flex: 1,
    },
    logout: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 36,
      marginTop: 14,
    },
    logoutLabel: {
      // Muted mauve in the mock, centered under the menu card.
      ...typeStyles.body,
      fontSize: 15,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
    },
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: spacing.md,
      lineHeight: 16,
    },
    primary: {
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.lg,
    },
    primaryLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    pressed: {
      opacity: 0.85,
    },
  });

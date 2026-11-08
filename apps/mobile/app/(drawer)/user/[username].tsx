import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronLeft,
  Headphones,
  Pencil,
  Play,
  Star,
  UserCheck,
  UserPlus,
} from 'lucide-react-native';
import type {
  NetworkResponse,
  UserActivityItem,
  UserHistoryResponse,
  UserPublicProfile,
  UserRankProfile,
  UserRatingsResponse,
  UserStats,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { PersonRow } from '../../../src/components/PersonRow';
import { ThemeRow } from '../../../src/components/ThemeRow';
import {
  fetchFollowState,
  fetchUserActivity,
  fetchUserHistory,
  fetchUserNetwork,
  fetchUserProfile,
  fetchUserRank,
  fetchUserRatings,
  fetchUserStats,
  followUser,
  unfollowUser,
} from '../../../src/socialApi';
import { relativeTime } from '../../../src/time';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

const PREVIEW_COUNT = 8;

function formatListened(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Public profile (Slice M5) — GET /users/:username and its satellite
 * reads: stats, network, activity, ratings, history, the rank chip
 * (GET /rank/:userId via the profile's id) and the caller's follow
 * state. Sections degrade independently: a failed satellite hides or
 * notes itself instead of taking the whole screen down.
 *
 * Activity is privacy-gated server-side (owner, or someone the owner
 * follows — everyone else gets an empty list). An empty list on
 * someone else's profile is therefore phrased as "isn't visible",
 * never filled in; on your own profile it is an honest "none yet".
 *
 * Follow/unfollow is optimistic (state + follower count flip
 * immediately, the response reconciles, an error reverts and shows
 * the server's message verbatim).
 */
export default function UserProfileScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { username } = useLocalSearchParams<{ username: string }>();
  const { status, user, updateUser } = useAuth();
  const signedIn = status === 'signedIn' && user !== null;

  const [profile, setProfile] = useState<UserPublicProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [rank, setRank] = useState<UserRankProfile | null>(null);
  const [network, setNetwork] = useState<NetworkResponse | null>(null);
  const [listTab, setListTab] = useState<'followers' | 'following' | null>(
    null,
  );
  const [activity, setActivity] = useState<UserActivityItem[] | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [ratings, setRatings] = useState<UserRatingsResponse | null>(null);
  const [history, setHistory] = useState<UserHistoryResponse | null>(null);

  const [isFollowing, setIsFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  const isOwn =
    signedIn &&
    profile !== null &&
    user.username.toLowerCase() === profile.username.toLowerCase();

  useEffect(() => {
    let live = true;
    setProfile(null);
    setLoadError(null);
    setStats(null);
    setRank(null);
    setNetwork(null);
    setListTab(null);
    setActivity(null);
    setActivityError(false);
    setRatings(null);
    setHistory(null);
    setIsFollowing(false);
    setFollowError(null);
    fetchUserProfile(username)
      .then((p) => {
        if (!live) return;
        setProfile(p);
        setFollowersCount(p.totalFollowers);
        // Satellites — each settles on its own.
        fetchUserStats(p.username)
          .then((s) => live && setStats(s))
          .catch(() => {});
        fetchUserRank(p.id)
          .then((r) => live && setRank(r))
          .catch(() => {});
        fetchUserNetwork(p.username)
          .then((n) => live && setNetwork(n))
          .catch(() => {});
        fetchUserActivity(p.username)
          .then((a) => live && setActivity(a.activity))
          .catch(() => live && setActivityError(true));
        fetchUserRatings(p.username)
          .then((r) => live && setRatings(r))
          .catch(() => live && setRatings({ ratings: [] }));
        fetchUserHistory(p.username)
          .then((h) => live && setHistory(h))
          .catch(() =>
            live &&
            setHistory({
              entries: [],
              meta: { total: 0, localCount: 0, remoteCount: 0, merged: false },
            }),
          );
        if (signedIn) {
          fetchFollowState(p.username)
            .then((f) => live && setIsFollowing(f.isFollowing))
            .catch(() => {});
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setLoadError(
            e instanceof Error ? e.message : 'Could not load this profile.',
          );
        }
      });
    return () => {
      live = false;
    };
    // signedIn is read once per profile load — a mid-view sign-in/out
    // remounts the app shell's session state anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const onToggleFollow = () => {
    if (!profile || followBusy) return;
    const target = !isFollowing;
    setFollowBusy(true);
    setFollowError(null);
    setIsFollowing(target);
    setFollowersCount((c) => Math.max(0, c + (target ? 1 : -1)));
    const call = target ? followUser : unfollowUser;
    call(profile.username)
      .then((res) => {
        // Reconcile with the server's answer (idempotent writes can
        // legitimately disagree with the optimistic flip — undo it)
        // and keep the session user's own following count in step,
        // so the Social feed's empty-state hint stays truthful.
        if (res.isFollowing !== target) {
          setIsFollowing(res.isFollowing);
          setFollowersCount((c) => Math.max(0, c + (target ? -1 : 1)));
        }
        if (res.isFollowing !== !target && user) {
          updateUser({
            ...user,
            totalFollowing: Math.max(
              0,
              user.totalFollowing + (res.isFollowing ? 1 : -1),
            ),
          });
        }
      })
      .catch((e: unknown) => {
        setIsFollowing(!target);
        setFollowersCount((c) => Math.max(0, c + (target ? -1 : 1)));
        setFollowError(
          e instanceof Error ? e.message : 'Could not update the follow.',
        );
      })
      .finally(() => setFollowBusy(false));
  };

  const openProfile = (name: string) => router.push(`/user/${name}`);
  const openTheme = (slug: string) => router.push(`/theme/${slug}`);

  const statBlock = (
    label: string,
    value: number,
    tab: 'followers' | 'following' | null,
  ) => (
    <Pressable
      onPress={() => tab && setListTab((t) => (t === tab ? null : tab))}
      disabled={!tab}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityState={{ selected: tab !== null && listTab === tab }}
      style={styles.statBlock}
    >
      <Text
        style={[
          styles.statValue,
          tab !== null && listTab === tab && styles.statValueActive,
        ]}
      >
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Pressable>
  );

  const listUsers = listTab ? (network?.[listTab] ?? []) : [];
  const visibleList = listUsers.filter((u) => u !== null);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {profile ? `@${profile.username}` : 'Profile'}
        </Text>
      </View>

      {loadError ? (
        <View style={styles.center}>
          <Text style={styles.message}>{loadError}</Text>
        </View>
      ) : !profile ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.identity}>
            <Avatar
              url={profile.avatarUrl}
              name={profile.displayName || profile.username}
              size={64}
            />
            <View style={styles.identityText}>
              <Text style={styles.displayName} numberOfLines={1}>
                {profile.displayName || profile.username}
              </Text>
              <Text style={styles.handle}>@{profile.username}</Text>
              {rank && (
                <View style={styles.rankChip}>
                  <Text style={styles.rankChipText}>
                    {rank.tier.charAt(0).toUpperCase() + rank.tier.slice(1)}
                    {rank.division ? ` ${rank.division}` : ''} · {rank.rp} RP
                  </Text>
                </View>
              )}
            </View>
          </View>

          {profile.bio.length > 0 && (
            <Text style={styles.bio}>{profile.bio}</Text>
          )}
          <Text style={styles.joined}>
            Joined{' '}
            {new Date(profile.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              year: 'numeric',
            })}
            {stats && stats.totalTime > 0
              ? ` · Listened ${formatListened(stats.totalTime)}`
              : ''}
          </Text>

          <View style={styles.statRow}>
            {statBlock('Followers', followersCount, 'followers')}
            {statBlock('Following', profile.totalFollowing, 'following')}
            {statBlock('Ratings', profile.totalRatings, null)}
          </View>

          {isOwn ? (
            <Pressable
              onPress={() => router.push('/settings')}
              accessibilityRole="button"
              accessibilityLabel="Edit profile"
              style={({ pressed }) => [
                styles.actionButton,
                styles.actionOutline,
                pressed && styles.pressed,
              ]}
            >
              <Pencil size={16} color={theme.text} strokeWidth={2} />
              <Text style={styles.actionOutlineText}>Edit profile</Text>
            </Pressable>
          ) : signedIn ? (
            <Pressable
              onPress={onToggleFollow}
              disabled={followBusy}
              accessibilityRole="button"
              accessibilityLabel={isFollowing ? 'Unfollow' : 'Follow'}
              accessibilityState={{ selected: isFollowing }}
              style={({ pressed }) => [
                styles.actionButton,
                isFollowing ? styles.actionOutline : styles.actionAccent,
                pressed && styles.pressed,
                followBusy && styles.actionBusy,
              ]}
            >
              {followBusy ? (
                <ActivityIndicator
                  size="small"
                  color={isFollowing ? theme.text : theme.onAccent}
                />
              ) : isFollowing ? (
                <>
                  <UserCheck size={16} color={theme.text} strokeWidth={2} />
                  <Text style={styles.actionOutlineText}>Following</Text>
                </>
              ) : (
                <>
                  <UserPlus size={16} color={theme.onAccent} strokeWidth={2} />
                  <Text style={styles.actionAccentText}>Follow</Text>
                </>
              )}
            </Pressable>
          ) : (
            <Pressable
              onPress={() => router.push('/login')}
              accessibilityRole="button"
              accessibilityLabel="Log in to follow"
              style={({ pressed }) => [
                styles.actionButton,
                styles.actionAccent,
                pressed && styles.pressed,
              ]}
            >
              <UserPlus size={16} color={theme.onAccent} strokeWidth={2} />
              <Text style={styles.actionAccentText}>Log in to follow</Text>
            </Pressable>
          )}
          {followError && <Text style={styles.errorText}>{followError}</Text>}

          {listTab && (
            <View style={styles.listSection}>
              <Text style={styles.sectionHeading}>
                {listTab === 'followers' ? 'Followers' : 'Following'}
              </Text>
              {network === null ? (
                <View style={styles.center}>
                  <ActivityIndicator color={theme.accent} />
                </View>
              ) : visibleList.length === 0 ? (
                <Text style={styles.note}>
                  {listTab === 'followers'
                    ? 'No followers yet.'
                    : 'Not following anyone yet.'}
                </Text>
              ) : (
                visibleList.map(
                  (person) =>
                    person && (
                      <PersonRow
                        key={person.id}
                        displayName={person.displayName}
                        username={person.username}
                        avatarUrl={person.avatarUrl}
                        onPress={() => openProfile(person.username)}
                      />
                    ),
                )
              )}
            </View>
          )}

          <Text style={styles.sectionHeading}>Recent activity</Text>
          {activity === null && !activityError ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : activityError ? (
            <Text style={styles.note}>Could not load activity.</Text>
          ) : activity && activity.length > 0 ? (
            activity.slice(0, PREVIEW_COUNT).map((item) => {
              const Icon =
                item.activityType === 'rating'
                  ? Star
                  : item.mode === 'listen'
                    ? Headphones
                    : Play;
              const line =
                item.activityType === 'rating'
                  ? `Rated ${item.score ?? '?'}/10`
                  : item.mode === 'listen'
                    ? 'Listened'
                    : 'Watched';
              return (
                <Pressable
                  key={item.id}
                  onPress={() => openTheme(item.themeSlug)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${item.theme?.songTitle ?? item.themeSlug}`}
                  style={({ pressed }) => [
                    styles.activityRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.activityIcon}>
                    <Icon size={15} color={theme.muted} strokeWidth={2} />
                  </View>
                  <View style={styles.activityMain}>
                    <Text style={styles.activityTitle} numberOfLines={1}>
                      {item.theme?.songTitle ?? item.themeSlug}
                    </Text>
                    <Text style={styles.activityMeta} numberOfLines={1}>
                      {line} · {relativeTime(item.date)}
                      {item.theme ? ` · ${item.theme.animeTitle}` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          ) : (
            <Text style={styles.note}>
              {isOwn
                ? 'No watches or ratings yet.'
                : 'Their recent activity isn’t visible.'}
            </Text>
          )}

          {ratings && ratings.ratings.length > 0 && (
            <>
              <Text style={styles.sectionHeading}>Ratings</Text>
              {ratings.ratings.slice(0, PREVIEW_COUNT).map((entry) =>
                entry.theme ? (
                  <ThemeRow
                    key={entry.id}
                    item={entry.theme}
                    detail={`Rated ${entry.score}/10 · ${relativeTime(entry.createdAt)}`}
                    onPress={() => openTheme(entry.themeSlug)}
                  />
                ) : (
                  <Pressable
                    key={entry.id}
                    onPress={() => openTheme(entry.themeSlug)}
                    style={styles.activityRow}
                  >
                    <View style={styles.activityMain}>
                      <Text style={styles.activityTitle} numberOfLines={1}>
                        {entry.themeSlug}
                      </Text>
                      <Text style={styles.activityMeta}>
                        Rated {entry.score}/10 ·{' '}
                        {relativeTime(entry.createdAt)}
                      </Text>
                    </View>
                  </Pressable>
                ),
              )}
            </>
          )}

          {history && history.entries.length > 0 && (
            <>
              <Text style={styles.sectionHeading}>History</Text>
              {history.entries.slice(0, PREVIEW_COUNT).map((entry) =>
                entry.theme ? (
                  <ThemeRow
                    key={entry.id}
                    item={entry.theme}
                    detail={`${entry.mode === 'watch' ? 'Watched' : 'Listened'} · ${relativeTime(entry.viewedAt)}`}
                    onPress={() => openTheme(entry.themeSlug)}
                  />
                ) : null,
              )}
            </>
          )}

          {fixtureMode && (
            <Text style={styles.note}>
              Demo mode — profile data comes from the live API.
            </Text>
          )}
        </ScrollView>
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
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      flex: 1,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xxl,
    },
    message: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 20,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    identity: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.sm,
    },
    identityText: {
      flex: 1,
      gap: 2,
      alignItems: 'flex-start',
    },
    displayName: {
      ...typeStyles.display,
      fontSize: 20,
      color: theme.text,
    },
    handle: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    rankChip: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 3,
      marginTop: spacing.xs,
    },
    rankChipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    bio: {
      ...typeStyles.body,
      color: theme.text,
      lineHeight: 20,
      marginTop: spacing.md,
    },
    joined: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: spacing.sm,
    },
    statRow: {
      flexDirection: 'row',
      marginTop: spacing.lg,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.md,
      paddingVertical: spacing.sm,
    },
    statBlock: {
      flex: 1,
      alignItems: 'center',
      gap: 1,
      paddingVertical: spacing.xs,
    },
    statValue: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    statValueActive: {
      color: theme.accent,
    },
    statLabel: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      minHeight: 44,
      borderRadius: radii.base,
      marginTop: spacing.md,
    },
    actionAccent: {
      backgroundColor: theme.accent,
    },
    actionOutline: {
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    actionBusy: {
      opacity: 0.6,
    },
    actionAccentText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    actionOutlineText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      marginTop: spacing.sm,
      lineHeight: 18,
    },
    listSection: {
      marginTop: spacing.sm,
    },
    sectionHeading: {
      ...typeStyles.heading,
      fontSize: 16,
      color: theme.text,
      marginTop: spacing.xl,
      marginBottom: spacing.xs,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
      marginTop: spacing.sm,
    },
    activityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 52,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    activityIcon: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    activityMain: {
      flex: 1,
      gap: 2,
    },
    activityTitle: {
      ...typeStyles.body,
      fontSize: 13,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    activityMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    pressed: {
      opacity: 0.85,
    },
  });

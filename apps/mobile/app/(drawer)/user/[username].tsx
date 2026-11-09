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
  ChevronRight,
  Pencil,
  UserCheck,
  UserPlus,
} from 'lucide-react-native';
import type {
  UserHistoryResponse,
  UserPublicProfile,
  UserRankProfile,
  UserRatingsResponse,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { ThemeRow } from '../../../src/components/ThemeRow';
import {
  fetchFollowState,
  fetchUserHistory,
  fetchUserProfile,
  fetchUserRank,
  fetchUserRatings,
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

/**
 * Public profile (Slice M5) — GET /users/:username and its satellite
 * reads: ratings, history, the rank chip (GET /rank/:userId via the
 * profile's id) and the caller's follow state. Sections degrade
 * independently: a failed satellite hides or notes itself instead
 * of taking the whole screen down.
 *
 * The follower/following lists are NOT expanded here any more:
 * since layout-fidelity Slice 4 the stat blocks open the standalone
 * Network screen (§6.17), like the web's separate network page.
 *
 * Layout-fidelity Slice 6 aligned the composition to the §6.16
 * design: the identity block is one white card (identity, bio,
 * follow/edit action, then the stats row in the design's order —
 * Ratings · Followers · Following), "Top ratings" previews the
 * first ratings, and the design's "See all ratings and history"
 * row expands the full ratings + the history list in place (there
 * is no separate all-ratings route in the app or the web). The
 * Recent activity section the pre-fidelity build carried is NOT
 * in the design and is removed — the activity read itself is
 * untouched server-side and still powers nothing here.
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
  const [rank, setRank] = useState<UserRankProfile | null>(null);
  const [ratings, setRatings] = useState<UserRatingsResponse | null>(null);
  const [history, setHistory] = useState<UserHistoryResponse | null>(null);
  /** The design's "See all ratings and history" expansion (Slice 6). */
  const [expanded, setExpanded] = useState(false);

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
    setRank(null);
    setRatings(null);
    setHistory(null);
    setExpanded(false);
    setIsFollowing(false);
    setFollowError(null);
    fetchUserProfile(username)
      .then((p) => {
        if (!live) return;
        setProfile(p);
        setFollowersCount(p.totalFollowers);
        // Satellites — each settles on its own.
        fetchUserRank(p.id)
          .then((r) => live && setRank(r))
          .catch(() => {});
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

  const openTheme = (slug: string) => router.push(`/theme/${slug}`);

  const statBlock = (
    label: string,
    value: number,
    tab: 'followers' | 'following' | null,
  ) => (
    <Pressable
      onPress={() =>
        tab &&
        profile &&
        router.push(`/network/${profile.username}?tab=${tab}`)
      }
      disabled={!tab}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={styles.statBlock}
    >
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Pressable>
  );

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
          {/* Identity card (§6.16): identity, bio, the follow/edit
              action and the stats row in ONE white card; the stats
              run in the design's order — Ratings · Followers ·
              Following. (The pre-fidelity build's Joined/Listened
              line under the bio is not in the design.) */}
          <View style={styles.identityCard}>
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

            {isOwn ? (
            <Pressable
              onPress={() => router.push('/edit-profile')}
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

            <View style={styles.statRow}>
              {statBlock('Ratings', profile.totalRatings, null)}
              {statBlock('Followers', followersCount, 'followers')}
              {statBlock('Following', profile.totalFollowing, 'following')}
            </View>
          </View>

          {ratings && ratings.ratings.length > 0 && (
            <>
              <Text style={styles.sectionHeading}>Top ratings</Text>
              {(expanded
                ? ratings.ratings
                : ratings.ratings.slice(0, PREVIEW_COUNT)
              ).map((entry) =>
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

          {/* The design's "See all ratings and history" row: it
              expands the full ratings list and reveals History in
              place (no separate route exists in app or web). */}
          {!expanded &&
            ((ratings && ratings.ratings.length > PREVIEW_COUNT) ||
              (history && history.entries.length > 0)) && (
              <Pressable
                onPress={() => setExpanded(true)}
                accessibilityRole="button"
                accessibilityLabel="See all ratings and history"
                style={({ pressed }) => [
                  styles.seeAllRow,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.seeAllText}>
                  See all ratings and history
                </Text>
                <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
              </Pressable>
            )}

          {expanded && history && history.entries.length > 0 && (
            <>
              <Text style={styles.sectionHeading}>History</Text>
              {history.entries.map((entry) =>
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
    identityCard: {
      // §6.16: the identity block is one white card.
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.cardLg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      marginTop: spacing.sm,
    },
    identity: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
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
    statRow: {
      // Inside the identity card now, divided by a hairline.
      flexDirection: 'row',
      marginTop: spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingTop: spacing.md,
    },
    seeAllRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      marginTop: spacing.md,
    },
    seeAllText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
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

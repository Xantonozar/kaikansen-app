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
import { ChevronLeft } from 'lucide-react-native';
import type { NetworkResponse, NetworkUser } from '@kaikansen/contracts';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { tierLabel } from '../../../src/rankUtil';
import {
  fetchUserNetwork,
  followUser,
  unfollowUser,
} from '../../../src/socialApi';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type NetworkTab = 'followers' | 'following';

/**
 * Network (DESIGN.md §6.17, layout-fidelity Slice 4) — a user's
 * followers / following as the designed standalone screen:
 * Followers/Following segmented control, the count line, and one
 * grouped card of rows (avatar, display name, "@username · Tier",
 * a Follow/Following button in the CALLER's state).
 *
 * Data is GET /users/:username/network — the web's full,
 * unpaginated lists. Since Slice 4's API enrichment the rows also
 * carry the rank tier and (for signed-in callers) the caller's
 * follow state; the buttons write through the same follow /
 * unfollow endpoints the profile screen uses, with the same
 * optimistic flip + reconcile + session-count bookkeeping.
 * Deleted accounts arrive as nulls (the web's populate) and are
 * filtered out, as on the profile screen. Entered from the
 * profile's follower/following stat blocks.
 */
export default function NetworkScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { username, tab: tabParam } = useLocalSearchParams<{
    username: string;
    tab?: string;
  }>();
  const { status, user, updateUser } = useAuth();
  const signedIn = status === 'signedIn' && user !== null;

  const [tab, setTab] = useState<NetworkTab>(
    tabParam === 'following' ? 'following' : 'followers',
  );
  const [network, setNetwork] = useState<NetworkResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /* Caller-state overrides keyed by username: the optimistic flip
     lands here first, the server's answer reconciles it. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setNetwork(null);
    setLoadError(null);
    setOverrides({});
    setActionError(null);
    fetchUserNetwork(username)
      .then((n) => live && setNetwork(n))
      .catch((e: unknown) => {
        if (live) {
          setLoadError(
            e instanceof Error ? e.message : 'Could not load this network.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [username]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const isFollowingOf = (person: NetworkUser): boolean =>
    overrides[person.username] ?? person.isFollowing ?? false;

  const onToggleFollow = (person: NetworkUser) => {
    if (busyFor) return;
    const target = !isFollowingOf(person);
    setBusyFor(person.username);
    setActionError(null);
    setOverrides((prev) => ({ ...prev, [person.username]: target }));
    const call = target ? followUser : unfollowUser;
    call(person.username)
      .then((res) => {
        // Reconcile (idempotent writes can disagree with the flip)
        // and keep the session user's following count in step —
        // the profile screen's bookkeeping, verbatim.
        setOverrides((prev) => ({ ...prev, [person.username]: res.isFollowing }));
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
        setOverrides((prev) => ({ ...prev, [person.username]: !target }));
        setActionError(
          e instanceof Error ? e.message : 'Could not update the follow.',
        );
      })
      .finally(() => setBusyFor(null));
  };

  const rows = (network?.[tab] ?? []).filter(
    (u): u is NetworkUser => u !== null,
  );

  const segment = (value: NetworkTab, label: string) => (
    <Pressable
      onPress={() => setTab(value)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: tab === value }}
      style={[styles.segment, tab === value && styles.segmentActive]}
    >
      <Text
        style={[
          styles.segmentText,
          tab === value && styles.segmentTextActive,
        ]}
      >
        {label}
      </Text>
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
          {username}
        </Text>
      </View>

      <View style={styles.segmentedWrap}>
        <View style={styles.segmented}>
          {segment('followers', 'Followers')}
          {segment('following', 'Following')}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {loadError ? (
          <Text style={styles.note}>{loadError}</Text>
        ) : network === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : (
          <>
            <Text style={styles.countLine}>
              {rows.length} {tab === 'followers' ? 'Followers' : 'Following'}
            </Text>
            {actionError !== null && (
              <Text style={styles.errorText}>{actionError}</Text>
            )}
            {rows.length === 0 ? (
              <Text style={styles.note}>
                {tab === 'followers'
                  ? 'No followers yet.'
                  : 'Not following anyone yet.'}
              </Text>
            ) : (
              <View style={styles.card}>
                {rows.map((person, i) => {
                  const isSelf =
                    signedIn &&
                    user.username.toLowerCase() ===
                      person.username.toLowerCase();
                  const following = isFollowingOf(person);
                  const showButton =
                    signedIn && !isSelf && person.isFollowing !== undefined;
                  return (
                    <Pressable
                      key={person.id}
                      onPress={() => router.push(`/user/${person.username}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${person.displayName || person.username}`}
                      style={({ pressed }) => [
                        styles.row,
                        i > 0 && styles.rowDivider,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Avatar
                        url={person.avatarUrl}
                        name={person.displayName || person.username}
                        seed={person.id}
                        size={40}
                      />
                      <View style={styles.rowTexts}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {person.displayName || person.username}
                        </Text>
                        <Text style={styles.rowMeta} numberOfLines={1}>
                          @{person.username}
                          {person.tier ? ` · ${tierLabel(person.tier)}` : ''}
                        </Text>
                      </View>
                      {showButton && (
                        <Pressable
                          onPress={() => onToggleFollow(person)}
                          disabled={busyFor === person.username}
                          accessibilityRole="button"
                          accessibilityLabel={
                            following
                              ? `Unfollow ${person.username}`
                              : `Follow ${person.username}`
                          }
                          accessibilityState={{ selected: following }}
                          style={({ pressed }) => [
                            styles.followButton,
                            following
                              ? styles.followButtonOn
                              : styles.followButtonOff,
                            pressed && styles.pressed,
                          ]}
                        >
                          {busyFor === person.username ? (
                            <ActivityIndicator
                              size="small"
                              color={
                                following
                                  ? theme.onAccentContainer
                                  : theme.onAccent
                              }
                            />
                          ) : (
                            <Text
                              style={
                                following
                                  ? styles.followButtonTextOn
                                  : styles.followButtonTextOff
                              }
                            >
                              {following ? 'Following' : 'Follow'}
                            </Text>
                          )}
                        </Pressable>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            )}
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
    segmentedWrap: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      marginBottom: spacing.sm,
    },
    segmented: {
      flexDirection: 'row',
      gap: spacing.xs,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      padding: 4,
    },
    segment: {
      flex: 1,
      minHeight: 36,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segmentActive: {
      backgroundColor: theme.accent,
    },
    segmentText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    segmentTextActive: {
      color: theme.onAccent,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xxl,
    },
    countLine: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      marginTop: spacing.sm,
      marginBottom: spacing.sm,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingHorizontal: spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    rowTexts: {
      flex: 1,
      gap: 1,
    },
    rowName: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    rowMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    followButton: {
      minWidth: 92,
      minHeight: 34,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    followButtonOff: {
      backgroundColor: theme.accent,
    },
    followButtonOn: {
      backgroundColor: theme.accentContainer,
    },
    followButtonTextOff: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    followButtonTextOn: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
      marginTop: spacing.sm,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.danger,
      marginBottom: spacing.sm,
      lineHeight: 18,
    },
    pressed: {
      opacity: 0.85,
    },
  });

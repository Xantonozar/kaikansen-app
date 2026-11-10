import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import type { NetworkResponse, NetworkUser } from '@kaikansen/contracts';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { SkeletonPersonRow } from '../../../src/components/Skeleton';
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
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type NetworkTab = 'followers' | 'following';

/** Page size for the paged network reads (audit S2). */
const PAGE_SIZE = 20;

/** The rows of one list with the deleted-account nulls removed. */
function visibleRows(list: (NetworkUser | null)[]): NetworkUser[] {
  return list.filter((u): u is NetworkUser => u !== null);
}

/** Append a fresh page, dropping any id already shown. */
function appendRows(
  current: NetworkUser[],
  page: NetworkUser[],
): NetworkUser[] {
  const seen = new Set(current.map((u) => u.id));
  return [...current, ...page.filter((u) => !seen.has(u.id))];
}

/**
 * Network — a user's followers / following as the designed
 * standalone screen (kaikansen-network.png + network.html, the
 * measurement truth): the owner's username as the header title, a
 * Followers/Following segmented control, the letterspaced count
 * line, and ONE grouped card of rows (avatar, display name,
 * "@username · Tier", and a Follow/Following pill in the CALLER's
 * state). Re-measured against the Stitch HTML in the design-fix
 * queue.
 *
 * Data is GET /users/:username/network, PAGED (audit S2 — the
 * full unpaginated lists froze this screen on big networks,
 * the Library AniList freeze class): page size 20 per list, each
 * tab infinite-scrolls its own page counter, and the count line
 * reads the server's totals. The rows render in a FlatList
 * inside the grouped card; page loads show person-row skeletons.
 * The rows carry the rank tier and (for signed-in callers) the
 * caller's follow state, both enriched by the endpoint; the
 * buttons write through the same follow / unfollow endpoints the
 * profile screen uses, with the same optimistic flip + reconcile
 * + session-count bookkeeping. Deleted accounts arrive as nulls
 * (the web's populate) and are filtered out of the rows, as on
 * the profile screen — the count line now reports the server's
 * follow-row totals. Entered from the public profile's
 * follower/following stat blocks.
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
  const [followers, setFollowers] = useState<NetworkUser[]>([]);
  const [following, setFollowing] = useState<NetworkUser[]>([]);
  const [totals, setTotals] = useState<{
    followers: number;
    following: number;
  } | null>(null);
  const [pages, setPages] = useState({ followers: 1, following: 1 });
  const [hasMore, setHasMore] = useState({
    followers: false,
    following: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /* Caller-state overrides keyed by username: the optimistic flip
     lands here first, the server's answer reconciles it. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /* In-flight page fetch for a tab (double-fire guard). */
  const fetchingRef = useRef(false);

  const applyPage = (
    response: NetworkResponse,
    only?: NetworkTab,
    append = false,
  ) => {
    if (only !== 'following') {
      const pageRows = visibleRows(response.followers);
      setFollowers((prev) =>
        append ? appendRows(prev, pageRows) : pageRows,
      );
    }
    if (only !== 'followers') {
      const pageRows = visibleRows(response.following);
      setFollowing((prev) =>
        append ? appendRows(prev, pageRows) : pageRows,
      );
    }
    setTotals({
      followers: response.followersTotal,
      following: response.followingTotal,
    });
    setPages({
      followers: response.followersPage,
      following: response.followingPage,
    });
    setHasMore({
      followers: response.followersHasMore,
      following: response.followingHasMore,
    });
  };

  useEffect(() => {
    let live = true;
    setFollowers([]);
    setFollowing([]);
    setTotals(null);
    setPages({ followers: 1, following: 1 });
    setHasMore({ followers: false, following: false });
    setLoaded(false);
    setLoadingMore(false);
    setLoadError(null);
    setOverrides({});
    setActionError(null);
    fetchingRef.current = true;
    fetchUserNetwork(username, {
      followersPage: 1,
      followingPage: 1,
      limit: PAGE_SIZE,
    })
      .then((n) => {
        if (live) {
          applyPage(n);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (live) {
          setLoadError(
            e instanceof Error ? e.message : 'Could not load this network.',
          );
        }
      })
      .finally(() => {
        fetchingRef.current = false;
      });
    return () => {
      live = false;
    };
    // applyPage is a stable setState composer; username is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const loadMore = () => {
    if (!loaded || fetchingRef.current || !hasMore[tab]) return;
    fetchingRef.current = true;
    setLoadingMore(true);
    fetchUserNetwork(username, {
      followersPage: tab === 'followers' ? pages.followers + 1 : pages.followers,
      followingPage: tab === 'following' ? pages.following + 1 : pages.following,
      limit: PAGE_SIZE,
    })
      .then((n) => applyPage(n, tab, true))
      .catch(() => {
        /* A failed page fetch leaves hasMore set — the next
           scroll to the end retries it. */
      })
      .finally(() => {
        fetchingRef.current = false;
        setLoadingMore(false);
      });
  };

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

  const rows = tab === 'followers' ? followers : following;
  const total = totals === null ? rows.length : totals[tab];

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

  const renderPerson = ({
    item: person,
    index,
  }: {
    item: NetworkUser;
    index: number;
  }) => {
    const isSelf =
      signedIn &&
      user.username.toLowerCase() === person.username.toLowerCase();
    const followingState = isFollowingOf(person);
    const showButton =
      signedIn && !isSelf && person.isFollowing !== undefined;
    return (
      <Pressable
        onPress={() => router.push(`/user/${person.username}`)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${person.displayName || person.username}`}
        style={({ pressed }) => [
          styles.row,
          index > 0 && styles.rowDivider,
          pressed && styles.rowPressed,
        ]}
      >
        <Avatar
          url={person.avatarUrl}
          name={person.displayName || person.username}
          seed={person.id}
          size={44}
        />
        <View style={styles.rowTexts}>
          <Text style={styles.rowName} numberOfLines={1}>
            {person.displayName || person.username}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            @{person.username}
            {person.tier ? (
              <>
                <Text style={styles.metaSeparator}> · </Text>
                {tierLabel(person.tier)}
              </>
            ) : (
              ''
            )}
          </Text>
        </View>
        {showButton && (
          <Pressable
            onPress={() => onToggleFollow(person)}
            disabled={busyFor === person.username}
            accessibilityRole="button"
            accessibilityLabel={
              followingState
                ? `Unfollow ${person.username}`
                : `Follow ${person.username}`
            }
            accessibilityState={{ selected: followingState }}
            style={({ pressed }) => [
              styles.followButton,
              followingState
                ? styles.followButtonOn
                : styles.followButtonOff,
              pressed && styles.pressed,
            ]}
          >
            {busyFor === person.username ? (
              <ActivityIndicator
                size="small"
                color={followingState ? theme.accent : theme.onAccent}
              />
            ) : (
              <Text
                style={
                  followingState
                    ? styles.followButtonTextOn
                    : styles.followButtonTextOff
                }
              >
                {followingState ? 'Following' : 'Follow'}
              </Text>
            )}
          </Pressable>
        )}
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backDisc}
        >
          <ArrowLeft size={20} color={theme.text} strokeWidth={2} />
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

      <View style={styles.content}>
        {loadError ? (
          <Text style={styles.note}>{loadError}</Text>
        ) : !loaded ? (
          <View style={styles.card}>
            {[0, 1, 2, 3, 4].map((i) => (
              <View key={i} style={i > 0 && styles.rowDivider}>
                <SkeletonPersonRow />
              </View>
            ))}
          </View>
        ) : (
          <>
            <Text style={styles.countLine}>
              {total} {tab === 'followers' ? 'Followers' : 'Following'}
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
                <FlatList
                  data={rows}
                  keyExtractor={(person) => person.id}
                  renderItem={renderPerson}
                  onEndReached={loadMore}
                  onEndReachedThreshold={0.5}
                  ListFooterComponent={
                    loadingMore ? (
                      <View style={styles.rowDivider}>
                        <SkeletonPersonRow />
                      </View>
                    ) : undefined
                  }
                />
              </View>
            )}
          </>
        )}
      </View>
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
      // network.html header: px-4, gap-3 (12), mb-4 (16).
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      marginBottom: spacing.lg,
      gap: spacing.md,
    },
    backDisc: {
      // network.html: w-10 h-10 (40) white/70 circular disc,
      // shadow-sm, arrow_back at 20 in the ink colour.
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      backgroundColor: withOpacity(theme.surface, 0.7),
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: theme.text,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.08,
      shadowRadius: 3,
      elevation: 1,
    },
    title: {
      // network.html: text-xl (20) font-bold tracking-tight.
      fontFamily: fontFamilies.display,
      fontSize: 20,
      letterSpacing: -0.5,
      color: theme.text,
      flex: 1,
    },
    segmentedWrap: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      marginBottom: spacing.md,
    },
    segmented: {
      // network.html: pill-pale track @75%, p-1 (4), rounded-2xl
      // (16), gap-1 (4). The track's #EFE4EC maps to the raised
      // token (the theme's measured pale lavender, Δ smallest).
      flexDirection: 'row',
      gap: spacing.xs,
      backgroundColor: theme.raised,
      borderRadius: radii.md,
      padding: spacing.xs,
    },
    segment: {
      // network.html: flex-1, py-2.5 (10), rounded-xl (12).
      flex: 1,
      paddingVertical: 10,
      borderRadius: radii.base,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segmentActive: {
      backgroundColor: theme.accent,
    },
    segmentText: {
      // network.html: text-sm (14) font-medium in the mauve.
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.secondary,
    },
    segmentTextActive: {
      // network.html: font-semibold, white on the deep mauve.
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    content: {
      // The body under the fixed header/segmented: the count line
      // and notes sit at the top, the card takes the rest and the
      // FlatList scrolls inside it (audit S2 virtualisation).
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxl,
    },
    countLine: {
      // network.html: px-1 (4), mb-3 (12), text-xs (12)
      // font-semibold, tracking-wide, uppercase, in the mauve
      // (theme.secondary — the HTML's exact #8E5B7B).
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.secondary,
      letterSpacing: 0.3,
      textTransform: 'uppercase',
      paddingHorizontal: spacing.xs,
      marginBottom: spacing.md,
    },
    card: {
      // network.html: white, rounded-3xl (24), 1px hairline
      // border, overflow hidden so the dividers and the rows'
      // pressed tint span/stop at the card's full width. Flexes
      // to fill the body so the FlatList scrolls within it.
      flex: 1,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: 'hidden',
    },
    row: {
      // network.html: p-4 (16 on every side), gap-3 (12).
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    rowPressed: {
      // network.html row hover: bg-lavender/30 — the page
      // background tint inside the white card.
      backgroundColor: theme.background,
    },
    rowTexts: {
      flex: 1,
    },
    rowName: {
      // network.html: text-[15px] font-bold, leading-snug.
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
      lineHeight: 20,
      color: theme.text,
    },
    rowMeta: {
      // network.html: text-xs (12) font-medium in the mauve,
      // mt-0.5 (2) under the name.
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.secondary,
      marginTop: 2,
    },
    metaSeparator: {
      // network.html: the "·" sits in the hairline colour with
      // mx-1 spacing — the surrounding spaces ride in this span
      // (spaces are invisible; the dot takes the pale colour).
      color: theme.border,
    },
    followButton: {
      // network.html: rounded-full, text-xs font-semibold,
      // py-1.5 (6). Width is padding-driven — the mock's Follow
      // pill is narrower than its Following pill.
      borderRadius: radii.pill,
      paddingVertical: 6,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    followButtonOff: {
      // "Follow": deep-mauve fill, px-5 (20).
      backgroundColor: theme.accent,
      paddingHorizontal: spacing.xl,
    },
    followButtonOn: {
      // "Following": pill-pale fill, px-4 (16).
      backgroundColor: theme.raised,
      paddingHorizontal: spacing.lg,
    },
    followButtonTextOff: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.onAccent,
    },
    followButtonTextOn: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.accent,
    },
    note: {
      fontFamily: fontFamilies.bodySmall,
      fontSize: 12,
      color: theme.muted,
      lineHeight: 18,
      marginTop: spacing.sm,
    },
    errorText: {
      fontFamily: fontFamilies.bodySmall,
      fontSize: 12,
      color: theme.danger,
      marginBottom: spacing.sm,
      lineHeight: 18,
    },
    pressed: {
      opacity: 0.85,
    },
  });

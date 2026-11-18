import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Play, Search, UserPlus, X } from 'lucide-react-native';
import type {
  FriendsActivityItem,
  NetworkUser,
} from '@kaikansen/contracts';
import { cacheKeyFor, fixtureMode, subscribeCache } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { AppImage } from '../../../src/components/AppImage';
import { PersonRow } from '../../../src/components/PersonRow';
import { useTabBottomInset } from '../../../src/useBottomInset';
import {
  SkeletonFeedRow,
  SkeletonPersonRow,
} from '../../../src/components/Skeleton';
import {
  fetchFriendsActivity,
  fetchUserNetwork,
  searchUsers,
} from '../../../src/socialApi';
import { compactRelativeTime } from '../../../src/time';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

/**
 * Social (Slice M5) — the real tab. Three parts:
 *
 * - People search at the top: the users branch of search
 *   (GET /social/users/search), live from 2 characters, paged with
 *   a Load more row; results route to profiles.
 * - The YOUR FRIENDS rail (design polish pass — the design's
 *   avatar rail the audit found missing): the caller's own
 *   following list (GET /users/:username/network), avatar discs
 *   with usernames, each routing to that user's profile. It
 *   renders only when the caller actually follows someone; a
 *   failed fetch just hides it — the feed below is unaffected.
 * - The friends-activity feed (the Social mock's individual
 *   white cards): watches ('listening'), ratings ('liked') and
 *   playlist adds ('playlist_add') by people the caller follows.
 *   Rows follow the mock exactly (owner order, 2026-11-10): the
 *   actor's real avatar at the left (shared Avatar — photo when
 *   usable, else their deterministic chibi), ONE sentence line —
 *   bold display name, the verb, the theme title in mauve, a
 *   rating carried inside the sentence ("rated X a 9") — and a
 *   "{anime} • {time}" second line in the mock's compact format
 *   ("Tokyo Ghoul • 2h"), with the mock's cover thumb + pale play
 *   disc trailing. No @handle anywhere and no badge/chip pills:
 *   the owner struck both. The feed payload carries the anime
 *   title additively (contracts, FriendsActivityItem) precisely
 *   so that second line can be drawn. The feed is follow-based,
 *   so signed-out gets a log-in prompt as the body state and
 *   fixture/demo mode gets a labelled demo note — the demo
 *   world has no people and none are fabricated.
 *
 * The feed refetches on focus, so follows made on a profile show up
 * here on return. Rows route by target: the row opens the theme,
 * the avatar/name opens the person.
 */
export default function SocialScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const bottomInset = useTabBottomInset();
  const router = useRouter();
  const { status, user } = useAuth();
  const signedIn = status === 'signedIn' && user !== null;

  const [feed, setFeed] = useState<FriendsActivityItem[] | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [friends, setFriends] = useState<NetworkUser[] | null>(null);

  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<NetworkUser[] | null>(null);
  const [peoplePage, setPeoplePage] = useState(1);
  const [peopleHasMore, setPeopleHasMore] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const searchSeq = useRef(0);

  const searching = query.trim().length >= 2;

  const loadFeed = useCallback(() => {
    if (!signedIn || fixtureMode) return;
    fetchFriendsActivity(30)
      .then((res) => {
        setFeed(res.activities);
        setFeedError(null);
      })
      .catch((e: unknown) =>
        setFeedError(
          e instanceof Error ? e.message : 'Could not load the feed.',
        ),
      );
  }, [signedIn]);

  /* The friends rail: the caller's own following list. A failure
     hides the rail (null) rather than surfacing an error — the
     feed below carries the screen's error states. */
  const myUsername = user?.username;
  const loadFriends = useCallback(() => {
    if (!signedIn || fixtureMode || !myUsername) return;
    fetchUserNetwork(myUsername)
      .then((res) =>
        setFriends(
          res.following.filter(
            (p): p is NetworkUser => p !== null,
          ),
        ),
      )
      .catch(() => {
        // Keep whatever is painted (perf problem 5): a failure
        // behind a cache paint must not blank a loaded rail.
        setFriends((prev) => prev ?? null);
      });
  }, [signedIn, myUsername]);

  /* Silent swap (perf problem 5): a background revalidation of
     the friends rail lands here and replaces the painted copy. */
  useEffect(() => {
    if (fixtureMode || !myUsername) return;
    return subscribeCache(
      cacheKeyFor(`/users/${encodeURIComponent(myUsername)}/network`),
      (fresh: { following: (NetworkUser | null)[] }) => {
        setFriends(
          fresh.following.filter(
            (p): p is NetworkUser => p !== null,
          ),
        );
      },
    );
  }, [myUsername]);

  useFocusEffect(
    useCallback(() => {
      loadFeed();
      loadFriends();
    }, [loadFeed, loadFriends]),
  );

  /* People search — debounced; a short query clears back to the feed. */
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      searchSeq.current += 1;
      setPeople(null);
      setPeopleError(null);
      setPeopleBusy(false);
      return;
    }
    const seq = ++searchSeq.current;
    setPeopleBusy(true);
    const timer = setTimeout(() => {
      searchUsers(q, 1)
        .then((res) => {
          if (searchSeq.current !== seq) return;
          setPeople(res.users);
          setPeoplePage(res.page);
          setPeopleHasMore(res.hasMore);
          setPeopleError(null);
        })
        .catch((e: unknown) => {
          if (searchSeq.current !== seq) return;
          setPeopleError(
            e instanceof Error ? e.message : 'Could not search people.',
          );
        })
        .finally(() => {
          if (searchSeq.current === seq) setPeopleBusy(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const loadMorePeople = () => {
    const q = query.trim();
    if (peopleBusy || !peopleHasMore || q.length < 2) return;
    const seq = searchSeq.current;
    setPeopleBusy(true);
    searchUsers(q, peoplePage + 1)
      .then((res) => {
        if (searchSeq.current !== seq) return;
        setPeople((prev) => [...(prev ?? []), ...res.users]);
        setPeoplePage(res.page);
        setPeopleHasMore(res.hasMore);
      })
      .catch((e: unknown) =>
        setPeopleError(
          e instanceof Error ? e.message : 'Could not load more people.',
        ),
      )
      .finally(() => setPeopleBusy(false));
  };

  const openProfile = (username: string) =>
    router.push(`/user/${username}`);

  const feedRow = (item: FriendsActivityItem) => {
    const listening = item.type === 'listening';
    const playlistAdd = item.type === 'playlist_add';
    const openTheme = () => router.push(`/theme/${item.item.slug}`);
    // The mock's second line: "{anime} • {time}" in the compact
    // format ("Tokyo Ghoul • 2h"). When the theme has left the
    // catalogue the anime is null and the line is the time alone.
    const when = compactRelativeTime(item.timestamp);
    const sub = item.item.anime ? `${item.item.anime} • ${when}` : when;
    return (
      <View key={item.id} style={styles.feedCard}>
        <Pressable
          onPress={() => openProfile(item.user.username)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.user.displayName}'s profile`}
          hitSlop={4}
        >
          <Avatar
            url={item.user.avatar}
            name={item.user.displayName || item.user.username}
            seed={item.user.username}
            size={40}
          />
        </Pressable>
        <Pressable
          onPress={openTheme}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.item.title}`}
          style={({ pressed }) => [
            styles.feedMain,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.feedSentence} numberOfLines={2}>
            <Text style={styles.feedName}>
              {item.user.displayName || item.user.username}
            </Text>
            {listening
              ? ' listened to '
              : playlistAdd
                ? ' added '
                : ' rated '}
            <Text style={styles.feedThemeInline}>{item.item.title}</Text>
            {playlistAdd
              ? ` to ${item.item.playlistName ?? 'a playlist'}`
              : !listening && item.item.score !== null
                ? ` a ${item.item.score}`
                : ''}
          </Text>
          <Text style={styles.feedSub} numberOfLines={1}>
            {sub}
          </Text>
        </Pressable>
        <View style={styles.feedTrail}>
          <Pressable
            onPress={openTheme}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.item.title}`}
            style={({ pressed }) => pressed && styles.pressed}
          >
            {item.item.cover ? (
              <AppImage
                source={item.item.cover}
                style={styles.feedThumb}
                recyclingKey={item.item.slug}
              />
            ) : (
              <View style={[styles.feedThumb, styles.feedThumbPlaceholder]} />
            )}
          </Pressable>
          <Pressable
            onPress={openTheme}
            accessibilityRole="button"
            accessibilityLabel={`Play ${item.item.title}`}
            style={({ pressed }) => [
              styles.feedPlayDisc,
              pressed && styles.pressed,
            ]}
          >
            <Play
              size={15}
              color={theme.accent}
              fill={theme.accent}
              strokeWidth={2}
              style={styles.feedPlayIcon}
            />
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={[styles.column, { paddingBottom: bottomInset }]}>
        <View style={styles.searchField}>
          <Search size={18} color={theme.muted} strokeWidth={2} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search people"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search people"
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => setQuery('')}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <X size={16} color={theme.muted} strokeWidth={2} />
            </Pressable>
          )}
        </View>

        {searching ? (
          <>
            <Text style={styles.heading}>People</Text>
            {fixtureMode ? (
              <Text style={styles.note}>
                People search is not available in demo mode.
              </Text>
            ) : peopleError ? (
              <Text style={styles.errorText}>{peopleError}</Text>
            ) : people === null ? (
              /* People search loading (skeleton sweep):
                 person-row shapes, the section's content. */
              <View style={styles.skeletonStack}>
                {[0, 1, 2].map((i) => (
                  <SkeletonPersonRow key={i} />
                ))}
              </View>
            ) : people.length === 0 ? (
              <Text style={styles.note}>
                Nobody matches “{query.trim()}”.
              </Text>
            ) : (
              <>
                {people.map((person) => (
                  <PersonRow
                    key={person.id}
                    displayName={person.displayName}
                    username={person.username}
                    avatarUrl={person.avatarUrl}
                    onPress={() => openProfile(person.username)}
                  />
                ))}
                {peopleHasMore && (
                  <Pressable
                    onPress={loadMorePeople}
                    disabled={peopleBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Load more people"
                    style={({ pressed }) => [
                      styles.loadMore,
                      pressed && styles.pressed,
                    ]}
                  >
                    {peopleBusy ? (
                      <ActivityIndicator size="small" color={theme.muted} />
                    ) : (
                      <Text style={styles.loadMoreText}>Load more</Text>
                    )}
                  </Pressable>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {signedIn && !fixtureMode && friends && friends.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>Your friends</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.rail}
                  contentContainerStyle={styles.railContent}
                >
                  {friends.map((person) => (
                    <Pressable
                      key={person.id}
                      onPress={() => openProfile(person.username)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${person.username}'s profile`}
                      style={({ pressed }) => [
                        styles.railItem,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Avatar
                        url={person.avatarUrl}
                        name={person.displayName || person.username}
                        seed={person.username}
                        size={60}
                      />
                      <Text style={styles.railName} numberOfLines={1}>
                        {person.username}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            )}
            <Text style={styles.sectionLabel}>Friends activity</Text>
            {fixtureMode ? (
              <View style={styles.promptCard}>
                <UserPlus size={22} color={theme.muted} strokeWidth={2} />
                <Text style={styles.promptText}>
                  Demo mode — the friends feed needs the live API, and
                  demo mode invents no people or activity.
                </Text>
              </View>
            ) : !signedIn ? (
              <View style={styles.promptCard}>
                <UserPlus size={22} color={theme.muted} strokeWidth={2} />
                <Text style={styles.promptText}>
                  The feed shows what people you follow watch and rate.
                  Log in to see yours.
                </Text>
                <Pressable
                  onPress={() => router.push('/login')}
                  accessibilityRole="button"
                  accessibilityLabel="Log in"
                  style={({ pressed }) => [
                    styles.loginChip,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.loginChipText}>Log in</Text>
                </Pressable>
              </View>
            ) : feedError ? (
              <View style={styles.promptCard}>
                <Text style={styles.promptText}>{feedError}</Text>
                <Pressable
                  onPress={loadFeed}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading the feed"
                  style={({ pressed }) => [
                    styles.loginChip,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.loginChipText}>Retry</Text>
                </Pressable>
              </View>
            ) : feed === null ? (
              /* Feed loading (skeleton sweep): feed-row shapes
                 stacked in the section's rhythm (the real cards
                 are separate; the rows carry their own gap). */
              <View style={styles.skeletonStack}>
                {[0, 1, 2].map((i) => (
                  <SkeletonFeedRow key={i} />
                ))}
              </View>
            ) : feed.length === 0 ? (
              <Text style={styles.note}>
                {user && user.totalFollowing === 0
                  ? 'You’re not following anyone yet — search for people above and follow them from their profile.'
                  : 'Nothing new from people you follow yet. Their watches, ratings and playlist adds will show up here.'}
              </Text>
            ) : (
              feed.map(feedRow)
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.md,
      paddingBottom: spacing.xxxl,
    },
    searchField: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: 14,
      paddingHorizontal: spacing.md,
      minHeight: 46,
    },
    searchInput: {
      flex: 1,
      ...typeStyles.body,
      color: theme.text,
      paddingVertical: 0,
    },
    heading: {
      ...typeStyles.heading,
      color: theme.text,
      marginTop: spacing.lg,
      marginBottom: spacing.xs,
    },
    sectionLabel: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      color: theme.muted,
      marginTop: spacing.lg,
      marginBottom: spacing.sm,
    },
    rail: {
      marginHorizontal: -spacing.screenEdge,
    },
    railContent: {
      paddingHorizontal: spacing.screenEdge,
      gap: spacing.md,
    },
    railItem: {
      width: 68,
      alignItems: 'center',
      gap: spacing.xs + 2,
    },
    railName: {
      ...typeStyles.caption,
      color: theme.text,
      maxWidth: 68,
      textAlign: 'center',
    },
    feedCard: {
      // The Social mock's activity cards, measured from its HTML
      // (social.html): white card, radius 16 (rounded-2xl),
      // padding 12 (p-3), avatar 40, cover thumb 40, play disc
      // 32, and an 8px gap between cards (the section's gap-2).
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.md,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    feedMain: {
      flex: 1,
      // Mock gap-2.5 (10) after the avatar, gap-3 (12) before
      // the trailing thumb + disc cluster.
      marginLeft: 10,
      marginRight: spacing.md,
    },
    feedSentence: {
      // Mock: 13px, leading-snug. Bold name, plain verb, the
      // theme title in mauve, the rating inside the sentence.
      fontFamily: fontFamilies.body,
      fontSize: 13,
      lineHeight: 18,
      color: theme.text,
    },
    feedName: {
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    feedThemeInline: {
      // Mock: font-medium (Inter 500) in mauveDeep (#7B5368).
      fontFamily: fontFamilies.caption,
      color: theme.accent,
    },
    feedSub: {
      // Mock: 11px muted, "{anime} • {time}", mt-0.5.
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: 2,
    },
    feedTrail: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    feedThumb: {
      width: 40,
      height: 40,
      borderRadius: radii.base,
      backgroundColor: theme.surface,
    },
    feedThumbPlaceholder: {
      backgroundColor: theme.raised,
    },
    feedPlayDisc: {
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    feedPlayIcon: {
      // The mock's glyph sits a hair right of centre
      // (translate-x-0.5) — optical centre for a play triangle.
      marginLeft: 1,
    },
    promptCard: {
      alignItems: 'flex-start',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.md,
      padding: spacing.md,
      marginTop: spacing.sm,
    },
    promptText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
    },
    loginChip: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    loginChipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
      marginTop: spacing.sm,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      lineHeight: 18,
      marginTop: spacing.sm,
    },
    center: {
      paddingVertical: spacing.xxl,
      alignItems: 'center',
    },
    skeletonStack: {
      // The section skeletons' stack (skeleton sweep): the
      // rows spaced like the sections' own content rhythm.
      gap: spacing.lg,
      paddingVertical: spacing.sm,
    },
    loadMore: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 44,
      marginTop: spacing.xs,
    },
    loadMoreText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    pressed: {
      opacity: 0.7,
    },
  });

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { AudioLines, Play, Search, Star, UserPlus, X } from 'lucide-react-native';
import type {
  FriendsActivityItem,
  NetworkUser,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { pickDefaultAvatar } from '../../../src/defaultAvatars';
import { PersonRow } from '../../../src/components/PersonRow';
import {
  fetchFriendsActivity,
  fetchUserNetwork,
  searchUsers,
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
 * - The friends-activity feed (design pass — the Social mock's
 *   individual white cards): watches ('listening'), ratings
 *   ('liked') and playlist adds ('playlist_add') by people the
 *   caller follows, rendered in the Home rich-feed card's language
 *   (name row with the time, action line with the artist byline,
 *   listening chip / ★ score pill from the enriched payload) with
 *   the mock's cover thumb + play disc trailing. The mock's
 *   "{anime} • {time}" second line cannot be drawn: the feed
 *   payload carries the artist, not the anime title. The feed is
 *   follow-based, so signed-out gets a log-in prompt as the body
 *   state and fixture/demo mode gets a labelled demo note — the
 *   demo world has no people and none are fabricated.
 *
 * The feed refetches on focus, so follows made on a profile show up
 * here on return. Rows route by target: the row opens the theme,
 * the avatar/name opens the person.
 */
export default function SocialScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
      .catch(() => setFriends(null));
  }, [signedIn, myUsername]);

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
            size={44}
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
          <View style={styles.feedNameRow}>
            <Text style={styles.feedNameLine} numberOfLines={1}>
              <Text style={styles.feedName}>
                {item.user.displayName || item.user.username}
              </Text>
              <Text style={styles.feedHandle}>
                {' '}
                @{item.user.username}
              </Text>
            </Text>
            <Text style={styles.feedTime}>
              {relativeTime(item.timestamp)}
            </Text>
          </View>
          <Text style={styles.feedAction} numberOfLines={2}>
            {listening ? 'listened to ' : playlistAdd ? 'added ' : 'rated '}
            <Text style={styles.feedThemeInline}>{item.item.title}</Text>
            {playlistAdd
              ? ` to ${item.item.playlistName ?? 'a playlist'}`
              : item.item.artist
                ? ` · ${item.item.artist}`
                : ''}
          </Text>
          {listening && (
            <View style={styles.feedChip}>
              <AudioLines
                size={11}
                color={theme.onAccentContainer}
                strokeWidth={2}
              />
              <Text style={styles.feedChipText}>listening</Text>
            </View>
          )}
          {!listening && !playlistAdd && item.item.score !== null && (
            <View style={styles.feedChip}>
              <Star
                size={11}
                color={theme.onAccentContainer}
                fill={theme.onAccentContainer}
                strokeWidth={2}
              />
              <Text style={styles.feedChipText}>{item.item.score}/10</Text>
            </View>
          )}
        </Pressable>
        <Pressable
          onPress={openTheme}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.item.title}`}
          style={({ pressed }) => pressed && styles.pressed}
        >
          {item.item.cover ? (
            <Image
              source={{ uri: item.item.cover }}
              style={styles.feedThumb}
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
            size={17}
            color={theme.accent}
            fill={theme.accent}
            strokeWidth={2}
          />
        </Pressable>
      </View>
    );
  };

  return (
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.column}>
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
              <View style={styles.center}>
                <ActivityIndicator color={theme.accent} />
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
                  {friends.map((person) => {
                    const usable =
                      person.avatarUrl !== null &&
                      person.avatarUrl.length > 0 &&
                      !person.avatarUrl.toLowerCase().includes('.svg');
                    // No avatar at all, or an SVG (DiceBear) URL the
                    // app cannot draw → the deterministic bundled
                    // chibi (same rule as the shared Avatar, owner
                    // decision 2026-11-09).
                    return (
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
                        {usable ? (
                          <Image
                            source={{ uri: person.avatarUrl! }}
                            style={styles.railAvatar}
                          />
                        ) : !usable ? (
                          <Image
                            source={pickDefaultAvatar(person.id)}
                            style={styles.railAvatar}
                          />
                        ) : (
                          <View
                            style={[
                              styles.railAvatar,
                              styles.railAvatarFallback,
                            ]}
                          >
                            <Text style={styles.railInitials}>
                              {person.username.slice(0, 2).toUpperCase()}
                            </Text>
                          </View>
                        )}
                        <Text style={styles.railName} numberOfLines={1}>
                          {person.username}
                        </Text>
                      </Pressable>
                    );
                  })}
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
              <View style={styles.center}>
                <ActivityIndicator color={theme.accent} />
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
    railAvatar: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: theme.surface,
    },
    railAvatarFallback: {
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    railInitials: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 17,
      color: theme.onAccentContainer,
    },
    railName: {
      ...typeStyles.caption,
      color: theme.text,
      maxWidth: 68,
      textAlign: 'center',
    },
    feedCard: {
      // The Social mock's activity cards (measured from
      // kaikansen-social-realimg.png): individual white cards,
      // radius ≈24, avatar ≈44, cover thumb ≈44, play disc ≈44.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginBottom: spacing.md,
    },
    feedMain: {
      flex: 1,
    },
    feedNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    feedNameLine: {
      ...typeStyles.body,
      flex: 1,
      color: theme.muted,
    },
    feedName: {
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    feedHandle: {
      fontFamily: fontFamilies.body,
      color: theme.muted,
    },
    feedTime: {
      ...typeStyles.caption,
      color: theme.muted,
      flexShrink: 0,
    },
    feedAction: {
      ...typeStyles.body,
      color: theme.muted,
      marginTop: 1,
    },
    feedThemeInline: {
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    feedChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      alignSelf: 'flex-start',
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      marginTop: spacing.xs,
    },
    feedChipText: {
      ...typeStyles.caption,
      color: theme.onAccentContainer,
    },
    feedThumb: {
      width: 44,
      height: 44,
      borderRadius: radii.base,
      backgroundColor: theme.surface,
    },
    feedThumbPlaceholder: {
      backgroundColor: theme.raised,
    },
    feedPlayDisc: {
      width: 44,
      height: 44,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
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

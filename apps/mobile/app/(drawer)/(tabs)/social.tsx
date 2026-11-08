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
import { Headphones, Search, Star, UserPlus, X } from 'lucide-react-native';
import type {
  FriendsActivityItem,
  NetworkUser,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { PersonRow } from '../../../src/components/PersonRow';
import { fetchFriendsActivity, searchUsers } from '../../../src/socialApi';
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
 * Social (Slice M5) — the real tab. Two parts:
 *
 * - People search at the top: the users branch of search
 *   (GET /social/users/search), live from 2 characters, paged with
 *   a Load more row; results route to profiles.
 * - The friends-activity feed: recent watches ('listening') and
 *   ratings ('liked') by people the caller follows. The feed is
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

  useFocusEffect(
    useCallback(() => {
      loadFeed();
    }, [loadFeed]),
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
    const ActionIcon = item.type === 'liked' ? Star : Headphones;
    const verb = item.type === 'liked' ? 'rated' : 'listened to';
    return (
      <View key={item.id} style={styles.feedRow}>
        <Pressable
          onPress={() => openProfile(item.user.username)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.user.displayName}'s profile`}
          hitSlop={4}
        >
          <Avatar
            url={item.user.avatar}
            name={item.user.displayName || item.user.username}
            size={40}
          />
        </Pressable>
        <Pressable
          onPress={() => router.push(`/theme/${item.item.slug}`)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.item.title}`}
          style={({ pressed }) => [
            styles.feedMain,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.feedName} numberOfLines={1}>
            {item.user.displayName || item.user.username}
            <Text style={styles.feedTime}>
              {'  ·  '}
              {relativeTime(item.timestamp)}
            </Text>
          </Text>
          <View style={styles.feedAction}>
            <ActionIcon size={13} color={theme.muted} strokeWidth={2} />
            <Text style={styles.feedTitle} numberOfLines={1}>
              {verb} {item.item.title}
            </Text>
          </View>
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
            <Text style={styles.heading}>Friends activity</Text>
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
                  : 'Nothing new from people you follow yet. Their watches and ratings will show up here.'}
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
    feedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 56,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    feedMain: {
      flex: 1,
      gap: 2,
    },
    feedName: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    feedTime: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.caption,
      color: theme.muted,
    },
    feedAction: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
    },
    feedTitle: {
      ...typeStyles.caption,
      color: theme.muted,
      flex: 1,
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

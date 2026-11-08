import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Play, Shuffle, Users } from 'lucide-react-native';
import type {
  FriendsActivityItem,
  HomeResponse,
  ThemeType,
  WatchHistoryEntry,
} from '@kaikansen/contracts';
import { fetchHome, fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { useFavorites } from '../../../src/favoritesStore';
import { fetchHistory } from '../../../src/libraryApi';
import { fetchFriendsActivity } from '../../../src/socialApi';
import { Avatar } from '../../../src/components/Avatar';
import { PopularCard } from '../../../src/components/PopularCard';
import { PosterCard } from '../../../src/components/PosterCard';
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

type TypeFilter = 'ALL' | ThemeType;

/** How many feed rows Home previews; the full feed lives on Social. */
const HOME_FEED_PREVIEW = 5;

/**
 * Home — the web home composition at phone size (HomeClient.tsx):
 * season poster rail → Surprise card → Friends Activity → Popular
 * Themes with the OP/ED filter → the web's end marker. The visual
 * treatments are ported from the website's Home (2026-11-08): season
 * cards carry the title in-art over a scrim (ThemeFeaturedCard),
 * Surprise is the web's quiet accent-container card with a circular
 * shuffle button (SurpriseBanner), Friends Activity uses the web's
 * empty/loading cards (FriendsActivity.tsx), and Popular rows are the
 * web's rounded accent-container cards with play + heart
 * (ThemeListRow). Content sits in a centred, width-capped column, and
 * the type filter is a segmented All/OP/ED control in the Popular
 * header row. Data comes from the new API, or from the bundled
 * real-data fixture when no API URL is configured (see src/api.ts).
 */
export default function HomeScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const { status, user } = useAuth();
  const signedIn = status === 'signedIn' && user !== null;
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [feed, setFeed] = useState<FriendsActivityItem[] | null>(null);
  const [feedFailed, setFeedFailed] = useState(false);
  const [history, setHistory] = useState<WatchHistoryEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    setHome(null);
    setError(null);
    fetchHome()
      .then((data) => {
        if (live) setHome(data);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : 'Could not load themes.');
        }
      });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  /* Friends Activity (the web's section): the follow-based feed from
     Slice M5, refetched on focus like the Social tab. Signed-out
     never fetches — the section renders its sign-in empty card. */
  const loadFeed = useCallback(() => {
    if (!signedIn) return;
    fetchFriendsActivity(30)
      .then((res) => {
        setFeed(res.activities);
        setFeedFailed(false);
      })
      .catch(() => setFeedFailed(true));
  }, [signedIn]);

  /* Continue Listening (the mock's rail between Surprise and Friends
     Activity): the caller's recent history, signed-in only. Failures
     and empty history hide the rail — it is a convenience surface,
     never an error state. */
  const loadHistory = useCallback(() => {
    if (!signedIn || fixtureMode) return;
    fetchHistory()
      .then((res) =>
        setHistory(res.entries.filter((e) => e.theme !== null).slice(0, 10)),
      )
      .catch(() => setHistory([]));
  }, [signedIn]);

  useFocusEffect(
    useCallback(() => {
      loadFeed();
      loadHistory();
    }, [loadFeed, loadHistory]),
  );

  const continuePlay = useCallback(
    (entry: WatchHistoryEntry) => {
      if (!entry.theme) return;
      router.push({
        pathname: '/player',
        params: {
          slug: entry.theme.slug,
          mode: entry.mode,
          ...(entry.atEntryId != null
            ? { entry: String(entry.atEntryId) }
            : {}),
        },
      });
    },
    [router],
  );

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );

  const openProfile = useCallback(
    (username: string) => router.push(`/user/${username}`),
    [router],
  );

  const surprise = useCallback(() => {
    if (!home) return;
    const pool = home.popular.length > 0 ? home.popular : home.seasonRail;
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    openTheme(pick.slug);
  }, [home, openTheme]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Couldn’t load Home.</Text>
        <Text style={styles.errorDetail}>{error}</Text>
        <Pressable
          style={styles.retry}
          onPress={() => setReloadKey((k) => k + 1)}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  if (!home) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.loadingText}>Loading themes…</Text>
      </View>
    );
  }

  const popular =
    typeFilter === 'ALL'
      ? home.popular
      : home.popular.filter((t) => t.type === typeFilter);

  /* Friends Activity states, mirroring the web's FriendsActivity:
     loading card → feed card → empty card. Copy is honest per state:
     signed-out gets the sign-in framing, signed-in with no activity
     gets the web's follow framing. */
  const feedLoading = signedIn && feed === null && !feedFailed;
  const feedItems = feed ?? [];
  const feedEmpty = !feedLoading && feedItems.length === 0;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.column}>
        {fixtureMode && (
          <Text style={styles.fixtureNote}>
            Fixture mode — showing the bundled catalogue snapshot (no API URL
            configured).
          </Text>
        )}
        {favorites.lastError && (
          <Pressable
            onPress={favorites.clearError}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.saveError}>{favorites.lastError}</Text>
          </Pressable>
        )}

        {/* Season poster rail — Lavender Dusk header treatment: mauve
            eyebrow over the big season title, View All on the right
            (opens the Season browse screen, §6.5). */}
        <View
          style={[
            styles.sectionHeader,
            styles.sectionHeaderFirst,
            styles.seasonHeaderRow,
          ]}
        >
          <View>
            <Text style={styles.eyebrow}>Current Season</Text>
            <Text style={styles.displayTitle}>
              {home.season.season} {home.season.year}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push('/season')}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="View all season themes"
          >
            <Text style={styles.feedLink}>View All</Text>
          </Pressable>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rail}
        >
          {home.seasonRail.map((item) => (
            <PosterCard
              key={item.slug}
              item={item}
              onPress={() => openTheme(item.slug)}
            />
          ))}
          {home.seasonRail.length === 0 && (
            <Text style={styles.emptyText}>No themes this season yet.</Text>
          )}
        </ScrollView>

        {/* Surprise — the web's SurpriseBanner as a quiet card:
            title + subtitle on the left, circular accent shuffle
            button on the right (same random-pick behaviour). */}
        <Pressable
          onPress={surprise}
          style={({ pressed }) => [
            styles.surprise,
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Surprise me"
        >
          <View style={styles.surpriseTextBlock}>
            <Text style={styles.surpriseTitle}>Surprise Me</Text>
            <Text style={styles.surpriseSubtitle}>
              Discover a random track
            </Text>
          </View>
          <View style={styles.surpriseButton}>
            <Shuffle size={20} color={theme.onAccent} strokeWidth={2} />
          </View>
        </Pressable>

        {/* Continue Listening — recent history as landscape cards
            with a play disc; tapping resumes in the entry's mode. */}
        {history !== null && history.length > 0 && (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.heading}>Continue Listening</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rail}
            >
              {history.map((entry) => (
                <Pressable
                  key={entry.id}
                  onPress={() => continuePlay(entry)}
                  accessibilityRole="button"
                  accessibilityLabel={`Continue ${entry.theme!.songTitle}`}
                  style={({ pressed }) => [
                    styles.continueCard,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.continueArtWrap}>
                    {entry.theme!.animeCoverImage ? (
                      <Image
                        source={{ uri: entry.theme!.animeCoverImage }}
                        style={styles.continueArt}
                      />
                    ) : (
                      <View
                        style={[
                          styles.continueArt,
                          { backgroundColor: theme.raised },
                        ]}
                      />
                    )}
                    <View style={styles.continuePlay}>
                      <Play
                        size={13}
                        color={theme.onAccent}
                        fill={theme.onAccent}
                        strokeWidth={2}
                      />
                    </View>
                  </View>
                  <Text style={styles.continueTitle} numberOfLines={1}>
                    {entry.theme!.songTitle}
                  </Text>
                  <Text style={styles.continueArtist} numberOfLines={1}>
                    {entry.theme!.artistName ?? entry.theme!.animeTitle}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}

        {/* Friends Activity */}
        <View style={[styles.sectionHeader, styles.feedHeader]}>
          <Text style={styles.heading}>Friends Activity</Text>
          <Pressable
            onPress={() => router.push('/social')}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={feedEmpty ? 'Find friends' : 'View full feed'}
          >
            <Text style={styles.feedLink}>
              {feedEmpty ? 'Find Friends' : 'View Full Feed'}
            </Text>
          </Pressable>
        </View>
        {feedLoading ? (
          <View style={styles.feedCardEmpty}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.feedEmptySub}>
              Catching up with friends…
            </Text>
          </View>
        ) : feedEmpty ? (
          <View style={styles.feedCardEmpty}>
            <View style={styles.feedIconCircle}>
              <Users size={24} color={theme.secondary} strokeWidth={2} />
            </View>
            <Text style={styles.feedEmptyTitle}>
              No activity from friends yet.
            </Text>
            <Text style={styles.feedEmptySub}>
              {signedIn
                ? 'Follow some people to see what they’re listening to!'
                : 'Sign in to see what your friends are listening to!'}
            </Text>
          </View>
        ) : (
          <View style={styles.feedCard}>
            {feedItems.slice(0, HOME_FEED_PREVIEW).map((activity) => (
              <View key={activity.id} style={styles.feedRow}>
                <Pressable
                  onPress={() => openProfile(activity.user.username)}
                  accessibilityRole="button"
                  accessibilityLabel={`${activity.user.displayName}'s profile`}
                >
                  <Avatar
                    url={activity.user.avatar}
                    name={activity.user.displayName}
                    size={44}
                  />
                </Pressable>
                <View style={styles.feedMain}>
                  <Text style={styles.feedLine} numberOfLines={1}>
                    <Text
                      style={styles.feedName}
                      onPress={() => openProfile(activity.user.username)}
                    >
                      {activity.user.displayName}
                    </Text>
                    {activity.type === 'listening'
                      ? ' is listening to'
                      : ' liked'}
                  </Text>
                  <Pressable onPress={() => openTheme(activity.item.slug)}>
                    <Text style={styles.feedTheme} numberOfLines={1}>
                      {activity.item.title}
                    </Text>
                  </Pressable>
                </View>
                <Text style={styles.feedTime}>
                  {relativeTime(activity.timestamp)}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Popular Themes with the All/OP/ED segmented filter (the existing
            client-side type filter in segmented-control dress; the web
            filters server-side — FR-HOME-01). Rows are the web's rounded
            Popular cards with play + heart. */}
        <View style={[styles.sectionHeader, styles.popularHeader]}>
          <Text style={styles.heading}>Popular Themes</Text>
          <View style={styles.segmented}>
            {(['ALL', 'OP', 'ED'] as TypeFilter[]).map((value) => {
              const active = typeFilter === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setTypeFilter(value)}
                  hitSlop={{ top: 6, bottom: 6 }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Filter: ${value === 'ALL' ? 'All' : value}`}
                  style={[
                    styles.segment,
                    active && { backgroundColor: theme.accent },
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      active && { color: theme.onAccent },
                    ]}
                  >
                    {value === 'ALL' ? 'All' : value}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.list}>
          {popular.map((item) => (
            <PopularCard
              key={item.slug}
              item={item}
              onPress={() => openTheme(item.slug)}
              saved={favorites.isFavorite(item.slug)}
              savePending={favorites.isPending(item.slug)}
              onToggleSave={() => void favorites.toggle(item.slug)}
            />
          ))}
          {popular.length === 0 && (
            <Text style={styles.emptyText}>No {typeFilter} themes here.</Text>
          )}
        </View>

        {/* The web's own end-of-list marker (DESIGN.md §6.4). */}
        <Text style={styles.endMarker}>
          You’ve reached the end of the hall of fame! ✨
        </Text>
      </View>
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: theme.background,
  },
  content: {
    paddingBottom: spacing.xxxl,
  },
  column: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  center: {
    flex: 1,
    backgroundColor: theme.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.screenEdge,
  },
  loadingText: {
    ...typeStyles.body,
    color: theme.muted,
  },
  errorText: {
    ...typeStyles.heading,
    color: theme.text,
  },
  errorDetail: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    textAlign: 'center',
  },
  retry: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radii.base,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: {
    ...typeStyles.body,
    color: theme.text,
  },
  fixtureNote: {
    ...typeStyles.caption,
    color: theme.muted,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.md,
  },
  saveError: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.md,
    lineHeight: 18,
  },
  sectionHeader: {
    paddingHorizontal: spacing.screenEdge,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  sectionHeaderFirst: {
    marginTop: spacing.md,
  },
  heading: {
    ...typeStyles.heading,
    color: theme.text,
  },
  seasonHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  eyebrow: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.sectionLabel,
    color: theme.secondary,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  continueCard: {
    width: 168,
  },
  continueArtWrap: {
    position: 'relative',
  },
  continueArt: {
    width: 168,
    height: 96,
    borderRadius: radii.md,
    backgroundColor: theme.surface,
  },
  continuePlay: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueTitle: {
    ...typeStyles.body,
    fontSize: 13,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    marginTop: spacing.sm,
  },
  continueArtist: {
    ...typeStyles.caption,
    color: theme.muted,
    marginTop: 1,
  },
  displayTitle: {
    ...typeStyles.display,
    color: theme.text,
  },
  rail: {
    paddingHorizontal: spacing.screenEdge,
    gap: spacing.sm,
  },
  surprise: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginHorizontal: spacing.screenEdge,
    marginTop: spacing.lg,
    backgroundColor: theme.accentContainer,
    borderRadius: radii.cardLg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    minHeight: 44,
  },
  pressed: {
    opacity: 0.85,
  },
  surpriseTextBlock: {
    flex: 1,
    gap: 2,
  },
  surpriseTitle: {
    ...typeStyles.heading,
    color: theme.text,
  },
  surpriseSubtitle: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  surpriseButton: {
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  feedLink: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.accent,
  },
  feedCard: {
    marginHorizontal: spacing.screenEdge,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.cardLg,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  feedCardEmpty: {
    marginHorizontal: spacing.screenEdge,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.cardLg,
    padding: spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  feedIconCircle: {
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  feedEmptyTitle: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    textAlign: 'center',
  },
  feedEmptySub: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    textAlign: 'center',
  },
  feedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  feedMain: {
    flex: 1,
  },
  feedLine: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  feedName: {
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  feedTheme: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.accent,
  },
  feedTime: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  emptyText: {
    ...typeStyles.body,
    color: theme.muted,
    paddingHorizontal: spacing.screenEdge,
    lineHeight: 20,
  },
  popularHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  segmented: {
    // Lavender Dusk mock: the filter is three separate pills, not one
    // segmented bar — lavender chip inactive, mauveDeep filled active.
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  segment: {
    minWidth: 44,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: theme.accentContainer,
  },
  segmentText: {
    ...typeStyles.caption,
    fontFamily: 'Inter_600SemiBold',
    color: theme.onAccentContainer,
  },
  list: {
    paddingHorizontal: spacing.screenEdge,
    gap: spacing.sm,
  },
  endMarker: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    textAlign: 'center',
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.screenEdge,
  },
});

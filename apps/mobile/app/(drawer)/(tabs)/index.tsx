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
import { AudioLines, Headphones, ListMusic, Play, Shuffle, Star, Users } from 'lucide-react-native';
import type {
  FriendsActivityItem,
  HomeResponse,
  NetworkUser,
  ThemeSummary,
  ThemeType,
  WatchHistoryEntry,
} from '@kaikansen/contracts';
import { fetchHome, fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { useFavorites } from '../../../src/favoritesStore';
import { fetchHistory } from '../../../src/libraryApi';
import {
  queueItemFromSummary,
  queueItemsFromSummaries,
  usePlaybackSession,
} from '../../../src/playback-context';
import { fetchFriendsActivity, fetchUserNetwork } from '../../../src/socialApi';
import { Avatar } from '../../../src/components/Avatar';
import { PopularCard } from '../../../src/components/PopularCard';
import { PosterCard } from '../../../src/components/PosterCard';
import { relativeTime } from '../../../src/time';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type TypeFilter = 'ALL' | ThemeType;

/** 'SPRING' → 'Spring' — the mocks title-case the season name. */
function seasonTitleCase(season: string): string {
  return season.charAt(0) + season.slice(1).toLowerCase();
}

/** How many feed rows Home previews; the full feed lives on Social. */
const HOME_FEED_PREVIEW = 5;

/** The strip's "recently active" window for the green dot (24h). */
const RECENT_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** One friend in the Rich Social Feed strip (network or feed actor). */
interface StripFriend {
  username: string;
  displayName: string;
  avatar: string | null;
}

/** Alpha steps of the Surprise banner's artwork fade (left → clear). */
const SURPRISE_FADE_ALPHAS = [1, 0.85, 0.68, 0.5, 0.33, 0.18, 0.07];

/** First name for the strip label: the display name's first word. */
function firstNameOf(displayName: string, username: string): string {
  return displayName.trim().split(/\s+/)[0] || username;
}

/**
 * Home — the web home composition at phone size (HomeClient.tsx):
 * season poster rail → Surprise card → Friends Activity → Popular
 * Themes with the OP/ED filter → the web's end marker. The visual
 * treatments are ported from the website's Home (2026-11-08): season
 * cards carry the title in-art over a scrim (ThemeFeaturedCard),
 * Surprise composites the rolled theme's anime cover on the right
 * under a translucent shuffle disc (Lavender Dusk Home mock), Friends
 * Activity is the owner's Variant 3 "Rich Social Feed" card (active-
 * friends strip + detailed rows in one card), and Popular rows are the
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
  const [friends, setFriends] = useState<NetworkUser[] | null>(null);
  const [history, setHistory] = useState<WatchHistoryEntry[] | null>(null);
  /* The Surprise banner's current roll: chosen from the same pool
     the tap uses (Popular, else the season rail) so the banner can
     composite that theme's real cover art, per the Lavender Dusk
     mock. Rolled when Home data lands and re-rolled on every tap. */
  const [surprisePick, setSurprisePick] = useState<ThemeSummary | null>(null);

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

  /* The Rich Social Feed strip's friends: the caller's own following
     list, loaded exactly like the Social tab's YOUR FRIENDS rail. A
     failure hides the network source (null) — the strip then falls
     back to the feed's own actors (see stripFriends below). */
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
      loadFriends();
      loadHistory();
    }, [loadFeed, loadFriends, loadHistory]),
  );

  const { startQueue } = usePlaybackSession();
  const continuePlay = useCallback(
    (entry: WatchHistoryEntry) => {
      if (!entry.theme) return;
      // The rail is the queue (Slice 2.5): the shown history, in
      // order, claimed in the tapped entry's mode — Next walks
      // back through what you were listening to. Navigation goes
      // to the theme detail, NOT the player route: the player
      // route is playlist/offline-only (owner ruling 2026-11-10,
      // recorded in app/(drawer)/player.tsx). The detail hero
      // renders the claimed session inline.
      if (history) {
        const playable = history.filter((e) => e.theme !== null);
        const items = playable.map((e) => ({
          ...queueItemFromSummary(e.theme!),
          atEntryId: e.atEntryId,
        }));
        const index = playable.findIndex((e) => e.id === entry.id);
        if (index >= 0) startQueue(items, index, entry.mode);
      }
      router.push(`/theme/${entry.theme.slug}`);
    },
    [router, history, startQueue],
  );

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );

  const openProfile = useCallback(
    (username: string) => router.push(`/user/${username}`),
    [router],
  );

  /* One roll of the Surprise pool — Popular when it has entries,
     else the season rail (the tap's pool since the web port). */
  const rollSurprise = useCallback((): ThemeSummary | null => {
    if (!home) return null;
    const pool = home.popular.length > 0 ? home.popular : home.seasonRail;
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }, [home]);

  /* Roll the banner's displayed theme when Home data lands, so its
     cover can be composited into the banner (the mock's treatment). */
  useEffect(() => {
    if (home) setSurprisePick(rollSurprise());
  }, [home, rollSurprise]);

  const surprise = useCallback(() => {
    const pick = rollSurprise();
    if (!pick) return;
    setSurprisePick(pick);
    openTheme(pick.slug);
  }, [rollSurprise, openTheme]);

  /* Rich Social Feed derivations. The newest real activity per
     friend, from the loaded feed's own timestamps — the app's only
     activity signal (there is NO presence system; the strip's green
     dot means "active in the last 24h", never "online now"). */
  const lastActivityAt = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of feed ?? []) {
      const t = new Date(a.timestamp).getTime();
      if (Number.isNaN(t)) continue;
      const prev = map.get(a.user.username);
      if (prev === undefined || t > prev) map.set(a.user.username, t);
    }
    return map;
  }, [feed]);

  const isRecentlyActive = (username: string): boolean => {
    const t = lastActivityAt.get(username);
    return t !== undefined && Date.now() - t < RECENT_ACTIVE_MS;
  };

  /* Strip friends: the caller's following list when it loaded,
     otherwise the feed's distinct actors. Recently active friends
     sort first (stable sort — source order survives otherwise). */
  const stripFriends = useMemo<StripFriend[]>(() => {
    const base: StripFriend[] = [];
    const seen = new Set<string>();
    if (friends && friends.length > 0) {
      for (const f of friends) {
        if (seen.has(f.username)) continue;
        seen.add(f.username);
        base.push({
          username: f.username,
          displayName: f.displayName,
          avatar: f.avatarUrl,
        });
      }
    } else {
      for (const a of feed ?? []) {
        if (seen.has(a.user.username)) continue;
        seen.add(a.user.username);
        base.push({
          username: a.user.username,
          displayName: a.user.displayName,
          avatar: a.user.avatar,
        });
      }
    }
    return base.sort(
      (x, y) =>
        (lastActivityAt.get(y.username) ?? -1) -
        (lastActivityAt.get(x.username) ?? -1),
    );
  }, [friends, feed, lastActivityAt]);

  /* Cover art fallback for feed rows, resolved by slug from the
     theme lists Home already loaded (season rail, Popular, Continue
     Listening). The enriched feed payload carries each row's own
     cover (item.cover) — this map only fills rows whose payload
     cover is null; a row with neither renders the neutral
     placeholder tile instead of invented art. */
  const coverBySlug = useMemo(() => {
    const map = new Map<string, string>();
    const add = (t: ThemeSummary) => {
      const cover = t.animeCoverImage ?? t.animeCoverImageSmall;
      if (cover && !map.has(t.slug)) map.set(t.slug, cover);
    };
    if (home) {
      home.seasonRail.forEach(add);
      home.popular.forEach(add);
    }
    for (const e of history ?? []) {
      if (e.theme) add(e.theme);
    }
    return map;
  }, [home, history]);

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

  /* Friends Activity states (Rich Social Feed): loading card →
     strip + rows card → the web's empty card. Copy is honest per
     state: signed-out gets the sign-in framing, signed-in with
     friends but no activity gets the strip card with a no-activity
     line, signed-in with no friends gets the follow framing. */
  const feedLoading = signedIn && feed === null && !feedFailed;
  const feedItems = feed ?? [];

  /* The Surprise banner's artwork: the rolled theme's anime cover —
     the same field the Home rails draw (PosterCard's order). */
  const surpriseCover = surprisePick
    ? (surprisePick.animeCoverImage ?? surprisePick.animeCoverImageSmall)
    : null;

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
              {seasonTitleCase(home.season.season)} {home.season.year}
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
          contentContainerStyle={[styles.rail, styles.seasonRail]}
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

        {/* Surprise — the Lavender Dusk mock's banner: the rolled
            theme's anime cover composited on the right, fading into
            the lavender at its left edge (stacked translucent strips
            stand in for a gradient — no gradient library in the app,
            the PosterCard scrim pattern), title + subtitle on the
            left, and the shuffle disc translucent over the artwork.
            Without a cover the banner is the plain card with the
            solid disc, as before. */}
        <Pressable
          onPress={surprise}
          style={({ pressed }) => [
            styles.surprise,
            pressed && styles.pressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Surprise me"
        >
          {surpriseCover && (
            <View style={styles.surpriseArtWrap} pointerEvents="none">
              <Image
                source={{ uri: surpriseCover }}
                style={styles.surpriseArt}
                resizeMode="cover"
              />
              <View style={styles.surpriseFade}>
                {SURPRISE_FADE_ALPHAS.map((alpha) => (
                  <View
                    key={alpha}
                    style={[
                      styles.surpriseFadeStrip,
                      {
                        backgroundColor: withOpacity(
                          theme.accentContainer,
                          alpha,
                        ),
                      },
                    ]}
                  />
                ))}
              </View>
            </View>
          )}
          <View style={styles.surpriseTextBlock}>
            <Text style={styles.surpriseTitle}>Surprise Me</Text>
            <Text style={styles.surpriseSubtitle}>
              Discover a random track
            </Text>
          </View>
          <View
            style={[
              styles.surpriseButton,
              surpriseCover && {
                backgroundColor: withOpacity(theme.accent, 0.85),
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.45)',
              },
            ]}
          >
            <Shuffle size={28} color={theme.onAccent} strokeWidth={2} />
          </View>
        </Pressable>

        {/* Continue Listening — the Home v3 mock's card (owner
            correction, 2026-11-10): a frosted white card holding
            SQUARE cover art, a progress bar under the art, and the
            title + artist inside the card; a mauve play disc
            overlaps the art's bottom-right corner. The card body
            opens the theme; the disc resumes in the entry's mode. */}
        {history !== null && history.length > 0 && (
          <>
            <View style={[styles.sectionHeader, styles.feedHeader]}>
              <Text style={styles.heading}>Continue Listening</Text>
              <Pressable
                onPress={() =>
                  router.push('/(drawer)/(tabs)/library?segment=recent')
                }
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="View all listening history"
              >
                <Text style={styles.feedLink}>View All</Text>
              </Pressable>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[styles.rail, styles.continueRail]}
            >
              {history.map((entry) => (
                <Pressable
                  key={entry.id}
                  onPress={() => openTheme(entry.theme!.slug)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${entry.theme!.songTitle}`}
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
                    <Pressable
                      onPress={() => continuePlay(entry)}
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel={`Continue ${entry.theme!.songTitle}`}
                      style={({ pressed }) => [
                        styles.continuePlay,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Play
                        size={14}
                        color={theme.onAccent}
                        fill={theme.onAccent}
                        strokeWidth={2}
                      />
                    </Pressable>
                  </View>
                  {/* Resume progress. No fraction is drawn yet:
                      history records only THAT a theme played —
                      the shared watchhistories rows carry no
                      position field and the player never persists
                      one — so there is no real value to fill the
                      measured track with (owner report, 2026-11-10).
                      The fill takes the recorded fraction the day
                      position recording exists end to end. */}
                  <View style={styles.continueProgressTrack}>
                    <View
                      style={[
                        styles.continueProgressFill,
                        { width: '0%' },
                      ]}
                    />
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

        {/* Friends Activity — Variant 3 "Rich Social Feed" (owner's
            pick): one card holding the active-friends strip over the
            detailed activity rows. The strip's green dot means the
            friend has real feed activity inside 24h — derived from
            the feed's timestamps; there is no presence system, so it
            never claims "online". */}
        <View style={[styles.sectionHeader, styles.feedHeader]}>
          <Text style={styles.heading}>Friends Activity</Text>
          <Pressable
            onPress={() => router.push('/social')}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Find friends"
          >
            <Text style={styles.feedLink}>Find Friends</Text>
          </Pressable>
        </View>
        {feedLoading ? (
          <View style={styles.feedCardEmpty}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.feedEmptySub}>
              Catching up with friends…
            </Text>
          </View>
        ) : signedIn && stripFriends.length > 0 ? (
          <View style={styles.feedCard}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.stripRow}
            >
              {stripFriends.map((friend) => (
                <Pressable
                  key={friend.username}
                  onPress={() => openProfile(friend.username)}
                  style={styles.stripItem}
                  accessibilityRole="button"
                  accessibilityLabel={`${friend.displayName}'s profile`}
                >
                  <View style={styles.stripAvatarRing}>
                    <Avatar
                      url={friend.avatar}
                      name={friend.displayName}
                      seed={friend.username}
                      size={48}
                    />
                    {isRecentlyActive(friend.username) && (
                      <View style={styles.activeDot} />
                    )}
                  </View>
                  <Text style={styles.stripName} numberOfLines={1}>
                    {firstNameOf(friend.displayName, friend.username)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.feedDivider} />
            {feedItems.length > 0 ? (
              <View>
                {feedItems
                  .slice(0, HOME_FEED_PREVIEW)
                  .map((activity, index, rows) => {
                    const cover =
                      activity.item.cover ??
                      coverBySlug.get(activity.item.slug);
                    const listening = activity.type === 'listening';
                    const playlistAdd = activity.type === 'playlist_add';
                    return (
                      <View key={activity.id}>
                        <View style={styles.feedRow}>
                          <View style={styles.feedAvatarWrap}>
                            <Pressable
                              onPress={() =>
                                openProfile(activity.user.username)
                              }
                              accessibilityRole="button"
                              accessibilityLabel={`${activity.user.displayName}'s profile`}
                            >
                              <Avatar
                                url={activity.user.avatar}
                                name={activity.user.displayName}
                                seed={activity.user.username}
                                size={44}
                              />
                            </Pressable>
                            <View
                              style={[
                                styles.feedBadge,
                                {
                                  backgroundColor: listening
                                    ? theme.accent
                                    : playlistAdd
                                      ? theme.success
                                      : theme.secondary,
                                },
                              ]}
                            >
                              {listening ? (
                                <Headphones
                                  size={11}
                                  color={theme.onAccent}
                                  strokeWidth={2}
                                />
                              ) : playlistAdd ? (
                                <ListMusic
                                  size={11}
                                  color={theme.onAccent}
                                  strokeWidth={2}
                                />
                              ) : (
                                <Star
                                  size={11}
                                  color={theme.onAccent}
                                  fill={theme.onAccent}
                                  strokeWidth={2}
                                />
                              )}
                            </View>
                          </View>
                          <View style={styles.feedMain}>
                            <View style={styles.feedNameRow}>
                              <Text
                                style={styles.feedNameLine}
                                numberOfLines={1}
                              >
                                <Text
                                  style={styles.feedName}
                                  onPress={() =>
                                    openProfile(activity.user.username)
                                  }
                                >
                                  {activity.user.displayName}
                                </Text>
                                <Text style={styles.feedHandle}>
                                  {' '}
                                  @{activity.user.username}
                                </Text>
                              </Text>
                              <Text style={styles.feedTime}>
                                {relativeTime(activity.timestamp)}
                              </Text>
                            </View>
                            <Text
                              style={styles.feedAction}
                              numberOfLines={2}
                            >
                              {listening
                                ? 'listened to '
                                : playlistAdd
                                  ? 'added '
                                  : 'rated '}
                              <Text
                                style={styles.feedThemeInline}
                                onPress={() =>
                                  openTheme(activity.item.slug)
                                }
                              >
                                {activity.item.title}
                              </Text>
                              {playlistAdd
                                ? ` to ${activity.item.playlistName ?? 'a playlist'}`
                                : activity.item.artist
                                  ? ` · ${activity.item.artist}`
                                  : ''}
                            </Text>
                            {listening && (
                              <View style={styles.feedChip}>
                                <AudioLines
                                  size={11}
                                  color={theme.onAccentContainer}
                                  strokeWidth={2}
                                />
                                <Text style={styles.feedChipText}>
                                  listening
                                </Text>
                              </View>
                            )}
                            {!listening &&
                              !playlistAdd &&
                              activity.item.score !== null && (
                                <View style={styles.feedChip}>
                                  <Star
                                    size={11}
                                    color={theme.onAccentContainer}
                                    fill={theme.onAccentContainer}
                                    strokeWidth={2}
                                  />
                                  <Text style={styles.feedChipText}>
                                    {activity.item.score}/10
                                  </Text>
                                </View>
                              )}
                          </View>
                          <Pressable
                            onPress={() => openTheme(activity.item.slug)}
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${activity.item.title}`}
                            style={styles.feedThumbWrap}
                          >
                            {cover ? (
                              <>
                                <Image
                                  source={{ uri: cover }}
                                  style={styles.feedThumb}
                                />
                                <View style={styles.feedThumbPlay}>
                                  <Play
                                    size={10}
                                    color="#FFFFFF"
                                    fill="#FFFFFF"
                                    strokeWidth={2}
                                  />
                                </View>
                              </>
                            ) : (
                              <View
                                style={[
                                  styles.feedThumb,
                                  styles.feedThumbPlaceholder,
                                ]}
                              />
                            )}
                          </Pressable>
                        </View>
                        {index < rows.length - 1 && (
                          <View style={styles.feedRowDivider} />
                        )}
                      </View>
                    );
                  })}
              </View>
            ) : (
              <Text style={styles.feedNoActivity}>
                No activity from friends yet.
              </Text>
            )}
          </View>
        ) : (
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
        )}

        {/* Popular Themes with the All/OP/ED segmented filter (the existing
            client-side type filter in segmented-control dress; the web
            filters server-side — FR-HOME-01). Rows are the web's rounded
            Popular cards with play + heart. */}
        <View style={[styles.sectionHeader, styles.popularHeader]}>
          <Text style={styles.heading}>🔥 Popular Themes</Text>
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
          {popular.map((item, index) => (
            <PopularCard
              key={item.slug}
              item={item}
              onPress={() => openTheme(item.slug)}
              onPlay={() => {
                // The shown (type-filtered) Popular list is the
                // queue (Slice 2.5): the play disc claims it at
                // this row, then opens the theme detail — the
                // player route is playlist/offline-only (owner
                // ruling 2026-11-10), and the detail hero renders
                // the claimed session inline.
                startQueue(queueItemsFromSummaries(popular), index, 'watch');
                openTheme(item.slug);
              }}
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
  // Continue Listening card — measured from the Home v3 Stitch
  // HTML (home-v3.html): w-28 card (112) at p-2 (8) with rounded-2xl
  // (16); square art at rounded-xl (12); play disc w-6 (24) in mauve
  // (#8e5b7b = secondary) hung -bottom-2 / -right-1 off the art;
  // progress h-1 (4) at mt-2.5 / mb-1; title text-xs bold (12);
  // artist text-[10px] medium (10). The white is the Home glass
  // treatment (design law #3, as on PopularCard) at this card's
  // measured 80% (the HTML's bg-white/80).
  continueCard: {
    width: 112,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: withOpacity(theme.surface, 0.8),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  continueArtWrap: {
    position: 'relative',
  },
  continueArt: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  continuePlay: {
    position: 'absolute',
    right: -4,
    bottom: -8,
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    backgroundColor: theme.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  continueProgressTrack: {
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: theme.raised,
    overflow: 'hidden',
    marginTop: 10,
    marginBottom: spacing.xs,
  },
  continueProgressFill: {
    height: '100%',
    borderRadius: radii.pill,
    backgroundColor: theme.secondary,
  },
  continueTitle: {
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 12,
    color: theme.text,
  },
  continueArtist: {
    fontFamily: fontFamilies.caption,
    fontSize: 10,
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
  seasonRail: {
    // The Home mock's season cards sit ≈29px apart @2x ≈ 14pt
    // (measured from kaikansen-home-v3-realimg.png) — wider than
    // the shared rail gap the Continue Listening rail keeps.
    gap: 14,
  },
  continueRail: {
    // The Home v3 HTML draws the Continue rail at gap-3 (12) with
    // pb-1 (4) under the cards.
    gap: spacing.md,
    paddingBottom: spacing.xs,
  },
  surprise: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // Owner tweak (2026-11-10): the banner renders at 1.4× its
    // original size — the metrics here are the originals × 1.4
    // (gap 12 → 17, paddingHorizontal 20 → 28, paddingVertical
    // 12 → 17, minHeight 44 → 62), with the title/subtitle sizes
    // and the shuffle disc scaled to match (see below), so the
    // box stands ≈101pt tall against the previous ≈72pt.
    gap: 17,
    marginHorizontal: spacing.screenEdge,
    marginTop: spacing.lg,
    backgroundColor: theme.accentContainer,
    borderRadius: radii.cardLg,
    paddingHorizontal: 28,
    paddingVertical: 17,
    minHeight: 62,
    overflow: 'hidden',
  },
  surpriseArtWrap: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: '62%',
  },
  surpriseArt: {
    width: '100%',
    height: '100%',
  },
  surpriseFade: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '55%',
    flexDirection: 'row',
  },
  surpriseFadeStrip: {
    flex: 1,
  },
  pressed: {
    opacity: 0.85,
  },
  surpriseTextBlock: {
    flex: 1,
    gap: 3,
  },
  surpriseTitle: {
    ...typeStyles.heading,
    // × 1.4 with the banner (2026-11-10): 18 → 25.
    fontSize: 25,
    color: theme.text,
  },
  surpriseSubtitle: {
    ...typeStyles.bodySmall,
    // × 1.4 with the banner (2026-11-10): 12 → 17.
    fontSize: 17,
    color: theme.muted,
  },
  surpriseButton: {
    // × 1.4 with the banner (2026-11-10): 48 → 67.
    width: 67,
    height: 67,
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
    gap: spacing.md,
  },
  stripRow: {
    gap: spacing.lg,
  },
  stripItem: {
    alignItems: 'center',
    gap: spacing.xs,
    width: 64,
  },
  stripAvatarRing: {
    borderWidth: 2,
    borderColor: theme.secondary,
    borderRadius: radii.pill,
    padding: 2,
  },
  activeDot: {
    position: 'absolute',
    right: 1,
    bottom: 1,
    width: 12,
    height: 12,
    borderRadius: radii.pill,
    backgroundColor: theme.success,
    borderWidth: 2,
    borderColor: theme.surface,
  },
  stripName: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    textAlign: 'center',
  },
  feedDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
  },
  feedRowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginVertical: spacing.md,
  },
  feedNoActivity: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    textAlign: 'center',
    paddingVertical: spacing.xs,
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
  feedAvatarWrap: {
    position: 'relative',
  },
  feedBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
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
  feedAction: {
    ...typeStyles.body,
    color: theme.muted,
    marginTop: 1,
  },
  feedThemeInline: {
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
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
  feedThumbWrap: {
    position: 'relative',
    width: 52,
    height: 52,
  },
  feedThumb: {
    width: 52,
    height: 52,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  feedThumbPlaceholder: {
    backgroundColor: theme.raised,
  },
  feedThumbPlay: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedTime: {
    ...typeStyles.caption,
    color: theme.muted,
    flexShrink: 0,
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

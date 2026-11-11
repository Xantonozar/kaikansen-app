import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ListMusic,
  MoreVertical,
  Pencil,
  Share2,
  Star,
  UserPlus,
  X,
} from 'lucide-react-native';
import type {
  PlaylistSummary,
  ProfileStats,
  UserHistoryResponse,
  UserPublicProfile,
  UserRankProfile,
  UserRatingEntry,
  UserRatingsResponse,
} from '@kaikansen/contracts';
import { cacheKeyFor, fixtureMode, subscribeCache } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { Avatar } from '../../../src/components/Avatar';
import { AppImage } from '../../../src/components/AppImage';
import { ThemeRow } from '../../../src/components/ThemeRow';
import {
  fetchFollowState,
  fetchUserHistory,
  fetchUserPlaylists,
  fetchUserProfile,
  fetchUserRank,
  fetchUserRatings,
  followUser,
  unfollowUser,
} from '../../../src/socialApi';
import { RankIcon } from '../../../src/components/RankIcon';
import {
  formatRp,
  ladderLabel,
  standingOf,
} from '../../../src/rankUtil';
import {
  formatCount,
  formatHoursListened,
  formatMeanRating,
  formatThemesListened,
} from '../../../src/profileStats';
import {
  hasPaintableStats,
  paintableNumbers,
  readProfileStatsCache,
  writeProfileStatsCache,
  type CachedProfileStatsNumbers,
} from '../../../src/profileStatsCache';
import { relativeTime } from '../../../src/time';
import { sectionStatus } from '../../../src/polishRules';
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

/** Rows in the design's "Top ratings" preview (the mock draws 3). */
const TOP_COUNT = 3;

/**
 * Public profile — GET /users/:username and its satellite reads:
 * ratings, history, the rank chip (GET /rank/:userId via the
 * profile's id) and the caller's follow state. Sections degrade
 * independently: a failed satellite hides or notes itself instead
 * of taking the whole screen down.
 *
 * Rebuilt against the owner-approved User Profile candidate
 * (2026-11-10): kaikansen-user-profile-v2-candidate.png (Stitch
 * screen faff6db7897a4305bfb504d2f0e762b3) — the SAME final
 * stats treatment the owner locked for the own Profile, applied
 * to another user's screen. A bare back arrow and a ⋮ at the
 * top; the identity block is ONE centred white card (avatar 80,
 * name, @handle, the rank chip, bio, the INLINE "N Followers ·
 * N Following" line, then the follow pill); under it the
 * divided listening-stats card — Mean Rating · Themes Listened
 * · Hours Listened — fed by the profile payload's ProfileStats
 * aggregates and formatted by the shared src/profileStats
 * helpers, exactly as the own Profile formats them (mean one
 * decimal or "—", hours one decimal under 100). The social
 * line's counts open the standalone Network screen for THIS
 * user (§6.17), followers/following tabs, as the own Profile's
 * line does; the followers number is the live follow-state
 * count, so an optimistic follow/unfollow moves it in step with
 * the pill. "Top ratings" previews the THREE highest-scored of
 * the user's ratings (the endpoint serves the 50 most recent,
 * newest first, so the top cut is sorted client-side by score,
 * newest first on ties) as cover rows with an outline-star
 * score pill; and the design's "See all ratings and history"
 * link expands the full ratings list + the history list in
 * place (there is no separate all-ratings route in the app or
 * the web; the history read is public on the web and mirrored
 * as-is).
 *
 * Playlists (owner-ordered addition, 2026-11-10): under the
 * stats card, a "Playlists" section lists the user's PUBLIC
 * playlists (GET /users/:username/playlists — the API filters
 * private ones out in the query, so nothing private can render
 * here). The cards are the Library Playlists cards minus the
 * owner's chrome: the same 2×2 cover mosaic, name and "N themes
 * · M min" line, plus the candidate's right chevron, but no ⋮
 * menu and no visibility pill (every listed row is public, and
 * none of them is the viewer's to edit). A tap opens the
 * playlist detail, which already gates its owner controls to
 * the owner, so a visitor gets playback only. The section
 * renders only when at least one public playlist exists.
 *
 * Satellite honesty (polish batch, 2026-11-11): each satellite
 * (rank, playlists, ratings, history) tracks its own failure.
 * A failed read no longer masquerades as "this user has
 * nothing": the section renders a compact "Couldn't load —
 * Retry" row whose Retry re-runs ONLY that section's fetch.
 * Rank's row sits in the identity card where the chip would
 * ride; the list sections show their heading over the row, and
 * History's row only makes sense once expanded (its section
 * only exists there). A genuinely-empty success keeps the
 * silent rendering, and data arriving later (a cache swap)
 * clears a failure on its own — sectionStatus in
 * src/polishRules derives the posture.
 *
 * Design notes / honest gaps:
 * - The rank chip draws "Tier · N RP" exactly as the mock phrases
 *   it (real tier + RP from GET /rank/:userId). The division the
 *   rank document also carries is NOT in this chip — the mock's
 *   format has no slot for it; divisions stay visible on the own
 *   Profile rank card and the leaderboard.
 * - The header ⋮ opens a small sheet whose only item is "Share
 *   profile" (the OS share sheet — a real capability, the same one
 *   the quiz room's Invite uses). No block/report/mute items are
 *   drawn: no such backends exist.
 * - On the viewer's OWN profile the pill is "Edit profile" (the
 *   pre-rebuild behaviour); signed out it is "Log in to follow".
 *   Neither state is drawn in the mock.
 *
 * Follow/unfollow is optimistic (state + follower count flip
 * immediately, the response reconciles, an error reverts and shows
 * the server's message verbatim).
 *
 * Instant paint (perf problem 4): while the profile loads, a
 * shell carrying the last saved stats for this username
 * (src/profileStatsCache) renders in place of the bare spinner,
 * and the loaded profile re-saves its stats for the next open.
 * The shell is honest about what it is: cached aggregates only —
 * no identity, no rank, no follow state is ever fabricated from
 * the cache — and it yields the moment the fetch settles (the
 * error state included).
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
  /** The instant-paint cache snapshot for this username (perf 4). */
  const [cachedNumbers, setCachedNumbers] =
    useState<CachedProfileStatsNumbers | null>(null);
  const [cachedHasStats, setCachedHasStats] = useState(false);
  const [rank, setRank] = useState<UserRankProfile | null>(null);
  const [profilePlaylists, setProfilePlaylists] = useState<
    PlaylistSummary[] | null
  >(null);
  const [ratings, setRatings] = useState<UserRatingsResponse | null>(null);
  const [history, setHistory] = useState<UserHistoryResponse | null>(null);
  /* Per-satellite failure flags (polish batch): a failed read
     sets its flag instead of faking an empty payload; the
     section renders "Couldn't load — Retry" off sectionStatus
     until data lands. */
  const [rankFailed, setRankFailed] = useState(false);
  const [playlistsFailed, setPlaylistsFailed] = useState(false);
  const [ratingsFailed, setRatingsFailed] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  /** The design's "See all ratings and history" expansion. */
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const [isFollowing, setIsFollowing] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  const isOwn =
    signedIn &&
    profile !== null &&
    user.username.toLowerCase() === profile.username.toLowerCase();

  /* Silent swaps (perf problem 5): background revalidations of
     this profile's USER-cached satellite reads replace them in
     place. The profile head itself swaps through the main effect
     below on its next read; the stats keep painting from the
     problem-4 store — untouched here. */
  useEffect(() => {
    if (fixtureMode) return;
    const base = `/users/${encodeURIComponent(username)}`;
    const offPlaylists = subscribeCache(
      cacheKeyFor(`${base}/playlists`),
      (fresh: { playlists: PlaylistSummary[] }) =>
        setProfilePlaylists(fresh.playlists),
    );
    const offRatings = subscribeCache<UserRatingsResponse>(
      cacheKeyFor(`${base}/ratings`),
      (fresh) => setRatings(fresh),
    );
    const offHistory = subscribeCache<UserHistoryResponse>(
      cacheKeyFor(`${base}/history`),
      (fresh) => setHistory(fresh),
    );
    return () => {
      offPlaylists();
      offRatings();
      offHistory();
    };
  }, [username]);

  const profileRef = useRef<UserPublicProfile | null>(null);

  /* Satellite loaders (polish batch): each owns its fetch +
     failure flag, so a section's Retry re-runs ONLY its own
     read. liveRef gates late landings like the main effect's
     `live` flag did. */
  const liveRef = useRef(true);
  const loadRank = useCallback((userId: string) => {
    setRankFailed(false);
    fetchUserRank(userId)
      .then((r) => liveRef.current && setRank(r))
      .catch(() => liveRef.current && setRankFailed(true));
  }, []);
  const loadPlaylists = useCallback((name: string) => {
    setPlaylistsFailed(false);
    fetchUserPlaylists(name)
      .then((r) => liveRef.current && setProfilePlaylists(r.playlists))
      .catch(() => liveRef.current && setPlaylistsFailed(true));
  }, []);
  const loadRatings = useCallback((name: string) => {
    setRatingsFailed(false);
    fetchUserRatings(name)
      .then((r) => liveRef.current && setRatings(r))
      .catch(() => liveRef.current && setRatingsFailed(true));
  }, []);
  const loadHistory = useCallback((name: string) => {
    setHistoryFailed(false);
    fetchUserHistory(name)
      .then((h) => liveRef.current && setHistory(h))
      .catch(() => liveRef.current && setHistoryFailed(true));
  }, []);

  useEffect(() => {
    let live = true;
    liveRef.current = true;
    profileRef.current = null;
    setProfile(null);
    setLoadError(null);
    setRank(null);
    setProfilePlaylists(null);
    setRatings(null);
    setHistory(null);
    setRankFailed(false);
    setPlaylistsFailed(false);
    setRatingsFailed(false);
    setHistoryFailed(false);
    setExpanded(false);
    setMenuOpen(false);
    setIsFollowing(false);
    setFollowError(null);
    setCachedNumbers(null);
    setCachedHasStats(false);
    // Instant paint (perf problem 4): pull the saved stats for
    // this username; they render in the loading shell below and
    // are re-saved from the fresh payload when it lands.
    readProfileStatsCache(username)
      .then((entry) => {
        if (!live) return;
        setCachedNumbers(paintableNumbers(entry));
        setCachedHasStats(hasPaintableStats(entry));
      })
      .catch(() => {});
    fetchUserProfile(username)
      .then((p) => {
        if (!live) return;
        setProfile(p);
        profileRef.current = p;
        setFollowersCount(p.totalFollowers);
        void writeProfileStatsCache(p.username, p.stats);
        // Satellites — each settles on its own.
        loadRank(p.id);
        loadPlaylists(p.username);
        loadRatings(p.username);
        loadHistory(p.username);
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
      liveRef.current = false;
    };
    // signedIn is read once per profile load — a mid-view sign-in/out
    // remounts the app shell's session state anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  /**
   * "Top" = highest score first (ties: newest first), over the
   * endpoint's 50-most-recent window — the endpoint itself serves
   * newest first and has no sort parameter (web parity).
   */
  const sortedRatings = useMemo(() => {
    if (!ratings) return [];
    return [...ratings.ratings].sort(
      (a, b) =>
        b.score - a.score || b.createdAt.localeCompare(a.createdAt),
    );
  }, [ratings]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const onShareProfile = () => {
    if (!profile) return;
    setMenuOpen(false);
    void Share.share({
      message: `Check out @${profile.username} on Kaikansen!`,
    }).catch(() => undefined);
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

  /**
   * One block of the divided listening-stats card — the own
   * Profile's stat anatomy (value over label, hairline on the
   * divided blocks), values pre-formatted by src/profileStats.
   */
  const stat = (label: string, value: string, divided = false) => (
    <View style={[styles.statBlock, divided && styles.statBlockDivided]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );

  /**
   * The compact per-section failure row (polish batch): muted
   * "Couldn't load" + an accent Retry that re-runs only that
   * section's fetch.
   */
  const sectionRetry = (label: string, retry: () => void) => (
    <View style={styles.sectionRetryRow}>
      <Text style={styles.sectionRetryText}>Couldn’t load {label}</Text>
      <Pressable
        onPress={retry}
        accessibilityRole="button"
        accessibilityLabel={`Retry loading ${label}`}
        style={({ pressed }) => [
          styles.sectionRetryLink,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.sectionRetryAction}>Retry</Text>
      </Pressable>
    </View>
  );

  /**
   * One rating row in the design's anatomy: white card, 48pt cover
   * at radii.base, title + artist, and the star-score pill at the
   * right. A rating whose theme left the catalogue keeps an honest
   * fallback (the slug as its title, no cover/artist to draw).
   */
  const ratingRow = (entry: UserRatingEntry) => {
    const t = entry.theme;
    const cover = t ? (t.animeCoverImageSmall ?? t.animeCoverImage) : null;
    const artist = t ? (t.artistName ?? t.allArtists.join(', ')) : null;
    return (
      <Pressable
        key={entry.id}
        onPress={() => openTheme(entry.themeSlug)}
        accessibilityRole="button"
        accessibilityLabel={`${t ? t.songTitle : entry.themeSlug}, rated ${entry.score} out of 10`}
        style={({ pressed }) => [
          styles.ratingRow,
          pressed && styles.pressed,
        ]}
      >
        {cover ? (
          <AppImage source={cover} style={styles.ratingCover} recyclingKey={entry.themeSlug} />
        ) : (
          <View style={[styles.ratingCover, styles.ratingCoverEmpty]} />
        )}
        <View style={styles.ratingMain}>
          <Text style={styles.ratingTitle} numberOfLines={1}>
            {t ? t.songTitle : entry.themeSlug}
          </Text>
          {artist ? (
            <Text style={styles.ratingArtist} numberOfLines={1}>
              {artist}
            </Text>
          ) : null}
        </View>
        <View style={styles.scorePill}>
          <Star size={14} color={theme.accent} strokeWidth={2} />
          <Text style={styles.scoreText}>{entry.score}</Text>
        </View>
      </Pressable>
    );
  };

  /**
   * The Library Playlists card's 2×2 cover mosaic at the same
   * geometry (the summary's distinct covers in stored order; a
   * lone cover fills the square; an empty playlist carries the
   * ListMusic glyph in its first cell).
   */
  const playlistMosaic = (covers: string[]) => {
    if (covers.length === 1) {
      return (
        <AppImage source={covers[0]} style={styles.plGridSingle} />
      );
    }
    return (
      <View style={styles.plGrid}>
        {[0, 1, 2, 3].map((i) =>
          covers[i] ? (
            <AppImage
              key={i}
              source={covers[i]}
              style={styles.plGridCell}
            />
          ) : (
            <View
              key={i}
              style={[styles.plGridCell, styles.plGridCellEmpty]}
            >
              {covers.length === 0 && i === 0 ? (
                <ListMusic size={16} color={theme.muted} strokeWidth={2} />
              ) : null}
            </View>
          ),
        )}
      </View>
    );
  };

  /**
   * One public-playlist card — the Library Playlists card's body
   * (mosaic, name, "N themes · M min") without the owner chrome.
   * The runtime segment follows the detail header's rule: summed
   * KNOWN durations rounded to minutes, omitted when none is known.
   */
  const playlistCard = (p: PlaylistSummary) => {
    const runtimeMin =
      p.totalDurationSeconds != null
        ? Math.round(p.totalDurationSeconds / 60)
        : null;
    return (
      <Pressable
        key={p.id}
        onPress={() => router.push(`/playlist/${p.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`Open playlist ${p.name}`}
        style={({ pressed }) => [styles.plCard, pressed && styles.pressed]}
      >
        {playlistMosaic(p.coverImages)}
        <View style={styles.plCardMain}>
          <Text style={styles.plCardName} numberOfLines={1}>
            {p.name}
          </Text>
          <Text style={styles.plCardMeta} numberOfLines={1}>
            {p.themeCount} {p.themeCount === 1 ? 'theme' : 'themes'}
            {runtimeMin !== null ? ` · ${runtimeMin} min` : ''}
          </Text>
        </View>
        <ChevronRight size={20} color={theme.muted} strokeWidth={2} />
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
          style={({ pressed }) => [
            styles.backHit,
            pressed && styles.pressed,
          ]}
        >
          <ArrowLeft size={26} color={theme.text} strokeWidth={2} />
        </Pressable>
        <View style={styles.headerSpacer} />
        {profile && (
          <Pressable
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="More options"
            style={({ pressed }) => [
              styles.menuHit,
              pressed && styles.pressed,
            ]}
          >
            <MoreVertical size={24} color={theme.text} strokeWidth={2} />
          </Pressable>
        )}
      </View>

      {loadError ? (
        <View style={styles.center}>
          <Text style={styles.message}>{loadError}</Text>
        </View>
      ) : !profile ? (
        cachedNumbers ? (
          /* The instant-paint shell (perf problem 4): while the
             profile fetch runs, the saved stats for this username
             render in the loaded screen's own card anatomy (the
             count line needs only the cached counts; the stats
             card only a clean record's stats — a dirty record
             paints counts alone). Nothing else is drawn: the
             cache holds no identity to show. */
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.socialRow}>
              <Text style={styles.socialText}>
                <Text style={styles.socialNumber}>
                  {formatCount(cachedNumbers.followersCount)}
                </Text>{' '}
                Followers
              </Text>
              <Text style={styles.socialDot}>·</Text>
              <Text style={styles.socialText}>
                <Text style={styles.socialNumber}>
                  {formatCount(cachedNumbers.followingCount)}
                </Text>{' '}
                Following
              </Text>
            </View>
            {cachedHasStats ? (
              <View style={styles.statsCard}>
                {stat(
                  'Mean Rating',
                  formatMeanRating(cachedNumbers as ProfileStats),
                )}
                {stat(
                  'Themes Listened',
                  formatThemesListened(cachedNumbers as ProfileStats),
                  true,
                )}
                {stat(
                  'Hours Listened',
                  formatHoursListened(cachedNumbers as ProfileStats),
                  true,
                )}
              </View>
            ) : null}
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
            </View>
          </ScrollView>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        )
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Identity card: centred avatar, name, @handle, the rank
              chip, the bio, the inline followers/following line
              and the follow pill — one white card. */}
          <View style={styles.identityCard}>
            <View style={styles.avatarWrap}>
              <Avatar
                url={profile.avatarUrl}
                name={profile.displayName || profile.username}
                seed={profile.id}
                size={80}
              />
            </View>
            <Text style={styles.displayName} numberOfLines={1}>
              {profile.displayName || profile.username}
            </Text>
            <Text style={styles.handle}>@{profile.username}</Text>
            {rank ? (
              <View style={styles.rankChip}>
                <RankIcon rank={standingOf(rank).rank} size={24} />
                <Text style={styles.rankChipText}>
                  {ladderLabel(standingOf(rank).rank)} · {formatRp(rank.rp)}
                </Text>
              </View>
            ) : sectionStatus(rankFailed, rank !== null) === 'failed' ? (
              sectionRetry('rank', () => loadRank(profile.id))
            ) : null}

            {profile.bio.length > 0 && (
              <Text style={styles.bio}>{profile.bio}</Text>
            )}

            {/* The candidate's inline social line — bold counts,
                muted labels — ABOVE the follow pill. Both counts
                open the Network screen for THIS user; the
                followers number is the live follow-state count,
                so it moves with the pill below. */}
            <View style={styles.socialRow}>
              <Pressable
                onPress={() =>
                  router.push(`/network/${profile.username}?tab=followers`)
                }
                accessibilityRole="button"
                accessibilityLabel={`${followersCount} followers`}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <Text style={styles.socialText}>
                  <Text style={styles.socialNumber}>
                    {formatCount(followersCount)}
                  </Text>{' '}
                  Followers
                </Text>
              </Pressable>
              <Text style={styles.socialDot}>·</Text>
              <Pressable
                onPress={() =>
                  router.push(`/network/${profile.username}?tab=following`)
                }
                accessibilityRole="button"
                accessibilityLabel={`${profile.stats.followingCount} following`}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <Text style={styles.socialText}>
                  <Text style={styles.socialNumber}>
                    {formatCount(profile.stats.followingCount)}
                  </Text>{' '}
                  Following
                </Text>
              </Pressable>
            </View>

            {isOwn ? (
              <Pressable
                onPress={() => router.push('/edit-profile')}
                accessibilityRole="button"
                accessibilityLabel="Edit profile"
                style={({ pressed }) => [
                  styles.actionPill,
                  styles.actionPillPale,
                  pressed && styles.pressed,
                ]}
              >
                <Pencil size={18} color={theme.text} strokeWidth={2} />
                <Text style={styles.actionPillEditText}>Edit profile</Text>
              </Pressable>
            ) : signedIn ? (
              <Pressable
                onPress={onToggleFollow}
                disabled={followBusy}
                accessibilityRole="button"
                accessibilityLabel={isFollowing ? 'Unfollow' : 'Follow'}
                accessibilityState={{ selected: isFollowing }}
                style={({ pressed }) => [
                  styles.actionPill,
                  isFollowing
                    ? styles.actionPillPale
                    : styles.actionPillAccent,
                  pressed && styles.pressed,
                  followBusy && styles.actionBusy,
                ]}
              >
                {followBusy ? (
                  <ActivityIndicator
                    size="small"
                    color={isFollowing ? theme.accent : theme.onAccent}
                  />
                ) : isFollowing ? (
                  <>
                    <Check size={18} color={theme.accent} strokeWidth={2.5} />
                    <Text style={styles.actionPillPaleText}>Following</Text>
                  </>
                ) : (
                  <>
                    <UserPlus size={18} color={theme.onAccent} strokeWidth={2} />
                    <Text style={styles.actionPillAccentText}>Follow</Text>
                  </>
                )}
              </Pressable>
            ) : (
              <Pressable
                onPress={() => router.push('/login')}
                accessibilityRole="button"
                accessibilityLabel="Log in to follow"
                style={({ pressed }) => [
                  styles.actionPill,
                  styles.actionPillAccent,
                  pressed && styles.pressed,
                ]}
              >
                <UserPlus size={18} color={theme.onAccent} strokeWidth={2} />
                <Text style={styles.actionPillAccentText}>
                  Log in to follow
                </Text>
              </Pressable>
            )}
            {followError && <Text style={styles.errorText}>{followError}</Text>}
          </View>

          {/* Listening-stats card — the candidate's divided card
              (Mean Rating · Themes Listened · Hours Listened)
              over the profile's ProfileStats aggregates. */}
          <View style={styles.statsCard}>
            {stat('Mean Rating', formatMeanRating(profile.stats))}
            {stat(
              'Themes Listened',
              formatThemesListened(profile.stats),
              true,
            )}
            {stat(
              'Hours Listened',
              formatHoursListened(profile.stats),
              true,
            )}
          </View>

          {/* Playlists — the user's PUBLIC playlists only (the
              endpoint never lists private ones); hidden entirely
              when they have none, a Retry row when the read
              failed (polish batch). */}
          {profilePlaylists && profilePlaylists.length > 0 ? (
            <>
              <Text style={styles.sectionHeading}>Playlists</Text>
              {profilePlaylists.map(playlistCard)}
            </>
          ) : sectionStatus(playlistsFailed, profilePlaylists !== null) ===
            'failed' ? (
            <>
              <Text style={styles.sectionHeading}>Playlists</Text>
              {sectionRetry('playlists', () =>
                loadPlaylists(profile.username),
              )}
            </>
          ) : null}

          {ratings && sortedRatings.length > 0 ? (
            <>
              <Text style={styles.sectionHeading}>Top ratings</Text>
              {(expanded
                ? sortedRatings
                : sortedRatings.slice(0, TOP_COUNT)
              ).map(ratingRow)}
            </>
          ) : sectionStatus(ratingsFailed, ratings !== null) === 'failed' ? (
            <>
              <Text style={styles.sectionHeading}>Top ratings</Text>
              {sectionRetry('ratings', () => loadRatings(profile.username))}
            </>
          ) : null}

          {/* The design's "See all ratings and history" link: it
              expands the full ratings list and reveals History in
              place (no separate route exists in app or web). */}
          {!expanded &&
            (sortedRatings.length > TOP_COUNT ||
              (history && history.entries.length > 0) ||
              sectionStatus(historyFailed, history !== null) ===
                'failed') && (
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
                <ChevronRight size={16} color={theme.secondary} strokeWidth={2} />
              </Pressable>
            )}

          {expanded && history && history.entries.length > 0 ? (
            <>
              <Text style={[styles.sectionHeading, styles.historyHeading]}>
                History
              </Text>
              {history.entries.map((entry) =>
                entry.theme ? (
                  <ThemeRow
                    key={entry.id}
                    item={entry.theme}
                    typeChip={false}
                    detail={`${entry.mode === 'watch' ? 'Watched' : 'Listened'} · ${relativeTime(entry.viewedAt)}`}
                    onPress={() => openTheme(entry.themeSlug)}
                  />
                ) : null,
              )}
            </>
          ) : expanded &&
            sectionStatus(historyFailed, history !== null) === 'failed' ? (
            <>
              <Text style={[styles.sectionHeading, styles.historyHeading]}>
                History
              </Text>
              {sectionRetry('history', () => loadHistory(profile.username))}
            </>
          ) : null}

          {fixtureMode && (
            <Text style={styles.note}>
              Demo mode — profile data comes from the live API.
            </Text>
          )}
        </ScrollView>
      )}

      {/* Header ⋮ sheet — the Playlist detail sheet's pattern. Its
          only item is Share profile: the one action this screen can
          honestly offer (no block/report backends exist). */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setMenuOpen(false)}
      >
        <View style={styles.menuBackdrop}>
          <Pressable
            style={styles.menuDismiss}
            onPress={() => setMenuOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={styles.menuSheet}>
            <View style={styles.menuHeader}>
              <View style={styles.menuHeaderMain}>
                <Text style={styles.menuTitle} numberOfLines={1}>
                  {profile ? profile.displayName || profile.username : ''}
                </Text>
                <Text style={styles.menuSubtitle}>
                  {profile ? `@${profile.username}` : ''}
                </Text>
              </View>
              <Pressable
                onPress={() => setMenuOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close menu"
                style={({ pressed }) => [
                  styles.menuClose,
                  pressed && styles.pressed,
                ]}
              >
                <X size={18} color={theme.text} strokeWidth={2} />
              </Pressable>
            </View>

            <Pressable
              onPress={onShareProfile}
              accessibilityRole="button"
              accessibilityLabel="Share profile"
              style={({ pressed }) => [
                styles.menuRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.menuIcon}>
                <Share2 size={18} color={theme.text} strokeWidth={2} />
              </View>
              <Text style={styles.menuLabel}>Share profile</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
      marginBottom: spacing.sm,
    },
    backHit: {
      // The HTML's w-10 h-10 hit area, -ml-1 against the edge.
      width: 40,
      height: 40,
      marginLeft: -4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerSpacer: {
      flex: 1,
    },
    menuHit: {
      width: 40,
      height: 40,
      marginRight: -4,
      alignItems: 'center',
      justifyContent: 'center',
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
      // The HTML's rounded-[26px] card (no token sits at 26; the
      // value is the screen HTML's own), p-5, centred column.
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: 26,
      padding: spacing.xl,
      alignItems: 'center',
      marginBottom: spacing.md,
    },
    avatarWrap: {
      marginBottom: spacing.md,
    },
    displayName: {
      fontFamily: fontFamilies.display,
      fontSize: 22,
      lineHeight: 26,
      color: theme.text,
      textAlign: 'center',
      marginBottom: 2,
    },
    handle: {
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.secondary,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },
    rankChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      marginBottom: spacing.md,
    },
    rankChipText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13.5,
      color: theme.accent,
    },
    bio: {
      // The HTML's relaxed line in its soft plum (#5C4554, a
      // Stitch approximation) — the token system's nearest
      // honest step is the ink at reduced opacity over the card.
      fontFamily: fontFamilies.body,
      fontSize: 14,
      lineHeight: 21,
      color: withOpacity(theme.text, 0.82),
      textAlign: 'center',
      maxWidth: 320,
      marginBottom: spacing.md,
    },
    socialRow: {
      // The candidate's inline social line — the own Profile's
      // socialRow, verbatim (bold ink counts, muted labels).
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.lg,
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
    actionPill: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: spacing.xxl,
      paddingVertical: spacing.sm,
      borderRadius: radii.pill,
    },
    actionPillPale: {
      // Following / Edit profile — the HTML's #EDE2EB pale fill is
      // the raised-disc lavender token's family step.
      backgroundColor: theme.raised,
    },
    actionPillAccent: {
      backgroundColor: theme.accent,
    },
    actionPillPaleText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
      color: theme.accent,
    },
    actionPillAccentText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
      color: theme.onAccent,
    },
    actionPillEditText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
      color: theme.text,
    },
    actionBusy: {
      opacity: 0.6,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      marginTop: spacing.sm,
      lineHeight: 18,
      textAlign: 'center',
    },
    statsCard: {
      // The candidate's divided listening-stats card — the own
      // Profile's stats anatomy (18 vertical padding, hairline-
      // split columns), keeping this screen's card chrome.
      flexDirection: 'row',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      paddingVertical: 18,
      paddingHorizontal: spacing.sm,
      marginBottom: spacing.xl,
    },
    statBlock: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
    },
    statBlockDivided: {
      // The candidate's vertical hairlines between stat columns.
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
    sectionHeading: {
      fontFamily: fontFamilies.display,
      fontSize: 18,
      color: theme.text,
      paddingHorizontal: spacing.xs,
      marginBottom: 10,
    },
    sectionRetryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xs,
      marginBottom: spacing.xl,
    },
    sectionRetryText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    sectionRetryLink: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    sectionRetryAction: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    historyHeading: {
      marginTop: spacing.xl,
    },
    ratingRow: {
      // The HTML's rounded-[20px] rows, p-3, space-y-2 rhythm.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: 20,
      padding: spacing.md,
      marginBottom: spacing.sm,
    },
    ratingCover: {
      width: 48,
      height: 48,
      borderRadius: radii.base,
      flexShrink: 0,
    },
    ratingCoverEmpty: {
      backgroundColor: theme.raised,
    },
    ratingMain: {
      flex: 1,
      gap: 1,
    },
    ratingTitle: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 15,
      color: theme.text,
    },
    ratingArtist: {
      fontFamily: fontFamilies.caption,
      fontSize: 13,
      color: theme.secondary,
    },
    scorePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: 10,
      paddingVertical: spacing.xs,
      flexShrink: 0,
    },
    scoreText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
      color: theme.accent,
    },
    /* Playlist cards — the Library Playlists card's geometry,
       verbatim (white card, 14 padding, spacing.lg stack gap). */
    plCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      padding: 14,
      marginBottom: spacing.lg,
    },
    plCardMain: {
      flex: 1,
      gap: 3,
    },
    plCardName: {
      fontFamily: fontFamilies.display,
      fontSize: 18,
      color: theme.text,
    },
    plCardMeta: {
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.muted,
    },
    plGrid: {
      // The detail header's collage at this card's scale: 64
      // square, 2 padding + 2 gutters, cells rounded 3.
      width: 64,
      height: 64,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      padding: 2,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 2,
      overflow: 'hidden',
    },
    plGridCell: {
      width: 29,
      height: 29,
      borderRadius: 3,
      backgroundColor: theme.surface,
    },
    plGridCellEmpty: {
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    plGridSingle: {
      width: 64,
      height: 64,
      borderRadius: radii.base,
      backgroundColor: theme.surface,
    },
    seeAllRow: {
      // The HTML's bare link row (no card): px-2 py-1, bold mauve.
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      alignSelf: 'flex-start',
      marginTop: spacing.xs,
    },
    seeAllText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.secondary,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
      marginTop: spacing.sm,
    },
    /* Header ⋮ sheet — the Playlist detail sheet's pattern. */
    menuBackdrop: {
      flex: 1,
      backgroundColor: withOpacity(theme.background, 0.72),
      justifyContent: 'flex-end',
    },
    menuDismiss: {
      flex: 1,
    },
    menuSheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: radii.cardLg,
      borderTopRightRadius: radii.cardLg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.md,
      paddingBottom: spacing.xl,
    },
    menuHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    menuHeaderMain: {
      flex: 1,
      gap: 2,
    },
    menuTitle: {
      ...typeStyles.heading,
      color: theme.text,
    },
    menuSubtitle: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    menuClose: {
      width: 36,
      height: 36,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    menuIcon: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    menuLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    pressed: {
      opacity: 0.85,
    },
  });

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
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
  Medal,
  MoreVertical,
  Pencil,
  Share2,
  Star,
  UserPlus,
  X,
} from 'lucide-react-native';
import type {
  UserHistoryResponse,
  UserPublicProfile,
  UserRankProfile,
  UserRatingEntry,
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
import { formatRp, tierLabel } from '../../../src/rankUtil';
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

/** Rows in the design's "Top ratings" preview (the mock draws 3). */
const TOP_COUNT = 3;

/**
 * Public profile — GET /users/:username and its satellite reads:
 * ratings, history, the rank chip (GET /rank/:userId via the
 * profile's id) and the caller's follow state. Sections degrade
 * independently: a failed satellite hides or notes itself instead
 * of taking the whole screen down.
 *
 * Rebuilt against the User Profile design (owner-ordered design
 * pass, 2026-11-10): mock kaikansen-userprofile-realimg.png +
 * its Stitch HTML (html/userprofile.html) as dual ground truth.
 * A bare back arrow and a ⋮ at the top; the identity block is ONE
 * centred white card (avatar 80, name, @handle, rank chip, bio,
 * the follow pill); the stats are their OWN card under it in the
 * design's order — Ratings · Followers · Following — split by
 * vertical hairlines (the follower/following blocks still open the
 * standalone Network screen, §6.17); "Top ratings" previews the
 * THREE highest-scored of the user's ratings (the endpoint serves
 * the 50 most recent, newest first, so the top cut is sorted
 * client-side by score, newest first on ties) as cover rows with a
 * star-score pill; and the design's "See all ratings and history"
 * link expands the full ratings list + the history list in place
 * (there is no separate all-ratings route in the app or the web;
 * the history read is public on the web and mirrored as-is).
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

  useEffect(() => {
    let live = true;
    setProfile(null);
    setLoadError(null);
    setRank(null);
    setRatings(null);
    setHistory(null);
    setExpanded(false);
    setMenuOpen(false);
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

  const statBlock = (
    label: string,
    value: number,
    tab: 'followers' | 'following' | null,
    divider: boolean,
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
      style={[styles.statBlock, divider && styles.statBlockDivider]}
    >
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Pressable>
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
          <Image source={{ uri: cover }} style={styles.ratingCover} />
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
          <Star
            size={13}
            color={theme.accent}
            fill={theme.accent}
            strokeWidth={2}
          />
          <Text style={styles.scoreText}>{entry.score}</Text>
        </View>
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
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Identity card: centred avatar, name, @handle, the rank
              chip, the bio and the follow pill — one white card. */}
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
            {rank && (
              <View style={styles.rankChip}>
                <Medal size={15} color={theme.accent} strokeWidth={2} />
                <Text style={styles.rankChipText}>
                  {tierLabel(rank.tier)} · {formatRp(rank.rp)}
                </Text>
              </View>
            )}

            {profile.bio.length > 0 && (
              <Text style={styles.bio}>{profile.bio}</Text>
            )}

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

          {/* Stats card — the design's own card, hairline-divided. */}
          <View style={styles.statsCard}>
            {statBlock('Ratings', profile.totalRatings, null, true)}
            {statBlock('Followers', followersCount, 'followers', true)}
            {statBlock('Following', profile.totalFollowing, 'following', false)}
          </View>

          {ratings && sortedRatings.length > 0 && (
            <>
              <Text style={styles.sectionHeading}>Top ratings</Text>
              {(expanded
                ? sortedRatings
                : sortedRatings.slice(0, TOP_COUNT)
              ).map(ratingRow)}
            </>
          )}

          {/* The design's "See all ratings and history" link: it
              expands the full ratings list and reveals History in
              place (no separate route exists in app or web). */}
          {!expanded &&
            (sortedRatings.length > TOP_COUNT ||
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
                <ChevronRight size={16} color={theme.secondary} strokeWidth={2} />
              </Pressable>
            )}

          {expanded && history && history.entries.length > 0 && (
            <>
              <Text style={[styles.sectionHeading, styles.historyHeading]}>
                History
              </Text>
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
      fontSize: 20,
      lineHeight: 24,
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
      fontSize: 12,
      color: theme.accent,
    },
    bio: {
      // The HTML's 13.5pt relaxed line in its soft plum (#5C4554,
      // a Stitch approximation) — the token system's nearest
      // honest step is the ink at reduced opacity over the card.
      fontFamily: fontFamilies.body,
      fontSize: 13.5,
      lineHeight: 22,
      color: withOpacity(theme.text, 0.82),
      textAlign: 'center',
      maxWidth: 320,
      marginBottom: spacing.lg,
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
      fontSize: 14,
      color: theme.accent,
    },
    actionPillAccentText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.onAccent,
    },
    actionPillEditText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
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
      // The HTML's rounded-[22px] stats card, py-4, hairline-split
      // columns in the design's order.
      flexDirection: 'row',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: 22,
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.xl,
    },
    statBlock: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statBlockDivider: {
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: theme.border,
    },
    statValue: {
      fontFamily: fontFamilies.wordmark,
      fontSize: 18,
      lineHeight: 18,
      color: theme.text,
      marginBottom: spacing.xs,
    },
    statLabel: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.secondary,
    },
    sectionHeading: {
      fontFamily: fontFamilies.display,
      fontSize: 16,
      color: theme.text,
      paddingHorizontal: spacing.xs,
      marginBottom: 10,
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
      fontSize: 14,
      color: theme.text,
    },
    ratingArtist: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
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
      fontSize: 12,
      color: theme.accent,
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

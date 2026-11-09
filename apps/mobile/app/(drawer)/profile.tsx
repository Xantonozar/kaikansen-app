import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Bell,
  ChevronRight,
  Download,
  History,
  RefreshCw,
  Settings as SettingsIcon,
  Star,
} from 'lucide-react-native';
import type { UserRankProfile } from '@kaikansen/contracts';
import { useAuth } from '../../src/auth';
import { Avatar } from '../../src/components/Avatar';
import { RankCard, RankCardSkeleton } from '../../src/components/RankCard';
import { fetchPlaylists } from '../../src/libraryApi';
import { fetchMyRank } from '../../src/socialApi';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Own Profile (the §6.15 design, layout-fidelity Slice 4) — the
 * signed-in user's hub, distinct from the public /user/:username
 * screen: identity card (avatar, name, handle, the sage "AniList
 * connected" pill, Edit → the Edit Profile screen), the shared
 * RankCard (GET /rank/me), the stats card (Ratings from the
 * session profile, Playlists counted from GET /playlists, Quizzes
 * = the rank document's lifetime games), the menu card, and
 * Log Out. The gear opens Settings.
 *
 * Data comes from the same paths the public profile uses —
 * session profile + /rank/me + the library reads — so the numbers
 * agree across surfaces. A failed satellite degrades to a dash or
 * a hidden card, never a fabricated number. Entered from the
 * drawer identity row and the header avatar.
 *
 * Menu targets: Listening History opens the Library on its Recent
 * segment (the library honours a `segment` param), My Ratings the
 * public own-profile screen (where the ratings list lives),
 * AniList Sync the Settings AniList rows (link state + action).
 */
export default function OwnProfileScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status, user, anilistUsername, logout } = useAuth();
  const signedIn = status === 'signedIn' && user !== null;

  const [rank, setRank] = useState<UserRankProfile | null>(null);
  const [rankLoading, setRankLoading] = useState(false);
  const [playlistCount, setPlaylistCount] = useState<number | null>(null);

  const userId = user?.id;
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    setRankLoading(true);
    fetchMyRank()
      .then((r) => live && setRank(r))
      .catch(() => live && setRank(null))
      .finally(() => live && setRankLoading(false));
    fetchPlaylists()
      .then((res) => live && setPlaylistCount(res.playlists.length))
      .catch(() => live && setPlaylistCount(null));
    return () => {
      live = false;
    };
    // Re-read when the signed-in account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const onLogout = async () => {
    await logout();
    router.replace('/(tabs)');
  };

  const linkedName = user?.anilist?.username ?? anilistUsername;

  const menuRow = (
    Icon: typeof Bell,
    label: string,
    onPress: () => void,
    last = false,
  ) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.menuRow,
        !last && styles.menuRowDivider,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.menuIcon}>
        <Icon size={17} color={theme.onAccentContainer} strokeWidth={2} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
      <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
    </Pressable>
  );

  const stat = (label: string, value: string) => (
    <View style={styles.statBlock}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Text style={styles.title}>Profile</Text>
        <Pressable
          onPress={() => router.push('/settings')}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Open settings"
          style={styles.backHit}
        >
          <View style={styles.gearCircle}>
            <SettingsIcon size={20} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {!signedIn ? (
          <>
            <Text style={styles.note}>You’re not signed in.</Text>
            <Pressable
              onPress={() => router.replace('/login')}
              style={styles.primary}
              accessibilityRole="button"
            >
              <Text style={styles.primaryLabel}>Log in</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.identityCard}>
              <Avatar
                url={user.avatarUrl}
                name={user.displayName || user.username}
                seed={user.id}
                size={64}
              />
              <View style={styles.identityTexts}>
                <Text style={styles.displayName} numberOfLines={1}>
                  {user.displayName || user.username}
                </Text>
                <Text style={styles.handle}>@{user.username}</Text>
                {linkedName && (
                  <View style={styles.anilistPill}>
                    <View style={styles.anilistDot} />
                    <Text style={styles.anilistPillText}>
                      AniList connected
                    </Text>
                  </View>
                )}
              </View>
              <Pressable
                onPress={() => router.push('/edit-profile')}
                accessibilityRole="button"
                accessibilityLabel="Edit profile"
                style={({ pressed }) => [
                  styles.editButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.editButtonText}>Edit</Text>
              </Pressable>
            </View>

            {/* Loading state (design polish pass): the rank
                card renders its skeleton while /rank/me is in
                flight instead of vanishing — same treatment as
                the Quiz hub. A failed fetch still degrades to
                no card, never a fabricated rank. */}
            {rank ? (
              <RankCard profile={rank} />
            ) : rankLoading ? (
              <RankCardSkeleton />
            ) : null}

            <View style={styles.statsCard}>
              {stat('Ratings', String(user.totalRatings))}
              {stat(
                'Playlists',
                playlistCount !== null ? String(playlistCount) : '–',
              )}
              {stat(
                'Quizzes',
                rank ? String(rank.stats.totalGames) : '–',
              )}
            </View>

            <View style={styles.menuCard}>
              {menuRow(History, 'Listening History', () =>
                router.push('/(drawer)/(tabs)/library?segment=recent'),
              )}
              {menuRow(Star, 'My Ratings', () =>
                router.push(`/user/${user.username}`),
              )}
              {menuRow(Download, 'Downloads', () =>
                router.push('/downloads'),
              )}
              {menuRow(Bell, 'Notifications', () =>
                router.push('/notifications'),
              )}
              {menuRow(
                RefreshCw,
                'AniList Sync',
                () => router.push('/settings'),
                true,
              )}
            </View>

            <Pressable
              onPress={() => void onLogout()}
              accessibilityRole="button"
              accessibilityLabel="Log out"
              style={({ pressed }) => [
                styles.logout,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.logoutLabel}>Log Out</Text>
            </Pressable>
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
    gearCircle: {
      // The mock's gear sits in a plain WHITE circle (design
      // polish pass) — surface fill, fully round, hairline edge.
      width: 38,
      height: 38,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      flex: 1,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    identityCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.md,
      marginTop: spacing.sm,
      marginBottom: spacing.lg,
    },
    identityTexts: {
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
    anilistPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: theme.successContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 3,
      marginTop: spacing.xs,
    },
    anilistDot: {
      width: 6,
      height: 6,
      borderRadius: radii.pill,
      backgroundColor: theme.success,
    },
    anilistPillText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.success,
    },
    editButton: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md + 2,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    editButtonText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    statsCard: {
      flexDirection: 'row',
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingVertical: spacing.md,
      marginTop: spacing.lg,
      marginBottom: spacing.lg,
    },
    statBlock: {
      flex: 1,
      alignItems: 'center',
      gap: 1,
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
    menuCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingHorizontal: spacing.md,
    },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 52,
    },
    menuRowDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    menuIcon: {
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    menuLabel: {
      ...typeStyles.body,
      color: theme.text,
      flex: 1,
    },
    logout: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
      marginTop: spacing.xl,
    },
    logoutLabel: {
      // Muted mauve in the mock (design polish pass) — the
      // strong danger red was the audit's delta here. (The
      // Settings screen's Log Out row keeps its dusty-red card
      // treatment, as its own mock draws.)
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
    },
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: spacing.md,
      lineHeight: 16,
    },
    primary: {
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.lg,
    },
    primaryLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    pressed: {
      opacity: 0.85,
    },
  });

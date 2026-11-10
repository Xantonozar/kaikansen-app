import { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Headphones,
  Info,
  LogOut,
  Moon,
  Play,
  RefreshCw,
  Sun,
  User,
} from 'lucide-react-native';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme, useThemeMode, type ThemeMode } from '../../src/theme-context';
import { useOpenThemesAs } from '../../src/playbackSettings';
import type { PlaybackMode } from '@kaikansen/contracts';
import { useAuth } from '../../src/auth';
import { useAnilistLink } from '../../src/hooks/useAnilistLink';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Settings — the Lavender Dusk mock's arrangement (design
 * polish pass): a bare-arrow header, then ONE flow of cards —
 * the APPEARANCE card first (segmented Light/Dark toggle, not
 * radio rows, with the mock's caption), a rows card (Edit
 * Profile · AniList Sync · Downloads, each led by a lavender
 * icon disc), the Log Out card (its own white card, dusty-red
 * row), and the version footer. The pre-polish ACCOUNT summary
 * card (username / display name / email readouts) is gone —
 * the mock doesn't draw it and the same data lives on Profile
 * and Edit Profile; no working row was orphaned: Edit Profile,
 * Downloads, the AniList link action and the version footer all
 * remain reachable exactly as before.
 *
 * The linked AniList username shown here is session-local: it comes
 * from the link response in this session, because GET /auth/me does
 * not expose the linked account. After an app restart the action
 * shows again even though the link itself persists server-side.
 * The Appearance card renders signed-out too (the theme choice is
 * a device preference, as before); the account rows don't.
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  /* Playback plan (2026-11-10): the Theme Detail open mode —
     device-local, persisted like the theme mode. */
  const { mode: openMode, setMode: setOpenMode } = useOpenThemesAs();
  const { status, demoMode, logout } = useAuth();
  // The link action itself (busy state, note/error wording, the
  // fixture-mode placeholder) is shared with the drawer — see
  // src/hooks/useAnilistLink.ts.
  const { anilistUsername, linkBusy, linkNote, linkError, startLink } =
    useAnilistLink();
  const router = useRouter();

  const onLinkAnilist = () => void startLink();

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const onLogout = async () => {
    await logout();
    router.replace('/(tabs)');
  };

  const signedIn = status === 'signedIn';

  const openModeSegment = (value: PlaybackMode, label: string) => {
    const active = openMode === value;
    const Icon = value === 'watch' ? Play : Headphones;
    return (
      <Pressable
        key={value}
        onPress={() => setOpenMode(value)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`Open themes as ${label}`}
        style={({ pressed }) => [
          styles.segment,
          active && styles.segmentActive,
          pressed && styles.pressed,
        ]}
      >
        <Icon
          size={16}
          color={active ? theme.onAccent : theme.secondary}
          strokeWidth={2}
        />
        <Text
          style={[
            styles.segmentText,
            active && styles.segmentTextActive,
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  const themeSegment = (value: ThemeMode, label: string) => {
    const active = mode === value;
    const Icon = value === 'dark' ? Moon : Sun;
    return (
      <Pressable
        key={value}
        onPress={() => setMode(value)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${label} theme`}
        style={({ pressed }) => [
          styles.segment,
          active && styles.segmentActive,
          pressed && styles.pressed,
        ]}
      >
        <Icon
          size={16}
          color={active ? theme.onAccent : theme.secondary}
          strokeWidth={2}
        />
        <Text
          style={[
            styles.segmentText,
            active && styles.segmentTextActive,
          ]}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  /* A settings row. With an onPress it's a button; without one
     (the connected AniList row — a status, not an action) it
     renders as a plain row: the app never draws a dead control. */
  const row = (
    Icon: typeof User,
    label: string,
    onPress: (() => void) | null,
    accessibilityLabel: string,
    trailing?: React.ReactNode,
    last = false,
  ) => {
    const inner = (
      <>
        <View style={styles.iconDisc}>
          <Icon size={18} color={theme.accent} strokeWidth={2} />
        </View>
        <Text style={styles.rowLabel}>{label}</Text>
        {trailing}
        <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
      </>
    );
    if (!onPress) {
      return (
        <View style={[styles.row, !last && styles.rowDivider]}>{inner}</View>
      );
    }
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [
          styles.row,
          !last && styles.rowDivider,
          pressed && styles.pressed,
        ]}
      >
        {inner}
      </Pressable>
    );
  };

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
          <ArrowLeft size={24} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {!signedIn && status !== 'loading' && (
          <View style={styles.signinBlock}>
            <Text style={styles.note}>You’re not signed in.</Text>
            <Pressable
              onPress={() => router.replace('/login')}
              style={styles.primary}
              accessibilityRole="button"
            >
              <Text style={styles.primaryLabel}>Log in</Text>
            </Pressable>
          </View>
        )}

        {/* Appearance — the mock's first card: section label,
            segmented Light/Dark toggle, caption. */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Appearance</Text>
          <View style={styles.segmented}>
            {themeSegment('light', 'Light')}
            {themeSegment('dark', 'Dark')}
          </View>
          <Text style={styles.caption}>
            Lavender Dusk is the light theme.
          </Text>
        </View>

        {/* Playback (playback plan, 2026-11-10): which side a
            theme page opens on — device-local, default Listen.
            The chosen side is also the side the page preloads. */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Playback</Text>
          <View style={styles.segmented}>
            {openModeSegment('listen', 'Listen')}
            {openModeSegment('watch', 'Watch')}
          </View>
          <Text style={styles.caption}>
            Open themes as: {openMode === 'watch' ? 'Watch' : 'Listen'}.
            Theme pages preload that side so it starts right away.
          </Text>
        </View>

        {signedIn && (
          <View style={styles.card}>
            {row(
              User,
              'Edit Profile',
              () => router.push('/edit-profile'),
              'Edit profile',
              undefined,
              false,
            )}
            {anilistUsername
              ? row(
                  RefreshCw,
                  'AniList Sync',
                  null,
                  `AniList connected as ${anilistUsername}`,
                  <View style={styles.connectedPill}>
                    <View style={styles.connectedDot} />
                    <Text style={styles.connectedText}>Connected</Text>
                  </View>,
                  false,
                )
              : row(
                  RefreshCw,
                  'AniList Sync',
                  () => void onLinkAnilist(),
                  'Link AniList account',
                  linkBusy ? (
                    <ActivityIndicator color={theme.accent} />
                  ) : undefined,
                  false,
                )}
            {row(
              Download,
              'Downloads',
              () => router.push('/downloads'),
              'Open Downloads',
              undefined,
              false,
            )}
            {row(
              Info,
              'About',
              () => router.push('/about'),
              'About Kaikansen',
              undefined,
              true,
            )}
          </View>
        )}
        {signedIn && linkNote !== null && (
          <Text style={styles.note}>{linkNote}</Text>
        )}
        {signedIn && linkError !== null && (
          <Text style={styles.error}>{linkError}</Text>
        )}
        {signedIn && demoMode && (
          <Text style={styles.note}>
            Demo account — stored only on this device.
          </Text>
        )}

        {signedIn && (
          <View style={styles.card}>
            <Pressable
              onPress={() => void onLogout()}
              accessibilityRole="button"
              accessibilityLabel="Log out"
              style={({ pressed }) => [
                styles.row,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.logoutDisc}>
                <LogOut size={18} color={theme.danger} strokeWidth={2} />
              </View>
              <Text style={styles.logoutLabel}>Log Out</Text>
              <ChevronRight size={18} color={theme.danger} strokeWidth={2} />
            </Pressable>
          </View>
        )}

        {/* The design's version footer — now the About entry
            point (release readiness, 2026-11-11): tappable, it
            opens the About screen. The version is the app's REAL
            one from its config — the mock's '1.0.0' was
            illustrative; app.json says what the build is. When
            signed out this footer is the ONLY About entry (the
            account card above is signed-in-only). */}
        <Pressable
          onPress={() => router.push('/about')}
          accessibilityRole="button"
          accessibilityLabel="About Kaikansen"
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={styles.versionFooter}>
            Kaikansen · Version {Constants.expoConfig?.version ?? '0.1.0'}
          </Text>
        </Pressable>
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
    title: {
      fontFamily: fontFamilies.display,
      fontSize: 26,
      color: theme.text,
      flex: 1,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
      gap: spacing.lg,
    },
    signinBlock: {
      gap: spacing.md,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    cardLabel: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      marginTop: spacing.sm,
      marginBottom: spacing.md,
    },
    segmented: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      padding: 3,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
    },
    segment: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 2,
      paddingVertical: spacing.sm + 2,
      borderRadius: radii.pill,
    },
    segmentActive: {
      backgroundColor: theme.accent,
    },
    segmentText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
    },
    segmentTextActive: {
      color: theme.onAccent,
    },
    caption: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: spacing.md,
      marginBottom: spacing.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 60,
    },
    rowDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    iconDisc: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    rowLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      flex: 1,
    },
    connectedPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      backgroundColor: theme.successContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs + 1,
    },
    connectedDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.success,
    },
    connectedText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.success,
    },
    logoutDisc: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.dangerContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    logoutLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.danger,
      flex: 1,
    },
    pressed: {
      opacity: 0.85,
    },
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      lineHeight: 16,
    },
    error: {
      ...typeStyles.bodySmall,
      color: theme.accent,
    },
    primary: {
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryLabel: {
      ...typeStyles.body,
      fontFamily: 'Inter_600SemiBold',
      color: theme.onAccent,
    },
    versionFooter: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
  });

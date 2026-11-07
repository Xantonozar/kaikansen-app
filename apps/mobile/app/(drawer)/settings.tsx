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
import {
  AtSign,
  Check,
  ChevronLeft,
  ChevronRight,
  Link2,
  LogOut,
  Mail,
  Moon,
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
import { useAuth } from '../../src/auth';
import { useAnilistLink } from '../../src/hooks/useAnilistLink';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Settings (DESIGN.md §6.27): account summary, the AniList link
 * action, the Theme selection (Dark default / Light — the Gate 4
 * decision, wired here in Slice 2), and sign-out. Reached from the
 * header avatar when signed in.
 * (Profile editing is §6.28 — a later slice, not this one.)
 *
 * Compact/icon-led chrome (approved mockup v1): a tile back button,
 * small muted section labels, and every row led by an icon slot —
 * the rows, values, notes and actions themselves are unchanged.
 *
 * The linked AniList username shown here is session-local: it comes
 * from the link response in this session, because GET /auth/me does
 * not expose the linked account. After an app restart the action
 * shows again even though the link itself persists server-side.
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const { status, user, demoMode, logout } = useAuth();
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

  const iconSlot = (Icon: typeof Moon, active = false) => (
    <View style={[styles.iconSlot, active && styles.iconSlotActive]}>
      <Icon
        size={17}
        color={active ? theme.accent : theme.muted}
        strokeWidth={2}
      />
    </View>
  );

  const themeOption = (value: ThemeMode, label: string) => (
    <Pressable
      key={value}
      onPress={() => setMode(value)}
      style={styles.optionRow}
      accessibilityRole="button"
      accessibilityState={{ selected: mode === value }}
    >
      {iconSlot(value === 'dark' ? Moon : Sun, mode === value)}
      <Text style={styles.optionLabel}>{label}</Text>
      {mode === value && (
        <Check size={18} color={theme.accent} strokeWidth={2} />
      )}
    </Pressable>
  );

  const accountRow = (
    Icon: typeof Moon,
    label: string,
    value: string,
    last: boolean,
  ) => (
    <View style={[styles.row, last && styles.rowLast]}>
      {iconSlot(Icon)}
      <View style={styles.rowTexts}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );

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
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {status === 'signedIn' && user ? (
          <>
            <Text style={styles.sectionLabel}>Account</Text>
            <View style={styles.card}>
              {accountRow(AtSign, 'Username', user.username, false)}
              {accountRow(User, 'Display name', user.displayName, false)}
              {accountRow(Mail, 'Email', user.email, true)}
            </View>
            {demoMode && (
              <Text style={styles.note}>
                Demo account — stored only on this device.
              </Text>
            )}
          </>
        ) : (
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
        )}

        {status === 'signedIn' && (
          <>
            <Text style={styles.sectionLabel}>AniList</Text>
            <View style={styles.card}>
              {anilistUsername ? (
                accountRow(Link2, 'Linked account', anilistUsername, true)
              ) : (
                <Pressable
                  onPress={() => void onLinkAnilist()}
                  disabled={linkBusy}
                  style={styles.optionRow}
                  accessibilityRole="button"
                >
                  {iconSlot(Link2)}
                  <Text style={styles.optionLabel}>Link AniList account</Text>
                  {linkBusy ? (
                    <ActivityIndicator color={theme.accent} />
                  ) : (
                    <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
                  )}
                </Pressable>
              )}
            </View>
            {linkNote !== null && (
              <Text style={styles.note}>{linkNote}</Text>
            )}
            {linkError !== null && (
              <Text style={styles.error}>{linkError}</Text>
            )}
          </>
        )}

        <Text style={styles.sectionLabel}>Theme</Text>
        <View style={styles.card}>
          {themeOption('dark', 'Dark')}
          <View style={styles.divider} />
          {themeOption('light', 'Light')}
        </View>
        <Text style={styles.note}>
          Dark is the default (Gate 4). Your choice is remembered on this
          device.
        </Text>

        {status === 'signedIn' && (
          <Pressable
            onPress={() => void onLogout()}
            style={styles.logout}
            accessibilityRole="button"
          >
            <LogOut size={18} color={theme.accent} strokeWidth={2} />
            <Text style={styles.logoutLabel}>Log out</Text>
          </Pressable>
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
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
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
    sectionLabel: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginTop: spacing.xl,
      marginBottom: spacing.sm,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      paddingHorizontal: spacing.md,
    },
    iconSlot: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    iconSlotActive: {
      backgroundColor: theme.accentContainer,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowLast: {
      borderBottomWidth: 0,
    },
    rowTexts: {
      flex: 1,
      gap: 1,
    },
    rowLabel: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    rowValue: {
      ...typeStyles.body,
      color: theme.text,
    },
    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 52,
    },
    optionLabel: {
      ...typeStyles.body,
      color: theme.text,
      flex: 1,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    note: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: spacing.md,
      lineHeight: 16,
    },
    error: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      marginTop: spacing.md,
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
      fontFamily: 'Inter_600SemiBold',
      color: theme.onAccent,
    },
    logout: {
      flexDirection: 'row',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: radii.base,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.xxxl,
    },
    logoutLabel: {
      ...typeStyles.body,
      fontFamily: 'Inter_600SemiBold',
      color: theme.accent,
    },
  });

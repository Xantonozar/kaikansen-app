import { useMemo } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Check, ChevronLeft } from 'lucide-react-native';
import { radii, spacing, typeStyles, type Theme } from '../src/theme';
import { useTheme, useThemeMode, type ThemeMode } from '../src/theme-context';
import { useAuth } from '../src/auth';

/**
 * Settings (DESIGN.md §6.27): account summary, the Theme selection
 * (Dark default / Light — the Gate 4 decision, wired here in Slice 2),
 * and sign-out. Reached from the header avatar when signed in.
 * (Profile editing is §6.28 — a later slice, not this one.)
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { mode, setMode } = useThemeMode();
  const { status, user, demoMode, logout } = useAuth();
  const router = useRouter();

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const onLogout = async () => {
    await logout();
    router.replace('/(tabs)');
  };

  const themeOption = (value: ThemeMode, label: string) => (
    <Pressable
      key={value}
      onPress={() => setMode(value)}
      style={styles.optionRow}
      accessibilityRole="button"
      accessibilityState={{ selected: mode === value }}
    >
      <Text style={styles.optionLabel}>{label}</Text>
      {mode === value && (
        <Check size={18} color={theme.accent} strokeWidth={2} />
      )}
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable onPress={goBack} hitSlop={8}>
          <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.topBarSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {status === 'signedIn' && user ? (
          <>
            <Text style={styles.sectionLabel}>Account</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Username</Text>
                <Text style={styles.rowValue}>{user.username}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Display name</Text>
                <Text style={styles.rowValue}>{user.displayName}</Text>
              </View>
              <View style={[styles.row, styles.rowLast]}>
                <Text style={styles.rowLabel}>Email</Text>
                <Text style={styles.rowValue}>{user.email}</Text>
              </View>
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
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.md,
      gap: spacing.md,
    },
    topBarSpacer: {
      width: 24,
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      flex: 1,
      textAlign: 'center',
    },
    content: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    sectionLabel: {
      ...typeStyles.sectionLabel,
      color: theme.text,
      marginTop: spacing.xxl,
      marginBottom: spacing.md,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      paddingHorizontal: spacing.lg,
    },
    row: {
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      gap: 2,
    },
    rowLast: {
      borderBottomWidth: 0,
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
      justifyContent: 'space-between',
      minHeight: 52,
    },
    optionLabel: {
      ...typeStyles.body,
      color: theme.text,
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

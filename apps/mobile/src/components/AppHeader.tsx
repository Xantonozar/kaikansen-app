import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRouter } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { Bell, Menu, Search, User } from 'lucide-react-native';
import { shell, spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { useAuth } from '../auth';

/**
 * App shell header (DESIGN.md §5): 64px, translucent, centred "Kaikansen"
 * wordmark in Outfit black italic — no logo glyph. Compact treatment
 * (approved mockup v1): every control is a 40px icon button. Left:
 * hamburger (opens the drawer sidebar — the header renders inside the
 * tab navigator, which is nested in the drawer, and the OPEN_DRAWER
 * action bubbles up to it) + avatar. Right: Search (opens the Search
 * screen) and Bell (still a visual placeholder — notifications are
 * not part of the prototype).
 *
 * The avatar is the auth entry point (Slice 2): signed out it shows the
 * User glyph and taps through to Login; signed in it shows the user's
 * initial on the accent container (avatar fallback, P-20) and taps
 * through to Settings.
 */
export function AppHeader() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const { status, user } = useAuth();

  const signedIn = status === 'signedIn' && user !== null;

  return (
    <View
      style={[
        styles.bar,
        { paddingTop: insets.top, height: shell.headerHeight + insets.top },
      ]}
    >
      <View style={styles.side}>
        <Pressable
          onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          style={styles.iconButton}
        >
          <Menu size={22} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Pressable
          onPress={() => router.push(signedIn ? '/settings' : '/login')}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={signedIn ? 'Open settings' : 'Log in'}
          style={styles.iconButton}
        >
          <View style={[styles.avatar, signedIn && styles.avatarSignedIn]}>
            {signedIn ? (
              <Text style={styles.avatarInitial}>
                {(user.displayName || user.username).charAt(0).toUpperCase()}
              </Text>
            ) : (
              <User size={16} color={theme.muted} strokeWidth={2} />
            )}
          </View>
        </Pressable>
      </View>

      <Text style={styles.wordmark}>Kaikansen</Text>

      <View style={[styles.side, styles.sideRight]}>
        <Pressable
          onPress={() => router.push('/search')}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Search"
          style={styles.iconButton}
        >
          <Search size={20} color={theme.text} strokeWidth={2} />
        </Pressable>
        <View style={styles.iconButton} accessibilityLabel="Notifications">
          <Bell size={20} color={theme.text} strokeWidth={2} />
        </View>
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.screenEdge,
      // P-06: theme background at ~85% opacity over content.
      backgroundColor: withOpacity(theme.background, 0.85),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    side: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    sideRight: {
      justifyContent: 'flex-end',
    },
    iconButton: {
      width: 40,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarSignedIn: {
      backgroundColor: theme.accentContainer,
    },
    avatarInitial: {
      ...typeStyles.body,
      color: theme.onAccentContainer,
    },
    wordmark: {
      ...typeStyles.wordmark,
      color: theme.wordmark,
    },
  });

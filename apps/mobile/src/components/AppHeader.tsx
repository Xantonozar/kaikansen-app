import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, usePathname, useRouter } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { Bell, Menu, Search, User } from 'lucide-react-native';
import { shell, spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { useAuth } from '../auth';
import { Avatar } from './Avatar';
import {
  refreshUnreadCount,
  useUnreadNotifications,
} from '../notificationsStore';

/**
 * App shell header (DESIGN.md §5): 64px, translucent, centred "Kaikansen"
 * wordmark in Outfit black italic — no logo glyph. Compact treatment
 * (approved mockup v1): every control is a 40px icon button. Left:
 * hamburger (opens the drawer sidebar — the header renders inside the
 * tab navigator, which is nested in the drawer, and the OPEN_DRAWER
 * action bubbles up to it) + avatar. Right: Search (opens the Search
 * screen) and, signed in, the notifications Bell (Slice M5 — a real
 * button to the notifications screen, badged with the unread count
 * from the shared notifications store). Signed out the bell is not
 * rendered at all: there is nobody to notify.
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
  const pathname = usePathname();
  const { status, user } = useAuth();
  const unread = useUnreadNotifications();

  const signedIn = status === 'signedIn' && user !== null;

  /* Badge freshness: on mount, on sign-in, and whenever the route
     changes (returning from the notifications screen included — the
     screen also keeps the count exact itself as it marks rows). */
  useEffect(() => {
    if (signedIn) void refreshUnreadCount();
  }, [signedIn, pathname]);

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
          {signedIn ? (
            <Avatar
              url={user.avatarUrl}
              name={user.displayName || user.username}
              size={32}
            />
          ) : (
            <View style={styles.avatar}>
              <User size={16} color={theme.muted} strokeWidth={2} />
            </View>
          )}
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
        {signedIn && (
          <Pressable
            onPress={() => router.push('/notifications')}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={
              unread > 0
                ? `Notifications, ${unread} unread`
                : 'Notifications'
            }
            style={styles.iconButton}
          >
            <Bell size={20} color={theme.text} strokeWidth={2} />
            {unread > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {unread > 99 ? '99+' : unread}
                </Text>
              </View>
            )}
          </Pressable>
        )}
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
    badge: {
      position: 'absolute',
      top: 4,
      right: 0,
      minWidth: 17,
      height: 17,
      borderRadius: 9,
      paddingHorizontal: 4,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: {
      fontSize: 10,
      fontFamily: 'Inter_600SemiBold',
      color: theme.onAccent,
    },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    wordmark: {
      ...typeStyles.wordmark,
      color: theme.wordmark,
    },
  });

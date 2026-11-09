import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, usePathname, useRouter } from 'expo-router';
import { DrawerActions } from '@react-navigation/native';
import { Bell, Menu, Search } from 'lucide-react-native';
import { shell, spacing, typeStyles, withOpacity, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { useAuth } from '../auth';
import {
  refreshUnreadCount,
  useUnreadNotifications,
} from '../notificationsStore';

/**
 * App shell header — the Lavender Dusk mocks' treatment (Home v3,
 * measured in layout-fidelity Slice 6): a 56px translucent bar,
 * hamburger left, the centred "Kaikansen ♪" wordmark (Outfit black
 * italic + the note glyph the mock draws), Search and — signed in —
 * the notifications Bell right (Slice M5: a real button to the
 * notifications screen, badged with the unread count from the
 * shared notifications store). Signed out the bell is not rendered
 * at all: there is nobody to notify.
 *
 * There is deliberately NO avatar button: the mock header has none.
 * Profile and Login live in the drawer (its identity row opens the
 * own-Profile screen; signed out it carries the Log in item) —
 * the header avatar this bar used to carry was the Gate-4
 * treatment, superseded by the mocks like the 64px height.
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
      </View>

      <Text style={styles.wordmark}>Kaikansen ♪</Text>

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
    wordmark: {
      ...typeStyles.wordmark,
      color: theme.wordmark,
    },
  });

import { useEffect, useMemo, useState } from 'react';
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
import { Bell, CheckCheck, ChevronLeft } from 'lucide-react-native';
import type {
  NotificationItem,
  NotificationType,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../src/api';
import { useAuth } from '../../src/auth';
import { Avatar } from '../../src/components/Avatar';
import {
  decrementUnread,
  refreshUnreadCount,
  setUnreadCount,
} from '../../src/notificationsStore';
import {
  fetchNotifications,
  markNotificationsRead,
} from '../../src/socialApi';
import { relativeTime } from '../../src/time';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * The type line for a notification. Only 'follow' is ever created
 * by the backend today (the Follow post-save hook); the rest of the
 * model's vocabulary is rendered generically so a row of any type
 * still reads sensibly if one ever exists.
 */
function typeLine(type: NotificationType): string {
  switch (type) {
    case 'follow':
      return 'started following you';
    case 'theme_rated':
      return 'rated a theme';
    case 'theme_favorited':
      return 'saved a theme';
    case 'comment':
      return 'commented';
    case 'rating_like':
      return 'liked your rating';
    case 'playlist_like':
      return 'liked your playlist';
    default:
      return 'did something';
  }
}

/**
 * Notifications (Slice M5) — the caller's 50 most recent, newest
 * first (GET /notifications). Tapping a row marks it read (just
 * that one) and routes to the actor's profile; "Mark all read"
 * clears the rest in one call. Every change is mirrored into the
 * shared badge store, so the header bell's count is already right
 * when the user navigates back. Fixture/demo mode gets a labelled
 * demo note — there are no notifications without the live API, and
 * none are invented.
 */
export default function NotificationsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  useEffect(() => {
    if (!signedIn || fixtureMode) return;
    let live = true;
    fetchNotifications()
      .then((res) => {
        if (!live) return;
        setItems(res.notifications);
        setUnreadCount(res.notifications.filter((n) => !n.read).length);
      })
      .catch((e: unknown) => {
        if (live) {
          setLoadError(
            e instanceof Error ? e.message : 'Could not load notifications.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [signedIn]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const unreadCount = (items ?? []).filter((n) => !n.read).length;

  const onMarkAll = () => {
    if (markingAll || unreadCount === 0) return;
    setMarkingAll(true);
    setActionError(null);
    markNotificationsRead()
      .then(() => {
        setItems((prev) =>
          (prev ?? []).map((n) => (n.read ? n : { ...n, read: true })),
        );
        setUnreadCount(0);
      })
      .catch((e: unknown) =>
        setActionError(
          e instanceof Error ? e.message : 'Could not mark them read.',
        ),
      )
      .finally(() => setMarkingAll(false));
  };

  const onOpenRow = (item: NotificationItem) => {
    if (!item.read) {
      // Optimistic: the row and badge settle now; a failed call is
      // surfaced and both are resynced from the server (the badge
      // via the store refresh; this screen's copy is replaced when
      // it next mounts, since the screen unmounts on navigation).
      setItems((prev) =>
        (prev ?? []).map((n) =>
          n.id === item.id ? { ...n, read: true } : n,
        ),
      );
      decrementUnread();
      markNotificationsRead([item.id]).catch((e: unknown) => {
        setActionError(
          e instanceof Error ? e.message : 'Could not mark it read.',
        );
        void refreshUnreadCount();
      });
    }
    if (item.actor) {
      router.push(`/user/${item.actor.username}`);
    }
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
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Notifications</Text>
        {/* "Mark all read" is always drawn for a signed-in live
            session (design polish pass — the mock shows it
            unconditionally); with nothing unread the handler is
            a no-op, as before. */}
        {signedIn && !fixtureMode && (
          <Pressable
            onPress={onMarkAll}
            disabled={markingAll}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Mark all notifications read"
            style={({ pressed }) => [
              styles.markAll,
              pressed && styles.pressed,
            ]}
          >
            {markingAll ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <>
                <CheckCheck size={16} color={theme.accent} strokeWidth={2} />
                <Text style={styles.markAllText}>Mark all read</Text>
              </>
            )}
          </Pressable>
        )}
      </View>

      {fixtureMode ? (
        <View style={styles.center}>
          <Bell size={26} color={theme.muted} strokeWidth={2} />
          <Text style={styles.message}>
            Demo mode — notifications need the live API, and demo mode
            invents none.
          </Text>
        </View>
      ) : !signedIn ? (
        <View style={styles.center}>
          <Text style={styles.message}>
            Log in to see your notifications.
          </Text>
          <Pressable
            onPress={() => router.replace('/login')}
            accessibilityRole="button"
            accessibilityLabel="Log in"
            style={({ pressed }) => [styles.loginChip, pressed && styles.pressed]}
          >
            <Text style={styles.loginChipText}>Log in</Text>
          </Pressable>
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={styles.message}>{loadError}</Text>
        </View>
      ) : items === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Bell size={26} color={theme.muted} strokeWidth={2} />
          <Text style={styles.message}>
            No notifications yet. When someone follows you, it shows up
            here.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {actionError && <Text style={styles.errorText}>{actionError}</Text>}
          {/* The design groups every row in ONE white card with
              hairline dividers (Slice 6; the rows used to be
              separate cards). Unread rows carry the lavender tint
              inside the card; the time sits at the first line's
              right edge, as drawn. */}
          <View style={styles.card}>
            {items.map((item, index) => {
              const actorName = item.actor
                ? item.actor.displayName || item.actor.username
                : 'A deleted account';
              return (
                <Pressable
                  key={item.id}
                  onPress={() => onOpenRow(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`${actorName} ${typeLine(item.type)}`}
                  style={({ pressed }) => [
                    styles.row,
                    index > 0 && styles.rowDivider,
                    !item.read && styles.rowUnread,
                    pressed && styles.pressed,
                  ]}
                >
                  <Avatar
                    url={item.actor?.avatarUrl ?? null}
                    name={actorName}
                    seed={item.actor?.id}
                    size={36}
                  />
                  <View style={styles.rowMain}>
                    <Text style={styles.rowText} numberOfLines={2}>
                      <Text style={styles.rowName}>{actorName}</Text>
                      {'  '}
                      {typeLine(item.type)}
                    </Text>
                  </View>
                  <Text style={styles.rowTime}>
                    {relativeTime(item.createdAt)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      )}
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
    markAll: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.xs,
    },
    markAllText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xxl,
    },
    message: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 20,
    },
    loginChip: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    loginChipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.accent,
      marginVertical: spacing.sm,
      lineHeight: 18,
    },
    card: {
      // The grouped card (mock: white, rounded-2xl, hairline
      // border, rows divided by hairlines).
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.md,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 60,
      paddingVertical: spacing.md - 2,
      paddingHorizontal: spacing.md + 2,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    rowUnread: {
      // The mock's unread tint is a pale wash of the lavender chip.
      backgroundColor: withOpacity(theme.accentContainer, 0.55),
    },
    rowMain: {
      flex: 1,
      gap: 2,
    },
    rowText: {
      ...typeStyles.bodySmall,
      color: theme.text,
      lineHeight: 18,
    },
    rowName: {
      fontFamily: fontFamilies.bodyStrong,
    },
    rowTime: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
      flexShrink: 0,
    },
    pressed: {
      opacity: 0.85,
    },
  });

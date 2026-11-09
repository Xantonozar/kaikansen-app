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
import { Bell, ChevronLeft, Star } from 'lucide-react-native';
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
 * The mock's compact relative time ("12m", "1h", "3h", "1d") —
 * the shared relativeTime() says "12m ago", which is the other
 * screens' wording; this screen's design drops the "ago". Same
 * thresholds and date fallback as the shared helper.
 */
function compactTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

/**
 * entityMeta is the model's free-form Mixed payload, passed
 * through untouched by the API (null when unset). No creator —
 * web or API — ever sets it today, so these readers are purely
 * defensive: IF a row ever carries a theme title / score, the
 * row renders them (the mock's rich anatomy); otherwise the
 * row falls back to the web's generic action line.
 */
function metaField(meta: unknown, keys: string[]): string | number | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  const record = meta as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function metaTitle(meta: unknown): string | null {
  const value = metaField(meta, ['themeTitle', 'title', 'themeName']);
  return typeof value === 'string' ? value : null;
}

function metaScore(meta: unknown): number | null {
  const value = metaField(meta, ['score', 'rating']);
  return typeof value === 'number' ? value : null;
}

/**
 * The plain action line for a notification type — the web UI's
 * own wording (app/notifications/page.tsx), which the current
 * build already ports. Only 'follow' is ever created by the
 * backend today (the Follow post-save hook); the rest of the
 * model's vocabulary is rendered so a row of any type still
 * reads sensibly if one ever exists. There is NO invite type
 * in the model's enum — quiz invites were never ported (the
 * website's were Pusher-bound) — so no Accept/Decline row can
 * exist; the mock's invite row is Stitch fiction.
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
 * Notifications — the caller's 50 most recent, newest first
 * (GET /notifications), rebuilt to the Notifications design:
 * a plain back arrow + large title + "Mark all read" header,
 * and ONE grouped white card whose hairline-divided rows carry
 * the unread tint, the actor's name in semibold, the action
 * line, and the compact time on the first line's right edge.
 * Tapping a row marks it read (just that one) and routes to
 * the actor's profile; "Mark all read" clears the rest in one
 * call. Every change is mirrored into the shared badge store,
 * so the header bell's count is already right when the user
 * navigates back. Fixture/demo mode gets a labelled demo note
 * — there are no notifications without the live API, and none
 * are invented.
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
  // The design draws "Mark all read" unconditionally; with
  // nothing unread it sits in the muted tone and does nothing
  // (the handler no-ops as before) rather than vanishing.
  const markAllDisabled = markingAll || (items !== null && unreadCount === 0);

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

  /**
   * The row's sentence: actor name in semibold, then the action.
   * Where a row's payload genuinely carries a theme title (and,
   * for a rating, its score), the mock's rich anatomy renders —
   * the title in italic deep mauve, the score with its star and
   * "/ 10". With no such payload the web's generic line stands.
   */
  const rowSentence = (item: NotificationItem, actorName: string) => {
    const title = metaTitle(item.entityMeta);
    const name = <Text style={styles.rowName}>{actorName}</Text>;
    if (item.type === 'theme_rated') {
      const score = metaScore(item.entityMeta);
      if (title || score !== null) {
        return {
          plain: `${actorName} rated ${title ?? 'a theme'}${
            score !== null ? ` a ${score} / 10` : ''
          }`,
          node: (
            <>
              <Text style={styles.rowLead}>
                {name}
                {' rated '}
                {title ? (
                  <Text style={styles.rowTheme}>{title}</Text>
                ) : (
                  'a theme'
                )}
                {score !== null ? ` a ${score}` : ''}
              </Text>
              {score !== null && (
                <View style={styles.scoreChip}>
                  <Star
                    size={13}
                    color={theme.secondary}
                    fill={theme.secondary}
                    strokeWidth={2}
                  />
                  <Text style={styles.scoreText}>/ 10</Text>
                </View>
              )}
            </>
          ),
        };
      }
    }
    if (
      title &&
      (item.type === 'comment' ||
        item.type === 'theme_favorited' ||
        item.type === 'rating_like' ||
        item.type === 'playlist_like')
    ) {
      const verb =
        item.type === 'comment'
          ? 'commented on '
          : item.type === 'theme_favorited'
            ? 'saved '
            : item.type === 'rating_like'
              ? 'liked your rating on '
              : 'liked your playlist ';
      return {
        plain: `${actorName} ${verb}${title}`,
        node: (
          <Text style={styles.rowLead}>
            {name} {verb}
            <Text style={styles.rowTheme}>{title}</Text>
          </Text>
        ),
      };
    }
    const line = typeLine(item.type);
    return {
      plain: `${actorName} ${line}`,
      node: (
        <Text style={styles.rowLead}>
          {name} {line}
        </Text>
      ),
    };
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => [
              styles.backHit,
              pressed && styles.pressed,
            ]}
          >
            <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
          </Pressable>
          <Text style={styles.title}>Notifications</Text>
        </View>
        {signedIn && !fixtureMode && (
          <Pressable
            onPress={onMarkAll}
            disabled={markAllDisabled}
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
              <Text
                style={[
                  styles.markAllText,
                  items !== null && unreadCount === 0 && styles.markAllIdle,
                ]}
              >
                Mark all read
              </Text>
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
          <View style={styles.card}>
            {items.map((item, index) => {
              const actorName = item.actor
                ? item.actor.username
                : 'A deleted account';
              const sentence = rowSentence(item, actorName);
              return (
                <Pressable
                  key={item.id}
                  onPress={() => onOpenRow(item)}
                  accessibilityRole="button"
                  accessibilityLabel={sentence.plain}
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
                  <View
                    style={[
                      styles.rowMain,
                      // The design's optical nudge: single-line
                      // follow rows sit 4pt down against the
                      // avatar, the richer rows 2pt (the HTML's
                      // per-row pt-1 / pt-0.5).
                      { paddingTop: item.type === 'follow' ? 4 : 2 },
                    ]}
                  >
                    <View style={styles.firstLine}>
                      <View style={styles.sentence}>{sentence.node}</View>
                      <Text style={styles.rowTime}>
                        {compactTime(item.createdAt)}
                      </Text>
                    </View>
                  </View>
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
      justifyContent: 'space-between',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
      marginBottom: spacing.lg,
    },
    topBarLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    backHit: {
      // The design's plain arrow: a 36pt round hit area, no tile.
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      // The HTML's text-2xl bold in the display face.
      fontFamily: fontFamilies.display,
      fontSize: 24,
      letterSpacing: -0.5,
      color: theme.text,
    },
    markAll: {
      paddingVertical: spacing.xs,
      paddingHorizontal: spacing.sm,
    },
    markAllText: {
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.secondary,
    },
    markAllIdle: {
      color: theme.muted,
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
      // The grouped card (design: white, rounded-2xl, hairline
      // border, rows divided by hairlines).
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.md,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      padding: 14,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withOpacity(theme.border, 0.6),
    },
    rowUnread: {
      // The design's unread tint: a pale wash of the lavender
      // chip tone over the card white.
      backgroundColor: withOpacity(theme.accentContainer, 0.55),
    },
    rowMain: {
      flex: 1,
    },
    firstLine: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: spacing.sm,
    },
    sentence: {
      flex: 1,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: 5,
    },
    rowLead: {
      ...typeStyles.body,
      color: theme.text,
      lineHeight: 20,
    },
    rowName: {
      fontFamily: fontFamilies.bodyStrong,
    },
    rowTheme: {
      fontStyle: 'italic',
      color: theme.accent,
    },
    scoreChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    scoreText: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.secondary,
    },
    rowTime: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.secondary,
      flexShrink: 0,
    },
    pressed: {
      opacity: 0.85,
    },
  });

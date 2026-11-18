import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import type { ChatConversationSummary } from '@kaikansen/contracts';
import {
  acceptChatRequest,
  declineChatRequest,
  fetchChatRequests,
} from '../../../src/chatApi';
import { formatInboxTime, messagePreview } from '../../../src/chatLogic';
import { Avatar } from '../../../src/components/Avatar';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

/**
 * Message requests — the requests model's inbox: people the
 * caller does not follow who opened a conversation. Accept moves
 * the conversation to active and opens the thread; Decline
 * deletes it server-side WITHOUT notifying the sender (the
 * footer says so, and the API emits nothing on decline).
 * Cursor-paginated (deep-analysis fix pass); the explainer copy
 * states the real pending-request cap (3 messages).
 */
export default function ChatRequestsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [requests, setRequests] = useState<ChatConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const PAGE_SIZE = 30;

  const load = useCallback(async () => {
    try {
      const res = await fetchChatRequests({ limit: PAGE_SIZE });
      setRequests(res.requests);
      setNextCursor(res.nextCursor);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchChatRequests({
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setRequests((current) => {
        const seen = new Set(current.map((c) => c.id));
        return [...current, ...res.requests.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(res.nextCursor);
    } catch {
      // Keep the cursor; scrolling again retries.
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onAccept = async (item: ChatConversationSummary) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await acceptChatRequest(item.id);
      router.push(`/chat/${item.id}`);
    } catch {
      setBusyId(null);
    }
  };

  const onDecline = async (item: ChatConversationSummary) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await declineChatRequest(item.id);
      setRequests((rows) => rows.filter((r) => r.id !== item.id));
    } catch {
      // Leave the row; the user can retry.
    } finally {
      setBusyId(null);
    }
  };

  const renderRow = ({ item }: { item: ChatConversationSummary }) => (
    <Pressable
      onPress={() => router.push(`/chat/${item.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`Request from ${item.other.username}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar
        url={item.other.avatarUrl}
        name={item.other.displayName || item.other.username}
        seed={item.other.id}
        size={48}
        disableDefaultAvatar
      />
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={styles.username} numberOfLines={1}>
            {item.other.username}
          </Text>
          <Text style={styles.time}>
            {item.lastMessage
              ? formatInboxTime(item.lastMessage.createdAt, new Date())
              : ''}
          </Text>
        </View>
        <Text style={styles.preview} numberOfLines={1}>
          {messagePreview(item.lastMessage)}
        </Text>
        <View style={styles.actions}>
          <Pressable
            onPress={() => void onDecline(item)}
            disabled={busyId === item.id}
            accessibilityRole="button"
            accessibilityLabel={`Decline request from ${item.other.username}`}
            style={({ pressed }) => [
              styles.pill,
              styles.pillPale,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.pillPaleText}>Decline</Text>
          </Pressable>
          <Pressable
            onPress={() => void onAccept(item)}
            disabled={busyId === item.id}
            accessibilityRole="button"
            accessibilityLabel={`Accept request from ${item.other.username}`}
            style={({ pressed }) => [
              styles.pill,
              styles.pillAccent,
              pressed && styles.pressed,
            ]}
          >
            {busyId === item.id ? (
              <ActivityIndicator size="small" color={theme.onAccent} />
            ) : (
              <Text style={styles.pillAccentText}>Accept</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.headerButton}
        >
          <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.title}>Message requests</Text>
      </View>

      <View style={styles.body}>
        <Text style={styles.explainer}>
          People you don’t follow can send up to 3 messages. Accept to reply.
        </Text>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : failed ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>Couldn’t load requests.</Text>
            <Pressable
              onPress={() => void load()}
              accessibilityRole="button"
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : requests.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No pending requests.</Text>
          </View>
        ) : (
          <FlatList
            data={requests}
            keyExtractor={(c) => c.id}
            renderItem={renderRow}
            ItemSeparatorComponent={() => <View style={styles.divider} />}
            style={styles.card}
            showsVerticalScrollIndicator={false}
            onEndReached={() => void loadMore()}
            onEndReachedThreshold={0.4}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.moreSpinner}>
                  <ActivityIndicator size="small" color={theme.accent} />
                </View>
              ) : undefined
            }
          />
        )}

        <Text style={styles.footer}>
          Declining a message removes the request without notifying the sender.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
    },
    headerButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { ...typeStyles.heading, flex: 1, color: theme.text },
    body: {
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.lg,
      gap: spacing.md,
    },
    explainer: {
      ...typeStyles.body,
      color: theme.muted,
      lineHeight: 21,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      overflow: 'hidden',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: spacing.md + 48 + spacing.md,
    },
    row: {
      flexDirection: 'row',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    pressed: { opacity: 0.7 },
    rowMain: { flex: 1, gap: 3 },
    rowTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    username: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      flex: 1,
    },
    time: { ...typeStyles.caption, color: theme.muted },
    preview: { ...typeStyles.bodySmall, color: theme.muted },
    actions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    pill: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs + 2,
      minWidth: 86,
      alignItems: 'center',
    },
    pillPale: { backgroundColor: theme.raised },
    pillPaleText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    pillAccent: { backgroundColor: theme.accent },
    pillAccentText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    footer: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 17,
      paddingHorizontal: spacing.lg,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xxl,
    },
    moreSpinner: {
      paddingVertical: spacing.md,
      alignItems: 'center',
    },
    emptyText: { ...typeStyles.body, color: theme.muted },
    retryButton: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: theme.raised,
    },
    retryText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
  });

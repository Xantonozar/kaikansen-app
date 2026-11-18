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
  fetchArchivedConversations,
  setConversationState,
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
 * Archived chats (deep-analysis fix pass) — the inbox's list
 * treatment for conversations the caller archived. Archiving is
 * per-user and reversible: Unarchive returns the row to the
 * inbox, and any new message un-archives automatically
 * server-side.
 */
export default function ArchivedChatsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [rows, setRows] = useState<ChatConversationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const PAGE_SIZE = 30;

  const load = useCallback(async () => {
    try {
      const res = await fetchArchivedConversations({ limit: PAGE_SIZE });
      setRows(res.conversations);
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
      const res = await fetchArchivedConversations({
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setRows((current) => {
        const seen = new Set(current.map((c) => c.id));
        return [...current, ...res.conversations.filter((c) => !seen.has(c.id))];
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

  const onUnarchive = async (item: ChatConversationSummary) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await setConversationState(item.id, { archived: false });
      setRows((current) => current.filter((c) => c.id !== item.id));
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
      accessibilityLabel={`Archived chat with ${item.other.username}`}
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
        <Text style={styles.username} numberOfLines={1}>
          {item.other.username}
        </Text>
        <Text style={styles.preview} numberOfLines={1}>
          {messagePreview(item.lastMessage) || 'Say hi 👋'}
        </Text>
      </View>
      <View style={styles.rowSide}>
        <Text style={styles.time}>
          {item.lastMessage
            ? formatInboxTime(item.lastMessage.createdAt, new Date())
            : ''}
        </Text>
        <Pressable
          onPress={() => void onUnarchive(item)}
          disabled={busyId === item.id}
          accessibilityRole="button"
          accessibilityLabel={`Unarchive chat with ${item.other.username}`}
          style={({ pressed }) => [styles.unarchivePill, pressed && styles.pressed]}
        >
          {busyId === item.id ? (
            <ActivityIndicator size="small" color={theme.accent} />
          ) : (
            <Text style={styles.unarchiveText}>Unarchive</Text>
          )}
        </Pressable>
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
        <Text style={styles.title}>Archived</Text>
      </View>

      <View style={styles.body}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : failed ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>Couldn’t load archived chats.</Text>
            <Pressable
              onPress={() => void load()}
              accessibilityRole="button"
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>No archived chats.</Text>
          </View>
        ) : (
          <FlatList
            data={rows}
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
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      minHeight: 68,
    },
    pressed: { opacity: 0.7 },
    rowMain: { flex: 1, gap: 2 },
    username: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    preview: { ...typeStyles.bodySmall, color: theme.muted },
    rowSide: { alignItems: 'flex-end', gap: 4 },
    time: { ...typeStyles.caption, color: theme.muted },
    unarchivePill: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 3,
      backgroundColor: theme.raised,
      minWidth: 86,
      alignItems: 'center',
    },
    unarchiveText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
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

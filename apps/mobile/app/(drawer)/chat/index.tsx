import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Archive,
  BellOff,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Search,
  ShieldOff,
  SquarePen,
  UserPlus,
  X,
} from 'lucide-react-native';
import type { ChatConversationSummary } from '@kaikansen/contracts';
import { useAuth } from '../../../src/auth';
import {
  clearConversation,
  fetchConversations,
  setConversationState,
} from '../../../src/chatApi';
import {
  applyInboxAccepted,
  applyInboxMessage,
  applyInboxPresence,
  formatInboxTime,
  messagePreview,
} from '../../../src/chatLogic';
import {
  onChatMessage,
  onChatPresence,
  onChatReadSync,
  onChatReconnect,
  onChatRequestAccepted,
} from '../../../src/chatSocket';
import { refreshChatUnread, setChatUnread } from '../../../src/chatUnreadStore';
import { Avatar } from '../../../src/components/Avatar';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

/**
 * Chats inbox — the approved mock's flat treatment: "Chats" title
 * with ONE flat deep-mauve compose icon (no circle buttons), a
 * "Search people" pill that opens New Chat, a slim Message
 * requests row while requests are pending, and the conversations
 * as ONE white container with hairline dividers (never stacked
 * cards). Photo avatars with the initial-disc fallback; the sage
 * dot is the gateway's live presence. The mini player overlays
 * this screen like every pushed screen; the bottom nav is hidden
 * (pushed-screen rule).
 */
export default function ChatsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status } = useAuth();
  const signedIn = status === 'signedIn';

  const [conversations, setConversations] = useState<ChatConversationSummary[]>([]);
  const [requestCount, setRequestCount] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [rowMenu, setRowMenu] = useState<ChatConversationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const loadSeq = useRef(0);
  // Mirrors of the list + badge total for the realtime handlers,
  // which patch rows locally instead of refetching the whole list.
  const conversationsRef = useRef<ChatConversationSummary[]>([]);
  const totalUnreadRef = useRef(0);

  const PAGE_SIZE = 30;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetchConversations({ limit: PAGE_SIZE });
      if (seq !== loadSeq.current) return;
      conversationsRef.current = res.conversations;
      totalUnreadRef.current = res.totalUnread;
      setConversations(res.conversations);
      setRequestCount(res.requestCount);
      setArchivedCount(res.archivedCount);
      setNextCursor(res.nextCursor);
      setChatUnread(res.totalUnread);
      setFailed(false);
    } catch {
      if (seq === loadSeq.current) setFailed(true);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  /** Cursor load-more: appends the next page, deduped by id. */
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchConversations({
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setConversations((current) => {
        const seen = new Set(current.map((c) => c.id));
        const merged = [
          ...current,
          ...res.conversations.filter((c) => !seen.has(c.id)),
        ];
        conversationsRef.current = merged;
        return merged;
      });
      setNextCursor(res.nextCursor);
    } catch {
      // Keep the cursor; scrolling again retries.
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  const patchRow = useCallback((summary: ChatConversationSummary) => {
    setConversations((current) => {
      const next = current.map((c) => (c.id === summary.id ? summary : c));
      conversationsRef.current = next;
      return next;
    });
  }, []);

  const dropRow = useCallback((conversationId: string) => {
    setConversations((current) => {
      const next = current.filter((c) => c.id !== conversationId);
      conversationsRef.current = next;
      return next;
    });
  }, []);

  /* Long-press row actions (deep-analysis fix pass). */
  const onToggleMute = async (row: ChatConversationSummary) => {
    setRowMenu(null);
    try {
      const summary = await setConversationState(row.id, {
        muted: !row.muted,
      });
      patchRow(summary);
      void refreshChatUnread();
    } catch {
      // Row stays as-is; the menu can be retried.
    }
  };

  const onArchive = async (row: ChatConversationSummary) => {
    setRowMenu(null);
    try {
      await setConversationState(row.id, { archived: true });
      dropRow(row.id);
      setArchivedCount((n) => n + 1);
    } catch {
      // Keep the row.
    }
  };

  const onDeleteChat = (row: ChatConversationSummary) => {
    setRowMenu(null);
    Alert.alert(
      'Delete this chat?',
      'The conversation and its history will be hidden for you only. The other person keeps their copy.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await clearConversation(row.id);
                dropRow(row.id);
                void refreshChatUnread();
              } catch {
                // Keep the row.
              }
            })();
          },
        },
      ],
    );
  };

  useFocusEffect(
    useCallback(() => {
      if (signedIn) void load();
      else setLoading(false);
    }, [signedIn, load]),
  );

  /* Realtime: patch rows locally from the event payloads (preview,
     unread, presence dot, accepted status). A full refetch only
     happens for a conversation the list does not know yet (new
     conversation / new request) and on reconnect catch-up. */
  useEffect(() => {
    if (!signedIn) return;
    const offMessage = onChatMessage((payload) => {
      const res = applyInboxMessage(conversationsRef.current, payload);
      if (!res.handled) {
        void load();
        return;
      }
      conversationsRef.current = res.rows;
      setConversations(res.rows);
      if (res.unreadDelta !== 0) {
        totalUnreadRef.current += res.unreadDelta;
        setChatUnread(totalUnreadRef.current);
      }
    });
    const offPresence = onChatPresence((payload) => {
      const rows = applyInboxPresence(conversationsRef.current, payload);
      if (rows !== conversationsRef.current) {
        conversationsRef.current = rows;
        setConversations(rows);
      }
    });
    const offAccepted = onChatRequestAccepted((payload) => {
      const rows = applyInboxAccepted(
        conversationsRef.current,
        payload.conversationId,
      );
      if (rows !== conversationsRef.current) {
        conversationsRef.current = rows;
        setConversations(rows);
      }
    });
    const offReconnect = onChatReconnect(() => void load());
    // I read on another device → my rows here clear their unread.
    const offReadSync = onChatReadSync(() => void load());
    return () => {
      offMessage();
      offPresence();
      offAccepted();
      offReconnect();
      offReadSync();
    };
  }, [signedIn, load]);

  const renderRow = ({ item }: { item: ChatConversationSummary }) => {
    const unread = item.unreadCount > 0;
    // Muted conversations keep their row but never badge.
    const showBadge = unread && !item.muted;
    return (
      <Pressable
        onPress={() => router.push(`/chat/${item.id}`)}
        onLongPress={() => setRowMenu(item)}
        accessibilityRole="button"
        accessibilityLabel={`Chat with ${item.other.username}${showBadge ? `, ${item.unreadCount} unread` : ''}`}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View>
          <Avatar
            url={item.other.avatarUrl}
            name={item.other.displayName || item.other.username}
            seed={item.other.id}
            size={48}
            disableDefaultAvatar
          />
          {item.other.online && <View style={styles.onlineDot} />}
        </View>
        <View style={styles.rowMain}>
          <Text style={styles.username} numberOfLines={1}>
            {item.other.username}
          </Text>
          <Text
            style={[styles.preview, unread && styles.previewUnread]}
            numberOfLines={1}
          >
            {messagePreview(item.lastMessage) || 'Say hi 👋'}
          </Text>
        </View>
        <View style={styles.rowSide}>
          <Text style={[styles.time, showBadge && styles.timeUnread]}>
            {item.lastMessage
              ? formatInboxTime(item.lastMessage.createdAt, new Date())
              : ''}
          </Text>
          {showBadge ? (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>
                {item.unreadCount > 99 ? '99+' : item.unreadCount}
              </Text>
            </View>
          ) : item.muted ? (
            <BellOff size={14} color={theme.muted} strokeWidth={2} />
          ) : (
            <View style={styles.badgeSpacer} />
          )}
        </View>
      </Pressable>
    );
  };

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
        <Text style={styles.title}>Chats</Text>
        <Pressable
          onPress={() => router.push('/chat/new')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New chat"
          style={styles.headerButton}
        >
          <SquarePen size={22} color={theme.accent} strokeWidth={2} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <Pressable
          onPress={() => router.push('/chat/new')}
          accessibilityRole="button"
          accessibilityLabel="Search people"
          style={({ pressed }) => [styles.searchPill, pressed && styles.pressed]}
        >
          <Search size={18} color={theme.muted} strokeWidth={2} />
          <Text style={styles.searchText}>Search people</Text>
        </Pressable>

        {requestCount > 0 && (
          <Pressable
            onPress={() => router.push('/chat/requests')}
            accessibilityRole="button"
            accessibilityLabel={`Message requests, ${requestCount} pending`}
            style={({ pressed }) => [styles.requestsRow, pressed && styles.pressed]}
          >
            <UserPlus size={20} color={theme.accent} strokeWidth={2} />
            <Text style={styles.requestsLabel}>Message requests</Text>
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{requestCount}</Text>
            </View>
            <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
          </Pressable>
        )}

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : failed ? (
          <View style={styles.center}>
            <Text style={styles.emptyBody}>Couldn’t load your chats.</Text>
            <Pressable
              onPress={() => void load()}
              accessibilityRole="button"
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : conversations.length === 0 ? (
          <View style={styles.center}>
            <View style={styles.emptyCircle}>
              <MessageCircle size={34} color={theme.accent} strokeWidth={1.8} />
            </View>
            <Text style={styles.emptyTitle}>No chats yet</Text>
            <Text style={styles.emptyBody}>
              Find people from your quiz rooms and say hi — share the themes
              you love.
            </Text>
            <Pressable
              onPress={() => router.push('/chat/new')}
              accessibilityRole="button"
              accessibilityLabel="Find people"
              style={({ pressed }) => [styles.findButton, pressed && styles.pressed]}
            >
              <Text style={styles.findButtonText}>Find people</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={conversations}
            keyExtractor={(c) => c.id}
            renderItem={renderRow}
            ItemSeparatorComponent={() => <View style={styles.divider} />}
            style={styles.listCard}
            contentContainerStyle={styles.listContent}
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

        {!loading && !failed && signedIn && (
          <>
            {archivedCount > 0 && (
              <Pressable
                onPress={() => router.push('/chat/archived')}
                accessibilityRole="button"
                accessibilityLabel={`Archived chats, ${archivedCount}`}
                style={({ pressed }) => [styles.requestsRow, pressed && styles.pressed]}
              >
                <Archive size={20} color={theme.accent} strokeWidth={2} />
                <Text style={styles.requestsLabel}>Archived</Text>
                <View style={styles.unreadBadge}>
                  <Text style={styles.unreadBadgeText}>{archivedCount}</Text>
                </View>
                <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
              </Pressable>
            )}
            <Pressable
              onPress={() => router.push('/chat/blocked')}
              accessibilityRole="button"
              accessibilityLabel="Blocked users"
              style={({ pressed }) => [styles.requestsRow, pressed && styles.pressed]}
            >
              <ShieldOff size={20} color={theme.accent} strokeWidth={2} />
              <Text style={styles.requestsLabel}>Blocked users</Text>
              <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
            </Pressable>
          </>
        )}
      </View>

      <Modal
        visible={rowMenu !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRowMenu(null)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setRowMenu(null)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {rowMenu ? `@${rowMenu.other.username}` : 'Chat'}
              </Text>
              <Pressable
                onPress={() => setRowMenu(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close menu"
              >
                <X size={20} color={theme.text} strokeWidth={2} />
              </Pressable>
            </View>
            {rowMenu && (
              <>
                <Pressable
                  onPress={() => void onToggleMute(rowMenu)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
                >
                  <Text style={styles.menuRowText}>
                    {rowMenu.muted ? 'Unmute notifications' : 'Mute notifications'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void onArchive(rowMenu)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
                >
                  <Text style={styles.menuRowText}>Archive</Text>
                </Pressable>
                <Pressable
                  onPress={() => onDeleteChat(rowMenu)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
                >
                  <Text style={[styles.menuRowText, styles.menuRowDanger]}>
                    Delete chat
                  </Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
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
    title: {
      ...typeStyles.heading,
      flex: 1,
      color: theme.text,
    },
    body: {
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.lg,
      gap: spacing.md,
    },
    searchPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.surface,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    searchText: {
      ...typeStyles.body,
      color: theme.muted,
    },
    requestsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    requestsLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      flex: 1,
      color: theme.text,
    },
    listCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      overflow: 'hidden',
    },
    listContent: {
      flexGrow: 1,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      minHeight: 68,
    },
    pressed: {
      opacity: 0.7,
    },
    onlineDot: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: 13,
      height: 13,
      borderRadius: 7,
      backgroundColor: theme.success,
      borderWidth: 2,
      borderColor: theme.surface,
    },
    rowMain: {
      flex: 1,
      gap: 2,
    },
    username: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    preview: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    previewUnread: {
      color: theme.text,
      fontFamily: fontFamilies.bodyStrong,
    },
    rowSide: {
      alignItems: 'flex-end',
      gap: 4,
    },
    time: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    timeUnread: {
      color: theme.accent,
      fontFamily: fontFamilies.bodyStrong,
    },
    unreadBadge: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 6,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    unreadBadgeText: {
      fontSize: 11,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    badgeSpacer: {
      height: 20,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: spacing.md + 48 + spacing.md,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
    },
    emptyCircle: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: withOpacity(theme.accent, 0.14),
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.sm,
    },
    emptyTitle: {
      ...typeStyles.heading,
      color: theme.text,
    },
    emptyBody: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 21,
    },
    findButton: {
      marginTop: spacing.md,
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.sm + 2,
    },
    findButtonText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    retryButton: {
      marginTop: spacing.sm,
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
    moreSpinner: {
      paddingVertical: spacing.md,
      alignItems: 'center',
    },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: theme.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.md,
      paddingBottom: spacing.xl,
      gap: spacing.xs,
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    sheetTitle: { ...typeStyles.heading, color: theme.text },
    menuRow: {
      paddingVertical: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    menuRowText: { ...typeStyles.body, color: theme.text },
    menuRowDanger: { color: theme.danger },
  });

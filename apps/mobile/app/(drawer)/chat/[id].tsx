import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Check,
  CheckCheck,
  ChevronLeft,
  Clock,
  MoreVertical,
  Play,
  Plus,
  Send,
  X,
} from 'lucide-react-native';
import type {
  ChatConversationStatus,
  ChatReportReason,
  ChatThemeSnapshot,
  ChatUserSummary,
  ThemeSummary,
} from '@kaikansen/contracts';
import { useAuth } from '../../../src/auth';
import {
  acceptChatRequest,
  blockChatUser,
  declineChatRequest,
  fetchBlockedUsers,
  fetchChatMessages,
  fetchChatMeta,
  markChatRead,
  reportChatUser,
  sendChatMessage,
  unblockChatUser,
} from '../../../src/chatApi';
import {
  applyIncoming,
  applyReadReceipt,
  buildThreadItems,
  deliveryStatus,
  headerLine,
  isGroupEnd,
  mergeCatchUp,
  timeOfDay,
  type LocalMessage,
  type ThreadItem,
} from '../../../src/chatLogic';
import {
  addToOutbox,
  clearDraft,
  loadDraft,
  removeFromOutbox,
  setDraft as persistDraft,
  updateOutbox,
  useOutbox,
} from '../../../src/chatOutbox';
import {
  emitChatSend,
  emitChatTyping,
  onChatMessage,
  onChatPresence,
  onChatRead,
  onChatReconnect,
  onChatRequestAccepted,
  onChatTyping,
} from '../../../src/chatSocket';
import { refreshChatUnread } from '../../../src/chatUnreadStore';
import { fetchFavorites, fetchHistory } from '../../../src/libraryApi';
import { usePlaybackSession, type QueueItem } from '../../../src/playback-context';
import { getOpenThemesAs } from '../../../src/playbackSettings';
import { Avatar } from '../../../src/components/Avatar';
import { Image } from '../../../src/expoImage';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';

/**
 * Conversation thread — bubbles (theirs white left, mine
 * mauveDeep right, NO per-bubble avatars, slim margins), day
 * dividers, real delivery states (sending/sent/read from socket
 * acks + chat:read receipts), failed sends as faded bubbles with
 * tap-to-retry, a three-dot typing bubble, and theme cards that
 * play through the mini player. In REQUEST state the receiver
 * gets the accept/decline/block bar instead of a composer, and
 * the API withholds receipts/typing from the sender; the
 * requester keeps a working composer (the approved mock shows
 * them sending more than one message).
 */

function snapshotOf(t: ThemeSummary): ChatThemeSnapshot {
  return {
    slug: t.slug,
    songTitle: t.songTitle,
    artistName: t.artistName,
    animeTitle: t.animeTitle,
    type: t.type,
    sequence: t.sequence,
    coverImage: t.animeCoverImageSmall ?? t.animeCoverImage,
  };
}

let clientSeq = 0;
function nextClientId(): string {
  clientSeq += 1;
  return `local-${Date.now()}-${clientSeq}`;
}

export default function ChatThreadScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const meId = user?.id ?? '';
  const { startQueue } = usePlaybackSession();

  const [other, setOther] = useState<ChatUserSummary | null>(null);
  const [status, setStatus] = useState<ChatConversationStatus>('active');
  const [requestedBy, setRequestedBy] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  // Pending/failed bubbles live in the outbox store (they survive
  // leaving the thread); the display list appends whichever of
  // them the server list does not already carry.
  const pending = useOutbox(conversationId);
  const displayMessages = useMemo(
    () => [
      ...messages,
      ...pending.filter(
        (p) => !messages.some((m) => m.clientId && m.clientId === p.clientId),
      ),
    ],
    [messages, pending],
  );
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [otherTyping, setOtherTyping] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recentThemes, setRecentThemes] = useState<ThemeSummary[]>([]);
  const [favoriteThemes, setFavoriteThemes] = useState<ThemeSummary[]>([]);
  const [pickerLoaded, setPickerLoaded] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  // Safety + management (deep-analysis fix pass): header menu,
  // message long-press menu, report reason sheet, my block state.
  const [menuOpen, setMenuOpen] = useState(false);
  const [msgMenu, setMsgMenu] = useState<LocalMessage | null>(null);
  const [reportTarget, setReportTarget] = useState<
    { messageId: string | null } | null
  >(null);
  const [blockedByMe, setBlockedByMe] = useState(false);

  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  const statusRef = useRef(status);
  statusRef.current = status;

  const markRead = useCallback(() => {
    if (!conversationId) return;
    markChatRead(conversationId)
      .then(() => refreshChatUnread())
      .catch(() => undefined);
  }, [conversationId]);

  const loadInitial = useCallback(async () => {
    if (!conversationId) return;
    try {
      const res = await fetchChatMessages(conversationId);
      setOther(res.other);
      setStatus(res.status);
      setRequestedBy(res.requestedBy);
      setMessages(res.messages);
      setHasMore(res.hasMore);
      setFailed(false);
      if (res.messages.some((m) => m.senderId !== meId)) markRead();
    } catch {
      // A blocked conversation 403s the messages endpoint — the
      // meta endpoint still answers for participants, so the
      // screen can render the closed state instead of an endless
      // load error with a Retry that can never succeed.
      try {
        const meta = await fetchChatMeta(conversationId);
        if (meta.status !== 'blocked') throw new Error('not blocked');
        setOther(meta.other);
        setStatus('blocked');
        setRequestedBy(meta.requestedBy);
        setMessages([]);
        setHasMore(false);
        setFailed(false);
      } catch {
        setFailed(true);
      }
    } finally {
      setLoading(false);
    }
  }, [conversationId, meId, markRead]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  /* Composer draft: restored from the durable draft store on
     mount (a draft survives leaving the thread AND the app
     process), persisted on every change, cleared on send. */
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void loadDraft(conversationId).then((saved) => {
      if (!cancelled && saved) setDraft(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /* Whether I blocked this user drives the header menu + the
     closed bar's Unblock action. */
  useEffect(() => {
    if (!other) return;
    let cancelled = false;
    fetchBlockedUsers()
      .then((res) => {
        if (!cancelled) {
          setBlockedByMe(res.users.some((u) => u.id === other.id));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [other]);

  /* Catch-up after a reconnect: refetch the newest page and
     merge it in, so messages missed during an outage appear
     without leaving and re-entering the thread. */
  useEffect(() => {
    if (!conversationId) return;
    const off = onChatReconnect(() => {
      void (async () => {
        try {
          const res = await fetchChatMessages(conversationId);
          setOther(res.other);
          setStatus(res.status);
          setRequestedBy(res.requestedBy);
          setMessages((list) => mergeCatchUp(list, res.messages));
          if (res.messages.some((m) => m.senderId !== meId)) markRead();
        } catch {
          // Keep the current state; the next event or visit retries.
        }
      })();
    });
    return off;
  }, [conversationId, meId, markRead]);

  /* Realtime wiring for this conversation. */
  useEffect(() => {
    if (!conversationId) return;
    const offMessage = onChatMessage((payload) => {
      if (payload.conversationId !== conversationId) return;
      setMessages((list) => applyIncoming(list, payload));
      if (payload.senderId !== meId) markRead();
    });
    const offRead = onChatRead((payload) => {
      if (payload.conversationId !== conversationId) return;
      setMessages((list) =>
        applyReadReceipt(list, payload.readerId, payload.readAt),
      );
    });
    const offTyping = onChatTyping((payload) => {
      if (payload.conversationId !== conversationId) return;
      setOtherTyping(true);
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => setOtherTyping(false), 2600);
    });
    const offPresence = onChatPresence((payload) => {
      setOther((current) =>
        current && current.id === payload.userId
          ? { ...current, online: payload.online }
          : current,
      );
    });
    const offAccepted = onChatRequestAccepted((payload) => {
      if (payload.conversationId === conversationId) setStatus('active');
    });
    return () => {
      offMessage();
      offRead();
      offTyping();
      offPresence();
      offAccepted();
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
    };
  }, [conversationId, meId, markRead]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const res = await fetchChatMessages(conversationId, messages[0].id);
      setMessages((list) => [...res.messages, ...list]);
      setHasMore(res.hasMore);
    } catch {
      // Keep what we have; scrolling up again retries.
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, hasMore, loadingOlder, messages]);

  /**
   * Sends one outbox bubble. Socket first, REST fallback — BOTH
   * carry the same clientId, and the server dedupes on it, so a
   * send whose ack was lost never lands twice. Resolution moves
   * the bubble out of the outbox into the server message list;
   * failure marks it failed (tap-to-retry) — unless the
   * conversation was closed meanwhile, in which case the bubble
   * is dropped and the closed state takes over the screen.
   */
  const deliver = useCallback(
    async (
      clientId: string,
      payload: { type: 'text'; text: string } | { type: 'theme'; themeSlug: string },
    ) => {
      const ack = await emitChatSend({ conversationId, clientId, ...payload });
      if (ack.ok && ack.message) {
        const saved = ack.message;
        removeFromOutbox(conversationId, clientId);
        setMessages((list) => applyIncoming(list, { ...saved, clientId }));
        return;
      }
      try {
        const saved = await sendChatMessage(conversationId, {
          ...payload,
          clientId,
        });
        removeFromOutbox(conversationId, clientId);
        setMessages((list) => applyIncoming(list, { ...saved, clientId }));
      } catch {
        try {
          const meta = await fetchChatMeta(conversationId);
          if (meta.status === 'blocked') {
            removeFromOutbox(conversationId, clientId);
            setOther(meta.other);
            setStatus('blocked');
            setRequestedBy(meta.requestedBy);
            return;
          }
        } catch {
          // Meta unreachable too — fall through to the failed state.
        }
        updateOutbox(conversationId, clientId, { localStatus: 'failed' });
      }
    },
    [conversationId],
  );

  const sendText = useCallback(() => {
    const text = draft.trim();
    if (!text || !meId) return;
    const clientId = nextClientId();
    const optimistic: LocalMessage = {
      id: clientId,
      clientId,
      conversationId,
      senderId: meId,
      type: 'text',
      text,
      theme: null,
      createdAt: new Date().toISOString(),
      readAt: null,
      localStatus: 'sending',
    };
    addToOutbox(conversationId, optimistic);
    setDraft('');
    clearDraft(conversationId);
    emitChatTyping({ conversationId, typing: false });
    void deliver(clientId, { type: 'text', text });
  }, [conversationId, deliver, draft, meId]);

  const sendTheme = useCallback(
    (summary: ThemeSummary) => {
      if (!meId) return;
      const clientId = nextClientId();
      const optimistic: LocalMessage = {
        id: clientId,
        clientId,
        conversationId,
        senderId: meId,
        type: 'theme',
        text: null,
        theme: snapshotOf(summary),
        createdAt: new Date().toISOString(),
        readAt: null,
        localStatus: 'sending',
      };
      addToOutbox(conversationId, optimistic);
      void deliver(clientId, { type: 'theme', themeSlug: summary.slug });
    },
    [conversationId, deliver, meId],
  );

  const retryMessage = useCallback(
    (msg: LocalMessage) => {
      if (!msg.clientId || msg.localStatus !== 'failed') return;
      const clientId = msg.clientId;
      updateOutbox(conversationId, clientId, { localStatus: 'sending' });
      if (msg.type === 'theme' && msg.theme) {
        void deliver(clientId, { type: 'theme', themeSlug: msg.theme.slug });
      } else if (msg.text) {
        void deliver(clientId, { type: 'text', text: msg.text });
      }
    },
    [conversationId, deliver],
  );

  const onDraftChange = (value: string) => {
    setDraft(value);
    persistDraft(conversationId, value);
    if (statusRef.current !== 'active') return;
    const now = Date.now();
    if (value.length > 0 && now - lastTypingSent.current > 2000) {
      lastTypingSent.current = now;
      emitChatTyping({ conversationId, typing: true });
    }
  };

  const openPicker = () => {
    setPickerOpen(true);
    if (pickerLoaded) return;
    setPickerLoaded(true);
    fetchHistory()
      .then((res) => {
        const seen = new Set<string>();
        const themes: ThemeSummary[] = [];
        for (const entry of res.entries) {
          if (!entry.theme || seen.has(entry.theme.slug)) continue;
          seen.add(entry.theme.slug);
          themes.push(entry.theme);
          if (themes.length >= 12) break;
        }
        setRecentThemes(themes);
      })
      .catch(() => undefined);
    fetchFavorites(1, 20)
      .then((res) => setFavoriteThemes(res.themes))
      .catch(() => undefined);
  };

  const playTheme = (snapshot: ChatThemeSnapshot) => {
    const item: QueueItem = {
      slug: snapshot.slug,
      atEntryId: null,
      title: snapshot.songTitle,
      artistLine: snapshot.artistName ?? '',
      coverUrl: snapshot.coverImage,
    };
    startQueue([item], 0, getOpenThemesAs(), 'other');
  };

  const onAccept = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await acceptChatRequest(conversationId);
      setStatus('active');
    } catch {
      // Stay in request mode; the bar remains for another try.
    } finally {
      setActionBusy(false);
    }
  };

  const onDecline = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await declineChatRequest(conversationId);
      router.back();
    } catch {
      setActionBusy(false);
    }
  };

  const onBlock = async () => {
    if (actionBusy || !other) return;
    setActionBusy(true);
    try {
      await blockChatUser(other.id);
      router.back();
    } catch {
      setActionBusy(false);
    }
  };

  /** Block always asks first (header menu + profile use the same shape). */
  const confirmBlock = () => {
    if (!other) return;
    setMenuOpen(false);
    Alert.alert(
      `Block @${other.username}?`,
      'They will no longer be able to message you, and this conversation closes. You can unblock them later from Chats → Blocked users.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () => void onBlock(),
        },
      ],
    );
  };

  const onUnblock = async () => {
    if (actionBusy || !other) return;
    setActionBusy(true);
    setMenuOpen(false);
    try {
      await unblockChatUser(other.id);
      setBlockedByMe(false);
      // A conversation closed by my block reopens server-side;
      // reload so its history + composer come back.
      await loadInitial();
    } catch {
      // Stay as-is; the action can be retried.
    } finally {
      setActionBusy(false);
    }
  };

  const submitReport = async (reason: ChatReportReason) => {
    if (!other || !reportTarget) return;
    const target = reportTarget;
    setReportTarget(null);
    try {
      await reportChatUser({
        reportedUserId: other.id,
        conversationId,
        ...(target.messageId ? { messageId: target.messageId } : {}),
        reason,
      });
      Alert.alert(
        'Report sent',
        'Thanks — a snapshot of this conversation was saved with your report.',
      );
    } catch {
      Alert.alert('Couldn’t send the report', 'Please try again in a moment.');
    }
  };

  const copyMessage = (msg: LocalMessage) => {
    setMsgMenu(null);
    if (msg.text) void Clipboard.setStringAsync(msg.text);
  };

  const isRequestReceiver =
    status === 'request' && requestedBy !== null && requestedBy !== meId;
  const composerVisible = status === 'active' || (status === 'request' && !isRequestReceiver);

  const items = useMemo(
    () => buildThreadItems(displayMessages, new Date()).reverse(),
    [displayMessages],
  );

  const renderMessage = (msg: LocalMessage) => {
    const mine = msg.senderId === meId;
    const delivery = deliveryStatus(msg, meId);
    const index = displayMessages.indexOf(msg);
    const groupEnd = index >= 0 && isGroupEnd(displayMessages, index);
    const failedSend = delivery === 'failed';

    const bubble = (
      <>
        {msg.type === 'theme' && msg.theme ? (
          <View style={styles.themeCard}>
            {msg.theme.coverImage ? (
              <Image
                source={{ uri: msg.theme.coverImage }}
                style={styles.themeCover}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.themeCover, styles.themeCoverEmpty]} />
            )}
            <View style={styles.themeMain}>
              <View style={styles.themeChip}>
                <Text style={styles.themeChipText}>
                  {msg.theme.type}
                  {msg.theme.sequence}
                </Text>
              </View>
              <Text style={styles.themeTitle} numberOfLines={1}>
                {msg.theme.songTitle}
              </Text>
              <Text style={styles.themeSub} numberOfLines={1}>
                {msg.theme.artistName ?? 'Unknown artist'} · {msg.theme.animeTitle}{' '}
                {msg.theme.type}
                {msg.theme.sequence}
              </Text>
            </View>
            <Pressable
              onPress={() => playTheme(msg.theme!)}
              accessibilityRole="button"
              accessibilityLabel={`Play ${msg.theme.songTitle}`}
              style={({ pressed }) => [styles.playDisc, pressed && styles.pressed]}
            >
              <Play size={16} color={theme.onAccent} fill={theme.onAccent} />
            </Pressable>
          </View>
        ) : (
          <Text style={[styles.bubbleText, mine ? styles.bubbleTextMine : styles.bubbleTextTheirs]}>
            {msg.text}
          </Text>
        )}
      </>
    );

    return (
      <View style={[styles.messageRow, mine ? styles.rowMine : styles.rowTheirs]}>
        {failedSend ? (
          <Pressable
            onPress={() => retryMessage(msg)}
            onLongPress={() => setMsgMenu(msg)}
            accessibilityRole="button"
            accessibilityLabel="Retry sending this message"
            style={[styles.bubble, styles.bubbleMine, styles.bubbleFailed]}
          >
            {bubble}
          </Pressable>
        ) : (
          <Pressable
            onLongPress={() => setMsgMenu(msg)}
            accessibilityRole="button"
            accessibilityLabel="Message options"
            style={[
              styles.bubble,
              mine ? styles.bubbleMine : styles.bubbleTheirs,
              msg.type === 'theme' && styles.bubbleTheme,
            ]}
          >
            {bubble}
          </Pressable>
        )}
        {groupEnd && (
          <View style={[styles.captionRow, mine && styles.captionRowMine]}>
            <Text style={styles.captionTime}>{timeOfDay(msg.createdAt)}</Text>
            {delivery === 'sending' && (
              <>
                <Clock size={11} color={theme.muted} strokeWidth={2} />
                <Text style={styles.captionText}>Sending…</Text>
              </>
            )}
            {delivery === 'sent' && (
              <>
                <Check size={12} color={theme.muted} strokeWidth={2.5} />
                <Text style={styles.captionText}>Sent</Text>
              </>
            )}
            {delivery === 'read' && (
              <>
                <CheckCheck size={13} color={theme.accent} strokeWidth={2.5} />
                <Text style={[styles.captionText, styles.captionRead]}>Read</Text>
              </>
            )}
            {failedSend && (
              <Text style={styles.captionFailed}>Couldn’t send · Tap to retry</Text>
            )}
          </View>
        )}
      </View>
    );
  };

  const renderItem = ({ item }: { item: ThreadItem }) => {
    if (item.type === 'day') {
      return (
        <View style={styles.dayRow}>
          <View style={styles.dayPill}>
            <Text style={styles.dayText}>{item.label}</Text>
          </View>
        </View>
      );
    }
    return renderMessage(item.message);
  };

  const renderPickerRow = (summary: ThemeSummary) => (
    <Pressable
      key={summary.slug}
      onPress={() => {
        setPickerOpen(false);
        sendTheme(summary);
      }}
      accessibilityRole="button"
      accessibilityLabel={`Share ${summary.songTitle}`}
      style={({ pressed }) => [styles.pickerRow, pressed && styles.pressed]}
    >
      {summary.animeCoverImageSmall ? (
        <Image
          source={{ uri: summary.animeCoverImageSmall }}
          style={styles.pickerCover}
          contentFit="cover"
        />
      ) : (
        <View style={[styles.pickerCover, styles.themeCoverEmpty]} />
      )}
      <View style={styles.themeMain}>
        <Text style={styles.pickerTitle} numberOfLines={1}>
          {summary.songTitle}
        </Text>
        <Text style={styles.themeSub} numberOfLines={1}>
          {summary.artistName ?? 'Unknown artist'} · {summary.animeTitle}
        </Text>
      </View>
      <View style={styles.themeChip}>
        <Text style={styles.themeChipText}>
          {summary.type}
          {summary.sequence}
        </Text>
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.backDisc, pressed && styles.pressed]}
        >
          <ChevronLeft size={20} color={theme.text} strokeWidth={2} />
        </Pressable>
        {other && (
          <>
            <View>
              <Avatar
                url={other.avatarUrl}
                name={other.displayName || other.username}
                seed={other.id}
                size={38}
                disableDefaultAvatar
              />
              {other.online && <View style={styles.onlineDot} />}
            </View>
            <View style={styles.headerMain}>
              <Text style={styles.headerName} numberOfLines={1}>
                {other.username}
              </Text>
              <Text style={styles.headerSub} numberOfLines={1}>
                {headerLine(other)}
              </Text>
            </View>
            <Pressable
              onPress={() => setMenuOpen(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Options for ${other.username}`}
              style={styles.headerButton}
            >
              <MoreVertical size={20} color={theme.text} strokeWidth={2} />
            </Pressable>
          </>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : failed ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>Couldn’t load this conversation.</Text>
            <Pressable
              onPress={() => void loadInitial()}
              accessibilityRole="button"
              style={styles.retryButton}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={items}
            inverted
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            onEndReached={() => void loadOlder()}
            onEndReachedThreshold={0.4}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={
              otherTyping && status === 'active' ? (
                <View style={[styles.messageRow, styles.rowTheirs]}>
                  <View style={[styles.bubble, styles.bubbleTheirs, styles.typingBubble]}>
                    <View style={styles.typingDot} />
                    <View style={styles.typingDot} />
                    <View style={styles.typingDot} />
                  </View>
                </View>
              ) : undefined
            }
            ListFooterComponent={
              loadingOlder ? (
                <View style={styles.olderSpinner}>
                  <ActivityIndicator size="small" color={theme.accent} />
                </View>
              ) : undefined
            }
          />
        )}

        {status === 'blocked' ? (
          <View style={styles.closedBar}>
            <Text style={styles.closedText}>
              {blockedByMe && other
                ? `You blocked @${other.username}.`
                : 'This conversation is closed.'}
            </Text>
            {blockedByMe && (
              <Pressable
                onPress={() => void onUnblock()}
                disabled={actionBusy}
                accessibilityRole="button"
                accessibilityLabel={`Unblock ${other?.username ?? 'user'}`}
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
              >
                <Text style={styles.retryText}>Unblock</Text>
              </Pressable>
            )}
          </View>
        ) : isRequestReceiver && other ? (
          <View style={styles.requestBar}>
            <Text style={styles.requestText}>
              Accept to reply to {other.username}. They won’t know you read this.
            </Text>
            <View style={styles.requestActions}>
              <Pressable
                onPress={() => void onAccept()}
                disabled={actionBusy}
                accessibilityRole="button"
                accessibilityLabel="Accept this message request"
                style={({ pressed }) => [
                  styles.requestPill,
                  styles.requestPillAccent,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.requestPillAccentText}>Accept</Text>
              </Pressable>
              <Pressable
                onPress={() => void onDecline()}
                disabled={actionBusy}
                accessibilityRole="button"
                accessibilityLabel="Decline this message request"
                style={({ pressed }) => [
                  styles.requestPill,
                  styles.requestPillPale,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.requestPillPaleText}>Decline</Text>
              </Pressable>
              <Pressable
                onPress={() => void onBlock()}
                disabled={actionBusy}
                accessibilityRole="button"
                accessibilityLabel={`Block ${other.username}`}
                style={({ pressed }) => [
                  styles.requestPill,
                  styles.requestPillPale,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.requestPillBlockText}>Block</Text>
              </Pressable>
            </View>
          </View>
        ) : composerVisible ? (
          <View style={styles.composer}>
            <Pressable
              onPress={openPicker}
              accessibilityRole="button"
              accessibilityLabel="Share a theme"
              style={({ pressed }) => [styles.plusButton, pressed && styles.pressed]}
            >
              <Plus size={20} color={theme.onAccent} strokeWidth={2.5} />
            </Pressable>
            <TextInput
              value={draft}
              onChangeText={onDraftChange}
              placeholder="Message…"
              placeholderTextColor={theme.muted}
              multiline
              style={styles.input}
              accessibilityLabel="Message"
            />
            <Pressable
              onPress={sendText}
              disabled={draft.trim().length === 0}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              style={({ pressed }) => [
                styles.sendDisc,
                draft.trim().length === 0 && styles.sendDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Send size={17} color={theme.onAccent} strokeWidth={2} />
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>

      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setPickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Share a theme</Text>
              <Pressable
                onPress={() => setPickerOpen(false)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close theme picker"
              >
                <X size={20} color={theme.text} strokeWidth={2} />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {recentThemes.length > 0 && (
                <>
                  <Text style={styles.sheetSection}>RECENTLY PLAYED</Text>
                  {recentThemes.map(renderPickerRow)}
                </>
              )}
              {favoriteThemes.length > 0 && (
                <>
                  <Text style={styles.sheetSection}>FAVOURITES</Text>
                  {favoriteThemes.map(renderPickerRow)}
                </>
              )}
              {recentThemes.length === 0 && favoriteThemes.length === 0 && (
                <Text style={styles.emptyText}>
                  Play or favourite a theme first — it will show up here to share.
                </Text>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setMenuOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {other ? `@${other.username}` : 'Options'}
              </Text>
              <Pressable
                onPress={() => setMenuOpen(false)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close menu"
              >
                <X size={20} color={theme.text} strokeWidth={2} />
              </Pressable>
            </View>
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                if (other) router.push(`/user/${other.username}`);
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
            >
              <Text style={styles.menuRowText}>View profile</Text>
            </Pressable>
            {blockedByMe ? (
              <Pressable
                onPress={() => void onUnblock()}
                accessibilityRole="button"
                style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              >
                <Text style={styles.menuRowText}>Unblock user</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={confirmBlock}
                accessibilityRole="button"
                style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              >
                <Text style={[styles.menuRowText, styles.menuRowDanger]}>Block user</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                setReportTarget({ messageId: null });
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
            >
              <Text style={styles.menuRowText}>Report user</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={msgMenu !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setMsgMenu(null)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setMsgMenu(null)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Message</Text>
              <Pressable
                onPress={() => setMsgMenu(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close message menu"
              >
                <X size={20} color={theme.text} strokeWidth={2} />
              </Pressable>
            </View>
            {msgMenu?.type === 'text' && (
              <Pressable
                onPress={() => msgMenu && copyMessage(msgMenu)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              >
                <Text style={styles.menuRowText}>Copy text</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => {
                if (msgMenu) setReportTarget({ messageId: msgMenu.id });
                setMsgMenu(null);
              }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
            >
              <Text style={[styles.menuRowText, styles.menuRowDanger]}>Report message</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={reportTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setReportTarget(null)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setReportTarget(null)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Report — why?</Text>
              <Pressable
                onPress={() => setReportTarget(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Cancel report"
              >
                <X size={20} color={theme.text} strokeWidth={2} />
              </Pressable>
            </View>
            {(
              [
                ['spam', 'Spam'],
                ['harassment', 'Harassment'],
                ['other', 'Other'],
              ] as [ChatReportReason, string][]
            ).map(([reason, label]) => (
              <Pressable
                key={reason}
                onPress={() => void submitReport(reason)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              >
                <Text style={styles.menuRowText}>{label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    backDisc: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: theme.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerMain: { flex: 1, gap: 1 },
    headerName: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    headerSub: { ...typeStyles.caption, color: theme.muted },
    headerButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    onlineDot: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: 11,
      height: 11,
      borderRadius: 6,
      backgroundColor: theme.success,
      borderWidth: 2,
      borderColor: theme.background,
    },
    listContent: {
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.md,
      gap: spacing.xs,
    },
    dayRow: { alignItems: 'center', paddingVertical: spacing.sm },
    dayPill: {
      backgroundColor: theme.raised,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 3,
    },
    dayText: { ...typeStyles.caption, color: theme.muted },
    messageRow: { maxWidth: '100%' },
    rowMine: { alignItems: 'flex-end' },
    rowTheirs: { alignItems: 'flex-start' },
    bubble: {
      maxWidth: '82%',
      borderRadius: 18,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    bubbleMine: {
      backgroundColor: theme.accent,
      borderBottomRightRadius: 6,
    },
    bubbleTheirs: {
      backgroundColor: theme.surface,
      borderBottomLeftRadius: 6,
    },
    bubbleTheme: {
      backgroundColor: theme.surface,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    bubbleFailed: { opacity: 0.55 },
    bubbleText: { ...typeStyles.body, lineHeight: 20 },
    bubbleTextMine: { color: theme.onAccent },
    bubbleTextTheirs: { color: theme.text },
    captionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      marginTop: 3,
      marginBottom: spacing.xs,
    },
    captionRowMine: { justifyContent: 'flex-end' },
    captionTime: { ...typeStyles.caption, color: theme.muted, fontSize: 11 },
    captionText: { ...typeStyles.caption, color: theme.muted, fontSize: 11 },
    captionRead: { color: theme.accent },
    captionFailed: {
      ...typeStyles.caption,
      color: theme.danger,
      fontSize: 11,
      fontFamily: fontFamilies.bodyStrong,
    },
    typingBubble: {
      flexDirection: 'row',
      gap: 4,
      paddingVertical: spacing.md,
    },
    typingDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: theme.muted,
      opacity: 0.7,
    },
    themeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      width: 248,
    },
    themeCover: { width: 44, height: 44, borderRadius: 8 },
    themeCoverEmpty: { backgroundColor: theme.raised },
    themeMain: { flex: 1, gap: 1 },
    themeChip: {
      alignSelf: 'flex-start',
      backgroundColor: withOpacity(theme.accent, 0.14),
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    themeChipText: {
      fontSize: 10,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.accent,
    },
    themeTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    themeSub: { ...typeStyles.caption, color: theme.muted },
    playDisc: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: { opacity: 0.7 },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    plusButton: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    input: {
      ...typeStyles.body,
      flex: 1,
      color: theme.text,
      backgroundColor: theme.surface,
      borderRadius: 20,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      maxHeight: 110,
    },
    sendDisc: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendDisabled: { opacity: 0.45 },
    requestBar: {
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    requestText: {
      ...typeStyles.body,
      color: theme.text,
      textAlign: 'center',
      lineHeight: 20,
    },
    requestActions: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: spacing.sm,
    },
    requestPill: {
      borderRadius: radii.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      minWidth: 92,
      alignItems: 'center',
    },
    requestPillAccent: { backgroundColor: theme.accent },
    requestPillAccentText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    requestPillPale: { backgroundColor: theme.raised },
    requestPillPaleText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    requestPillBlockText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.danger,
    },
    closedBar: {
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.md,
      alignItems: 'center',
      gap: spacing.sm,
    },
    menuRow: {
      paddingVertical: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    menuRowText: { ...typeStyles.body, color: theme.text },
    menuRowDanger: { color: theme.danger },
    closedText: { ...typeStyles.body, color: theme.muted },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
    },
    emptyText: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      lineHeight: 21,
    },
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
    olderSpinner: { paddingVertical: spacing.sm, alignItems: 'center' },
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
      maxHeight: '80%',
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    sheetTitle: { ...typeStyles.heading, color: theme.text },
    sheetSection: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.8,
      color: theme.muted,
      marginTop: spacing.md,
      marginBottom: spacing.xs,
    },
    pickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.sm,
      marginBottom: spacing.xs,
    },
    pickerCover: { width: 44, height: 44, borderRadius: 8 },
    pickerTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
  });

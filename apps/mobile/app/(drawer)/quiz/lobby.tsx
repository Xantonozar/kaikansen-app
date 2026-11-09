import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementRef,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputInstance,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from 'expo-router';
import { ChevronLeft, Plus } from 'lucide-react-native';
import type {
  PublicRoomListItem,
  RoomGuessType,
} from '@kaikansen/contracts';
import {
  disconnectQuizSocket,
  emitRoomEvent,
  ensureQuizSocket,
  markRoomOwnership,
  roomOwnership,
  subscribeQuizSocketStatus,
  type QuizSocketStatus,
} from '../../../src/quizSocket';
import { Avatar } from '../../../src/components/Avatar';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH, FORM_MAX_WIDTH } from '../../../src/layout';

const GUESS_LABEL: Record<RoomGuessType, string> = {
  anime: 'Guess the Anime',
  song: 'Guess the Song',
  artist: 'Guess the Artist',
};

const PUBLIC_REFRESH_MS = 20_000;

/**
 * Multiplayer lobby (Slice 5 rebuild, design §6.22) — the single
 * designed screen replacing the old Create/Join/Public tabs:
 *
 * - Create card → the Create Room screen (§6.23) — creation no
 *   longer lives in the lobby;
 * - Join with a code — the design's six single-character boxes over
 *   one hidden input (so typing auto-advances, paste fills all six,
 *   and backspace steps back naturally); incomplete codes keep Join
 *   disabled with the hint showing, a rejected code marks the boxes
 *   in the error colour with the server's message verbatim;
 * - Public rooms — the discovery list served by the gateway's
 *   `room:list-public` event (this API's addition; the web has no
 *   room list). Rows join through the same `room:join` flow as a
 *   typed code; full rooms render disabled, as designed. The list
 *   refreshes on focus, on a 20s interval, and on pull-to-refresh.
 *
 * Quick match (the old `room:public` join-or-create card) was
 * removed by owner decision 2026-11-09 — strict design only. The
 * gateway capability itself is untouched; only the UI card is
 * gone. The hub's Public entry now lands on the Public rooms
 * section below instead.
 *
 * Socket lifecycle is unchanged from the tabbed lobby: the lobby
 * owns the shared connection, a success ack hands it to the room
 * screen (markRoomOwnership) and replaces this route, and leaving
 * without a room disconnects. The hub's `intent` param is still
 * accepted — 'join' focuses the code boxes, 'public' scrolls to
 * the Public rooms section.
 */
export default function QuizLobbyScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ intent?: string }>();

  const [connStatus, setConnStatus] = useState<QuizSocketStatus>('connecting');
  const [connError, setConnError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Join-by-code state.
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [joining, setJoining] = useState<'code' | 'list' | null>(null);
  const [joiningCode, setJoiningCode] = useState<string | null>(null);
  const codeInputRef = useRef<TextInputInstance | null>(null);
  const scrollRef = useRef<ElementRef<typeof ScrollView> | null>(null);
  const publicSectionY = useRef<number | null>(null);

  // Public rooms list state.
  const [rooms, setRooms] = useState<PublicRoomListItem[] | null>(null);
  const [roomsError, setRoomsError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handedOffRef = useRef(false);

  useEffect(() => {
    const unsub = subscribeQuizSocketStatus((s, err) => {
      setConnStatus(s);
      setConnError(err);
    });
    void ensureQuizSocket().catch((e: unknown) => {
      setFatal(
        e instanceof Error
          ? e.message
          : 'Could not connect to the quiz server.',
      );
    });
    return () => {
      unsub();
      if (!handedOffRef.current && !roomOwnership()) {
        disconnectQuizSocket();
      }
    };
  }, []);

  const connected = connStatus === 'connected';

  const fetchRooms = useCallback(async () => {
    try {
      const ack = await emitRoomEvent('room:list-public', {});
      if (ack.success && ack.rooms) {
        setRooms(ack.rooms);
        setRoomsError(false);
      } else {
        setRoomsError(true);
      }
    } catch {
      setRoomsError(true);
    }
  }, []);

  /* Fetch the public list when the screen focuses and keep it warm
     on an interval while mounted (only over a live connection). */
  useFocusEffect(
    useCallback(() => {
      if (!connected) return;
      void fetchRooms();
      const timer = setInterval(() => void fetchRooms(), PUBLIC_REFRESH_MS);
      return () => clearInterval(timer);
    }, [connected, fetchRooms]),
  );

  /* The hub's Join entry focuses the code boxes. */
  useEffect(() => {
    if (params.intent === 'join' && connected) {
      const timer = setTimeout(() => codeInputRef.current?.focus(), 350);
      return () => clearTimeout(timer);
    }
  }, [params.intent, connected]);

  /* The hub's Public entry lands on the Public rooms section
     (it used to rely on the Quick match card, removed 2026-11-09). */
  useEffect(() => {
    if (params.intent !== 'public') return;
    const timer = setTimeout(() => {
      if (publicSectionY.current !== null) {
        scrollRef.current?.scrollTo({
          y: Math.max(0, publicSectionY.current - spacing.sm),
          animated: true,
        });
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [params.intent]);

  const enterRoom = (roomId: string | undefined) => {
    if (!roomId) {
      setError('The server did not return a room. Please try again.');
      return;
    }
    handedOffRef.current = true;
    markRoomOwnership(roomId);
    router.replace({ pathname: '/quiz/room', params: { roomId } });
  };

  const joinByCode = async (roomCode: string, via: 'code' | 'list') => {
    if (joining) return;
    setJoining(via);
    setJoiningCode(roomCode);
    if (via === 'code') setCodeError(null);
    setError(null);
    try {
      const ack = await emitRoomEvent('room:join', { roomCode });
      if (!ack.success) {
        const message = ack.error ?? 'Could not join that room.';
        if (via === 'code') setCodeError(message);
        else setError(message);
        // A listed room may have filled or closed since the fetch.
        if (via === 'list') void fetchRooms();
        return;
      }
      enterRoom(ack.roomId ?? ack.room?.roomId);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Could not join that room.';
      if (via === 'code') setCodeError(message);
      else setError(message);
    } finally {
      setJoining(null);
      setJoiningCode(null);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchRooms();
    setRefreshing(false);
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/quiz');
  };

  const onCodeChange = (text: string) => {
    setCode(text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
    setCodeError(null);
  };

  const openCount = rooms?.filter((r) => !r.isFull).length ?? 0;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          onPress={goBack}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Back to quiz home"
          style={styles.backHit}
        >
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <View style={styles.headerMain}>
          <Text style={styles.headerTitle}>Multiplayer</Text>
          <Text style={styles.headerSub}>
            Play quizzes live with friends or anyone.
          </Text>
        </View>
        <View
          style={[
            styles.statusDot,
            connected && styles.statusDotOn,
            connStatus === 'error' && styles.statusDotError,
          ]}
        />
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={theme.accent}
          />
        }
      >
        <View style={styles.column}>
          {fatal ? (
            <View style={styles.card}>
              <Text style={styles.errorText}>{fatal}</Text>
            </View>
          ) : (
            <>
              {connStatus === 'error' && connError && (
                <Text style={styles.errorText}>{connError}</Text>
              )}
              {error && <Text style={styles.errorText}>{error}</Text>}

              {/* Create card (§6.22) */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Create a room</Text>
                <Text style={styles.cardBody}>
                  Host a Party of 3 to 8 players, or a 1v1 Duel.
                </Text>
                <Pressable
                  onPress={() => router.push('/quiz/create')}
                  disabled={!connected}
                  accessibilityRole="button"
                  accessibilityLabel="Create a room"
                  accessibilityState={{ disabled: !connected }}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    !connected && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Plus size={17} color={theme.onAccent} strokeWidth={2} />
                  <Text style={styles.primaryButtonText}>Create Room</Text>
                </Pressable>
              </View>

              {/* Join with a code (§6.22) */}
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Join with a code</Text>
                <Pressable
                  onPress={() => codeInputRef.current?.focus()}
                  accessibilityRole="button"
                  accessibilityLabel="Room code, 6 characters"
                  style={styles.boxesPressable}
                >
                  <View style={styles.boxesRow} pointerEvents="none">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <View
                        key={i}
                        style={[
                          styles.box,
                          i === code.length &&
                            !codeError &&
                            styles.boxActive,
                          codeError && styles.boxError,
                          code[i] && styles.boxFilled,
                        ]}
                      >
                        <Text style={styles.boxChar}>{code[i] ?? ''}</Text>
                      </View>
                    ))}
                  </View>
                  <TextInput
                    ref={codeInputRef}
                    value={code}
                    onChangeText={onCodeChange}
                    onSubmitEditing={() => {
                      if (code.length === 6) void joinByCode(code, 'code');
                    }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    caretHidden
                    maxLength={6}
                    style={styles.hiddenInput}
                    accessibilityLabel="Room code"
                  />
                </Pressable>
                {codeError ? (
                  <Text style={styles.errorText}>{codeError}</Text>
                ) : (
                  <Text style={styles.hint}>
                    {code.length < 6
                      ? `Codes are 6 characters — ${6 - code.length} to go. Ask the host for theirs.`
                      : 'Ready — tap Join.'}
                  </Text>
                )}
                <Pressable
                  onPress={() => void joinByCode(code, 'code')}
                  disabled={!connected || joining !== null || code.length !== 6}
                  accessibilityRole="button"
                  accessibilityLabel="Join room"
                  accessibilityState={{
                    disabled:
                      !connected || joining !== null || code.length !== 6,
                    busy: joining === 'code',
                  }}
                  style={({ pressed }) => [
                    styles.joinButton,
                    (!connected || joining !== null || code.length !== 6) &&
                      styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  {joining === 'code' ? (
                    <ActivityIndicator color={theme.accent} size="small" />
                  ) : null}
                  <Text style={styles.joinButtonText}>
                    {joining === 'code' ? 'Joining…' : 'Join'}
                  </Text>
                </Pressable>
              </View>

              {/* Public rooms (§6.22) */}
              <View
                style={styles.sectionHead}
                onLayout={(e) => {
                  publicSectionY.current = e.nativeEvent.layout.y;
                }}
              >
                <Text style={styles.sectionTitle}>Public rooms</Text>
                {rooms !== null && (
                  <Text style={styles.sectionMeta}>{openCount} open</Text>
                )}
              </View>
              {rooms === null && !roomsError ? (
                <View style={styles.cardCenter}>
                  <ActivityIndicator color={theme.accent} />
                </View>
              ) : roomsError && rooms === null ? (
                <Text style={styles.hint}>
                  Could not load public rooms. Pull to retry.
                </Text>
              ) : rooms !== null && rooms.length === 0 ? (
                <Text style={styles.hint}>
                  No open rooms right now — create one above.
                </Text>
              ) : (
                rooms?.map((room) => (
                  <View key={room.roomId} style={styles.roomRow}>
                    <Avatar
                      url={room.hostAvatar}
                      name={room.hostUsername}
                      size={44}
                    />
                    <View style={styles.roomMain}>
                      <Text style={styles.roomHost} numberOfLines={1}>
                        {room.hostUsername}
                      </Text>
                      <Text style={styles.roomMeta} numberOfLines={1}>
                        {room.roomType === 'party' ? 'Party' : 'Duel'} ·{' '}
                        {GUESS_LABEL[room.guessType]} · {room.roundCount}{' '}
                        rounds
                      </Text>
                    </View>
                    <Text style={styles.roomCount}>
                      {room.playerCount}/{room.maxPlayers}
                    </Text>
                    {room.isFull ? (
                      <View
                        style={[styles.joinPill, styles.joinPillDisabled]}
                      >
                        <Text style={styles.joinPillTextDisabled}>Full</Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => void joinByCode(room.roomCode, 'list')}
                        disabled={!connected || joining !== null}
                        accessibilityRole="button"
                        accessibilityLabel={`Join ${room.hostUsername}'s room`}
                        accessibilityState={{
                          disabled: !connected || joining !== null,
                          busy:
                            joining === 'list' &&
                            joiningCode === room.roomCode,
                        }}
                        style={({ pressed }) => [
                          styles.joinPill,
                          (!connected || joining !== null) &&
                            styles.buttonDisabled,
                          pressed && styles.pressed,
                        ]}
                      >
                        {joining === 'list' &&
                        joiningCode === room.roomCode ? (
                          <ActivityIndicator
                            color={theme.onAccent}
                            size="small"
                          />
                        ) : (
                          <Text style={styles.joinPillText}>Join</Text>
                        )}
                      </Pressable>
                    )}
                  </View>
                ))
              )}
            </>
          )}
        </View>
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
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
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
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerMain: {
      flex: 1,
    },
    headerTitle: {
      ...typeStyles.heading,
      fontSize: 20,
      color: theme.text,
    },
    headerSub: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: 1,
    },
    statusDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: theme.muted,
      marginRight: spacing.sm,
    },
    statusDotOn: {
      backgroundColor: theme.accent,
    },
    statusDotError: {
      backgroundColor: theme.secondary,
    },
    content: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    column: {
      width: '100%',
      maxWidth: FORM_MAX_WIDTH,
      alignSelf: 'center',
      gap: spacing.md,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cardCenter: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.xl,
      alignItems: 'center',
    },
    cardTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    cardBody: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 17,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    primaryButtonText: {
      ...typeStyles.sectionLabel,
      color: theme.onAccent,
    },
    joinButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.base,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    joinButtonText: {
      ...typeStyles.sectionLabel,
      color: theme.accent,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    boxesPressable: {
      position: 'relative',
    },
    boxesRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    box: {
      flex: 1,
      height: 56,
      borderRadius: radii.base,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxFilled: {
      backgroundColor: theme.surface,
      borderColor: theme.muted,
    },
    boxActive: {
      borderColor: theme.accent,
      borderWidth: 1.5,
    },
    boxError: {
      borderColor: theme.secondary,
    },
    boxChar: {
      ...typeStyles.mono,
      fontSize: 20,
      color: theme.text,
    },
    hiddenInput: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      opacity: 0,
    },
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginTop: spacing.sm,
    },
    sectionTitle: {
      ...typeStyles.sectionLabel,
      color: theme.text,
    },
    sectionMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    roomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.md,
    },
    roomMain: {
      flex: 1,
      gap: 2,
    },
    roomHost: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    roomMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    roomCount: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    joinPill: {
      minWidth: 64,
      minHeight: 36,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
    },
    joinPillDisabled: {
      backgroundColor: theme.accentContainer,
    },
    joinPillText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    joinPillTextDisabled: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
    },
    hint: {
      ...typeStyles.caption,
      color: theme.muted,
      lineHeight: 16,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.secondary,
      textAlign: 'center',
    },
    pressed: {
      opacity: 0.85,
    },
  });

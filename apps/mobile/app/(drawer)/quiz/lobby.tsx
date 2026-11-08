import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ChevronLeft,
  Globe,
  Hash,
  Library,
  Lock,
  Mic,
  Music,
  Plus,
  Shuffle,
  Swords,
  Tv,
  Users,
} from 'lucide-react-native';
import type {
  CreateRoomRequest,
  QuizMatchmaking,
  QuizPoolMode,
  QuizRoomType,
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
import {
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH, FORM_MAX_WIDTH } from '../../../src/layout';

type Intent = 'create' | 'join' | 'public';
type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

const GUESS_OPTIONS: { key: RoomGuessType; label: string; Icon: IconComponent }[] = [
  { key: 'anime', label: 'Anime', Icon: Tv },
  { key: 'song', label: 'Song', Icon: Music },
  { key: 'artist', label: 'Artist', Icon: Mic },
];

const POOL_OPTIONS: { key: QuizPoolMode; label: string; Icon: IconComponent }[] = [
  { key: 'random', label: 'Random', Icon: Shuffle },
  { key: 'watched', label: 'Watched', Icon: Library },
  { key: 'common', label: 'Common', Icon: Users },
];

/**
 * Multiplayer lobby (Slice M4) — the socket entry point: create a
 * room, join by 6-char code, or take a public match. All three are
 * `room:*` emits on the shared gateway connection (quizSocket.ts);
 * a success ack hands the socket to the room screen
 * (markRoomOwnership) and replaces this route with it, so the
 * connection outlives the navigation. Leaving without a room
 * disconnects.
 *
 * Create mirrors the web's create body — rounds run 30s by the
 * server's create rule; the host can change the timer inside the
 * room. Errors from acks are shown verbatim (the API's room errors
 * are user-facing sentences, as on the web).
 */
export default function QuizLobbyScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ intent?: string }>();

  const [intent, setIntent] = useState<Intent>(
    params.intent === 'join' || params.intent === 'public'
      ? params.intent
      : 'create',
  );
  const [connStatus, setConnStatus] = useState<QuizSocketStatus>('connecting');
  const [connError, setConnError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState<Intent | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create / public form state.
  const [roomType, setRoomType] = useState<QuizRoomType>('party');
  const [guessType, setGuessType] = useState<RoomGuessType>('anime');
  const [poolMode, setPoolMode] = useState<QuizPoolMode>('random');
  const [roundCount, setRoundCount] = useState(10);
  const [maxPlayers, setMaxPlayers] = useState(6);
  const [matchmaking, setMatchmaking] = useState<QuizMatchmaking>('invite');
  const [joinCode, setJoinCode] = useState('');

  const handedOffRef = useRef(false);

  useEffect(() => {
    const unsub = subscribeQuizSocketStatus((s, err) => {
      setConnStatus(s);
      setConnError(err);
    });
    void ensureQuizSocket().catch((e: unknown) => {
      setFatal(
        e instanceof Error ? e.message : 'Could not connect to the quiz server.',
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

  const enterRoom = (roomId: string | undefined) => {
    if (!roomId) {
      setError('The server did not return a room. Please try again.');
      return;
    }
    handedOffRef.current = true;
    markRoomOwnership(roomId);
    router.replace({ pathname: '/quiz/room', params: { roomId } });
  };

  const run = async (kind: Intent, event: string, payload: Record<string, unknown>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const ack = await emitRoomEvent(event, payload);
      if (!ack.success) {
        setError(ack.error ?? 'The room action failed.');
        return;
      }
      enterRoom(ack.roomId ?? ack.room?.roomId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The room action failed.');
    } finally {
      setBusy(null);
    }
  };

  const onCreate = () => {
    const body: CreateRoomRequest = {
      roomType,
      poolMode,
      guessType,
      roundCount,
      matchmaking,
      ...(roomType === 'party' ? { maxPlayers } : {}),
    };
    void run('create', 'room:create', { ...body });
  };

  const onJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6) {
      setError('Room codes are 6 characters.');
      return;
    }
    void run('join', 'room:join', { roomCode: code });
  };

  const onPublic = () => {
    void run('public', 'room:public', {
      roomType,
      poolMode,
      guessType,
      ...(roomType === 'party' ? { maxPlayers: 6 } : {}),
    });
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/quiz');
  };

  const chip = (
    active: boolean,
    label: string,
    Icon: IconComponent | null,
    onPress: () => void,
  ) => (
    <Pressable
      key={label}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        pressed && styles.pressed,
      ]}
    >
      {Icon && (
        <Icon
          size={15}
          color={active ? theme.onAccent : theme.muted}
          strokeWidth={2}
        />
      )}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );

  const fieldLabel = (text: string) => (
    <Text style={styles.fieldLabel}>{text}</Text>
  );

  const roomTypeSegment = (
    <View style={styles.segmentRow}>
      <Pressable
        onPress={() => setRoomType('party')}
        accessibilityRole="button"
        accessibilityState={{ selected: roomType === 'party' }}
        style={[styles.segment, roomType === 'party' && styles.segmentActive]}
      >
        <Users
          size={15}
          color={roomType === 'party' ? theme.onAccent : theme.muted}
          strokeWidth={2}
        />
        <Text
          style={[
            styles.segmentText,
            roomType === 'party' && styles.segmentTextActive,
          ]}
        >
          Party
        </Text>
      </Pressable>
      <Pressable
        onPress={() => setRoomType('duel')}
        accessibilityRole="button"
        accessibilityState={{ selected: roomType === 'duel' }}
        style={[styles.segment, roomType === 'duel' && styles.segmentActive]}
      >
        <Swords
          size={15}
          color={roomType === 'duel' ? theme.onAccent : theme.muted}
          strokeWidth={2}
        />
        <Text
          style={[
            styles.segmentText,
            roomType === 'duel' && styles.segmentTextActive,
          ]}
        >
          Duel
        </Text>
      </Pressable>
    </View>
  );

  const actionButton = (
    kind: Intent,
    label: string,
    Icon: IconComponent,
    onPress: () => void,
    disabled: boolean,
  ) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: busy === kind }}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled && styles.buttonDisabled,
        pressed && styles.pressed,
      ]}
    >
      {busy === kind ? (
        <ActivityIndicator color={theme.onAccent} size="small" />
      ) : (
        <Icon size={17} color={theme.onAccent} strokeWidth={2} />
      )}
      <Text style={styles.primaryButtonText}>
        {busy === kind ? 'Working…' : label}
      </Text>
    </Pressable>
  );

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
            {connStatus === 'connected'
              ? 'Connected'
              : connStatus === 'connecting'
                ? 'Connecting…'
                : connStatus === 'error'
                  ? 'Connection problem'
                  : 'Offline'}
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
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          {fatal ? (
            <View style={styles.card}>
              <Text style={styles.errorText}>{fatal}</Text>
            </View>
          ) : (
            <>
              <View style={styles.segmentRow}>
                {(
                  [
                    { key: 'create', label: 'Create', Icon: Plus },
                    { key: 'join', label: 'Join', Icon: Hash },
                    { key: 'public', label: 'Public', Icon: Globe },
                  ] as { key: Intent; label: string; Icon: IconComponent }[]
                ).map((tab) => (
                  <Pressable
                    key={tab.key}
                    onPress={() => {
                      setIntent(tab.key);
                      setError(null);
                    }}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: intent === tab.key }}
                    style={[
                      styles.segment,
                      intent === tab.key && styles.segmentActive,
                    ]}
                  >
                    <tab.Icon
                      size={15}
                      color={
                        intent === tab.key ? theme.onAccent : theme.muted
                      }
                      strokeWidth={2}
                    />
                    <Text
                      style={[
                        styles.segmentText,
                        intent === tab.key && styles.segmentTextActive,
                      ]}
                    >
                      {tab.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {connStatus === 'error' && connError && (
                <Text style={styles.errorText}>{connError}</Text>
              )}
              {error && <Text style={styles.errorText}>{error}</Text>}

              {intent === 'create' && (
                <View style={styles.card}>
                  {fieldLabel('Room')}
                  {roomTypeSegment}
                  {fieldLabel('Guess the')}
                  <View style={styles.chipRow}>
                    {GUESS_OPTIONS.map((o) =>
                      chip(guessType === o.key, o.label, o.Icon, () =>
                        setGuessType(o.key),
                      ),
                    )}
                  </View>
                  {fieldLabel('Theme pool')}
                  <View style={styles.chipRow}>
                    {POOL_OPTIONS.map((o) =>
                      chip(poolMode === o.key, o.label, o.Icon, () =>
                        setPoolMode(o.key),
                      ),
                    )}
                  </View>
                  {fieldLabel('Rounds')}
                  <View style={styles.chipRow}>
                    {[5, 10, 15, 20].map((n) =>
                      chip(roundCount === n, `${n}`, null, () =>
                        setRoundCount(n),
                      ),
                    )}
                  </View>
                  {roomType === 'party' && (
                    <>
                      {fieldLabel('Max players')}
                      <View style={styles.chipRow}>
                        {[4, 6, 8].map((n) =>
                          chip(maxPlayers === n, `${n}`, null, () =>
                            setMaxPlayers(n),
                          ),
                        )}
                      </View>
                    </>
                  )}
                  {fieldLabel('Who can join')}
                  <View style={styles.chipRow}>
                    {chip(matchmaking === 'invite', 'By code', Lock, () =>
                      setMatchmaking('invite'),
                    )}
                    {chip(matchmaking === 'public', 'Public', Globe, () =>
                      setMatchmaking('public'),
                    )}
                  </View>
                  <Text style={styles.hint}>
                    Rounds run 30 seconds each — as host you can change the
                    timer inside the room.
                    {roomType === 'duel'
                      ? ' Duels are 1v1 and start when both players are ready.'
                      : ''}
                  </Text>
                  {actionButton(
                    'create',
                    'Create room',
                    Plus,
                    onCreate,
                    !connected || busy !== null,
                  )}
                </View>
              )}

              {intent === 'join' && (
                <View style={styles.card}>
                  {fieldLabel('Room code')}
                  <TextInput
                    value={joinCode}
                    onChangeText={(t) =>
                      setJoinCode(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                    }
                    placeholder="ABC123"
                    placeholderTextColor={theme.muted}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={6}
                    style={styles.codeInput}
                    accessibilityLabel="Room code"
                  />
                  <Text style={styles.hint}>
                    Codes are 6 characters — ask the host for theirs.
                  </Text>
                  {actionButton(
                    'join',
                    'Join room',
                    Hash,
                    onJoin,
                    !connected || busy !== null || joinCode.length !== 6,
                  )}
                </View>
              )}

              {intent === 'public' && (
                <View style={styles.card}>
                  {fieldLabel('Room')}
                  {roomTypeSegment}
                  {fieldLabel('Guess the')}
                  <View style={styles.chipRow}>
                    {GUESS_OPTIONS.map((o) =>
                      chip(guessType === o.key, o.label, o.Icon, () =>
                        setGuessType(o.key),
                      ),
                    )}
                  </View>
                  {fieldLabel('Theme pool')}
                  <View style={styles.chipRow}>
                    {POOL_OPTIONS.map((o) =>
                      chip(poolMode === o.key, o.label, o.Icon, () =>
                        setPoolMode(o.key),
                      ),
                    )}
                  </View>
                  <Text style={styles.hint}>
                    Joins an open public room with these settings, or starts
                    a new one (10 rounds) if none is waiting.
                  </Text>
                  {actionButton(
                    'public',
                    'Find a match',
                    Globe,
                    onPublic,
                    !connected || busy !== null,
                  )}
                </View>
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
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerMain: {
      flex: 1,
    },
    headerTitle: {
      ...typeStyles.sectionLabel,
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
    segmentRow: {
      flexDirection: 'row',
      gap: spacing.xs,
      backgroundColor: theme.surface,
      borderRadius: radii.base,
      padding: spacing.xs,
    },
    segment: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      minHeight: 38,
      borderRadius: radii.sm + 2,
    },
    segmentActive: {
      backgroundColor: theme.accent,
    },
    segmentText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    segmentTextActive: {
      color: theme.onAccent,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.lg,
      gap: spacing.md,
    },
    fieldLabel: {
      ...typeStyles.caption,
      color: theme.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      minHeight: 38,
      paddingHorizontal: spacing.md,
      borderRadius: radii.pill,
      backgroundColor: theme.raised,
      borderWidth: 1,
      borderColor: theme.border,
    },
    chipActive: {
      backgroundColor: theme.accent,
      borderColor: theme.accent,
    },
    chipText: {
      ...typeStyles.bodySmall,
      color: theme.text,
    },
    chipTextActive: {
      color: theme.onAccent,
    },
    hint: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    codeInput: {
      ...typeStyles.mono,
      fontSize: 22,
      letterSpacing: 6,
      color: theme.text,
      backgroundColor: theme.raised,
      borderRadius: radii.base,
      borderWidth: 1,
      borderColor: theme.border,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      textAlign: 'center',
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
    buttonDisabled: {
      opacity: 0.45,
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

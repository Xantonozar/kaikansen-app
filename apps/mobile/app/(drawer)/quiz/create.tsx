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
import { ChevronLeft, Minus, Plus } from 'lucide-react-native';
import type {
  CreateRoomRequest,
  QuizMatchmaking,
  QuizPoolMode,
  QuizRoomType,
  RoomGuessType,
} from '@kaikansen/contracts';
import {
  emitRoomEvent,
  ensureQuizSocket,
  markRoomOwnership,
  subscribeQuizSocketStatus,
  type QuizSocketStatus,
} from '../../../src/quizSocket';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH, FORM_MAX_WIDTH } from '../../../src/layout';

const GUESS_OPTIONS: { key: RoomGuessType; label: string }[] = [
  { key: 'anime', label: 'Anime' },
  { key: 'song', label: 'Song' },
  { key: 'artist', label: 'Artist' },
];

const POOL_OPTIONS: { key: QuizPoolMode; label: string }[] = [
  { key: 'random', label: 'Random' },
  { key: 'watched', label: 'Watched' },
  { key: 'common', label: 'Common' },
];

const ROUND_OPTIONS = [5, 10, 15];
const TIME_OPTIONS = [10, 20, 30];

/**
 * Create Room (Slice 5, design §6.23) — the designed single form
 * for multiplayer room creation, reached from the lobby's Create
 * card. One card per setting group, exactly as designed: Room type
 * (Party/Duel segmented), Guess the… chips, Question pool chips,
 * Rounds chips, a combined card with the Max players stepper (party
 * only — duels are 1v1) and Time per round chips, and the Visibility
 * segmented (Public / Invite only).
 *
 * Wiring: creation goes through the existing `room:create` gateway
 * event with the form's settings. The create contract has no time-
 * limit field — the server's create rule stamps 30s (the web's
 * rule) — so the chosen limit is applied immediately after creation
 * with `room:update-settings`, the web's own settings mechanism,
 * while the room is still waiting and this user is its host. The
 * default selection is the design's 20s.
 *
 * Socket ownership: this screen is only ever pushed over the lobby,
 * which owns the shared connection; it therefore never disconnects
 * on unmount. A successful create hands the socket to the room
 * screen (markRoomOwnership) and replaces the route with it.
 */
export default function CreateRoomScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();

  const [connStatus, setConnStatus] = useState<QuizSocketStatus>('connecting');
  const [connError, setConnError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [roomType, setRoomType] = useState<QuizRoomType>('party');
  const [guessType, setGuessType] = useState<RoomGuessType>('anime');
  const [poolMode, setPoolMode] = useState<QuizPoolMode>('random');
  const [roundCount, setRoundCount] = useState(10);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [timeLimit, setTimeLimit] = useState(20);
  const [matchmaking, setMatchmaking] = useState<QuizMatchmaking>('public');

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
    // No disconnect on unmount: the lobby beneath owns the
    // connection (see the docblock). On handoff the room screen
    // owns it via markRoomOwnership.
    return unsub;
  }, []);

  const connected = connStatus === 'connected';

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/quiz/lobby');
  };

  const onCreate = async () => {
    if (busy || !connected) return;
    setBusy(true);
    setError(null);
    try {
      const body: CreateRoomRequest = {
        roomType,
        poolMode,
        guessType,
        roundCount,
        matchmaking,
        ...(roomType === 'party' ? { maxPlayers } : {}),
      };
      const ack = await emitRoomEvent('room:create', { ...body });
      if (!ack.success) {
        setError(ack.error ?? 'Could not create the room.');
        return;
      }
      const roomId = ack.roomId ?? ack.room?.roomId;
      if (!roomId) {
        setError('The server did not return a room. Please try again.');
        return;
      }
      // Apply the chosen round timer (the create rule stamps 30s;
      // the design's default is 20s). If the settings ack fails the
      // room still exists at 30s and the host can change it in the
      // room — so a failure here does not strand the created room.
      if (timeLimit !== 30) {
        await emitRoomEvent('room:update-settings', {
          roomId,
          settings: { timeLimitSeconds: timeLimit },
        }).catch(() => undefined);
      }
      markRoomOwnership(roomId);
      router.replace({ pathname: '/quiz/room', params: { roomId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the room.');
    } finally {
      setBusy(false);
    }
  };

  const chip = (
    active: boolean,
    label: string,
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
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );

  const segment = (
    active: boolean,
    label: string,
    onPress: () => void,
  ) => (
    <Pressable
      key={label}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.segment,
        active && styles.segmentActive,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.segmentText,
          active && styles.segmentTextActive,
        ]}
      >
        {label}
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
          accessibilityLabel="Back to multiplayer lobby"
          style={styles.backHit}
        >
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <Text style={styles.headerTitle}>Create Room</Text>
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
              {connStatus === 'error' && connError && (
                <Text style={styles.errorText}>{connError}</Text>
              )}
              {error && <Text style={styles.errorText}>{error}</Text>}
              {!connected && !error && connStatus !== 'error' && (
                <Text style={styles.hint}>
                  Connecting to the quiz server…
                </Text>
              )}

              <View style={styles.card}>
                <Text style={styles.cardLabel}>Room type</Text>
                <View style={styles.segmentRow}>
                  {segment(roomType === 'party', 'Party', () =>
                    setRoomType('party'),
                  )}
                  {segment(roomType === 'duel', 'Duel', () =>
                    setRoomType('duel'),
                  )}
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardLabel}>Guess the…</Text>
                <View style={styles.chipRow}>
                  {GUESS_OPTIONS.map((o) =>
                    chip(guessType === o.key, o.label, () =>
                      setGuessType(o.key),
                    ),
                  )}
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardLabel}>Question pool</Text>
                <View style={styles.chipRow}>
                  {POOL_OPTIONS.map((o) =>
                    chip(poolMode === o.key, o.label, () =>
                      setPoolMode(o.key),
                    ),
                  )}
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardLabel}>Rounds</Text>
                <View style={styles.chipRow}>
                  {ROUND_OPTIONS.map((n) =>
                    chip(roundCount === n, `${n}`, () => setRoundCount(n)),
                  )}
                </View>
              </View>

              <View style={styles.card}>
                {roomType === 'party' && (
                  <>
                    <View style={styles.stepperRow}>
                      <Text style={styles.cardLabel}>Max players</Text>
                      <View style={styles.stepper}>
                        <Pressable
                          onPress={() =>
                            setMaxPlayers((n) => Math.max(2, n - 1))
                          }
                          disabled={maxPlayers <= 2}
                          accessibilityRole="button"
                          accessibilityLabel="Fewer players"
                          accessibilityState={{ disabled: maxPlayers <= 2 }}
                          style={({ pressed }) => [
                            styles.stepperButton,
                            maxPlayers <= 2 && styles.buttonDisabled,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Minus size={16} color={theme.text} strokeWidth={2} />
                        </Pressable>
                        <Text style={styles.stepperValue}>{maxPlayers}</Text>
                        <Pressable
                          onPress={() =>
                            setMaxPlayers((n) => Math.min(8, n + 1))
                          }
                          disabled={maxPlayers >= 8}
                          accessibilityRole="button"
                          accessibilityLabel="More players"
                          accessibilityState={{ disabled: maxPlayers >= 8 }}
                          style={({ pressed }) => [
                            styles.stepperButton,
                            maxPlayers >= 8 && styles.buttonDisabled,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Plus size={16} color={theme.text} strokeWidth={2} />
                        </Pressable>
                      </View>
                    </View>
                    <View style={styles.divider} />
                  </>
                )}
                <Text style={styles.cardLabel}>Time per round</Text>
                <View style={styles.chipRow}>
                  {TIME_OPTIONS.map((n) =>
                    chip(timeLimit === n, `${n}s`, () => setTimeLimit(n)),
                  )}
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardLabel}>Visibility</Text>
                <View style={styles.segmentRow}>
                  {segment(matchmaking === 'public', 'Public', () =>
                    setMatchmaking('public'),
                  )}
                  {segment(matchmaking === 'invite', 'Invite only', () =>
                    setMatchmaking('invite'),
                  )}
                </View>
              </View>

              <Pressable
                onPress={() => void onCreate()}
                disabled={!connected || busy}
                accessibilityRole="button"
                accessibilityLabel="Create room"
                accessibilityState={{ disabled: !connected || busy, busy }}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (!connected || busy) && styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={theme.onAccent} size="small" />
                ) : null}
                <Text style={styles.primaryButtonText}>
                  {busy ? 'Creating…' : 'Create Room'}
                </Text>
              </Pressable>
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
    headerTitle: {
      ...typeStyles.heading,
      fontSize: 20,
      color: theme.text,
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
    cardLabel: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    segmentRow: {
      flexDirection: 'row',
      gap: spacing.xs,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.base,
      padding: spacing.xs,
    },
    segment: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 40,
      borderRadius: radii.sm + 2,
    },
    segmentActive: {
      backgroundColor: theme.accent,
    },
    segmentText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    segmentTextActive: {
      color: theme.onAccent,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    chip: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 38,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
    },
    chipActive: {
      backgroundColor: theme.accent,
    },
    chipText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    chipTextActive: {
      color: theme.onAccent,
    },
    stepperRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    stepperButton: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperValue: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      minWidth: 20,
      textAlign: 'center',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 52,
      paddingHorizontal: spacing.lg,
    },
    primaryButtonText: {
      ...typeStyles.sectionLabel,
      color: theme.onAccent,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    hint: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
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

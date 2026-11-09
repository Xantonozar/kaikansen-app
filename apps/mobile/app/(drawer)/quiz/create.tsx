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

/* Party size bounds — the lobby card's own copy ("Host a Party of
   3 to 8 players, or a 1v1 Duel"). The web/API impose no party
   floor (the web hard-codes 6 and never offers the choice), so the
   design's stated range is the rule here. Duels are 1v1: the
   server forces maxPlayers 2 for duel creates regardless of the
   payload (quiz-rooms.service, mirroring the web create route). */
const PARTY_MIN_PLAYERS = 3;
const PARTY_MAX_PLAYERS = 8;
const DUEL_PLAYERS = 2;

/**
 * Create Room (Slice 5, design §6.23) — the designed single form
 * for multiplayer room creation, reached from the lobby's Create
 * card. One card per setting group, exactly as designed: Room type
 * (Party/Duel segmented), Guess the… chips, Question pool chips,
 * Rounds chips, a combined card with the Max players stepper and
 * Time per round chips, and the Visibility segmented (Public /
 * Invite only). The Create Room CTA sits in a footer under the
 * scroll area, as the mock draws it.
 *
 * Create Room fidelity pass (2026-11-10, measured from the Stitch
 * HTML; the earlier build had the skeleton but generic shapes):
 * cards at the mock's 16pt radius with 16pt padding and 14pt
 * semibold labels; chips and segments at 12pt radius with 14pt
 * medium labels, unselected text in the deep-mauve accent (the
 * HTML's colour), the segmented track and the stepper pill in the
 * page-pale tone; Rounds chips flexed equal-width; Time per round
 * as the mock's small right-aligned chips on the label's own row;
 * the CTA at 16pt radius with a 16pt label. The header is the
 * lobby family's bare arrow + bold title at this screen's own
 * measurements (40pt hit area, 24pt title).
 *
 * Duel handling: the stepper row stays on screen (the mock's card
 * always has both rows) pinned to 2 with both steppers disabled —
 * the real 1v1 constraint — and the create payload keeps omitting
 * maxPlayers for duels, since the server forces 2 either way.
 *
 * Wiring: creation goes through the existing `room:create` gateway
 * event with the form's settings. The create contract has no time-
 * limit field — the server's create rule stamps 30s (the web's
 * rule) — so the chosen limit is applied immediately after creation
 * with `room:update-settings`, the web's own settings mechanism,
 * while the room is still waiting and this user is its host. The
 * default selection is the design's 20s. Visibility maps to the
 * create payload's `matchmaking`: 'public' rooms are listed by
 * `room:list-public` in the lobby; 'invite' rooms are unlisted and
 * joinable by code only (there is deliberately no in-app invite
 * system — "Invite only" names the listing, nothing more).
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
  const isDuel = roomType === 'duel';
  const shownPlayers = isDuel ? DUEL_PLAYERS : maxPlayers;
  const minusDisabled = isDuel || maxPlayers <= PARTY_MIN_PLAYERS;
  const plusDisabled = isDuel || maxPlayers >= PARTY_MAX_PLAYERS;

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
    grow = false,
  ) => (
    <Pressable
      key={label}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.chip,
        grow && styles.chipGrow,
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
          <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.headerTitle}>Create Room</Text>
      </View>

      <ScrollView
        style={styles.scroll}
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
                    chip(roundCount === n, `${n}`, () => setRoundCount(n), true),
                  )}
                </View>
              </View>

              <View style={[styles.card, styles.settingsCard]}>
                <View style={styles.stepperRow}>
                  <Text style={styles.cardLabel}>Max players</Text>
                  <View style={styles.stepper}>
                    <Pressable
                      onPress={() =>
                        setMaxPlayers((n) =>
                          Math.max(PARTY_MIN_PLAYERS, n - 1),
                        )
                      }
                      disabled={minusDisabled}
                      accessibilityRole="button"
                      accessibilityLabel="Fewer players"
                      accessibilityState={{ disabled: minusDisabled }}
                      style={({ pressed }) => [
                        styles.stepperButton,
                        minusDisabled && styles.buttonDisabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Minus size={18} color={theme.accent} strokeWidth={2.5} />
                    </Pressable>
                    <Text style={styles.stepperValue}>{shownPlayers}</Text>
                    <Pressable
                      onPress={() =>
                        setMaxPlayers((n) =>
                          Math.min(PARTY_MAX_PLAYERS, n + 1),
                        )
                      }
                      disabled={plusDisabled}
                      accessibilityRole="button"
                      accessibilityLabel="More players"
                      accessibilityState={{ disabled: plusDisabled }}
                      style={({ pressed }) => [
                        styles.stepperButton,
                        plusDisabled && styles.buttonDisabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Plus size={18} color={theme.accent} strokeWidth={2.5} />
                    </Pressable>
                  </View>
                </View>
                <View style={styles.divider} />
                <View style={styles.stepperRow}>
                  <Text style={styles.cardLabel}>Time per round</Text>
                  <View style={styles.timeRow}>
                    {TIME_OPTIONS.map((n) => (
                      <Pressable
                        key={n}
                        onPress={() => setTimeLimit(n)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: timeLimit === n }}
                        style={({ pressed }) => [
                          styles.timeChip,
                          timeLimit === n && styles.chipActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.timeChipText,
                            timeLimit === n && styles.chipTextActive,
                          ]}
                        >
                          {`${n}s`}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
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
            </>
          )}
        </View>
      </ScrollView>

      {!fatal && (
        <View style={styles.footer}>
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
        </View>
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
    /* Header — this screen's HTML: a 40pt bare-arrow hit area
       nudged 8pt left, 12pt gap, 24pt display title; no back tile,
       no subtitle (the lobby header family at this mock's own
       measurements). */
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    },
    backHit: {
      width: 40,
      height: 40,
      marginLeft: -8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      fontFamily: fontFamilies.display,
      fontSize: 24,
      color: theme.text,
    },
    scroll: {
      flex: 1,
    },
    content: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxl,
    },
    column: {
      width: '100%',
      maxWidth: FORM_MAX_WIDTH,
      alignSelf: 'center',
      // The mock stacks its cards 12 apart (gap-3).
      gap: spacing.md,
    },
    /* Cards — this screen's HTML rounds them at 16 (rounded-2xl)
       with 16pt padding; the generic radii.card (24) belongs to
       other screens' mocks, not this one. The label sits 12 above
       its control (the HTML's mb-3), via the card gap. */
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.lg,
      gap: spacing.md,
    },
    settingsCard: {
      // Rows + the divider's own margins carry this card's rhythm.
      gap: 0,
    },
    cardLabel: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 14,
      color: theme.text,
    },
    /* Segmented control — pale page-tone track (the HTML's
       #FAF5F8, the background family), 4pt padding, 8pt between
       segments, 12pt radii; the unselected label is the deep
       mauve, not ink. */
    segmentRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      backgroundColor: theme.background,
      borderRadius: radii.base,
      padding: spacing.xs,
    },
    segment: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: spacing.sm,
      borderRadius: radii.base,
    },
    segmentActive: {
      backgroundColor: theme.accent,
    },
    segmentText: {
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.accent,
    },
    segmentTextActive: {
      color: theme.onAccent,
    },
    /* Chips — the HTML's 12pt radius (rounded-xl, not pills),
       16×8 padding, 14pt medium labels in the deep mauve on the
       lavender chip tone. */
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    chip: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radii.base,
      backgroundColor: theme.accentContainer,
    },
    chipGrow: {
      flex: 1,
    },
    chipActive: {
      backgroundColor: theme.accent,
    },
    chipText: {
      fontFamily: fontFamilies.caption,
      fontSize: 14,
      color: theme.accent,
    },
    chipTextActive: {
      color: theme.onAccent,
    },
    stepperRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    /* Stepper — the mock's pale pill: page-tone container with a
       hairline, 32pt lavender discs for −/+, a 16pt bold value on
       a 32pt minimum measure. */
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: theme.background,
      borderRadius: radii.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.xs,
    },
    stepperButton: {
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperValue: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 16,
      color: theme.text,
      minWidth: 32,
      textAlign: 'center',
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.accentContainer,
      marginVertical: spacing.md,
    },
    /* Time per round — the mock's small chips on the label's row:
       12×6 padding, 8pt radius, 12pt semibold labels, 6pt apart. */
    timeRow: {
      flexDirection: 'row',
      gap: 6,
    },
    timeChip: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radii.sm,
      backgroundColor: theme.accentContainer,
    },
    timeChipText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.accent,
    },
    /* Footer CTA — the mock pins it under the form: 16pt radius,
       14pt vertical padding, 16pt semibold label. */
    footer: {
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
      width: '100%',
      maxWidth: FORM_MAX_WIDTH,
      alignSelf: 'center',
    },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accent,
      borderRadius: radii.md,
      paddingVertical: 14,
      paddingHorizontal: spacing.lg,
    },
    primaryButtonText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 16,
      color: theme.onAccent,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    hint: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.muted,
      textAlign: 'center',
    },
    errorText: {
      fontFamily: fontFamilies.bodySmall,
      fontSize: 12,
      color: theme.secondary,
      textAlign: 'center',
    },
    pressed: {
      opacity: 0.85,
    },
  });

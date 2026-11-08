import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import {
  Check,
  ChevronLeft,
  Copy,
  Crown,
  LogOut,
  Play,
  Swords,
  Trophy,
  Users,
} from 'lucide-react-native';
import type {
  PlayerAnsweredEvent,
  QuizPoolMode,
  QuizRoomAck,
  QuizRoomPlayer,
  QuizRoomSettings,
  QuizRoomState,
  RankUpdatedEvent,
  RoomGuessType,
  RoundEndedEvent,
  RoundStartedEvent,
} from '@kaikansen/contracts';
import { useAuth } from '../../../src/auth';
import {
  clearRoomOwnership,
  disconnectQuizSocket,
  emitRoomEvent,
  ensureQuizSocket,
  HEARTBEAT_INTERVAL_MS,
  onRoomEvent,
  subscribeQuizSocketStatus,
  type QuizSocketStatus,
} from '../../../src/quizSocket';
import { CountdownRing } from '../../../src/components/CountdownRing';
import { QuizMedia } from '../../../src/components/QuizMedia';
import { QuizOptions } from '../../../src/components/QuizOptions';
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

const GUESS_LABEL: Record<RoomGuessType, string> = {
  anime: 'Guess the anime',
  song: 'Guess the song',
  artist: 'Guess the artist',
};
const POOL_LABEL: Record<QuizPoolMode, string> = {
  random: 'Random pool',
  watched: 'Watched pool',
  common: 'Common pool',
};

/**
 * Room screen (Slice M4) — lobby, game and results for one
 * multiplayer room, driven by the gateway's broadcasts with
 * `room:subscribe` as the resync primitive (mount, reconnect, and
 * any event that doesn't carry full state). The phases:
 *
 * - waiting: code + copy, player list with ready state and the
 *   host crown, the host's settings editor (room:update-settings),
 *   Ready toggle, host Start (duels auto-start on both-ready —
 *   server behaviour, the round-started broadcast just arrives);
 * - playing: the round's media + options with a countdown ring
 *   derived from the server's startedAt (the server owns the round
 *   timer), lock-in on answer, who's-answered from
 *   room:player-answered;
 * - reveal: room:round-ended — correct answer, everyone's results,
 *   running scoreboard; the host (or anyone in a hostless public
 *   room) advances with room:next;
 * - ended: final standings + per-player RP from room:rank-updated.
 *
 * Presence: a heartbeat every 15s (the gateway drops players at
 * 45s); a rejected heartbeat or room:closed lands on the closed
 * state with the reason shown. Leaving emits room:leave exactly
 * once and tears the socket down (this screen owns it — see
 * quizSocket.ts ownership). A mid-round reconnect resyncs players
 * and answers from the room state, but the live round's media only
 * ever travels on round-started, so a rejoined round is honestly
 * labelled media-unavailable while staying answerable.
 */
export default function QuizRoomScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const { user } = useAuth();
  const myId = user?.id ?? null;

  const [room, setRoom] = useState<QuizRoomState | null>(null);
  const [liveRound, setLiveRound] = useState<RoundStartedEvent | null>(null);
  const [roundEnded, setRoundEnded] = useState<RoundEndedEvent | null>(null);
  const [ranks, setRanks] = useState<Record<string, RankUpdatedEvent>>({});
  const [myAnswer, setMyAnswer] = useState<string | null>(null);
  const [myResult, setMyResult] = useState<{
    correct: boolean;
    gained: number;
  } | null>(null);
  const [answeredUsers, setAnsweredUsers] = useState<Set<string>>(new Set());
  const [connStatus, setConnStatus] = useState<QuizSocketStatus>('connecting');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mediaMissing, setMediaMissing] = useState(false);

  const mountedRef = useRef(true);
  const leftRef = useRef(false);
  const roomRef = useRef<QuizRoomState | null>(null);
  roomRef.current = room;
  const myIdRef = useRef<string | null>(null);
  myIdRef.current = myId;

  const goHome = useCallback(() => {
    router.replace('/(tabs)/quiz');
  }, [router]);

  const liveRoundRef = useRef<RoundStartedEvent | null>(null);

  /** Authoritative resync: the subscribe ack carries full state. */
  const resync = useCallback(async () => {
    if (!roomId) return;
    try {
      const ack = await emitRoomEvent('room:subscribe', { roomId });
      if (!mountedRef.current) return;
      if (!ack.success || !ack.room) {
        if (!roomRef.current) {
          setFatal(ack.error ?? 'Could not load this room.');
        }
        return;
      }
      const next = ack.room;
      setRoom(next);
      if (next.status === 'in_progress') {
        // Reattach to the live round: options + answers come from
        // the room state; the media does not (see header note).
        const round = next.rounds[next.currentRound - 1];
        if (round) {
          setAnsweredUsers(new Set(round.answers.map((a) => a.userId)));
          const mine = round.answers.find((a) => a.userId === myIdRef.current);
          if (mine) {
            setMyAnswer(mine.submittedAnswer);
            setMyResult({
              correct: mine.correct,
              gained: mine.totalScoreGained,
            });
          }
          const existing = liveRoundRef.current;
          const hasMedia =
            existing !== null &&
            existing.round === next.currentRound &&
            existing.theme.mediaCandidates.length > 0;
          if (!hasMedia) {
            setLiveRound({
              round: next.currentRound,
              theme: {
                videoUrl: '',
                mediaCandidates: [],
                options: round.options,
              },
              startedAt: round.startedAt,
              timeLimitSeconds: next.settings.timeLimitSeconds,
            });
            setMediaMissing(true);
          }
        }
      }
    } catch {
      // A failed resync leaves the current state standing; the
      // connection banner reports the transport problem.
    }
  }, [roomId]);

  liveRoundRef.current = liveRound;

  /* ------------------------------------------------------------ */
  /* Socket lifecycle + broadcast wiring                           */
  /* ------------------------------------------------------------ */
  useEffect(() => {
    mountedRef.current = true;
    const unsubStatus = subscribeQuizSocketStatus((s) => setConnStatus(s));
    let offs: (() => void)[] = [];
    let firstConnect = true;

    void (async () => {
      let sock;
      try {
        sock = await ensureQuizSocket();
      } catch (e) {
        if (mountedRef.current) {
          setFatal(
            e instanceof Error
              ? e.message
              : 'Could not connect to the quiz server.',
          );
        }
        return;
      }
      if (!mountedRef.current) return;

      const onConnect = () => {
        if (firstConnect) {
          firstConnect = false;
          return;
        }
        // Reconnected mid-room: reattach + resync.
        void resync();
      };
      sock.on('connect', onConnect);
      offs.push(() => sock.off('connect', onConnect));

      offs.push(
        onRoomEvent(
          'room:player-joined',
          (p: { players: QuizRoomPlayer[] }) => {
            setRoom((r) => (r ? { ...r, players: p.players } : r));
          },
        ),
        onRoomEvent('room:player-left', () => {
          // Carries no player list — resync for the authoritative
          // roster + host (host migration lands here).
          void resync();
        }),
        onRoomEvent(
          'room:player-ready',
          (p: { players: QuizRoomPlayer[] }) => {
            setRoom((r) => (r ? { ...r, players: p.players } : r));
          },
        ),
        onRoomEvent(
          'room:settings-updated',
          (p: { settings: QuizRoomSettings }) => {
            setRoom((r) => (r ? { ...r, settings: p.settings } : r));
          },
        ),
        onRoomEvent('room:round-started', (p: RoundStartedEvent) => {
          setLiveRound(p);
          setMediaMissing(false);
          setRoundEnded(null);
          setMyAnswer(null);
          setMyResult(null);
          setAnsweredUsers(new Set());
          setActionError(null);
          setRoom((r) =>
            r
              ? { ...r, status: 'in_progress', currentRound: p.round }
              : r,
          );
        }),
        onRoomEvent('room:player-answered', (p: PlayerAnsweredEvent) => {
          setAnsweredUsers((prev) => {
            const next = new Set(prev);
            next.add(p.userId);
            return next;
          });
          if (p.userId === myIdRef.current) {
            setMyResult({ correct: p.correct, gained: p.totalScoreGained });
          }
        }),
        onRoomEvent('room:round-ended', (p: RoundEndedEvent) => {
          setRoundEnded(p);
          setLiveRound(null);
          setAnsweredUsers(new Set(p.answers.map((a) => a.userId)));
          setRoom((r) =>
            r
              ? {
                  ...r,
                  players: p.players,
                  status: p.gameOver ? 'ended' : r.status,
                  currentRound: p.round,
                }
              : r,
          );
        }),
        onRoomEvent('room:rank-updated', (p: RankUpdatedEvent) => {
          setRanks((prev) => ({ ...prev, [p.userId]: p }));
        }),
        onRoomEvent('room:closed', () => {
          setClosedNote(
            'This room was closed due to inactivity. Everyone has been sent back.',
          );
        }),
      );

      await resync();
      if (!mountedRef.current) return;
      if (!roomRef.current) {
        // resync already set fatal when the subscribe failed.
        return;
      }
    })();

    return () => {
      mountedRef.current = false;
      unsubStatus();
      for (const off of offs) off();
      // Leaving the screen leaves the room (once) and drops the
      // socket this screen owns.
      if (!leftRef.current) {
        leftRef.current = true;
        const current = roomRef.current;
        if (current && current.status !== 'ended') {
          void emitRoomEvent('room:leave', { roomId }).catch(() => undefined);
        }
      }
      clearRoomOwnership();
      disconnectQuizSocket();
    };
    // Mount-only wiring; resync identity is stable via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  /* Heartbeat — the gateway's presence cadence. Keyed on stable
   * primitives: room-state merges mint a new object per broadcast,
   * and an interval that reset on each one could starve the very
   * heartbeat it exists to send. */
  const heartbeatActive = room !== null && room.status !== 'ended' && !closedNote;
  useEffect(() => {
    if (!heartbeatActive) return;
    const id = setInterval(() => {
      void emitRoomEvent('room:heartbeat', { roomId })
        .then((ack) => {
          if (mountedRef.current && !ack.success) {
            setClosedNote('This room was closed. Everyone has been sent back.');
          }
        })
        .catch(() => {
          // Transient transport failure — the banner owns it.
        });
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [heartbeatActive, roomId]);

  /* ------------------------------------------------------------ */
  /* Actions                                                       */
  /* ------------------------------------------------------------ */
  /** Runs a room action; resolves true only on a success ack. */
  const runAction = useCallback(
    async (
      kind: string,
      event: string,
      payload: Record<string, unknown>,
      apply?: (ack: QuizRoomAck) => void,
    ): Promise<boolean> => {
      if (busy) return false;
      setBusy(kind);
      setActionError(null);
      try {
        const ack = await emitRoomEvent(event, payload);
        if (!mountedRef.current) return false;
        if (!ack.success) {
          setActionError(ack.error ?? 'The action failed.');
          return false;
        }
        apply?.(ack);
        return true;
      } catch (e) {
        if (mountedRef.current) {
          setActionError(
            e instanceof Error ? e.message : 'The action failed.',
          );
        }
        return false;
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [busy],
  );

  const leaveExplicitly = useCallback(() => {
    if (leftRef.current) {
      goHome();
      return;
    }
    leftRef.current = true;
    const current = roomRef.current;
    if (current && current.status !== 'ended') {
      // Await the leave ack before navigating so the emit is not
      // killed by the unmount teardown; the ack timeout bounds it,
      // and the gateway's 45s presence sweep is the backstop.
      void emitRoomEvent('room:leave', { roomId })
        .catch(() => undefined)
        .finally(() => {
          if (mountedRef.current) goHome();
        });
    } else {
      goHome();
    }
  }, [goHome, roomId]);

  const onCopyCode = useCallback(() => {
    if (!room) return;
    void Clipboard.setStringAsync(room.roomCode)
      .then(() => {
        if (!mountedRef.current) return;
        setCopied(true);
        setTimeout(() => {
          if (mountedRef.current) setCopied(false);
        }, 2000);
      })
      .catch(() => undefined);
  }, [room]);

  const onAnswer = useCallback(
    (option: string) => {
      if (!liveRound || myAnswer !== null || roundEnded) return;
      // Optimistic lock-in; a failed send unlocks so the player can
      // retry while the round is still live (the error shows above).
      setMyAnswer(option);
      void runAction('answer', 'room:answer', {
        roomId,
        roundNumber: liveRound.round,
        submittedAnswer: option,
      }).then((ok) => {
        if (!ok && mountedRef.current) setMyAnswer(null);
      });
    },
    [liveRound, myAnswer, roundEnded, roomId, runAction],
  );

  /* ------------------------------------------------------------ */
  /* Derived state                                                 */
  /* ------------------------------------------------------------ */
  const me = room?.players.find((p) => p.userId === myId) ?? null;
  const isHost =
    room !== null && (room.hostId === null || room.hostId === myId);
  const gameOver = roundEnded?.gameOver === true || room?.status === 'ended';
  const phase: 'loading' | 'waiting' | 'playing' | 'reveal' | 'ended' =
    !room
      ? 'loading'
      : gameOver
        ? 'ended'
        : roundEnded
          ? 'reveal'
          : room.status === 'in_progress'
            ? 'playing'
            : 'waiting';

  const standings = useMemo(() => {
    if (!room) return [];
    return [...room.players].sort((a, b) => b.totalScore - a.totalScore);
  }, [room]);

  const deadlineMs = liveRound
    ? Date.parse(liveRound.startedAt) + liveRound.timeLimitSeconds * 1000
    : 0;

  const startHint = (() => {
    if (!room || phase !== 'waiting') return null;
    if (room.roomType === 'duel') {
      if (room.players.length !== 2) return 'Waiting for an opponent…';
      if (!room.players.every((p) => p.ready)) return 'Both players must ready up.';
      return null;
    }
    if (room.players.length < 2) return 'At least 2 players are needed.';
    if (!room.players.every((p) => p.ready)) return 'Everyone must ready up.';
    return null;
  })();

  /* ------------------------------------------------------------ */
  /* Render                                                        */
  /* ------------------------------------------------------------ */
  const playerRow = (player: QuizRoomPlayer, showAnswerState: boolean) => {
    const isMe = player.userId === myId;
    const host = room?.hostId === player.userId;
    const answered = answeredUsers.has(player.userId);
    const rank = ranks[player.userId];
    return (
      <View key={player.userId} style={styles.playerRow}>
        {player.avatar ? (
          <Image source={{ uri: player.avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarInitial}>
              {player.username.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.playerMain}>
          <View style={styles.playerNameRow}>
            <Text style={styles.playerName} numberOfLines={1}>
              {player.username}
            </Text>
            {host && (
              <Crown size={13} color={theme.secondary} strokeWidth={2} />
            )}
            {isMe && <Text style={styles.youTag}>You</Text>}
          </View>
          {phase === 'ended' && rank ? (
            <Text style={styles.playerSub}>
              RP {rank.rpChange >= 0 ? '+' : ''}
              {rank.rpChange} · {rank.tierAfter}
            </Text>
          ) : phase === 'waiting' ? (
            <Text style={styles.playerSub}>
              {player.ready ? 'Ready' : 'Not ready'}
            </Text>
          ) : (
            <Text style={styles.playerSub}>{player.totalScore} pts</Text>
          )}
        </View>
        {phase === 'waiting' ? (
          <View
            style={[
              styles.readyDot,
              player.ready && styles.readyDotOn,
            ]}
          >
            {player.ready && (
              <Check size={12} color={theme.onAccent} strokeWidth={3} />
            )}
          </View>
        ) : showAnswerState ? (
          answered ? (
            <Check size={17} color={theme.accent} strokeWidth={2.5} />
          ) : (
            <View style={styles.pendingDot} />
          )
        ) : (
          <Text style={styles.playerScore}>{player.totalScore}</Text>
        )}
      </View>
    );
  };

  const settingsChip = (
    active: boolean,
    label: string,
    onPress: () => void,
  ) => (
    <Pressable
      key={label}
      onPress={onPress}
      disabled={busy === 'settings'}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: busy === 'settings' }}
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

  const updateSetting = (patch: Record<string, unknown>) => {
    void runAction(
      'settings',
      'room:update-settings',
      { roomId, settings: patch },
      (ack) => {
        if (ack.settings) {
          setRoom((r) => (r ? { ...r, settings: ack.settings! } : r));
        }
      },
    );
  };

  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={leaveExplicitly}
        hitSlop={3}
        accessibilityRole="button"
        accessibilityLabel="Leave room"
        style={styles.backHit}
      >
        <View style={styles.backTile}>
          <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
        </View>
      </Pressable>
      <View style={styles.headerMain}>
        <Text style={styles.headerTitle}>
          {room ? `Room ${room.roomCode}` : 'Room'}
        </Text>
        <Text style={styles.headerSub}>
          {room
            ? room.roomType === 'duel'
              ? 'Duel'
              : 'Party'
            : 'Connecting…'}
        </Text>
      </View>
      <View
        style={[
          styles.statusDot,
          connStatus === 'connected' && styles.statusDotOn,
          connStatus === 'error' && styles.statusDotError,
        ]}
      />
    </View>
  );

  if (fatal) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.fatalText}>{fatal}</Text>
          <Pressable
            onPress={goHome}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Quiz home</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (closedNote) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        {header}
        <View style={styles.center}>
          <Text style={styles.fatalText}>{closedNote}</Text>
          <Pressable
            onPress={goHome}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Quiz home</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!room) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} size="large" />
          <Text style={styles.centerText}>Joining the room…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const myRank = myId ? ranks[myId] : undefined;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.column}>
        {header}
        {connStatus !== 'connected' && (
          <View style={styles.connBanner}>
            <Text style={styles.connBannerText}>
              {connStatus === 'connecting'
                ? 'Reconnecting to the quiz server…'
                : connStatus === 'error'
                  ? 'Connection problem — retrying…'
                  : 'Disconnected — reconnecting…'}
            </Text>
          </View>
        )}
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {actionError && <Text style={styles.errorText}>{actionError}</Text>}

          {phase === 'waiting' && (
            <>
              <View style={styles.card}>
                <View style={styles.codeRow}>
                  <View>
                    <Text style={styles.fieldLabel}>Room code</Text>
                    <Text style={styles.codeText}>{room.roomCode}</Text>
                  </View>
                  <Pressable
                    onPress={onCopyCode}
                    accessibilityRole="button"
                    accessibilityLabel="Copy room code"
                    style={({ pressed }) => [
                      styles.copyButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    {copied ? (
                      <Check size={16} color={theme.accent} strokeWidth={2.5} />
                    ) : (
                      <Copy size={16} color={theme.text} strokeWidth={2} />
                    )}
                    <Text style={styles.copyText}>
                      {copied ? 'Copied' : 'Copy'}
                    </Text>
                  </Pressable>
                </View>
                <Text style={styles.summaryText}>
                  {room.roomType === 'duel' ? 'Duel' : 'Party'} ·{' '}
                  {GUESS_LABEL[room.settings.guessType]} ·{' '}
                  {POOL_LABEL[room.settings.poolMode]} ·{' '}
                  {room.settings.roundCount} rounds ·{' '}
                  {room.settings.timeLimitSeconds}s per round ·{' '}
                  {room.players.length}/{room.settings.maxPlayers} players
                </Text>
                {isHost ? (
                  <View style={styles.settingsBlock}>
                    <Text style={styles.fieldLabel}>Rounds</Text>
                    <View style={styles.chipRow}>
                      {[5, 10, 15, 20].map((n) =>
                        settingsChip(room.settings.roundCount === n, `${n}`, () =>
                          updateSetting({ roundCount: n }),
                        ),
                      )}
                    </View>
                    <Text style={styles.fieldLabel}>Seconds per round</Text>
                    <View style={styles.chipRow}>
                      {[15, 20, 30, 45, 60].map((n) =>
                        settingsChip(
                          room.settings.timeLimitSeconds === n,
                          `${n}`,
                          () => updateSetting({ timeLimitSeconds: n }),
                        ),
                      )}
                    </View>
                    <Text style={styles.fieldLabel}>Guess the</Text>
                    <View style={styles.chipRow}>
                      {(['anime', 'song', 'artist'] as RoomGuessType[]).map(
                        (g) =>
                          settingsChip(
                            room.settings.guessType === g,
                            g === 'anime'
                              ? 'Anime'
                              : g === 'song'
                                ? 'Song'
                                : 'Artist',
                            () => updateSetting({ guessType: g }),
                          ),
                      )}
                    </View>
                    <Text style={styles.fieldLabel}>Theme pool</Text>
                    <View style={styles.chipRow}>
                      {(['random', 'watched', 'common'] as QuizPoolMode[]).map(
                        (p) =>
                          settingsChip(
                            room.settings.poolMode === p,
                            p === 'random'
                              ? 'Random'
                              : p === 'watched'
                                ? 'Watched'
                                : 'Common',
                            () => updateSetting({ poolMode: p }),
                          ),
                      )}
                    </View>
                    {room.roomType === 'party' && (
                      <>
                        <Text style={styles.fieldLabel}>Max players</Text>
                        <View style={styles.chipRow}>
                          {[4, 6, 8].map((n) =>
                            settingsChip(
                              room.settings.maxPlayers === n,
                              `${n}`,
                              () => updateSetting({ maxPlayers: n }),
                            ),
                          )}
                        </View>
                      </>
                    )}
                  </View>
                ) : (
                  <Text style={styles.hint}>
                    Only the host can change the settings.
                  </Text>
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.fieldLabel}>
                  Players · {room.players.length}/{room.settings.maxPlayers}
                </Text>
                {room.players.map((p) => playerRow(p, false))}
              </View>

              <Pressable
                onPress={() =>
                  void runAction('ready', 'room:ready', { roomId }, (ack) => {
                    if (ack.room) setRoom(ack.room);
                  })
                }
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel={me?.ready ? 'Cancel ready' : 'Ready up'}
                accessibilityState={{ busy: busy === 'ready' }}
                style={({ pressed }) => [
                  me?.ready ? styles.ghostButton : styles.primaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Check
                  size={17}
                  color={me?.ready ? theme.text : theme.onAccent}
                  strokeWidth={2}
                />
                <Text
                  style={
                    me?.ready
                      ? styles.ghostButtonText
                      : styles.primaryButtonText
                  }
                >
                  {busy === 'ready'
                    ? 'Working…'
                    : me?.ready
                      ? 'Ready — tap to cancel'
                      : 'Ready up'}
                </Text>
              </Pressable>
              {isHost && room.roomType === 'party' && (
                <Pressable
                  onPress={() =>
                    void runAction('start', 'room:start', { roomId }, (ack) => {
                      if (ack.room) setRoom(ack.room);
                    })
                  }
                  disabled={busy !== null || startHint !== null}
                  accessibilityRole="button"
                  accessibilityLabel="Start game"
                  accessibilityState={{
                    disabled: busy !== null || startHint !== null,
                  }}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    (busy !== null || startHint !== null) &&
                      styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Play size={17} color={theme.onAccent} strokeWidth={2} />
                  <Text style={styles.primaryButtonText}>
                    {busy === 'start' ? 'Starting…' : 'Start game'}
                  </Text>
                </Pressable>
              )}
              {startHint && <Text style={styles.hint}>{startHint}</Text>}
              {room.roomType === 'duel' && !isHost && (
                <Text style={styles.hint}>
                  Duels start automatically when both players are ready.
                </Text>
              )}
            </>
          )}

          {phase === 'playing' && liveRound && (
            <>
              <View style={styles.roundHead}>
                <Text style={styles.roundTitle}>
                  Round {liveRound.round} of {room.settings.roundCount}
                </Text>
                <CountdownRing
                  deadlineMs={deadlineMs}
                  totalSeconds={liveRound.timeLimitSeconds}
                />
              </View>
              {mediaMissing ? (
                <View style={styles.mediaMissingCard}>
                  <Text style={styles.mediaMissingText}>
                    You rejoined mid-round — this round's media isn't
                    available, but you can still answer.
                  </Text>
                </View>
              ) : (
                <QuizMedia
                  candidates={liveRound.theme.mediaCandidates}
                  coverImage={null}
                  mediaKey={`${roomId}:${liveRound.round}`}
                />
              )}
              <Text style={styles.guessLabel}>
                {GUESS_LABEL[room.settings.guessType]}
                {myAnswer !== null ? ' — answer locked in' : ''}
              </Text>
              <QuizOptions
                options={liveRound.theme.options}
                onSelect={onAnswer}
                disabled={myAnswer !== null}
                selected={myAnswer}
              />
              {myResult && (
                <Text
                  style={[
                    styles.myResult,
                    !myResult.correct && styles.myResultWrong,
                  ]}
                >
                  {myResult.correct
                    ? `Correct · +${myResult.gained} pts`
                    : 'Not the one — scores land at round end'}
                </Text>
              )}
              <View style={styles.card}>
                {room.players.map((p) => playerRow(p, true))}
              </View>
            </>
          )}

          {phase === 'reveal' && roundEnded && (
            <>
              <View style={styles.card}>
                <Text style={styles.fieldLabel}>
                  Round {roundEnded.round} · Answer
                </Text>
                <Text style={styles.correctAnswer}>
                  {roundEnded.correctAnswer}
                </Text>
                <Text style={styles.summaryText}>
                  {roundEnded.theme.songTitle ?? 'Unknown song'}
                  {roundEnded.theme.artistName
                    ? ` · ${roundEnded.theme.artistName}`
                    : ''}{' '}
                  —{' '}
                  {roundEnded.theme.animeTitleEnglish ??
                    roundEnded.theme.animeTitle ??
                    'Unknown anime'}
                </Text>
                {roundEnded.answers.map((a) => {
                  const player = room.players.find(
                    (p) => p.userId === a.userId,
                  );
                  return (
                    <View key={a.userId} style={styles.answerRow}>
                      <Text style={styles.answerName} numberOfLines={1}>
                        {player?.username ?? 'Player'}
                      </Text>
                      <Text style={styles.answerValue} numberOfLines={1}>
                        {a.submittedAnswer
                          ? a.submittedAnswer
                          : a.autoLocked
                            ? 'No answer (auto-locked)'
                            : 'Skipped'}
                      </Text>
                      {a.correct ? (
                        <Check size={15} color={theme.accent} strokeWidth={2.5} />
                      ) : (
                        <View style={styles.pendingDot} />
                      )}
                      <Text style={styles.answerScore}>
                        {a.totalScoreGained >= 0 ? '+' : ''}
                        {a.totalScoreGained}
                      </Text>
                    </View>
                  );
                })}
              </View>
              <View style={styles.card}>
                <Text style={styles.fieldLabel}>Scoreboard</Text>
                {standings.map((p) => playerRow(p, false))}
              </View>
              {isHost ? (
                <Pressable
                  onPress={() =>
                    void runAction('next', 'room:next', {
                      roomId,
                      expectedRound: roundEnded.round,
                    })
                  }
                  disabled={busy !== null}
                  accessibilityRole="button"
                  accessibilityLabel="Next round"
                  accessibilityState={{ busy: busy === 'next' }}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Play size={17} color={theme.onAccent} strokeWidth={2} />
                  <Text style={styles.primaryButtonText}>
                    {busy === 'next' ? 'Starting…' : 'Next round'}
                  </Text>
                </Pressable>
              ) : (
                <Text style={styles.hint}>
                  Waiting for the host to start the next round…
                </Text>
              )}
            </>
          )}

          {phase === 'ended' && (
            <>
              <View style={styles.card}>
                <View style={styles.overHead}>
                  <View style={styles.trophyTile}>
                    <Trophy size={24} color={theme.accent} strokeWidth={2} />
                  </View>
                  <Text style={styles.overTitle}>Final standings</Text>
                  {!roundEnded?.gameOver && (
                    <Text style={styles.hint}>The game ended early.</Text>
                  )}
                </View>
                {standings.map((p, i) => {
                  const rank = ranks[p.userId];
                  return (
                    <View key={p.userId} style={styles.playerRow}>
                      <Text style={styles.placeText}>{i + 1}</Text>
                      {p.avatar ? (
                        <Image
                          source={{ uri: p.avatar }}
                          style={styles.avatar}
                        />
                      ) : (
                        <View style={[styles.avatar, styles.avatarFallback]}>
                          <Text style={styles.avatarInitial}>
                            {p.username.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <View style={styles.playerMain}>
                        <View style={styles.playerNameRow}>
                          <Text style={styles.playerName} numberOfLines={1}>
                            {p.username}
                          </Text>
                          {room.hostId === p.userId && (
                            <Crown
                              size={13}
                              color={theme.secondary}
                              strokeWidth={2}
                            />
                          )}
                          {p.userId === myId && (
                            <Text style={styles.youTag}>You</Text>
                          )}
                        </View>
                        {rank && (
                          <Text style={styles.playerSub}>
                            RP {rank.rpChange >= 0 ? '+' : ''}
                            {rank.rpChange} · {rank.tierAfter}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.playerScore}>{p.totalScore}</Text>
                    </View>
                  );
                })}
              </View>
              {myRank && (
                <View style={styles.card}>
                  <Text style={styles.fieldLabel}>Your rank points</Text>
                  <Text style={styles.rpLine}>
                    {myRank.rpBefore} → {myRank.rpAfter} RP (
                    {myRank.rpChange >= 0 ? '+' : ''}
                    {myRank.rpChange})
                  </Text>
                  <Text style={styles.summaryText}>
                    {myRank.tierBefore} → {myRank.tierAfter}
                    {myRank.promoted
                      ? ' · Promoted!'
                      : myRank.demoted
                        ? ' · Demoted'
                        : ''}
                    {myRank.streakBonus > 0
                      ? ` · Streak bonus +${myRank.streakBonus}`
                      : ''}
                  </Text>
                </View>
              )}
              <View style={styles.overButtons}>
                <Pressable
                  onPress={leaveExplicitly}
                  accessibilityRole="button"
                  accessibilityLabel="Back to quiz home"
                  style={({ pressed }) => [
                    styles.primaryButton,
                    styles.overButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>Quiz home</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    leftRef.current = true;
                    router.replace({
                      pathname: '/quiz/lobby',
                      params: { intent: 'create' },
                    });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Create a new room"
                  style={({ pressed }) => [
                    styles.ghostButton,
                    styles.overButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.ghostButtonText}>New room</Text>
                </Pressable>
              </View>
            </>
          )}

          {phase !== 'ended' && (
            <Pressable
              onPress={leaveExplicitly}
              accessibilityRole="button"
              accessibilityLabel="Leave room"
              style={({ pressed }) => [
                styles.leaveButton,
                pressed && styles.pressed,
              ]}
            >
              <LogOut size={15} color={theme.secondary} strokeWidth={2} />
              <Text style={styles.leaveText}>Leave room</Text>
            </Pressable>
          )}
          {room.roomType === 'duel' && phase === 'waiting' && (
            <View style={styles.duelNote}>
              <Swords size={13} color={theme.muted} strokeWidth={2} />
              <Text style={styles.hint}>
                Share the code — your opponent joins with it.
              </Text>
            </View>
          )}
          {room.players.length > 0 && phase === 'waiting' && (
            <View style={styles.duelNote}>
              <Users size={13} color={theme.muted} strokeWidth={2} />
              <Text style={styles.hint}>
                {room.matchmaking === 'public'
                  ? 'Public room — anyone can land here.'
                  : 'Invite room — code only.'}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    column: {
      flex: 1,
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
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
    connBanner: {
      marginHorizontal: spacing.screenEdge,
      marginBottom: spacing.md,
      backgroundColor: withOpacity(theme.secondary, 0.12),
      borderRadius: radii.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    connBannerText: {
      ...typeStyles.caption,
      color: theme.text,
      textAlign: 'center',
    },
    content: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
      gap: spacing.md,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xxl,
    },
    centerText: {
      ...typeStyles.body,
      color: theme.muted,
    },
    fatalText: {
      ...typeStyles.body,
      color: theme.text,
      textAlign: 'center',
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
    codeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    codeText: {
      ...typeStyles.mono,
      fontSize: 26,
      letterSpacing: 4,
      color: theme.text,
      marginTop: spacing.xs,
    },
    copyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: theme.raised,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      minHeight: 36,
    },
    copyText: {
      ...typeStyles.bodySmall,
      color: theme.text,
    },
    summaryText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    settingsBlock: {
      gap: spacing.sm,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    chip: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 36,
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
      textAlign: 'center',
    },
    playerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.xs + 2,
    },
    avatar: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: theme.raised,
    },
    avatarFallback: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.accentContainer,
    },
    avatarInitial: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.onAccentContainer,
    },
    playerMain: {
      flex: 1,
    },
    playerNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
    },
    playerName: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.text,
      flexShrink: 1,
    },
    youTag: {
      ...typeStyles.caption,
      color: theme.accent,
    },
    playerSub: {
      ...typeStyles.caption,
      color: theme.muted,
      marginTop: 1,
    },
    playerScore: {
      ...typeStyles.mono,
      color: theme.text,
    },
    readyDot: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    readyDotOn: {
      backgroundColor: theme.accent,
    },
    pendingDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.border,
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
    ghostButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.base,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    },
    ghostButtonText: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.text,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    leaveButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      minHeight: 42,
    },
    leaveText: {
      ...typeStyles.bodySmall,
      color: theme.secondary,
    },
    duelNote: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 2,
    },
    roundHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    roundTitle: {
      ...typeStyles.sectionLabel,
      color: theme.text,
    },
    mediaMissingCard: {
      backgroundColor: withOpacity(theme.secondary, 0.1),
      borderRadius: radii.md,
      padding: spacing.lg,
    },
    mediaMissingText: {
      ...typeStyles.bodySmall,
      color: theme.text,
      textAlign: 'center',
    },
    guessLabel: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
    },
    myResult: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.accent,
      textAlign: 'center',
    },
    myResultWrong: {
      color: theme.secondary,
    },
    correctAnswer: {
      ...typeStyles.heading,
      color: theme.text,
    },
    answerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs + 2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    answerName: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.text,
      width: 90,
    },
    answerValue: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      flex: 1,
    },
    answerScore: {
      ...typeStyles.mono,
      color: theme.text,
      minWidth: 36,
      textAlign: 'right',
    },
    overHead: {
      alignItems: 'center',
      gap: spacing.sm,
    },
    trophyTile: {
      width: 52,
      height: 52,
      borderRadius: radii.md,
      backgroundColor: withOpacity(theme.accent, 0.14),
      alignItems: 'center',
      justifyContent: 'center',
    },
    overTitle: {
      ...typeStyles.heading,
      color: theme.text,
    },
    placeText: {
      ...typeStyles.mono,
      color: theme.muted,
      width: 18,
      textAlign: 'center',
    },
    rpLine: {
      ...typeStyles.sectionLabel,
      color: theme.text,
    },
    overButtons: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    overButton: {
      flex: 1,
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

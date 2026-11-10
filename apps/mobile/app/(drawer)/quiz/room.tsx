import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowRight,
  AudioWaveform,
  Check,
  ChevronLeft,
  Crown,
  Hourglass,
  LogOut,
  Music,
  Play,
  Share2,
  Trophy,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';
import type {
  PlayerAnsweredEvent,
  PlayerRankSummary,
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
import { ROUND_COUNTDOWN_SECONDS } from '@kaikansen/contracts';
import { useAuth } from '../../../src/auth';
import { fetchPlayerRanks } from '../../../src/socialApi';
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
import { Avatar } from '../../../src/components/Avatar';
import { CountdownRing } from '../../../src/components/CountdownRing';
import {
  QuizAudioOnly,
  type QuizAudioState,
} from '../../../src/components/QuizMedia';
import { quizAudioCandidates } from '../../../src/playback';
import { countdownSecondsLeft } from '../../../src/quizTiming';
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
  anilist: 'AniList pool',
};
/** Waiting-lobby summary chips use the design's title case
 * ("Guess the Anime"); GUESS_LABEL above keeps the in-game
 * sentence case the other phases already ship. */
const CHIP_GUESS_LABEL: Record<RoomGuessType, string> = {
  anime: 'Guess the Anime',
  song: 'Guess the Song',
  artist: 'Guess the Artist',
};

/** The question prompt per guess type — the solo question
 * screen's QUESTION_PROMPT wording, mapped onto the room's
 * guess-type vocabulary (solo's 'title' is the room's 'song'). */
const QUESTION_PROMPT: Record<RoomGuessType, string> = {
  anime: 'Which anime is this theme from?',
  song: 'What is the name of this song?',
  artist: 'Who performs this theme?',
};

/**
 * Room screen (Slice M4) — lobby, game and results for one
 * multiplayer room, driven by the gateway's broadcasts with
 * `room:subscribe` as the resync primitive (mount, reconnect, and
 * any event that doesn't carry full state). The phases:
 *
 * - waiting: the Quiz Room Lobby design — ✕/Leave header, the
 *   centred code card with Invite (share sheet), the settings
 *   chip summary, player cards with rank sublines and
 *   HOST/Ready/Not-ready pills, and the footer whose single
 *   button is the guest's Ready toggle or, once the host has
 *   readied (the server requires the host ready too), the
 *   host's Start (duels auto-start on both-ready — server
 *   behaviour, the round-started broadcast just arrives).
 *   Room settings are chosen on the Create Room screen; the
 *   Slice 6 in-lobby settings editor no longer ships here
 *   (room:update-settings itself is untouched server-side);
 * - playing: the Quiz Room in-game design — ✕ / Room-code /
 *   Round top row, the players strip card (answered badges +
 *   waiting caption), the big countdown ring derived from the
 *   server's startedAt (the server owns the round timer) over
 *   the hidden audio (QuizAudioOnly — audio-only per the
 *   owner's ruling; no media card), the per-type question, the
 *   answer cards with lock-in on answer, and the Live
 *   standings card (top 3 + the viewer's own row when they sit
 *   outside it). Each round OPENS with the owner's pre-round
 *   countdown (2026-11-10): the broadcast's startedAt sits
 *   ROUND_COUNTDOWN_SECONDS in the future, so the screen first
 *   shows a big 5→1 count while the round's audio loads HELD in
 *   the background (QuizAudioOnly's playAtMs); at 0 the audio
 *   starts and the ring + answer window open together — the
 *   server refuses answers before startedAt, so the countdown
 *   is inside nobody's window. The design's hint line under the question
 *   ("Opening Theme 1 • Released 1995") is NOT drawn: the
 *   round-started payload carries no theme type, sequence or
 *   year, and nothing else in the round state identifies the
 *   theme — inventing it is not an option;
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
  const [mediaMissing, setMediaMissing] = useState(false);
  /** Playback state of the round's hidden audio (QuizAudioOnly
   * reports it) — drives the question phase's ring glyph and
   * "Playing…" pill text, the solo screen's pattern. */
  const [roomAudio, setRoomAudio] = useState<QuizAudioState>({
    phase: 'buffering',
    muted: false,
    toggleMute: () => undefined,
  });
  const handleRoomAudioState = useCallback((state: QuizAudioState) => {
    setRoomAudio(state);
  }, []);
  /**
   * Waiting-roster rank standings for the design's "Chunin ·
   * 1,270 RP" player sublines (Slice 6) — GET /rank/players,
   * read-only; the room payload itself carries no tier/RP.
   */
  const [playerRanks, setPlayerRanks] = useState<
    Record<string, PlayerRankSummary>
  >({});

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
              countdownSeconds: ROUND_COUNTDOWN_SECONDS,
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
          (p: {
            settings: QuizRoomSettings;
            commonPoolCount?: number | null;
          }) => {
            setRoom((r) =>
              r
                ? {
                    ...r,
                    settings: p.settings,
                    ...(typeof p.commonPoolCount === 'number'
                      ? { commonPoolCount: p.commonPoolCount }
                      : {}),
                  }
                : r,
            );
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

  const onInvite = useCallback(() => {
    if (!room) return;
    // The design's code card carries an "Invite friends" share
    // action (Slice 6) — the system share sheet, carrying the
    // code. (The pre-fidelity build copied the code instead.)
    void Share.share({
      message: `Join my Kaikansen quiz room! Room code: ${room.roomCode}`,
    }).catch(() => undefined);
  }, [room]);

  const onAnswer = useCallback(
    (option: string) => {
      if (!liveRound || myAnswer !== null || roundEnded) return;
      // Pre-round countdown (owner, 2026-11-10): the answer
      // window opens at the server's startedAt — taps before it
      // are ignored here and refused by the server besides.
      if (Date.parse(liveRound.startedAt) > Date.now()) return;
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

  // Waiting-roster rank sublines (Slice 6): one batched read-only
  // fetch whenever the waiting membership changes; failures leave
  // the sublines empty rather than inventing standings.
  const waitingIds =
    phase === 'waiting' && room
      ? room.players.map((p) => p.userId).join(',')
      : '';
  useEffect(() => {
    if (!waitingIds) return;
    let live = true;
    fetchPlayerRanks(waitingIds.split(','))
      .then((map) => {
        if (live) setPlayerRanks(Object.fromEntries(map));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [waitingIds]);

  const deadlineMs = liveRound
    ? Date.parse(liveRound.startedAt) + liveRound.timeLimitSeconds * 1000
    : 0;

  // Pre-round countdown display (owner design, 2026-11-10):
  // whole seconds until the server's startedAt — derived from
  // that one timestamp, so every client in the room counts the
  // same countdown. 0 once the answer window is open.
  const [countdownLeft, setCountdownLeft] = useState(0);
  useEffect(() => {
    if (!liveRound) {
      setCountdownLeft(0);
      return;
    }
    const opensAt = Date.parse(liveRound.startedAt);
    const update = () => {
      const left = countdownSecondsLeft(opensAt, Date.now());
      setCountdownLeft(left);
      return left;
    };
    if (update() <= 0) return;
    const id = setInterval(() => {
      if (update() <= 0) clearInterval(id);
    }, 200);
    return () => clearInterval(id);
  }, [liveRound]);
  const inCountdown = countdownLeft > 0;

  // Owner rulings: quiz questions are AUDIO-ONLY (2026-11-09 — the
  // theme's video gives the anime away on sight, so no candidate is
  // ever rendered), and the audio plays the .ogg first with the
  // video file as the audio-only last resort (2026-11-10) — the
  // ordered candidate list tries each in turn, and the round only
  // reports no playable media after all of them fail.
  const roundAudioCandidates = liveRound
    ? quizAudioCandidates(
        liveRound.theme.videoUrl,
        liveRound.theme.mediaCandidates,
      )
    : [];

  const startHint = (() => {
    if (!room || phase !== 'waiting') return null;
    // Common-pool eligibility (owner spec, 2026-11-10): the
    // shared-theme count must cover the rounds; the server
    // refuses the start too — this hint is the honest preview.
    if (
      room.settings.poolMode === 'common' &&
      typeof room.commonPoolCount === 'number' &&
      room.commonPoolCount < room.settings.roundCount
    ) {
      return `Not enough common themes: you share ${room.commonPoolCount} theme${room.commonPoolCount === 1 ? '' : 's'} for ${room.settings.roundCount} rounds. Players with no AniList lists or listening history share nothing — add overlapping anime or pick fewer rounds.`;
    }
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
    const standing = playerRanks[player.userId];
    return (
      <View key={player.userId} style={styles.playerRow}>
        <Avatar
          url={player.avatar}
          name={player.username}
          seed={player.userId}
          size={38}
        />
        <View style={styles.playerMain}>
          <View style={styles.playerNameRow}>
            <Text style={styles.playerName} numberOfLines={1}>
              {player.username}
            </Text>
            {host && phase !== 'waiting' && (
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
            // The design's waiting subline is the player's rank
            // standing ("Chunin · 1,270 RP"); readiness moved to
            // the right-side pills below (Slice 6).
            standing ? (
              <Text style={styles.playerSub}>
                {standing.tier.charAt(0).toUpperCase() +
                  standing.tier.slice(1)}{' '}
                · {standing.rp.toLocaleString()} RP
              </Text>
            ) : null
          ) : (
            <Text style={styles.playerSub}>{player.totalScore} pts</Text>
          )}
        </View>
        {phase === 'waiting' ? (
          host ? (
            <View style={styles.hostPill}>
              <Text style={styles.hostPillText}>HOST</Text>
            </View>
          ) : player.ready ? (
            <View style={styles.readyPill}>
              <Check size={11} color={theme.success} strokeWidth={3} />
              <Text style={styles.readyPillText}>Ready</Text>
            </View>
          ) : (
            <Text style={styles.notReadyText}>Not ready</Text>
          )
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

  /**
   * Waiting-lobby player card (Quiz Room design): the shared
   * Avatar at the mock's 40px, username, the rank subline from
   * the GET /rank/players standings (absent until they land —
   * never invented), and the HOST / Ready / Not-ready pill.
   * Separate from playerRow above, which the reveal scoreboard
   * still uses unchanged.
   */
  const waitingPlayerRow = (player: QuizRoomPlayer) => {
    const host = room?.hostId === player.userId;
    const standing = playerRanks[player.userId];
    return (
      <View key={player.userId} style={styles.waitPlayerCard}>
        <Avatar
          url={player.avatar}
          name={player.username}
          size={40}
          seed={player.userId}
        />
        <View style={styles.playerMain}>
          <Text style={styles.waitPlayerName} numberOfLines={1}>
            {player.username}
          </Text>
          {standing ? (
            <Text style={styles.waitPlayerSub}>
              {standing.tier.charAt(0).toUpperCase() +
                standing.tier.slice(1)}{' '}
              · {standing.rp.toLocaleString()} RP
            </Text>
          ) : null}
        </View>
        {host ? (
          <View style={styles.waitHostPill}>
            <Text style={styles.waitHostPillText}>HOST</Text>
          </View>
        ) : player.ready ? (
          <View style={styles.waitReadyPill}>
            <Check size={15} color={theme.success} strokeWidth={2.5} />
            <Text style={styles.waitReadyPillText}>Ready</Text>
          </View>
        ) : (
          <View style={styles.waitNotReadyPill}>
            <Text style={styles.waitNotReadyPillText}>Not ready</Text>
          </View>
        )}
      </View>
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

  /**
   * Waiting-lobby header (Quiz Room design): plain ✕ at the
   * left, centred "Room", and a "Leave" text action at the
   * right. Both controls run the existing explicit leave —
   * identical semantics, the design simply draws both. The
   * shared header above still serves every other phase and
   * the loading/fatal/closed states.
   */
  const waitingHeader = (
    <View style={styles.waitHeader}>
      <View style={styles.waitHeaderSide}>
        <Pressable
          onPress={leaveExplicitly}
          accessibilityRole="button"
          accessibilityLabel="Leave room"
          style={({ pressed }) => [
            styles.waitCloseHit,
            pressed && styles.pressed,
          ]}
        >
          <X size={22} color={theme.accent} strokeWidth={2} />
        </Pressable>
      </View>
      <Text style={styles.waitHeaderTitle}>Room</Text>
      <View style={[styles.waitHeaderSide, styles.waitHeaderSideEnd]}>
        <Pressable
          onPress={leaveExplicitly}
          accessibilityRole="button"
          accessibilityLabel="Leave room"
          style={({ pressed }) => [
            styles.waitLeaveHit,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.waitLeaveText}>Leave</Text>
        </Pressable>
      </View>
    </View>
  );

  /**
   * In-game top row (Quiz Room in-game design): a plain ✕ in a
   * white disc — the leave control, running the existing
   * explicit leave — the centred room pill (its dot follows
   * the real connection state), and the round pill. The shared
   * header still serves the reveal/ended phases and the
   * loading/fatal/closed states.
   */
  const playingHeader = (
    <View style={styles.playHeader}>
      <Pressable
        onPress={leaveExplicitly}
        accessibilityRole="button"
        accessibilityLabel="Leave room"
        style={({ pressed }) => [
          styles.playCloseDisc,
          pressed && styles.pressed,
        ]}
      >
        <X size={18} color={theme.accent} strokeWidth={2} />
      </Pressable>
      <View style={styles.playRoomPill}>
        <View
          style={[
            styles.playRoomDot,
            connStatus !== 'connected' && styles.playRoomDotOff,
          ]}
        />
        <Text style={styles.playRoomText}>Room {room.roomCode}</Text>
      </View>
      <View style={styles.playRoundPill}>
        <Music size={14} color={theme.secondary} strokeWidth={2} />
        <Text style={styles.playRoundText}>
          Round {liveRound?.round ?? room.currentRound}/
          {room.settings.roundCount}
        </Text>
      </View>
    </View>
  );

  // The standings card shows the mock's top 3; a viewer ranked
  // below that keeps their own row appended (highlighted), so
  // nobody loses sight of their own score mid-game.
  const topStandings = standings.slice(0, 3);
  const myStandingIndex = standings.findIndex((p) => p.userId === myId);
  const myStandingRow =
    myStandingIndex >= 3 ? standings[myStandingIndex] : null;

  // The strip caption names whoever has not locked in yet.
  const pendingPlayers = room.players.filter(
    (p) => !answeredUsers.has(p.userId),
  );

  // The Playing pill reports the hidden audio's real phase;
  // its playing text follows the room's guess type (the solo
  // screen's sentence pattern).
  const playingPillText = mediaMissing
    ? 'Rejoined mid-round — no media'
    : roomAudio.phase === 'failed'
      ? 'This theme could not be played'
      : roomAudio.phase === 'empty'
        ? 'No playable media for this theme'
        : roomAudio.phase === 'buffering'
          ? 'Loading the theme…'
          : `Playing... ${GUESS_LABEL[room.settings.guessType].toLowerCase()}!`;

  // Players-header state line (Quiz Room design), derived from
  // the real roster: not full / full but not all ready / full
  // and everyone ready.
  const playersStateLine =
    room.players.length < room.settings.maxPlayers
      ? 'Waiting for more players…'
      : room.players.every((p) => p.ready)
        ? "Everyone's ready!"
        : 'Room full — waiting on Ready';

  // Footer primary action (waiting phase). The design draws ONE
  // full-width button: the host's "Start Game". Server parity
  // requires the host to be ready before start (startGame checks
  // every player, host included), so an unreadied host's button
  // is their Ready toggle and it becomes Start once they ready;
  // a guest's button is their Ready toggle throughout.
  const showStart = isHost && (me?.ready ?? false);
  const footerBusyLabel =
    busy === 'start' ? 'Starting…' : busy === 'ready' ? 'Working…' : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.column}>
        {phase === 'waiting'
          ? waitingHeader
          : phase === 'playing'
            ? playingHeader
            : header}
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
            <View style={styles.waitWrap}>
              {/* Room code card (Quiz Room design): centred label,
                  the code in the large display face, and the
                  Invite pill — the OS share sheet carrying the
                  code (onInvite); there is no in-app invite
                  system to wire it to. */}
              <View style={styles.codeCard}>
                <Text style={styles.codeLabel}>ROOM CODE</Text>
                <Text style={styles.codeValue} selectable>
                  {room.roomCode}
                </Text>
                <Pressable
                  onPress={onInvite}
                  accessibilityRole="button"
                  accessibilityLabel="Invite friends"
                  style={({ pressed }) => [
                    styles.inviteButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Share2 size={17} color={theme.accent} strokeWidth={2} />
                  <Text style={styles.inviteText}>Invite friends</Text>
                </Pressable>
              </View>
              {/* Settings summary chips — the room's real
                  configuration, centred and wrapping. */}
              <View style={styles.chipsRow}>
                {[
                  room.roomType === 'duel' ? 'Duel' : 'Party',
                  CHIP_GUESS_LABEL[room.settings.guessType],
                  POOL_LABEL[room.settings.poolMode],
                  `${room.settings.roundCount} rounds`,
                  `${room.settings.timeLimitSeconds}s`,
                ].map((label) => (
                  <View key={label} style={styles.outlineChip}>
                    <Text style={styles.outlineChipText}>{label}</Text>
                  </View>
                ))}
              </View>
              {/* Common-pool count (owner spec, 2026-11-10):
                  the server-computed number of themes every
                  player here shares; below the round count the
                  game cannot start (see the footer hint). */}
              {room.settings.poolMode === 'common' &&
                typeof room.commonPoolCount === 'number' && (
                  <Text style={styles.commonPoolLine}>
                    {room.commonPoolCount >= room.settings.roundCount
                      ? `Common pool: ${room.commonPoolCount} shared themes — enough for ${room.settings.roundCount} rounds.`
                      : `Common pool: ${room.commonPoolCount} shared themes for ${room.settings.roundCount} rounds.`}
                  </Text>
                )}
              <View style={styles.playersHead}>
                <Text style={styles.playersTitle}>
                  Players ({room.players.length}/{room.settings.maxPlayers})
                </Text>
                <Text style={styles.playersState}>{playersStateLine}</Text>
              </View>
              <View style={styles.playerCards}>
                {room.players.map((p) => waitingPlayerRow(p))}
              </View>
            </View>
          )}

          {phase === 'playing' && liveRound && (
            <>
              {/* Hidden audio only (owner ruling): the clip
                  plays behind no surface at all — the ring and
                  the Playing pill below report its state. During
                  the pre-round countdown it LOADS but is held
                  (playAtMs = the server's startedAt) so the whole
                  room hears it start at 0 together. */}
              <QuizAudioOnly
                candidates={roundAudioCandidates}
                mediaKey={`${roomId}:${liveRound.round}`}
                onStateChange={handleRoomAudioState}
                playAtMs={Date.parse(liveRound.startedAt)}
              />
              {/* Players strip card (Quiz Room in-game design):
                  Avatar + answered badge + name per player, with
                  the waiting caption inside the card. The strip
                  scrolls sideways when the roster outgrows the
                  card (a party seats up to 4); at the mock's
                  four players it spreads across the card. */}
              <View style={styles.stripCard}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.stripRowInner}
                >
                  {room.players.map((p) => {
                    const answered = answeredUsers.has(p.userId);
                    const isMePlayer = p.userId === myId;
                    return (
                      <View key={p.userId} style={styles.stripItem}>
                        <View>
                          <Avatar
                            url={p.avatar}
                            name={p.username}
                            size={40}
                            seed={p.userId}
                          />
                          <View
                            style={[
                              styles.stripBadge,
                              answered && styles.stripBadgeOn,
                            ]}
                          >
                            {answered ? (
                              <Check
                                size={11}
                                color={theme.success}
                                strokeWidth={3}
                              />
                            ) : (
                              <Hourglass
                                size={11}
                                color={theme.secondary}
                                strokeWidth={2.5}
                              />
                            )}
                          </View>
                        </View>
                        <Text
                          style={[
                            styles.stripName,
                            isMePlayer && styles.stripNameMe,
                            !answered &&
                              !isMePlayer &&
                              styles.stripNamePending,
                          ]}
                          numberOfLines={1}
                        >
                          {p.username}
                          {isMePlayer ? ' (You)' : ''}
                        </Text>
                      </View>
                    );
                  })}
                </ScrollView>
                <View style={styles.stripCaption}>
                  <View style={styles.stripCaptionDot} />
                  <Text style={styles.stripCaptionText}>
                    {pendingPlayers.length > 0
                      ? `Waiting for ${pendingPlayers
                          .map((p) => p.username)
                          .join(', ')}...`
                      : 'Everyone has answered'}
                  </Text>
                </View>
              </View>
              {mediaMissing && (
                <View style={styles.mediaMissingCard}>
                  <Text style={styles.mediaMissingText}>
                    You rejoined mid-round — this round's media isn't
                    available, but you can still answer.
                  </Text>
                </View>
              )}
              {/* Countdown ring + Playing pill: during the
                  pre-round countdown a big 5→1 number stands
                  where the ring will be (the audio is loading
                  held behind it); from 0 the ring shows the
                  round's real remaining time (the server's
                  startedAt + limit, as before) and the pill
                  reports the hidden audio's phase. The mute
                  toggle sits at the ring's lower-right — the
                  solo screen's placement; the mock draws none,
                  but muting the clip is an existing capability
                  this phase keeps (flagged in the slice report). */}
              <View style={styles.ringBlock}>
                {inCountdown ? (
                  <View style={styles.countdownWrap}>
                    <Text style={styles.countdownNumber}>
                      {countdownLeft}
                    </Text>
                    <Text style={styles.countdownCaption}>
                      Get ready
                    </Text>
                  </View>
                ) : (
                <View style={styles.ringWrap}>
                  <CountdownRing
                    variant="room"
                    deadlineMs={deadlineMs}
                    totalSeconds={liveRound.timeLimitSeconds}
                    size={112}
                    glyph={
                      roomAudio.phase === 'buffering' ? (
                        <ActivityIndicator color={theme.accent} />
                      ) : (
                        <AudioWaveform
                          size={15}
                          color={theme.secondary}
                          strokeWidth={2}
                        />
                      )
                    }
                    caption="seconds"
                  />
                  {roomAudio.phase !== 'failed' &&
                    roomAudio.phase !== 'empty' && (
                      <Pressable
                        onPress={roomAudio.toggleMute}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={
                          roomAudio.muted
                            ? 'Unmute theme'
                            : 'Mute theme'
                        }
                        style={styles.ringMute}
                      >
                        {roomAudio.muted ? (
                          <VolumeX
                            size={17}
                            color={theme.text}
                            strokeWidth={2}
                          />
                        ) : (
                          <Volume2
                            size={17}
                            color={theme.text}
                            strokeWidth={2}
                          />
                        )}
                      </Pressable>
                    )}
                </View>
                )}
                <View style={styles.playingPill}>
                  <View style={styles.waveBars}>
                    <View style={[styles.waveBar, styles.waveBarA]} />
                    <View style={[styles.waveBar, styles.waveBarB]} />
                    <View style={[styles.waveBar, styles.waveBarC]} />
                  </View>
                  <Text style={styles.playingPillText}>
                    {playingPillText}
                  </Text>
                </View>
              </View>
              {/* The question. The design's hint line under it
                  (theme type • release year) is omitted: the
                  round payload carries neither (see the header
                  comment) — flagged, never invented. */}
              <Text style={styles.questionText}>
                {QUESTION_PROMPT[room.settings.guessType]}
              </Text>
              <QuizOptions
                variant="room"
                options={liveRound.theme.options}
                onSelect={onAnswer}
                disabled={myAnswer !== null || inCountdown}
                selected={myAnswer}
              />
              {/* The mock's submitted state carries no result
                  line — myResult still arrives on
                  room:player-answered and the reveal phase
                  reports it in full; the standings below land
                  the points at round end, as before. */}
              {/* Live standings (Quiz Room in-game design):
                  match points only — no RP suffix (RP is
                  rank, awarded at game end). The sync label
                  follows the real socket status: it only
                  claims "Sync active" while connected. */}
              <View style={styles.liveCard}>
                <View style={styles.liveHead}>
                  <Text style={styles.liveTitle}>Live standings</Text>
                  <View style={styles.liveSync}>
                    <View
                      style={[
                        styles.liveSyncDot,
                        connStatus !== 'connected' &&
                          styles.liveSyncDotOff,
                      ]}
                    />
                    <Text
                      style={[
                        styles.liveSyncText,
                        connStatus !== 'connected' &&
                          styles.liveSyncTextOff,
                      ]}
                    >
                      {connStatus === 'connected'
                        ? 'Sync active'
                        : 'Reconnecting…'}
                    </Text>
                  </View>
                </View>
                <View style={styles.liveRows}>
                  {[
                    ...topStandings.map((p, i) => ({
                      p,
                      place: i + 1,
                    })),
                    ...(myStandingRow
                      ? [{ p: myStandingRow, place: myStandingIndex + 1 }]
                      : []),
                  ].map(({ p, place }) => {
                    const isMeRow = p.userId === myId;
                    return (
                      <View
                        key={p.userId}
                        style={[
                          styles.liveRow,
                          isMeRow && styles.liveRowMe,
                        ]}
                      >
                        <View style={styles.liveRowLeft}>
                          <Text
                            style={[
                              styles.livePlace,
                              isMeRow && styles.livePlaceMe,
                            ]}
                          >
                            {place}
                          </Text>
                          <Text
                            style={[
                              styles.liveName,
                              place !== 1 &&
                                !isMeRow &&
                                styles.liveNameMuted,
                              isMeRow && styles.liveNameMe,
                            ]}
                            numberOfLines={1}
                          >
                            {p.username}
                          </Text>
                          {isMeRow && (
                            <View style={styles.liveYouPill}>
                              <Text style={styles.liveYouText}>YOU</Text>
                            </View>
                          )}
                        </View>
                        <Text
                          style={[
                            styles.liveScore,
                            (place === 1 || isMeRow) &&
                              styles.liveScoreAccent,
                          ]}
                        >
                          {p.totalScore.toLocaleString()}
                        </Text>
                      </View>
                    );
                  })}
                </View>
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
                      <Avatar
                        url={p.avatar}
                        name={p.username}
                        seed={p.userId}
                        size={38}
                      />
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

          {/* The waiting phase leaves through its header (✕ /
              Leave) and footer instead, and the playing phase
              through its top-row ✕ — neither design draws a
              bottom leave row. The reveal phase keeps this
              leave row. */}
          {phase !== 'ended' &&
            phase !== 'waiting' &&
            phase !== 'playing' && (
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
        </ScrollView>
        {phase === 'waiting' && (
          <View style={styles.waitFooter}>
            <Text style={styles.waitFooterLine}>
              Only the host can start. Everyone else taps Ready.
            </Text>
            {showStart ? (
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
                  styles.waitPrimary,
                  (busy !== null || startHint !== null) &&
                    styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.waitPrimaryText}>
                  {footerBusyLabel ?? 'Start Game'}
                </Text>
                <ArrowRight size={20} color={theme.onAccent} strokeWidth={2} />
              </Pressable>
            ) : (
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
                  styles.waitPrimary,
                  pressed && styles.pressed,
                ]}
              >
                {me?.ready && !footerBusyLabel ? (
                  <Check size={18} color={theme.onAccent} strokeWidth={2.5} />
                ) : null}
                <Text style={styles.waitPrimaryText}>
                  {footerBusyLabel ??
                    (me?.ready ? 'Ready — tap to cancel' : 'Ready up')}
                </Text>
              </Pressable>
            )}
            {startHint && (
              <Text style={styles.waitFooterHint}>{startHint}</Text>
            )}
          </View>
        )}
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
    summaryChips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    summaryChip: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 4,
    },
    summaryChipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    hostPill: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 3,
    },
    hostPillText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.8,
      color: theme.onAccentContainer,
    },
    readyPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: theme.successContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 3,
    },
    readyPillText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.success,
    },
    notReadyText: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    /* Playing phase (Quiz Room in-game design) — 16px card
     * radius, 40px strip avatars with 16px status badges, the
     * 112px ring, and the compact standings rows. */
    stripCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      gap: 6,
    },
    stripRowInner: {
      flexGrow: 1,
      justifyContent: 'space-around',
      gap: spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    stripItem: {
      alignItems: 'center',
      gap: spacing.xs,
      width: 64,
    },
    stripBadge: {
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: theme.raised,
      borderWidth: 1,
      borderColor: theme.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stripBadgeOn: {
      backgroundColor: theme.successContainer,
    },
    stripName: {
      fontFamily: fontFamilies.sectionLabel,
      fontSize: 10,
      color: theme.muted,
      textAlign: 'center',
    },
    stripNameMe: {
      color: theme.accent,
    },
    stripNamePending: {
      color: theme.secondary,
    },
    stripCaption: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingTop: 2,
    },
    stripCaptionDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.secondary,
    },
    stripCaptionText: {
      ...typeStyles.caption,
      color: theme.secondary,
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
    /* Waiting lobby (Quiz Room design) — this screen's HTML
     * measures a 20px canvas edge (the other phases keep the
     * shared 16px content edge), 16px code-card radius, 12px
     * player-card radius, and full-pill footer button. */
    waitHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    waitHeaderSide: {
      width: 64,
      alignItems: 'flex-start',
    },
    waitHeaderSideEnd: {
      alignItems: 'flex-end',
    },
    waitCloseHit: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    waitHeaderTitle: {
      flex: 1,
      textAlign: 'center',
      fontFamily: fontFamilies.display,
      fontSize: 17,
      color: theme.text,
    },
    waitLeaveHit: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
    },
    waitLeaveText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
      color: theme.secondary,
    },
    waitWrap: {
      gap: spacing.md,
      paddingHorizontal: spacing.xs,
    },
    codeCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      padding: spacing.xl,
      alignItems: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    codeLabel: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      letterSpacing: 1.1,
      color: theme.secondary,
      marginBottom: spacing.xs,
    },
    codeValue: {
      fontFamily: fontFamilies.display,
      fontSize: 36,
      letterSpacing: 3.6,
      color: theme.text,
      marginVertical: spacing.xs,
    },
    inviteButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      marginTop: 14,
    },
    inviteText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      color: theme.accent,
    },
    chipsRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: spacing.xs,
      marginBottom: spacing.xs,
    },
    outlineChip: {
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.pill,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    outlineChipText: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.accent,
    },
    commonPoolLine: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.muted,
      textAlign: 'center',
      paddingHorizontal: spacing.md,
    },
    playersHead: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xs,
      marginBottom: -2,
    },
    playersTitle: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 16,
      color: theme.text,
    },
    playersState: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.secondary,
    },
    playerCards: {
      gap: 10,
    },
    waitPlayerCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.base,
      padding: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    waitPlayerName: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
      color: theme.text,
    },
    waitPlayerSub: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.secondary,
      marginTop: 2,
    },
    waitHostPill: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    waitHostPillText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      letterSpacing: 0.3,
      color: theme.onAccent,
    },
    waitReadyPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: theme.successContainer,
      borderRadius: radii.pill,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    waitReadyPillText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      color: theme.success,
    },
    waitNotReadyPill: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    waitNotReadyPillText: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.secondary,
    },
    waitFooter: {
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.md,
      paddingBottom: spacing.xl,
      backgroundColor: theme.background,
    },
    waitFooterLine: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.secondary,
      textAlign: 'center',
      marginBottom: 10,
    },
    waitPrimary: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingVertical: 14,
      paddingHorizontal: spacing.lg,
    },
    waitPrimaryText: {
      fontFamily: fontFamilies.display,
      fontSize: 16,
      color: theme.onAccent,
    },
    waitFooterHint: {
      fontFamily: fontFamilies.caption,
      fontSize: 11,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.sm,
    },
    /* In-game top row (Quiz Room in-game design). */
    playHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    playCloseDisc: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playRoomPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: theme.raised,
      borderWidth: 1,
      borderColor: withOpacity(theme.accent, 0.15),
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
    },
    playRoomDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.success,
    },
    playRoomDotOff: {
      backgroundColor: theme.muted,
    },
    playRoomText: {
      ...typeStyles.mono,
      fontSize: 11,
      letterSpacing: 0.5,
      color: theme.accent,
    },
    playRoundPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
    },
    playRoundText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      color: theme.accent,
    },
    /* Ring + Playing pill block. */
    ringBlock: {
      alignItems: 'center',
      paddingVertical: spacing.xs,
    },
    ringWrap: {
      position: 'relative',
    },
    /* Pre-round countdown (owner, 2026-11-10): the big number
       stands in the ring's footprint while the audio preloads. */
    countdownWrap: {
      height: 112,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countdownNumber: {
      fontFamily: fontFamilies.display,
      fontSize: 64,
      lineHeight: 68,
      color: theme.accent,
    },
    countdownCaption: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 10,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: theme.secondary,
      marginTop: 2,
    },
    ringMute: {
      position: 'absolute',
      right: 2,
      bottom: 2,
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playingPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: withOpacity(theme.surface, 0.7),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
      marginTop: spacing.sm,
    },
    waveBars: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 2,
      height: 12,
    },
    waveBar: {
      width: 2,
      borderRadius: 1,
      backgroundColor: theme.accent,
    },
    waveBarA: {
      height: 5,
    },
    waveBarB: {
      height: 11,
    },
    waveBarC: {
      height: 7,
    },
    playingPillText: {
      ...typeStyles.caption,
      color: theme.text,
    },
    questionText: {
      fontFamily: fontFamilies.display,
      fontSize: 22,
      lineHeight: 30,
      letterSpacing: -0.3,
      color: theme.text,
      textAlign: 'center',
      paddingHorizontal: spacing.sm,
    },
    /* Live standings card (Quiz Room in-game design). */
    liveCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: 10,
    },
    liveHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xs,
      marginBottom: 6,
    },
    liveTitle: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 10,
      letterSpacing: 1.5,
      textTransform: 'uppercase',
      color: theme.secondary,
    },
    liveSync: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    liveSyncDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.success,
    },
    liveSyncDotOff: {
      backgroundColor: theme.muted,
    },
    liveSyncText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 10,
      color: theme.success,
    },
    liveSyncTextOff: {
      color: theme.muted,
    },
    liveRows: {
      gap: spacing.xs,
    },
    liveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radii.sm,
    },
    liveRowMe: {
      backgroundColor: theme.accentContainer,
      borderWidth: 1,
      borderColor: withOpacity(theme.accent, 0.15),
    },
    liveRowLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flex: 1,
    },
    livePlace: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      color: theme.secondary,
      width: 16,
      textAlign: 'center',
    },
    livePlaceMe: {
      color: theme.accent,
    },
    liveName: {
      fontFamily: fontFamilies.caption,
      fontSize: 13,
      color: theme.text,
      flexShrink: 1,
    },
    liveNameMuted: {
      color: theme.muted,
    },
    liveNameMe: {
      fontFamily: fontFamilies.bodyStrong,
    },
    liveYouPill: {
      backgroundColor: theme.accent,
      borderRadius: radii.pill,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    liveYouText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 9,
      letterSpacing: 0.3,
      color: theme.onAccent,
    },
    liveScore: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 11,
      color: theme.muted,
    },
    liveScoreAccent: {
      color: theme.accent,
    },
    pressed: {
      opacity: 0.85,
    },
  });

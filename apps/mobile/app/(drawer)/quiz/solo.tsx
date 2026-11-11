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
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppImage } from '../../../src/components/AppImage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Check,
  ChevronRight,
  Flame,
  Hourglass,
  Music2,
  RotateCcw,
  SkipForward,
  Trophy,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react-native';
import type {
  QuizGuessType,
  QuizSource,
  SoloAnswerResponse,
  SoloQuestion,
  UserRankProfile,
} from '@kaikansen/contracts';
import { ApiRequestError } from '../../../src/api';
import { warmAudioEngine } from '../../../src/audioEngine';
import {
  resolveSoloNextPreload,
  soloClockStartsOnPhase,
  soloLoadSafetyMs,
} from '../../../src/mediaEngine';
import {
  clearQuizSlices,
  getQuizSliceUri,
  pinQuizSlice,
  quizSliceCandidates,
} from '../../../src/quizPrefetch';
import {
  createSoloGame,
  markSoloPlaybackStarted,
  submitSoloAnswer,
} from '../../../src/quizApi';
import { fetchMyRank } from '../../../src/socialApi';
import { RankResultCard } from '../../../src/components/RankCard';
import { CountdownRing } from '../../../src/components/CountdownRing';
import { QuizGenerating } from '../../../src/components/QuizGenerating';
import { GENERATING_MIN_DISPLAY_MS } from '../../../src/quizGenerating';
import {
  QuizAudioOnly,
  type QuizAudioState,
} from '../../../src/components/QuizMedia';
import { QuizOptions } from '../../../src/components/QuizOptions';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type Phase = 'creating' | 'question' | 'feedback' | 'over' | 'fatal';

const FEEDBACK_MS = 2800;

/**
 * Anti-hang safety for the playback-start clock (below; v2 —
 * the clock obeys the song): the clock starts on the media
 * phase — playing, or the failed / empty verdict
 * (mediaEngine.soloClockStartsOnPhase). The per-question safety
 * timer (mediaEngine.soloLoadSafetyMs — one full answer window)
 * is insurance only, for a media layer that never reports a
 * phase at all; the earlier blind 10s start fired mid-load on
 * slow connections and stole the window it protected, so it is
 * gone as a normal path. A question must never hang forever.
 */

/**
 * The question prompt per guess type — the Quiz Question v2 mock's
 * line for 'anime' verbatim, the other two following its pattern.
 * (The short GUESS_LABEL chips the screen used to print under the
 * media card are gone with the card: the mock shows only the
 * question, and the theme's type/sequence line gave framing away.)
 */
const QUESTION_PROMPT: Record<QuizGuessType, string> = {
  anime: 'Which anime is this theme from?',
  title: 'What is the name of this song?',
  artist: 'Who performs this theme?',
};

/** Title-case variant for the results screen's subtitle (§6.25). */
const RESULTS_GUESS_LABEL: Record<QuizGuessType, string> = {
  anime: 'Guess the Anime',
  title: 'Guess the Song',
  artist: 'Guess the Artist',
};

/**
 * Solo game (Slice M4) — a server-held 10-question game over the
 * S4 REST surface. The question phase follows the Quiz Question v2
 * design and the owner's audio-only ruling (2026-11-09): the theme
 * plays as HIDDEN .ogg audio only (QuizAudioOnly) — no video, no
 * cover, nothing that gives the anime away on sight — under a big
 * countdown ring, while a LOCAL 20s countdown drives the ring's
 * display (the server measures and scores authoritatively), and
 * the chosen option is sent verbatim — or null on timeout/skip.
 * BOTH clocks start when the audio ACTUALLY starts playing, not
 * when the question renders (owner timing fix, 2026-11-10 — the
 * load used to eat the window on both clocks): the ring holds
 * full while the hidden audio loads, the screen signals the
 * moment playback begins (or the media proves unplayable) via
 * POST …/playback-started, and the server measures from the
 * draw plus the credited load, capped server-side. (v2,
 * 2026-11-11: the blind 10s safety start was removed — the
 * clock starts ONLY through that path, at playback or at the
 * media verdict; an anti-hang timer of one full answer window
 * remains solely for a media layer that never reports a phase
 * at all, so a question can still never hang.) The answer
 * response drives the feedback state (correct option revealed,
 * points + streak), then the game auto-advances (a Next button
 * skips the wait). The end screen is the designed results screen
 * (§6.25): final score card with the run's Correct / Accuracy /
 * Best Streak stats, and the results rank card (RankResultCard)
 * showing the player's CURRENT rank state. RP is multiplayer-only
 * in this system — the API applies it solely when a multiplayer
 * room finishes (the web's rank-utils run from room routes only;
 * solo games record attempts and award no RP) — so the card is
 * fed by /rank/me, no gainedRp is passed, and its "+N RP" award
 * pill stays hidden on solo by design (owner ruling, reaffirmed
 * 2026-11-09). The "saved to your history" footer is literal:
 * the API persists one QuizAttempt per solo answer, exactly as
 * the web's submit stores it. The results screen replaces the
 * whole play layout — the question header is not rendered over
 * it (the Quiz Results mock opens on the trophy disc).
 *
 * Errors are never swallowed: a failed create lands on a retry
 * screen; a failed answer keeps the live question with the error
 * shown and the pick retryable; a 400/404 from the answer call
 * means the server-side game is gone (session expiry) and is
 * reported as such, with Play again as the way out.
 */
export default function SoloQuizScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ quizType?: string; source?: string }>();
  const quizType: QuizGuessType =
    params.quizType === 'title' || params.quizType === 'artist'
      ? params.quizType
      : 'anime';
  const source: QuizSource =
    params.source === 'anilist' || params.source === 'listened'
      ? params.source
      : 'random';

  const [phase, setPhase] = useState<Phase>('creating');
  const [runId, setRunId] = useState(0);
  const [gameId, setGameId] = useState<string | null>(null);
  const [totalQuestions, setTotalQuestions] = useState(10);
  const [timeLimit, setTimeLimit] = useState(20);
  const [question, setQuestion] = useState<SoloQuestion | null>(null);
  const [deadlineMs, setDeadlineMs] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SoloAnswerResponse | null>(null);
  const [totalScore, setTotalScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [maxStreak, setMaxStreak] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fatalMessage, setFatalMessage] = useState<string | null>(null);
  const [rankProfile, setRankProfile] = useState<UserRankProfile | null>(
    null,
  );
  const [rankLoading, setRankLoading] = useState(false);
  // Earlier reveal (part 5, 2026-11-11): the playback-start
  // signal's response can carry the NEXT question's audio URL a
  // whole question before the answer response would. Held as
  // {index, audioUrl} and consumed by resolveSoloNextPreload
  // below; null whenever the API is older, the question is the
  // last, or the next theme has no resolvable audio.
  const [earlyNext, setEarlyNext] = useState<{
    index: number;
    audioUrl: string;
  } | null>(null);
  // The hidden question audio's reported state (QuizAudioOnly):
  // drives the status line and the ring's mute toggle.
  const [audioState, setAudioState] = useState<QuizAudioState>({
    phase: 'empty',
    muted: false,
    toggleMute: () => {},
  });
  const handleAudioState = useCallback((state: QuizAudioState) => {
    setAudioState(state);
  }, []);

  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackRef = useRef<SoloAnswerResponse | null>(null);
  const advancedForRef = useRef(0);
  // Playback-start clock (owner timing fix, 2026-11-10): the
  // question index the clock has started for (0 = not yet), the
  // live game's id/limit for the signal + deadline, the safety
  // timer, and the render-visible running flag for the ring.
  const clockStartedForRef = useRef(0);
  const gameIdRef = useRef<string | null>(null);
  const limitRef = useRef(20);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [clockRunning, setClockRunning] = useState(false);
  // Part 6: the live question's candidate chain, frozen when the
  // question starts. The slice lookup happens once, at the
  // freeze; a slice that lands mid-question must not swap the
  // chain under a candidate that is already loading/playing
  // (that would restart its load) — it simply serves the NEXT
  // time this question would start, and the remote chain covers
  // this one, exactly as before slices existed.
  const chainSnapshotRef = useRef<{ key: string; list: string[] } | null>(
    null,
  );

  useEffect(() => {
    mountedRef.current = true;
    // Cold-start fix (v2): warm the audio engine on mount, so
    // the first question's load doesn't pay the native start-up
    // inside its media wait — the create-game round trip below
    // covers the cost.
    warmAudioEngine();
    return () => {
      mountedRef.current = false;
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      // Part 6 hygiene: no prefetched slice outlives the screen.
      clearQuizSlices();
    };
  }, []);

  /**
   * Start the answer clock for a question — exactly once per
   * question, at the moment the media wait ends: the deadline
   * moves to now + the limit (the ring unpauses onto it) and the
   * server is signalled so its measurement opens at the same
   * moment. Fire-and-forget: a lost signal only means the server
   * measures from the draw (the pre-fix behaviour). The signal's
   * RESPONSE is part 5's earlier reveal: when it carries the
   * next question's audio URL, that is remembered so the slice
   * prefetch (part 6) starts a whole question early — an absent
   * field (older API) or null (last question / no audio) simply
   * leaves the feedback-phase reveal as the only trigger.
   */
  const startClock = useCallback((qIndex: number) => {
    if (clockStartedForRef.current === qIndex) return;
    clockStartedForRef.current = qIndex;
    if (loadTimerRef.current) {
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
    setDeadlineMs(Date.now() + limitRef.current * 1000);
    setClockRunning(true);
    const gid = gameIdRef.current;
    if (gid) {
      void markSoloPlaybackStarted(gid)
        .then((res) => {
          if (!mountedRef.current) return;
          if (res?.nextAudioUrl) {
            setEarlyNext({
              index: qIndex + 1,
              audioUrl: res.nextAudioUrl,
            });
          }
        })
        .catch(() => {});
    }
  }, []);

  const startQuestion = useCallback(
    (q: SoloQuestion, limitSeconds: number) => {
      // Part 6: pin this question's prefetched slice — its
      // player may read the file, so the next prefetch's
      // eviction must not delete it from under the player — and
      // drop an early reveal that named this (or an older)
      // question: it has done its job.
      pinQuizSlice(`${gameIdRef.current ?? 'game'}:${q.index}`);
      setEarlyNext((e) => (e && e.index <= q.index ? null : e));
      setQuestion(q);
      setPicked(null);
      setFeedback(null);
      feedbackRef.current = null;
      setError(null);
      limitRef.current = limitSeconds;
      // Hold the clock until this question's audio starts: reset
      // the started marker, treat the media as loading again (a
      // stale 'playing' from the previous question must not
      // start this one early), and arm the anti-hang safety —
      // one full answer window, so it can only fire if the
      // media layer never reports a phase at all; playback and
      // the verdict start the clock long before it.
      clockStartedForRef.current = 0;
      setClockRunning(false);
      setAudioState((s) => ({ ...s, phase: 'buffering' }));
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      loadTimerRef.current = setTimeout(
        () => startClock(q.index),
        soloLoadSafetyMs(limitSeconds),
      );
      setDeadlineMs(Date.now() + limitSeconds * 1000);
      setPhase('question');
    },
    [startClock],
  );

  /* Create the game (and recreate on Play again via runId). */
  useEffect(() => {
    let live = true;
    let applyTimer: ReturnType<typeof setTimeout> | null = null;
    /* Generating-screen pacing (approved design cfc7c9ac): the
       creating phase now shows the designed "Setting up your
       quiz" screen, and a create that resolves near-instantly
       would flash it for a frame — so the RESULT is applied
       only once the screen has been up for
       GENERATING_MIN_DISPLAY_MS. The request itself is never
       delayed, and no game timing hangs off this: it paces the
       phase transition, nothing else. */
    const shownAt = Date.now();
    const applyResult = (fn: () => void) => {
      const wait = Math.max(
        0,
        GENERATING_MIN_DISPLAY_MS - (Date.now() - shownAt),
      );
      if (wait <= 0) {
        fn();
        return;
      }
      applyTimer = setTimeout(() => {
        if (live) fn();
      }, wait);
    };
    setPhase('creating');
    setError(null);
    feedbackRef.current = null;
    advancedForRef.current = 0;
    setTotalScore(0);
    setStreak(0);
    setMaxStreak(0);
    setCorrectCount(0);
    setRankProfile(null);
    setRankLoading(false);
    // Part 5/6 hygiene: a new game starts with no early reveal
    // and an empty prefetch cache — nothing leaks across games.
    setEarlyNext(null);
    clearQuizSlices();
    createSoloGame({ quizType, source })
      .then((state) => {
        if (!live) return;
        applyResult(() => {
          gameIdRef.current = state.gameId;
          setGameId(state.gameId);
          setTotalQuestions(state.totalQuestions);
          setTimeLimit(state.timeLimitSeconds);
          if (state.question) {
            startQuestion(state.question, state.timeLimitSeconds);
          } else {
            setFatalMessage('The game could not be started.');
            setPhase('fatal');
          }
        });
      })
      .catch((e: unknown) => {
        if (!live) return;
        applyResult(() => {
          setFatalMessage(
            e instanceof Error ? e.message : 'Could not start the game.',
          );
          setPhase('fatal');
        });
      });
    return () => {
      live = false;
      if (applyTimer) clearTimeout(applyTimer);
    };
  }, [quizType, source, runId, startQuestion]);

  /* The clock starts when the media wait ends (v2 — the clock
     obeys the song): the audio actually playing, or
     known-unplayable ('failed' / 'empty') — either way the
     question is live from that moment. While the media still
     reports 'buffering' the clock NEVER starts: the load does
     not eat the player's window (the pure rule is
     mediaEngine.soloClockStartsOnPhase). A verdict followed by
     a late start (resurrection) re-reports 'playing' — the
     clock is already running from the verdict by then, and
     startClock's once-per-question guard keeps it so. */
  useEffect(() => {
    if (phase !== 'question' || !question) return;
    if (!soloClockStartsOnPhase(audioState.phase)) return;
    startClock(question.index);
  }, [audioState.phase, phase, question, startClock]);

  const advance = useCallback(() => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
    // Idempotent per answered question: the auto-advance timer and
    // the Next button can race, and state updaters are not a safe
    // place for these side effects — the feedback lives in a ref.
    const current = feedbackRef.current;
    if (!current || advancedForRef.current === current.answeredCount) {
      return;
    }
    advancedForRef.current = current.answeredCount;
    if (current.gameOver || !current.nextQuestion) {
      setPhase('over');
      // The results rank card shows the player's CURRENT rank
      // state (see the docblock: solo runs award no RP). A failed
      // fetch simply omits the card — the score stands on its own.
      setRankLoading(true);
      void fetchMyRank()
        .then((profile) => {
          if (mountedRef.current) setRankProfile(profile);
        })
        .catch(() => {
          if (mountedRef.current) setRankProfile(null);
        })
        .finally(() => {
          if (mountedRef.current) setRankLoading(false);
        });
    } else {
      startQuestion(current.nextQuestion, timeLimit);
    }
  }, [startQuestion, timeLimit]);

  const submit = useCallback(
    async (answer: string | null) => {
      if (!gameId || !question || submittingRef.current) return;
      if (phase !== 'question') return;
      submittingRef.current = true;
      setPicked(answer);
      setError(null);
      try {
        const res = await submitSoloAnswer(gameId, answer);
        if (!mountedRef.current) return;
        feedbackRef.current = res;
        setFeedback(res);
        setTotalScore(res.totalScore);
        setStreak(res.streak);
        setMaxStreak((m) => Math.max(m, res.streak));
        setCorrectCount(res.correctCount);
        setPhase('feedback');
        advanceTimerRef.current = setTimeout(advance, FEEDBACK_MS);
      } catch (e) {
        if (!mountedRef.current) return;
        if (
          e instanceof ApiRequestError &&
          (e.status === 400 || e.status === 404)
        ) {
          // The server-side game is gone (finished elsewhere, or the
          // session expired with an API restart) — retrying the same
          // answer can never work, so say so plainly.
          setFatalMessage(
            'This game is no longer live on the server. Start a new one to keep playing.',
          );
          setPhase('fatal');
          return;
        }
        setError(
          e instanceof Error
            ? `${e.message} — tap your answer again to retry.`
            : 'The answer could not be sent — tap again to retry.',
        );
      } finally {
        submittingRef.current = false;
      }
    },
    [gameId, question, phase, advance],
  );

  const onExpire = useCallback(() => {
    void submit(null);
  }, [submit]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/quiz');
  };

  /* Header (Quiz Question v2): the ✕ in a white disc, the centred
     "Question N of M" with the progress bar under it, and the
     streak pill at the top-right once a streak is live. */
  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={goBack}
        hitSlop={3}
        accessibilityRole="button"
        accessibilityLabel="Leave game"
        style={styles.backDisc}
      >
        <X size={20} color={theme.text} strokeWidth={2} />
      </Pressable>
      <View style={styles.headerMain}>
        <Text style={styles.headerTitle}>
          {question
            ? `Question ${question.index} of ${totalQuestions}`
            : 'Solo quiz'}
        </Text>
        {question && (
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.min(
                    100,
                    (question.index / Math.max(1, totalQuestions)) * 100,
                  )}%`,
                },
              ]}
            />
          </View>
        )}
      </View>
      <View style={styles.headerSide}>
        {streak >= 2 && (
          <View style={styles.streakPill}>
            <Flame size={13} color={theme.secondary} strokeWidth={2} />
            <Text style={styles.streakPillText}>Streak x{streak}</Text>
          </View>
        )}
      </View>
    </View>
  );

  /* Score block (the mock): the centred "SCORE" label + big total.
     The countdown ring lives in the question body now (v2 centres
     it between the score and the status line). */
  const scoreBlock = (
    <View style={styles.scoreBlock}>
      <Text style={styles.scoreBlockLabel}>Score</Text>
      <Text style={styles.scoreBlockValue}>
        {totalScore.toLocaleString('en-US')}
      </Text>
    </View>
  );

  let body: React.ReactNode;
  if (phase === 'fatal') {
    body = (
      <View style={styles.center}>
        <Text style={styles.fatalText}>{fatalMessage}</Text>
        <Pressable
          onPress={() => setRunId((n) => n + 1)}
          accessibilityRole="button"
          accessibilityLabel="Start a new game"
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && styles.pressed,
          ]}
        >
          <RotateCcw size={17} color={theme.onAccent} strokeWidth={2} />
          <Text style={styles.primaryButtonText}>New game</Text>
        </Pressable>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back to quiz home"
          style={styles.ghostButton}
        >
          <Text style={styles.ghostButtonText}>Quiz home</Text>
        </Pressable>
      </View>
    );
  } else if (phase === 'over') {
    const accuracy =
      totalQuestions > 0
        ? Math.round((correctCount / totalQuestions) * 100)
        : 0;
    body = (
      <ScrollView
        contentContainerStyle={styles.overContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.trophyDisc}>
          <Trophy size={28} color={theme.accent} strokeWidth={2} />
        </View>
        <Text style={styles.overTitle}>Run Complete!</Text>
        <Text style={styles.overSub}>
          Solo Run · {RESULTS_GUESS_LABEL[quizType]}
        </Text>

        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>FINAL SCORE</Text>
          <Text style={styles.overScore}>
            {totalScore.toLocaleString('en-US')}
          </Text>
          <View style={styles.scoreDivider} />
          <View style={styles.statRow}>
            <View style={styles.statCell}>
              <Text style={styles.statValue}>
                {correctCount}/{totalQuestions}
              </Text>
              <Text style={styles.statLabel}>Correct</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>{accuracy}%</Text>
              <Text style={styles.statLabel}>Accuracy</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={styles.statValue}>×{maxStreak}</Text>
              <Text style={styles.statLabel}>Best Streak</Text>
            </View>
          </View>
        </View>

        {rankProfile ? (
          <View style={styles.rankWrap}>
            {/* No gainedRp: a solo run grants no RP (see the
                docblock), so the results card's "+N RP" pill
                stays hidden — it lights up only where a session
                genuinely granted RP. */}
            <RankResultCard profile={rankProfile} />
          </View>
        ) : rankLoading ? (
          <View style={styles.rankLoading}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : null}

        <View style={styles.overSpacer} />

        <View style={styles.overButtons}>
          <Pressable
            onPress={() => setRunId((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Play again"
            style={({ pressed }) => [
              styles.overPrimaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.overPrimaryButtonText}>Play Again</Text>
          </Pressable>
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Back to quiz"
            style={({ pressed }) => [
              styles.overSecondaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.overSecondaryButtonText}>Back to Quiz</Text>
          </Pressable>
        </View>

        <Text style={styles.overFooter}>
          Your answers were saved to your history.
        </Text>
      </ScrollView>
    );
  } else if (question) {
    const inFeedback = phase === 'feedback' && feedback !== null;
    const audioFailed = audioState.phase === 'failed';
    const audioEmpty = audioState.phase === 'empty';
    const mediaKey = `${gameId ?? 'game'}:${question.index}`;
    // Part 6: this question's chain, frozen at its start — its
    // prefetched slice (when one landed in time) leads, then the
    // remote chain in doctrine order (the API-resolved audio —
    // the derived .ogg — first, then the theme's video file
    // played audio-only as the last resort; the question reports
    // unplayable only after all fail).
    if (chainSnapshotRef.current?.key !== mediaKey) {
      chainSnapshotRef.current = {
        key: mediaKey,
        list: quizSliceCandidates(getQuizSliceUri(mediaKey), [
          question.theme.audioUrl,
          question.theme.videoUrl,
        ]),
      };
    }
    const questionCandidates = chainSnapshotRef.current.list;
    // The next question's preload target (parts 5+6): the
    // feedback reveal when it exists, else the early reveal from
    // this question's playback-start signal — both feed the same
    // slice prefetch inside the quiz hook, deduped by key.
    const nextPreload = resolveSoloNextPreload({
      gameKey: gameId ?? 'game',
      currentIndex: question.index,
      feedbackNext: feedback?.nextQuestion
        ? {
            index: feedback.nextQuestion.index,
            audioUrl: feedback.nextQuestion.theme.audioUrl,
            videoUrl: feedback.nextQuestion.theme.videoUrl,
          }
        : null,
      earlyNext,
    });
    body = (
      <>
        <QuizAudioOnly
          candidates={questionCandidates}
          mediaKey={mediaKey}
          onStateChange={handleAudioState}
          /* Playback plan (2026-11-10) + parts 5/6 (2026-11-11):
             the NEXT question's audio prefetches as a file slice
             while this one plays — triggered by the early reveal
             at this question's playback start when available, and
             by the feedback reveal (the answer response's
             nextQuestion) otherwise — so the advance starts it
             near-instantly. The clock still starts at actual
             playback — a sliced clip simply reaches 'playing'
             sooner, through the same phase signal. */
          nextCandidates={nextPreload?.candidates}
          nextMediaKey={nextPreload?.mediaKey}
        />
        <ScrollView
          contentContainerStyle={styles.gameContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Quiz Question v2 centrepiece: the big countdown ring
              (music note, seconds left) with the hidden audio's
              mute toggle at its lower-right — the mock's layout has
              no media card at all; the clip is audio-only. */}
          <View style={styles.ringWrap}>
            <CountdownRing
              deadlineMs={deadlineMs}
              totalSeconds={timeLimit}
              onExpire={phase === 'question' ? onExpire : undefined}
              paused={phase === 'question' && !clockRunning}
              size={168}
              glyph={
                audioState.phase === 'buffering' ? (
                  <ActivityIndicator color={theme.accent} />
                ) : (
                  <Music2 size={22} color={theme.accent} strokeWidth={2} />
                )
              }
              caption="seconds"
            />
            {!audioFailed && !audioEmpty && (
              <Pressable
                onPress={audioState.toggleMute}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={
                  audioState.muted ? 'Unmute theme' : 'Mute theme'
                }
                style={styles.ringMute}
              >
                {audioState.muted ? (
                  <VolumeX size={17} color={theme.text} strokeWidth={2} />
                ) : (
                  <Volume2 size={17} color={theme.text} strokeWidth={2} />
                )}
              </Pressable>
            )}
          </View>
          {phase === 'question' && (
            <>
              <View style={styles.statusRow}>
                <View
                  style={[
                    styles.statusDot,
                    (audioFailed || audioEmpty) && styles.statusDotMuted,
                  ]}
                />
                <Text style={styles.statusText}>
                  {audioFailed
                    ? 'This theme could not be played — you can still answer.'
                    : audioEmpty
                      ? 'No playable media for this theme — you can still answer.'
                      : 'Playing... guess the anime!'}
                </Text>
              </View>
              <Text style={styles.prompt}>
                {QUESTION_PROMPT[quizType]}
              </Text>
            </>
          )}
          <QuizOptions
            variant="large"
            options={question.options}
            onSelect={(option) => void submit(option)}
            disabled={phase !== 'question'}
            selected={picked}
            correctValue={inFeedback ? feedback.correctValue : null}
            pickedValue={inFeedback ? picked : null}
          />
          {error && phase === 'question' && (
            <Text style={styles.errorText}>{error}</Text>
          )}
          {phase === 'question' && (
            <Pressable
              onPress={() => void submit(null)}
              accessibilityRole="button"
              accessibilityLabel="Skip this question"
              style={({ pressed }) => [
                styles.skipButton,
                pressed && styles.pressed,
              ]}
            >
              <SkipForward size={15} color={theme.muted} strokeWidth={2} />
              <Text style={styles.skipText}>Skip</Text>
            </Pressable>
          )}
          {phase === 'question' && (
            <Text style={styles.footerNote}>
              Clip plays from 0:00. Faster answers earn more points.
            </Text>
          )}
        {inFeedback && (
          <View style={styles.feedbackCard}>
            <View style={styles.feedbackHead}>
              {feedback.correct ? (
                <>
                  <Check size={18} color={theme.accent} strokeWidth={2.5} />
                  <Text style={styles.feedbackTitle}>
                    Correct · +{feedback.scoreGained}
                  </Text>
                  <Text style={styles.feedbackSub}>
                    {feedback.secondsRemaining}s to spare
                  </Text>
                </>
              ) : picked === null ? (
                <>
                  <Hourglass size={17} color={theme.secondary} strokeWidth={2} />
                  <Text style={styles.feedbackTitle}>Time up</Text>
                  <Text style={styles.feedbackSub}>
                    The answer was {feedback.correctValue}
                  </Text>
                </>
              ) : (
                <>
                  <X size={18} color={theme.secondary} strokeWidth={2.5} />
                  <Text style={styles.feedbackTitle}>Not quite</Text>
                  <Text style={styles.feedbackSub}>
                    The answer was {feedback.correctValue}
                  </Text>
                </>
              )}
            </View>
            <View style={styles.revealRow}>
              {feedback.reveal.coverImage ? (
                <AppImage
                  source={feedback.reveal.coverImage}
                  style={styles.revealCover}
                />
              ) : (
                <View style={[styles.revealCover, styles.revealCoverEmpty]} />
              )}
              <View style={styles.revealMain}>
                <Text style={styles.revealSong} numberOfLines={1}>
                  {feedback.reveal.songTitle}
                </Text>
                <Text style={styles.revealMeta} numberOfLines={2}>
                  {feedback.reveal.animeTitleEnglish ??
                    feedback.reveal.animeTitle}
                  {feedback.reveal.artistName
                    ? ` · ${feedback.reveal.artistName}`
                    : ''}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={advance}
              accessibilityRole="button"
              accessibilityLabel={
                feedback.gameOver ? 'See results' : 'Next question'
              }
              style={({ pressed }) => [
                styles.nextButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.nextButtonText}>
                {feedback.gameOver ? 'See results' : 'Next'}
              </Text>
              <ChevronRight size={16} color={theme.onAccent} strokeWidth={2} />
            </Pressable>
          </View>
          )}
        </ScrollView>
      </>
    );
  } else {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.column}>
        {phase === 'creating' ? (
          /* The generating screen is a full-column design of
             its own (approved cfc7c9ac): it carries its own top
             row — the same leave-game ✕ on goBack, plus the
             Solo Run chip — so the shared header stands down
             for this phase only. */
          <QuizGenerating onExit={goBack} />
        ) : (
          <>
            {phase !== 'over' && header}
            {(phase === 'question' || phase === 'feedback') && scoreBlock}
            {body}
          </>
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
    backDisc: {
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    progressTrack: {
      width: 150,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.raised,
      marginTop: spacing.xs + 2,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: theme.accent,
    },
    headerMain: {
      flex: 1,
      alignItems: 'center',
    },
    headerTitle: {
      ...typeStyles.sectionLabel,
      color: theme.text,
    },
    headerSide: {
      minWidth: 44,
      alignItems: 'flex-end',
    },
    streakPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs + 2,
    },
    streakPillText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    scoreBlock: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.md,
    },
    scoreBlockLabel: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      color: theme.muted,
    },
    scoreBlockValue: {
      fontFamily: fontFamilies.display,
      fontSize: 30,
      color: theme.text,
    },
    gameContent: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
      gap: spacing.md,
    },
    ringWrap: {
      alignSelf: 'center',
      position: 'relative',
      marginTop: spacing.sm,
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
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 2,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.accent,
    },
    statusDotMuted: {
      backgroundColor: theme.muted,
    },
    statusText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
    },
    prompt: {
      ...typeStyles.heading,
      fontSize: 21,
      lineHeight: 27,
      color: theme.text,
      textAlign: 'center',
    },
    footerNote: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
    },
    skipButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      minHeight: 40,
    },
    skipText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.secondary,
      textAlign: 'center',
    },
    feedbackCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.lg,
      gap: spacing.md,
    },
    feedbackHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      flexWrap: 'wrap',
    },
    feedbackTitle: {
      ...typeStyles.sectionLabel,
      color: theme.text,
    },
    feedbackSub: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    revealRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    revealCover: {
      width: 46,
      height: 62,
      borderRadius: radii.sm,
      backgroundColor: theme.raised,
    },
    revealCoverEmpty: {
      backgroundColor: theme.raised,
    },
    revealMain: {
      flex: 1,
    },
    revealSong: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.text,
    },
    revealMeta: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: 2,
    },
    nextButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 46,
    },
    nextButtonText: {
      ...typeStyles.sectionLabel,
      color: theme.onAccent,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xxl,
    },
    fatalText: {
      ...typeStyles.body,
      color: theme.text,
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
    ghostButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 46,
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
    /* Results layout (Quiz Results mock, measured): content
       inset 20, trophy disc 64, the two white cards stacked with
       a 20 gap, then a flex spacer pinning the buttons + footer
       toward the bottom exactly as the mock draws them. */
    overContent: {
      flexGrow: 1,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xxxl,
    },
    overScore: {
      ...typeStyles.display,
      fontSize: 42,
      color: theme.text,
      marginTop: spacing.lg,
    },
    trophyDisc: {
      width: 64,
      height: 64,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'center',
    },
    overTitle: {
      ...typeStyles.display,
      fontSize: 26,
      color: theme.text,
      textAlign: 'center',
      marginTop: spacing.md + 2,
    },
    overSub: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.sm + 2,
    },
    scoreCard: {
      alignSelf: 'stretch',
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingTop: spacing.xxl,
      paddingBottom: spacing.xxl,
      paddingHorizontal: spacing.lg,
      alignItems: 'center',
      marginTop: spacing.xxl,
    },
    scoreLabel: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 12,
      letterSpacing: 1.2,
      color: theme.muted,
    },
    scoreDivider: {
      alignSelf: 'stretch',
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginTop: spacing.xl,
    },
    statRow: {
      alignSelf: 'stretch',
      flexDirection: 'row',
      marginTop: spacing.xl,
    },
    statCell: {
      flex: 1,
      alignItems: 'center',
      gap: spacing.sm,
    },
    statDivider: {
      width: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      alignSelf: 'stretch',
    },
    statValue: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 19,
      color: theme.text,
    },
    statLabel: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    rankWrap: {
      alignSelf: 'stretch',
      marginTop: spacing.xl,
    },
    rankLoading: {
      alignSelf: 'stretch',
      alignItems: 'center',
      paddingVertical: spacing.lg,
      marginTop: spacing.xl,
    },
    overSpacer: {
      flex: 1,
      minHeight: spacing.xxl,
    },
    overButtons: {
      alignSelf: 'stretch',
      gap: spacing.md,
    },
    overPrimaryButton: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      height: 52,
      paddingHorizontal: spacing.lg,
    },
    overPrimaryButtonText: {
      ...typeStyles.sectionLabel,
      fontSize: 16,
      color: theme.onAccent,
    },
    overSecondaryButton: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.accentContainer,
      borderRadius: radii.base,
      height: 52,
      paddingHorizontal: spacing.lg,
    },
    overSecondaryButtonText: {
      ...typeStyles.sectionLabel,
      fontSize: 16,
      color: theme.accent,
    },
    overFooter: {
      ...typeStyles.caption,
      color: theme.muted,
      textAlign: 'center',
      marginTop: spacing.xxxl,
    },
    pressed: {
      opacity: 0.85,
    },
  });

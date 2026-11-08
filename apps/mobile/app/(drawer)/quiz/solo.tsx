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
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Flame,
  Hourglass,
  RotateCcw,
  SkipForward,
  Star,
  Trophy,
  X,
} from 'lucide-react-native';
import type {
  QuizGuessType,
  QuizLeaderboardEntry,
  QuizSource,
  SoloAnswerResponse,
  SoloQuestion,
} from '@kaikansen/contracts';
import { ApiRequestError } from '../../../src/api';
import {
  createSoloGame,
  fetchQuizLeaderboard,
  submitSoloAnswer,
} from '../../../src/quizApi';
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

type Phase = 'creating' | 'question' | 'feedback' | 'over' | 'fatal';

const FEEDBACK_MS = 2800;

const GUESS_LABEL: Record<QuizGuessType, string> = {
  anime: 'Guess the anime',
  title: 'Guess the song',
  artist: 'Guess the artist',
};

/**
 * Solo game (Slice M4) — a server-held 10-question game over the
 * S4 REST surface. The client renders the question theme inline
 * (QuizMedia), runs a LOCAL 20s countdown ring for display (the
 * server measures and scores authoritatively), and sends the
 * chosen option verbatim — or null on timeout/skip. The answer
 * response drives the feedback state (correct option revealed,
 * points + streak), then the game auto-advances (a Next button
 * skips the wait). The end screen shows the final score and the
 * leaderboard for this quiz type.
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
  const source: QuizSource = params.source === 'library' ? 'library' : 'random';

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
  const [board, setBoard] = useState<QuizLeaderboardEntry[] | null>(null);

  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackRef = useRef<SoloAnswerResponse | null>(null);
  const advancedForRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    };
  }, []);

  const startQuestion = useCallback(
    (q: SoloQuestion, limitSeconds: number) => {
      setQuestion(q);
      setPicked(null);
      setFeedback(null);
      feedbackRef.current = null;
      setError(null);
      setDeadlineMs(Date.now() + limitSeconds * 1000);
      setPhase('question');
    },
    [],
  );

  /* Create the game (and recreate on Play again via runId). */
  useEffect(() => {
    let live = true;
    setPhase('creating');
    setError(null);
    feedbackRef.current = null;
    advancedForRef.current = 0;
    setTotalScore(0);
    setStreak(0);
    setMaxStreak(0);
    setCorrectCount(0);
    setBoard(null);
    createSoloGame({ quizType, source })
      .then((state) => {
        if (!live) return;
        setGameId(state.gameId);
        setTotalQuestions(state.totalQuestions);
        setTimeLimit(state.timeLimitSeconds);
        if (state.question) {
          startQuestion(state.question, state.timeLimitSeconds);
        } else {
          setFatalMessage('The game could not be started.');
          setPhase('fatal');
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        setFatalMessage(
          e instanceof Error ? e.message : 'Could not start the game.',
        );
        setPhase('fatal');
      });
    return () => {
      live = false;
    };
  }, [quizType, source, runId, startQuestion]);

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
      void fetchQuizLeaderboard(quizType)
        .then((res) => {
          if (mountedRef.current) setBoard(res.entries);
        })
        .catch(() => {
          // The board is garnish on the end screen; its failure
          // leaves the score standing and the list simply absent.
          if (mountedRef.current) setBoard([]);
        });
    } else {
      startQuestion(current.nextQuestion, timeLimit);
    }
  }, [quizType, startQuestion, timeLimit]);

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

  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={goBack}
        hitSlop={3}
        accessibilityRole="button"
        accessibilityLabel="Leave game"
        style={styles.backHit}
      >
        <View style={styles.backTile}>
          <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
        </View>
      </Pressable>
      <View style={styles.headerMain}>
        <Text style={styles.headerTitle}>
          {question
            ? `Question ${question.index} of ${totalQuestions}`
            : 'Solo quiz'}
        </Text>
        <Text style={styles.headerSub}>{GUESS_LABEL[quizType]}</Text>
      </View>
      {(phase === 'question' || phase === 'feedback') && question && (
        <CountdownRing
          deadlineMs={deadlineMs}
          totalSeconds={timeLimit}
          onExpire={phase === 'question' ? onExpire : undefined}
        />
      )}
    </View>
  );

  const scoreRow = (
    <View style={styles.scoreRow}>
      <View style={styles.scoreChip}>
        <Star size={13} color={theme.onAccentContainer} strokeWidth={2} />
        <Text style={styles.scoreChipText}>{totalScore} pts</Text>
      </View>
      <View
        style={[
          styles.scoreChip,
          streak >= 2 && styles.scoreChipHot,
        ]}
      >
        <Flame
          size={13}
          color={streak >= 2 ? theme.secondary : theme.onAccentContainer}
          strokeWidth={2}
        />
        <Text style={styles.scoreChipText}>{streak} streak</Text>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            {
              width: `${
                question
                  ? Math.min(
                      100,
                      ((question.index - (phase === 'question' ? 1 : 0)) /
                        totalQuestions) *
                        100,
                    )
                  : 0
              }%`,
            },
          ]}
        />
      </View>
    </View>
  );

  let body: React.ReactNode;
  if (phase === 'creating') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} size="large" />
        <Text style={styles.centerText}>Dealing your questions…</Text>
      </View>
    );
  } else if (phase === 'fatal') {
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
    body = (
      <ScrollView
        contentContainerStyle={styles.overContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.overCard}>
          <View style={styles.trophyTile}>
            <Trophy size={26} color={theme.accent} strokeWidth={2} />
          </View>
          <Text style={styles.overScore}>{totalScore}</Text>
          <Text style={styles.overMeta}>
            {correctCount} of {totalQuestions} correct · best streak{' '}
            {maxStreak}
          </Text>
          <View style={styles.overButtons}>
            <Pressable
              onPress={() => setRunId((n) => n + 1)}
              accessibilityRole="button"
              accessibilityLabel="Play again"
              style={({ pressed }) => [
                styles.primaryButton,
                styles.overButton,
                pressed && styles.pressed,
              ]}
            >
              <RotateCcw size={17} color={theme.onAccent} strokeWidth={2} />
              <Text style={styles.primaryButtonText}>Play again</Text>
            </Pressable>
            <Pressable
              onPress={goBack}
              accessibilityRole="button"
              accessibilityLabel="Back to quiz home"
              style={({ pressed }) => [
                styles.ghostButton,
                styles.overButton,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.ghostButtonText}>Quiz home</Text>
            </Pressable>
          </View>
        </View>
        {board !== null && board.length > 0 && (
          <View style={styles.boardCard}>
            <Text style={styles.boardTitle}>
              Top {GUESS_LABEL[quizType].replace('Guess the ', '')} attempts
            </Text>
            {board.slice(0, 5).map((entry, i) => (
              <View key={entry.id} style={styles.boardRow}>
                <Text style={styles.boardRank}>{i + 1}</Text>
                <Text style={styles.boardName} numberOfLines={1}>
                  {entry.author?.displayName ??
                    entry.author?.username ??
                    'Guest'}
                </Text>
                {entry.correct ? (
                  <Check size={14} color={theme.accent} strokeWidth={2.5} />
                ) : (
                  <X size={14} color={theme.muted} strokeWidth={2.5} />
                )}
                <Text style={styles.boardScore}>{entry.score}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    );
  } else if (question) {
    const inFeedback = phase === 'feedback' && feedback !== null;
    body = (
      <ScrollView
        contentContainerStyle={styles.gameContent}
        showsVerticalScrollIndicator={false}
      >
        <QuizMedia
          candidates={[question.theme.videoUrl, question.theme.audioUrl]}
          coverImage={question.theme.coverImage}
          mediaKey={`${gameId ?? 'game'}:${question.index}`}
        />
        <View style={styles.themeMeta}>
          <Text style={styles.themeMetaText}>
            {question.theme.type}
            {question.theme.sequence} · {GUESS_LABEL[quizType]} — tap an
            answer
          </Text>
        </View>
        <QuizOptions
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
                <Image
                  source={{ uri: feedback.reveal.coverImage }}
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
        {header}
        {(phase === 'question' || phase === 'feedback') && scoreRow}
        {body}
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
    scoreRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.md,
    },
    scoreChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: spacing.xs + 2,
    },
    scoreChipHot: {
      backgroundColor: withOpacity(theme.secondary, 0.18),
    },
    scoreChipText: {
      ...typeStyles.caption,
      color: theme.onAccentContainer,
    },
    progressTrack: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.raised,
      overflow: 'hidden',
    },
    progressFill: {
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.accent,
    },
    gameContent: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
      gap: spacing.md,
    },
    themeMeta: {
      alignItems: 'center',
    },
    themeMetaText: {
      ...typeStyles.caption,
      color: theme.muted,
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
    centerText: {
      ...typeStyles.body,
      color: theme.muted,
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
    overContent: {
      padding: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
      gap: spacing.lg,
    },
    overCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.xl,
      alignItems: 'center',
      gap: spacing.sm,
    },
    trophyTile: {
      width: 56,
      height: 56,
      borderRadius: radii.md,
      backgroundColor: withOpacity(theme.accent, 0.14),
      alignItems: 'center',
      justifyContent: 'center',
    },
    overScore: {
      ...typeStyles.display,
      fontSize: 40,
      color: theme.text,
    },
    overMeta: {
      ...typeStyles.body,
      color: theme.muted,
      textAlign: 'center',
    },
    overButtons: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    overButton: {
      flex: 1,
    },
    boardCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    boardTitle: {
      ...typeStyles.sectionLabel,
      color: theme.text,
      marginBottom: spacing.xs,
    },
    boardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xs + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    boardRank: {
      ...typeStyles.mono,
      color: theme.muted,
      width: 20,
      textAlign: 'center',
    },
    boardName: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.text,
      flex: 1,
    },
    boardScore: {
      ...typeStyles.mono,
      color: theme.text,
      minWidth: 34,
      textAlign: 'right',
    },
    pressed: {
      opacity: 0.85,
    },
  });

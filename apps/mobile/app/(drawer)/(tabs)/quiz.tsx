import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Check,
  Flame,
  Globe,
  Hash,
  Info,
  Library,
  LogIn,
  Mic,
  Music,
  Play,
  Plus,
  Shuffle,
  Swords,
  Trophy,
  Tv,
  Users,
  X,
} from 'lucide-react-native';
import type {
  QuizGuessType,
  QuizLeaderboardEntry,
  QuizSource,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { fetchQuizLeaderboard } from '../../../src/quizApi';
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

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

const TYPE_OPTIONS: { key: QuizGuessType; label: string; Icon: IconComponent }[] = [
  { key: 'anime', label: 'Anime', Icon: Tv },
  { key: 'title', label: 'Song', Icon: Music },
  { key: 'artist', label: 'Artist', Icon: Mic },
];

const TYPE_LABEL: Record<QuizGuessType, string> = {
  anime: 'Anime',
  title: 'Song',
  artist: 'Artist',
};

/**
 * Quiz home (Slice M4) — replaces the placeholder tab. Solo setup
 * (guess type as icon chips + Random/Library source), the
 * multiplayer entry points (create / join by code / public match —
 * all in the lobby route), and a live preview of the API's
 * leaderboard (top attempts; the board itself is public).
 *
 * Honest states: signed-out gets a log-in prompt in place of the
 * play cards (the quiz API requires auth — solo games are per-user
 * and rooms have no anonymous sockets); fixture mode labels demo
 * and disables play (there is no API to play against) while the
 * board renders its honest empty shape.
 */
export default function QuizScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status } = useAuth();

  const [quizType, setQuizType] = useState<QuizGuessType>('anime');
  const [source, setSource] = useState<QuizSource>('random');
  const [boardType, setBoardType] = useState<QuizGuessType | null>(null);
  const [board, setBoard] = useState<QuizLeaderboardEntry[] | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);

  const loadBoard = useCallback(async () => {
    setBoardLoading(true);
    setBoardError(null);
    try {
      const res = await fetchQuizLeaderboard(boardType ?? undefined);
      setBoard(res.entries);
    } catch (e) {
      setBoardError(
        e instanceof Error ? e.message : 'Could not load the leaderboard.',
      );
    } finally {
      setBoardLoading(false);
    }
  }, [boardType]);

  useFocusEffect(
    useCallback(() => {
      void loadBoard();
    }, [loadBoard]),
  );

  const signedIn = status === 'signedIn';
  const canPlay = signedIn && !fixtureMode;

  const chip = (
    active: boolean,
    label: string,
    Icon: IconComponent,
    onPress: () => void,
    disabled = false,
  ) => (
    <Pressable
      key={label}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      style={({ pressed }) => [
        styles.chip,
        active && styles.chipActive,
        disabled && styles.chipDisabled,
        pressed && styles.pressed,
      ]}
    >
      <Icon
        size={15}
        color={active ? theme.onAccent : theme.muted}
        strokeWidth={2}
      />
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );

  const boardRow = (entry: QuizLeaderboardEntry, i: number) => (
    <View key={entry.id} style={styles.boardRow}>
      <Text style={styles.boardRank}>{i + 1}</Text>
      <View style={styles.boardMain}>
        <Text style={styles.boardName} numberOfLines={1}>
          {entry.author?.displayName ?? entry.author?.username ?? 'Guest'}
        </Text>
        <Text style={styles.boardMeta} numberOfLines={1}>
          {TYPE_LABEL[entry.quizType]} · {entry.themeSlug}
        </Text>
      </View>
      {entry.streak >= 2 && (
        <View style={styles.streak}>
          <Flame size={13} color={theme.secondary} strokeWidth={2} />
          <Text style={styles.streakText}>{entry.streak}</Text>
        </View>
      )}
      {entry.correct ? (
        <Check size={15} color={theme.accent} strokeWidth={2.5} />
      ) : (
        <X size={15} color={theme.muted} strokeWidth={2.5} />
      )}
      <Text style={styles.boardScore}>{entry.score}</Text>
    </View>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.column}>
        {fixtureMode && (
          <View style={styles.noteCard}>
            <Info size={17} color={theme.secondary} strokeWidth={2} />
            <Text style={styles.noteText}>
              Demo mode — the quiz needs the live API. Connect the app to
              play solo games and multiplayer rooms.
            </Text>
          </View>
        )}

        {!signedIn && status !== 'loading' ? (
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <View style={styles.iconSlot}>
                <LogIn size={17} color={theme.accent} strokeWidth={2} />
              </View>
              <Text style={styles.cardTitle}>Log in to play</Text>
            </View>
            <Text style={styles.cardBody}>
              Solo games and multiplayer rooms are tied to your account —
              scores, streaks and ranks are yours.
            </Text>
            <Pressable
              onPress={() => router.push('/login')}
              accessibilityRole="button"
              accessibilityLabel="Log in"
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.pressed,
              ]}
            >
              <LogIn size={17} color={theme.onAccent} strokeWidth={2} />
              <Text style={styles.primaryButtonText}>Log in</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <View style={styles.iconSlot}>
                  <Play size={17} color={theme.accent} strokeWidth={2} />
                </View>
                <Text style={styles.cardTitle}>Solo</Text>
                <Text style={styles.cardHint}>10 questions · 20s each</Text>
              </View>
              <Text style={styles.fieldLabel}>Guess the</Text>
              <View style={styles.chipRow}>
                {TYPE_OPTIONS.map((o) =>
                  chip(quizType === o.key, o.label, o.Icon, () =>
                    setQuizType(o.key),
                  ),
                )}
              </View>
              <Text style={styles.fieldLabel}>Pool</Text>
              <View style={styles.chipRow}>
                {chip(source === 'random', 'Random', Shuffle, () =>
                  setSource('random'),
                )}
                {chip(source === 'library', 'My library', Library, () =>
                  setSource('library'),
                )}
              </View>
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/quiz/solo',
                    params: { quizType, source },
                  })
                }
                disabled={!canPlay}
                accessibilityRole="button"
                accessibilityLabel="Start solo game"
                accessibilityState={{ disabled: !canPlay }}
                style={({ pressed }) => [
                  styles.primaryButton,
                  !canPlay && styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Play size={17} color={theme.onAccent} strokeWidth={2} />
                <Text style={styles.primaryButtonText}>Start game</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHead}>
                <View style={styles.iconSlot}>
                  <Users size={17} color={theme.accent} strokeWidth={2} />
                </View>
                <Text style={styles.cardTitle}>Multiplayer</Text>
                <Text style={styles.cardHint}>Party or duel</Text>
              </View>
              <View style={styles.mpRow}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: '/quiz/lobby',
                      params: { intent: 'create' },
                    })
                  }
                  disabled={!canPlay}
                  accessibilityRole="button"
                  accessibilityLabel="Create a room"
                  accessibilityState={{ disabled: !canPlay }}
                  style={({ pressed }) => [
                    styles.mpButton,
                    !canPlay && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Plus size={16} color={theme.text} strokeWidth={2} />
                  <Text style={styles.mpButtonText}>Create</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: '/quiz/lobby',
                      params: { intent: 'join' },
                    })
                  }
                  disabled={!canPlay}
                  accessibilityRole="button"
                  accessibilityLabel="Join a room with a code"
                  accessibilityState={{ disabled: !canPlay }}
                  style={({ pressed }) => [
                    styles.mpButton,
                    !canPlay && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Hash size={16} color={theme.text} strokeWidth={2} />
                  <Text style={styles.mpButtonText}>Join</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: '/quiz/lobby',
                      params: { intent: 'public' },
                    })
                  }
                  disabled={!canPlay}
                  accessibilityRole="button"
                  accessibilityLabel="Find a public match"
                  accessibilityState={{ disabled: !canPlay }}
                  style={({ pressed }) => [
                    styles.mpButton,
                    !canPlay && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Globe size={16} color={theme.text} strokeWidth={2} />
                  <Text style={styles.mpButtonText}>Public</Text>
                </Pressable>
              </View>
              <View style={styles.duelHint}>
                <Swords size={13} color={theme.muted} strokeWidth={2} />
                <Text style={styles.duelHintText}>
                  Duels are 1v1 and start as soon as both players are ready.
                </Text>
              </View>
            </View>
          </>
        )}

        <View style={styles.card}>
          <View style={styles.cardHead}>
            <View style={styles.iconSlot}>
              <Trophy size={17} color={theme.accent} strokeWidth={2} />
            </View>
            <Text style={styles.cardTitle}>Leaderboard</Text>
            <Text style={styles.cardHint}>Top attempts</Text>
          </View>
          <View style={styles.chipRow}>
            <Pressable
              onPress={() => setBoardType(null)}
              accessibilityRole="button"
              accessibilityState={{ selected: boardType === null }}
              style={({ pressed }) => [
                styles.chip,
                boardType === null && styles.chipActive,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  boardType === null && styles.chipTextActive,
                ]}
              >
                All
              </Text>
            </Pressable>
            {TYPE_OPTIONS.map((o) =>
              chip(boardType === o.key, o.label, o.Icon, () =>
                setBoardType(o.key),
              ),
            )}
          </View>
          {boardLoading && board === null ? (
            <ActivityIndicator color={theme.accent} style={styles.boardSpin} />
          ) : boardError ? (
            <View style={styles.boardState}>
              <Text style={styles.errorText}>{boardError}</Text>
              <Pressable
                onPress={() => void loadBoard()}
                accessibilityRole="button"
                accessibilityLabel="Retry loading the leaderboard"
                style={styles.retryLink}
              >
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : board && board.length > 0 ? (
            <View style={styles.boardList}>
              {board.slice(0, 5).map(boardRow)}
            </View>
          ) : (
            <Text style={styles.emptyText}>
              {fixtureMode
                ? 'No leaderboard in demo mode.'
                : 'No attempts yet — be the first on the board.'}
            </Text>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    content: {
      padding: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      gap: spacing.lg,
    },
    noteCard: {
      flexDirection: 'row',
      gap: spacing.sm,
      alignItems: 'flex-start',
      backgroundColor: withOpacity(theme.secondary, 0.1),
      borderRadius: radii.base,
      padding: spacing.md,
    },
    noteText: {
      ...typeStyles.bodySmall,
      color: theme.text,
      flex: 1,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cardHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    iconSlot: {
      width: 32,
      height: 32,
      borderRadius: radii.sm,
      backgroundColor: withOpacity(theme.accent, 0.14),
      alignItems: 'center',
      justifyContent: 'center',
    },
    cardTitle: {
      ...typeStyles.heading,
      color: theme.text,
    },
    cardHint: {
      ...typeStyles.caption,
      color: theme.muted,
      marginLeft: 'auto',
    },
    cardBody: {
      ...typeStyles.body,
      color: theme.muted,
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
    chipDisabled: {
      opacity: 0.5,
    },
    chipText: {
      ...typeStyles.bodySmall,
      color: theme.text,
    },
    chipTextActive: {
      color: theme.onAccent,
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
    mpRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    mpButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs + 2,
      minHeight: 46,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      borderWidth: 1,
      borderColor: theme.border,
    },
    mpButtonText: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.text,
    },
    duelHint: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
    },
    duelHintText: {
      ...typeStyles.caption,
      color: theme.muted,
      flex: 1,
    },
    boardSpin: {
      paddingVertical: spacing.lg,
    },
    boardState: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    errorText: {
      ...typeStyles.bodySmall,
      color: theme.secondary,
      textAlign: 'center',
    },
    retryLink: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    retryText: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.accent,
    },
    boardList: {
      gap: spacing.xs,
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
    boardMain: {
      flex: 1,
    },
    boardName: {
      fontFamily: fontFamilies.bodyStrong, fontSize: 14,
      color: theme.text,
    },
    boardMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    streak: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    streakText: {
      ...typeStyles.caption,
      color: theme.secondary,
    },
    boardScore: {
      ...typeStyles.mono,
      color: theme.text,
      minWidth: 34,
      textAlign: 'right',
    },
    emptyText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
      paddingVertical: spacing.sm,
    },
    pressed: {
      opacity: 0.85,
    },
  });

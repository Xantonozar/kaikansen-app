import { useCallback, useMemo, useState } from 'react';
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
  Headphones,
  Info,
  LogIn,
  Play,
  Users,
} from 'lucide-react-native';
import type {
  QuizGuessType,
  QuizSource,
  RankLeaderboardEntry,
  UserRankProfile,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import {
  fetchMyRank,
  fetchRankLeaderboard,
} from '../../../src/socialApi';
import { RankCard, RankCardSkeleton } from '../../../src/components/RankCard';
import { RankRow } from '../../../src/components/RankRow';
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

const TYPE_OPTIONS: { key: QuizGuessType; label: string }[] = [
  { key: 'anime', label: 'Anime' },
  { key: 'title', label: 'Song' },
  { key: 'artist', label: 'Artist' },
];

/** The Solo Run pool picker (owner spec, 2026-11-10). */
const POOL_OPTIONS: { key: QuizSource; label: string }[] = [
  { key: 'random', label: 'Random' },
  { key: 'anilist', label: 'AniList' },
  { key: 'listened', label: 'Listened' },
];

/** The Solo card's body line — the mock's sentence, per guess type. */
const SOLO_BODY: Record<QuizGuessType, string> = {
  anime: 'Guess the anime from the song. 10 questions, 20 seconds each.',
  title: 'Guess the song title from the clip. 10 questions, 20 seconds each.',
  artist: 'Guess the artist from the song. 10 questions, 20 seconds each.',
};

/**
 * Quiz home (Slice M4) — replaces the placeholder tab.
 *
 * Design polish pass — the hub now matches its Lavender Dusk
 * mock card for card: the rank card on top (with the design's
 * loading skeleton while /rank/me is in flight, instead of
 * vanishing), the "Solo Run" card (guess-type text chips and a
 * "Start Solo" button), the "Play with Friends" card (exactly
 * the mock's two buttons: Create Room filled, Join with Code
 * lavender — public-room browsing lives on the lobby screen
 * itself), and the RP leaderboard preview
 * (GET /rank/leaderboard, "View all" → the leaderboard route).
 * The mock draws NO top-attempts card, so that card is gone;
 * the solo-attempts endpoint itself is untouched.
 *
 * Owner addition (spec 2026-11-10): the Solo Run card ALSO
 * carries the pool picker — Random / AniList / Listened chips
 * under the guess types. The mock predates the picker; the
 * chips reuse the card's own chip language, and the choice
 * rides the solo route's `source` param to the API's named
 * pools (a thin pool refuses with the server's message on the
 * solo screen, never a silent fallback).
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
  const [myRank, setMyRank] = useState<UserRankProfile | null>(null);
  const [rankLoading, setRankLoading] = useState(false);
  const [rankBoard, setRankBoard] = useState<RankLeaderboardEntry[] | null>(
    null,
  );
  const [rankError, setRankError] = useState<string | null>(null);

  const signedIn = status === 'signedIn';

  // Rank card + RP preview: the board is public; /rank/me only
  // exists for a signed-in caller (its failure just hides the
  // card and the YOU highlight — never an error surface here).
  // While the fetch is in flight the card renders its loading
  // skeleton (the design's loading state) instead of vanishing.
  const loadRank = useCallback(async () => {
    setRankError(null);
    try {
      const res = await fetchRankLeaderboard();
      setRankBoard(res.leaderboard);
    } catch (e) {
      setRankError(
        e instanceof Error ? e.message : 'Could not load the rankings.',
      );
    }
    if (signedIn) {
      setRankLoading(true);
      try {
        setMyRank(await fetchMyRank());
      } catch {
        setMyRank(null);
      } finally {
        setRankLoading(false);
      }
    } else {
      setMyRank(null);
    }
  }, [signedIn]);

  useFocusEffect(
    useCallback(() => {
      void loadRank();
    }, [loadRank]),
  );
  const canPlay = signedIn && !fixtureMode;

  const chip = (
    active: boolean,
    label: string,
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
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
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
            {myRank ? (
              <>
                <RankCard profile={myRank} />
                {/* The approved hub mock's line under the rank
                    card: rank standing is read-only here — RP
                    moves in multiplayer only. */}
                <View style={styles.rankNote}>
                  <View style={styles.rankNoteHairline} />
                  <Text style={styles.rankNoteText}>
                    Rank card only — RP is earned in multiplayer
                  </Text>
                </View>
              </>
            ) : rankLoading ? (
              <RankCardSkeleton />
            ) : null}

            <View style={styles.card}>
              <View style={styles.cardHeadSpread}>
                <Text style={styles.cardTitle}>Solo Run</Text>
                <Headphones size={20} color={theme.muted} strokeWidth={2} />
              </View>
              <Text style={styles.cardBody}>{SOLO_BODY[quizType]}</Text>
              <View style={styles.chipRow}>
                {TYPE_OPTIONS.map((o) =>
                  chip(quizType === o.key, o.label, () =>
                    setQuizType(o.key),
                  ),
                )}
              </View>
              <Text style={styles.poolLabel}>Question pool</Text>
              <View style={styles.chipRow}>
                {POOL_OPTIONS.map((o) =>
                  chip(source === o.key, o.label, () => setSource(o.key)),
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
                <Text style={styles.primaryButtonText}>Start Solo</Text>
              </Pressable>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeadSpread}>
                <Text style={styles.cardTitle}>Play with Friends</Text>
                <Users size={20} color={theme.muted} strokeWidth={2} />
              </View>
              <Text style={styles.cardBody}>
                Party for up to 4 players, or a 1v1 Duel.
              </Text>
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
                    styles.mpPrimary,
                    !canPlay && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.mpPrimaryText}>Create Room</Text>
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
                  <Text style={styles.mpButtonText}>Join with Code</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}

        <View>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Leaderboard</Text>
            <Pressable
              onPress={() => router.push('/quiz/leaderboard')}
              accessibilityRole="button"
              accessibilityLabel="View the full leaderboard"
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <Text style={styles.viewAllText}>View all</Text>
            </Pressable>
          </View>
          <View style={styles.previewCard}>
            {rankBoard === null && !rankError ? (
              <ActivityIndicator
                color={theme.accent}
                style={styles.boardSpin}
              />
            ) : rankError ? (
              <View style={styles.boardState}>
                <Text style={styles.errorText}>{rankError}</Text>
                <Pressable
                  onPress={() => void loadRank()}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading the rankings"
                  style={styles.retryLink}
                >
                  <Text style={styles.retryText}>Retry</Text>
                </Pressable>
              </View>
            ) : rankBoard && rankBoard.length > 0 ? (
              rankBoard
                .slice(0, 5)
                .map((entry, i) => (
                  <RankRow
                    key={entry.userId}
                    position={i + 1}
                    entry={entry}
                    isYou={
                      myRank !== null && entry.userId === myRank.userId
                    }
                  />
                ))
            ) : (
              <Text style={styles.emptyText}>
                {fixtureMode
                  ? 'No rankings in demo mode.'
                  : 'No ranked players yet — play a game to earn RP.'}
              </Text>
            )}
          </View>
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
    cardHeadSpread: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
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
    cardBody: {
      ...typeStyles.body,
      color: theme.muted,
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
      backgroundColor: theme.accentContainer,
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
    poolLabel: {
      ...typeStyles.caption,
      color: theme.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginBottom: -spacing.xs,
    },
    // Quiz button text (owner's design pass): the hub mock's
    // labels measure ≈17px cap height @2x ≈ 12–13pt on ≈38–40pt
    // buttons (kaikansen-quiz-realimg.png) — the app's 15pt
    // sectionLabel on 48pt buttons read large. Hub-scoped: these
    // styles live in this file only (the lobby has its own).
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 40,
      paddingHorizontal: spacing.lg,
    },
    primaryButtonText: {
      ...typeStyles.sectionLabel,
      fontSize: 13,
      color: theme.onAccent,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    mpRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    mpPrimary: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 40,
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
    },
    mpPrimaryText: {
      ...typeStyles.sectionLabel,
      fontSize: 13,
      color: theme.onAccent,
    },
    mpButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 40,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
    },
    mpButtonText: {
      ...typeStyles.sectionLabel,
      fontSize: 13,
      color: theme.onAccentContainer,
    },
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    sectionTitle: {
      ...typeStyles.caption,
      color: theme.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    viewAllText: {
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 13,
      color: theme.accent,
    },
    previewCard: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.sm,
    },
    boardSpin: {
      paddingVertical: spacing.lg,
    },
    rankNote: {
      marginTop: -6,
      gap: spacing.sm,
    },
    rankNoteHairline: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    rankNoteText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
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

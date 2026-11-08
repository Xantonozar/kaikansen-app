/**
 * Pure quiz game rules — the arithmetic and derivations of the web
 * quiz with the database stripped out, so they can be unit-tested
 * directly. Every function names the web source it ports
 * (ZadidSalman/Kaisen).
 */

/** The theme fields the quiz derivations read. */
export interface QuizThemeLike {
  _id: unknown;
  slug?: string;
  animeTitle?: string | null;
  animeTitleEnglish?: string | null;
  animeTitleAlternative?: string[] | null;
  songTitle?: string | null;
  artistName?: string | null;
  anilistId?: number | null;
  videoUrl?: string | null;
}

/* ------------------------------------------------------------------ */
/* Answer derivation — lib/quiz-room-utils.ts `getThemeValue` /        */
/* `getCorrectAnswer`, and the solo twin in                            */
/* app/api/quiz/question/route.ts `getCorrectValue`.                   */
/*                                                                     */
/* guessType vocabulary differs by surface ('title' in solo, 'song'    */
/* in rooms) but names the same derivation; both map here.             */
/* ------------------------------------------------------------------ */

export function getThemeValue(
  theme: QuizThemeLike | null | undefined,
  guessType: string,
): string {
  if (!theme) return 'Unknown';

  let value = '';
  if (guessType === 'anime') {
    value =
      theme.animeTitleEnglish ||
      theme.animeTitle ||
      theme.animeTitleAlternative?.[0] ||
      'Unknown Anime';
  } else if (guessType === 'song' || guessType === 'title') {
    value = theme.songTitle || 'Unknown Song';
  } else if (guessType === 'artist') {
    value = theme.artistName || 'Unknown Artist';
  } else {
    value = theme.animeTitle || 'Unknown';
  }

  return value.trim();
}

export const getCorrectAnswer = getThemeValue;

/**
 * The distractor filter for one correct theme — shared by the solo
 * question route and the room option generator on the web (both
 * exclude the correct theme and, per guess type, themes carrying
 * the correct value). `popularOnly` is the solo pool's base filter;
 * the room generator always samples popular distractors too, so
 * both call sites pass the same shape with different bases merged
 * by the caller.
 */
export function distractorFilterFor(
  correctTheme: QuizThemeLike,
  guessType: string,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    _id: { $ne: correctTheme._id },
    isPopular: true,
    videoUrl: { $nin: [null, ''] },
  };
  if (guessType === 'artist') {
    filter.artistName = { $nin: [null, '', 'Unknown', correctTheme.artistName] };
  } else if (guessType === 'song' || guessType === 'title') {
    filter.songTitle = { $nin: [null, '', 'Unknown', correctTheme.songTitle] };
  } else {
    filter.animeTitle = { $ne: correctTheme.animeTitle };
  }
  return filter;
}

/**
 * Room option derivation — lib/quiz-room-utils.ts
 * `generateRoundOptions` minus the query: given the sampled
 * distractor candidates, take their values, drop duplicates and
 * the correct value, keep 3, add the correct value, shuffle.
 * (The web samples 10 candidates so the dedup has material.)
 */
export function buildRoundOptions(
  correctTheme: QuizThemeLike,
  guessType: string,
  distractorCandidates: QuizThemeLike[],
  random: () => number = Math.random,
): string[] {
  const correctValue = getThemeValue(correctTheme, guessType);
  const distractorValues = Array.from(
    new Set(
      distractorCandidates
        .map((t) => getThemeValue(t, guessType))
        .filter((v) => v !== correctValue),
    ),
  ).slice(0, 3);

  return shuffle([correctValue, ...distractorValues], random);
}

/**
 * Solo option derivation — app/api/quiz/question/route.ts: the
 * web samples exactly 3 distractors and shuffles all four values,
 * WITHOUT the room generator's value dedup (a solo quirk: two
 * distractors could theoretically carry the same value). Mirrored.
 */
export function buildSoloOptions(
  correctTheme: QuizThemeLike,
  quizType: string,
  distractors: QuizThemeLike[],
  random: () => number = Math.random,
): string[] {
  return shuffle(
    [correctTheme, ...distractors].map((t) => getThemeValue(t, quizType)),
    random,
  );
}

/** The web's shuffle: `.sort(() => Math.random() - 0.5)`. */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  return [...items].sort(() => random() - 0.5);
}

/* ------------------------------------------------------------------ */
/* Solo scoring — app/quiz/QuizClient.tsx `handleOptionSelect`:        */
/* points = ceil(secondsRemaining * (1 + streak * 0.1)) for a          */
/* correct answer, using the streak BEFORE this answer; 0 otherwise.   */
/* The clock is a 20s countdown; timeTaken = 20 - secondsRemaining,    */
/* or the full 20 on skip/timeout.                                     */
/* ------------------------------------------------------------------ */

export function soloScoreFor(
  correct: boolean,
  secondsRemaining: number,
  streakBefore: number,
): number {
  if (!correct) return 0;
  return Math.ceil(secondsRemaining * (1 + streakBefore * 0.1));
}

/**
 * Server-measured seconds remaining — the multiplayer answer route's
 * formula (app/api/quiz/room/answer/route.ts): whole elapsed seconds
 * since the round started, subtracted from the limit, floored at 0.
 * The solo service uses the same measurement against its 20s limit
 * (the web solo client measures locally; the value definition is the
 * same countdown).
 */
export function secondsRemainingAt(
  startedAt: Date,
  timeLimitSeconds: number,
  now: Date = new Date(),
): number {
  const elapsedSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);
  return Math.max(0, timeLimitSeconds - elapsedSeconds);
}

/* ------------------------------------------------------------------ */
/* Multiplayer scoring — app/api/quiz/room/answer/route.ts:            */
/* correct → base = +secondsRemaining; wrong → base =                  */
/* −secondsRemaining (negative scoring is real); party-only first-     */
/* correct bonus = 10 × playerCount.                                   */
/* ------------------------------------------------------------------ */

export function multiplayerScoreFor(input: {
  correct: boolean;
  secondsRemaining: number;
  roomType: string;
  playerCount: number;
  isFirstCorrect: boolean;
}): { baseScore: number; bonusScore: number; totalScoreGained: number } {
  const baseScore = input.correct
    ? input.secondsRemaining
    : -input.secondsRemaining;
  let bonusScore = 0;
  if (input.correct && input.roomType === 'party' && input.isFirstCorrect) {
    bonusScore = 10 * input.playerCount;
  }
  return { baseScore, bonusScore, totalScoreGained: baseScore + bonusScore };
}

/**
 * The auto-lock rule from the same route: once all-but-one players
 * have answered, the remaining player is locked out at 0 — except
 * in a duel where nobody has answered correctly yet (the last
 * duelist keeps their chance to steal the round).
 */
export function shouldAutoLock(input: {
  answeredCount: number;
  playerCount: number;
  roomType: string;
  hasCorrectAnswer: boolean;
}): boolean {
  const { answeredCount, playerCount, roomType, hasCorrectAnswer } = input;
  return (
    answeredCount >= playerCount - 1 &&
    answeredCount < playerCount &&
    (roomType !== 'duel' || hasCorrectAnswer)
  );
}

/* ------------------------------------------------------------------ */
/* Room codes — app/api/quiz/room/create/route.ts `generateRoomCode`:  */
/* 6 chars from A–Z0–9.                                                */
/* ------------------------------------------------------------------ */

const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS.charAt(Math.floor(random() * ROOM_CODE_CHARS.length));
  }
  return code;
}

/* ------------------------------------------------------------------ */
/* Rank math — lib/rank-utils.ts, verbatim: tiers, placement RP,       */
/* streak bonuses. The stateful application lives in RankService.      */
/* ------------------------------------------------------------------ */

export type RankTier = 'academy' | 'genin' | 'chunin' | 'jonin' | 'anbu' | 'kage';

export const RANK_TIERS: {
  tier: RankTier;
  min: number;
  max: number;
  floor: number;
  divisions: number | null;
}[] = [
  { tier: 'academy', min: 0, max: 399, floor: 0, divisions: null },
  { tier: 'genin', min: 400, max: 799, floor: 400, divisions: 3 },
  { tier: 'chunin', min: 800, max: 1399, floor: 800, divisions: 3 },
  { tier: 'jonin', min: 1400, max: 2199, floor: 1400, divisions: 3 },
  { tier: 'anbu', min: 2200, max: 3199, floor: 2200, divisions: 2 },
  { tier: 'kage', min: 3200, max: Infinity, floor: 3200, divisions: null },
];

export function getTierFromRP(rp: number): {
  tier: RankTier;
  division: number | null;
  newFloor: number;
} {
  const t = RANK_TIERS.find((tier) => rp >= tier.min && rp <= tier.max)!;
  let division: number | null = null;

  if (t.divisions) {
    const range = t.max - t.min;
    const posInTier = rp - t.min;
    // Division III = bottom, Division I = top
    division = t.divisions - Math.floor((posInTier / range) * t.divisions);
    division = Math.max(1, Math.min(t.divisions, division));
  }

  return { tier: t.tier, division, newFloor: t.floor };
}

export function getBaseRP(
  placement: number,
  totalPlayers: number,
  roomType: 'party' | 'duel',
): number {
  if (roomType === 'duel') {
    if (placement === 1) return 20; // WIN
    if (placement === 2 && totalPlayers === 2) return -15; // LOSS
    return 5; // DRAW fallback
  }

  // Party mode
  if (placement === 1) return 20;
  if (placement === 2) return 10;
  if (placement === 3) return 0;
  if (placement === 4) return -5;
  if (placement === 5) return -10;
  if (placement >= 6) return -15;

  return -15;
}

export function getStreakBonus(winStreak: number): number {
  if (winStreak <= 1) return 0;
  if (winStreak === 2) return 5;
  if (winStreak === 3) return 10;
  if (winStreak === 4) return 15;
  return 20; // 5+ wins
}

export function tierIndex(tier: string): number {
  return RANK_TIERS.findIndex((t) => t.tier === tier);
}

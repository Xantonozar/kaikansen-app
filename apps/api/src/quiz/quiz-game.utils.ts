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
/* Solo playback-start timing (owner report, 2026-11-10): the solo    */
/* question's audio loads async, and measuring from the draw made     */
/* the load time eat the player's 20s on both clocks. The answer      */
/* window now opens when playback ACTUALLY starts: the client         */
/* signals that moment, the server stamps it on its own clock, and    */
/* the measurement starts at draw + credited load. The credit is      */
/* capped — a client that stalls its signal (the clip is already      */
/* audible while it waits) can buy at most the cap, never an          */
/* unbounded pause. No signal at all (older clients, a player who     */
/* answers before the media resolves) keeps the draw-time             */
/* measurement, exactly as before.                                    */
/* ------------------------------------------------------------------ */

/** Max load time credited to a solo question's answer window. */
export const SOLO_LOAD_CREDIT_CAP_MS = 5000;

/** The load time credited toward a solo question's start, in ms. */
export function creditedLoadMs(
  startedAt: Date,
  playbackStartedAt: Date | null | undefined,
): number {
  if (!playbackStartedAt) return 0;
  const raw = playbackStartedAt.getTime() - startedAt.getTime();
  return Math.min(Math.max(0, raw), SOLO_LOAD_CREDIT_CAP_MS);
}

/** The moment a solo question's answer window effectively opened. */
export function effectiveQuestionStart(
  startedAt: Date,
  playbackStartedAt: Date | null | undefined,
): Date {
  return new Date(
    startedAt.getTime() + creditedLoadMs(startedAt, playbackStartedAt),
  );
}

/* ------------------------------------------------------------------ */
/* Multiplayer scoring — OWNER FORMULA (spec 2026-11-10, replacing   */
/* the web answer route's arithmetic): a correct answer earns the    */
/* seconds remaining × the number of players who had not answered    */
/* yet, PLUS ONE — the +1 is the owner's explicit pick so the LAST   */
/* correct answerer still earns the remaining time × 1 instead of    */
/* × 0. A wrong answer earns 0 (the web's negative scoring is gone). */
/* Solving for the multiplier at answer time: the players who have   */
/* not answered yet, excluding the answerer, are                     */
/* playerCount − answeredCount − 1, so the multiplier is             */
/* playerCount − answeredCount. `answeredCount` is the number of     */
/* answers already recorded in the round BEFORE this one.            */
/* ------------------------------------------------------------------ */

export function multiplayerScoreFor(input: {
  correct: boolean;
  secondsRemaining: number;
  playerCount: number;
  answeredCount: number;
}): { baseScore: number; bonusScore: number; totalScoreGained: number } {
  if (!input.correct) {
    return { baseScore: 0, bonusScore: 0, totalScoreGained: 0 };
  }
  const notYetAnsweredPlusOne = Math.max(
    1,
    input.playerCount - input.answeredCount,
  );
  const baseScore = input.secondsRemaining * notYetAnsweredPlusOne;
  // No separate bonus under the owner's formula — being first is
  // already what the multiplier rewards. bonusScore stays in the
  // answer shape at 0 (the rows and payloads carry the field).
  return { baseScore, bonusScore: 0, totalScoreGained: baseScore };
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
/* Rank math — lib/rank-utils.ts tiers verbatim; the PLACEMENT RP    */
/* table is the OWNER'S (spec 2026-11-10), replacing the web's: it   */
/* is keyed by mode and the ACTUAL player count at game end. Party   */
/* rooms cap at 4 players, so the 4-row is the largest table; a      */
/* legacy oversized room (created before the cap) reads the 4-row    */
/* table with placements past 4th taking the last row's value.       */
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

/** Owner RP tables (spec 2026-11-10), indexed by placement − 1. */
const PARTY_RP_BY_PLAYER_COUNT: Record<number, number[]> = {
  2: [5, -5],
  3: [7, 0, -5],
  4: [10, 5, -3, -7],
};

export function getBaseRP(
  placement: number,
  totalPlayers: number,
  roomType: 'party' | 'duel',
): number {
  if (roomType === 'duel') {
    if (placement === 1) return 10; // WIN
    if (placement === 2 && totalPlayers === 2) return -10; // LOSS
    return 5; // DRAW fallback (degenerate duel shape)
  }

  // Party mode — the table for the game's actual player count.
  const table =
    PARTY_RP_BY_PLAYER_COUNT[totalPlayers] ?? PARTY_RP_BY_PLAYER_COUNT[4];
  if (placement < 1) return table[table.length - 1];
  if (placement > table.length) return table[table.length - 1];
  return table[placement - 1];
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

/* ------------------------------------------------------------------ */
/* The app's 24-rank ladder — a pure function of RP, derived at     */
/* read time and served additively next to the legacy tier fields.  */
/* It is NEVER written to the shared `userranks` documents (the     */
/* website runs the 6-tier system on them): the only stored value   */
/* it ever influences is none — even the rank-updated event's       */
/* ladder slugs are derived in memory at emit time, while           */
/* rank-history rows keep the legacy tiers. The mobile rankUtil     */
/* mirrors this exact table; both sides carry the same boundary     */
/* tests.                                                           */
/*                                                                  */
/* Thresholds are the owner's REAL values, decided 2026-11-11       */
/* (spec RANK-RP-PLAN-2026-11-11.md, "Curve B" — even stairs to a   */
/* 35,000 RP Pirate King, a ~1-year grind), replacing the           */
/* 2026-11-10 design-stage placeholders. The ladder has NO floor:   */
/* there is deliberately no peak/clamp input — a standing derives   */
/* from current RP alone, so an RP drop below a threshold demotes   */
/* the derived rank (owner decision 2026-11-11; the legacy tier's   */
/* tierFloor clamp in RankService is the web's write arithmetic     */
/* and is untouched by this function).                             */
/* ------------------------------------------------------------------ */

export type LadderRankSlug =
  | 'academy-student'
  | 'scout'
  | 'mizunoto'
  | 'genin'
  | 'chunin'
  | 'shinobi'
  | 'assassin'
  | 'firebender'
  | 'kitsune'
  | 'lone-wolf'
  | 'karasu'
  | 'jonin'
  | 'ronin'
  | 'shogun'
  | 'anbu'
  | 'pilot'
  | 'sannin'
  | 'berserk'
  | 'wizard-king'
  | 'jinchuriki'
  | 'newtype'
  | 'overlord'
  | 'shadow-monarch'
  | 'pirate-king';

export const LADDER_RANKS: { rank: LadderRankSlug; min: number }[] = [
  { rank: 'academy-student', min: 0 },
  { rank: 'scout', min: 100 },
  { rank: 'mizunoto', min: 250 },
  { rank: 'genin', min: 450 },
  { rank: 'chunin', min: 700 },
  { rank: 'shinobi', min: 1100 },
  { rank: 'assassin', min: 1600 },
  { rank: 'firebender', min: 2300 },
  { rank: 'kitsune', min: 3200 },
  { rank: 'lone-wolf', min: 4200 },
  { rank: 'karasu', min: 5400 },
  { rank: 'jonin', min: 6800 },
  { rank: 'ronin', min: 8400 },
  { rank: 'shogun', min: 10200 },
  { rank: 'anbu', min: 12200 },
  { rank: 'pilot', min: 14500 },
  { rank: 'sannin', min: 17000 },
  { rank: 'berserk', min: 19800 },
  { rank: 'wizard-king', min: 22800 },
  { rank: 'jinchuriki', min: 25800 },
  { rank: 'newtype', min: 28800 },
  { rank: 'overlord', min: 31800 },
  { rank: 'shadow-monarch', min: 33400 },
  { rank: 'pirate-king', min: 35000 },
];

export interface LadderStandingFacts {
  rank: LadderRankSlug;
  /** 0-based position on the ladder (0–23). */
  index: number;
  /**
   * The PROGRESS TARGET rank (see ladderForRp — the NEXT rank,
   * per spec RANK-RP-PLAN-2026-11-11.md), or null at
   * Pirate King.
   */
  nextRank: LadderRankSlug | null;
  /** RP still needed to reach `nextRank` (0 at the top). */
  toNext: number;
  /** 0–1 progress toward `nextRank` (1 at the top). */
  fraction: number;
}

/**
 * The ladder standing for an RP total (spec
 * RANK-RP-PLAN-2026-11-11.md).
 *
 * PROGRESS TARGET — the NEXT rank (owner decision 2026-11-11):
 * progress is measured from the current rank's threshold to
 * the NEXT rank's threshold, i.e. fraction = (rp − cur.min) /
 * (next.min − cur.min), and `toNext` is the RP still needed to
 * reach that next rank. (This replaces the 2026-11-10 design
 * stage's aim-ahead rule, which targeted the rank after next —
 * its Jonin 5,340 → "1,660 RP to Shogun" worked example was
 * drawn from placeholder thresholds and is retired with them.)
 *
 * NO FLOOR (owner decision 2026-11-11): the standing is a pure
 * function of the RP handed in. A player whose RP falls below
 * their rank's threshold derives the lower rank — demotion is
 * real. Callers must pass CURRENT rp, never stats.peakRP
 * (peakRank is a separate, historical fact).
 *
 * Negative RP reads as the bottom rank; Pirate King is
 * open-ended (fraction 1).
 */
export function ladderForRp(rp: number): LadderStandingFacts {
  const safe = Number.isFinite(rp) ? Math.max(0, Math.floor(rp)) : 0;
  let idx = 0;
  for (let i = 0; i < LADDER_RANKS.length; i++) {
    if (safe >= LADDER_RANKS[i].min) idx = i;
    else break;
  }
  const cur = LADDER_RANKS[idx];
  const target = LADDER_RANKS[idx + 1] ?? null;
  if (!target) {
    return { rank: cur.rank, index: idx, nextRank: null, toNext: 0, fraction: 1 };
  }
  const span = target.min - cur.min;
  const done = Math.min(Math.max(safe - cur.min, 0), span);
  return {
    rank: cur.rank,
    index: idx,
    nextRank: target.rank,
    toNext: target.min - safe,
    fraction: span > 0 ? done / span : 1,
  };
}

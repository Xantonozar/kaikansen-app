import {
  buildRoundOptions,
  buildSoloOptions,
  creditedLoadMs,
  effectiveQuestionStart,
  generateRoomCode,
  getBaseRP,
  getStreakBonus,
  getThemeValue,
  getTierFromRP,
  LADDER_RANKS,
  ladderForRp,
  multiplayerScoreFor,
  secondsRemainingAt,
  shouldAutoLock,
  SOLO_LOAD_CREDIT_CAP_MS,
  soloScoreFor,
  type QuizThemeLike,
} from './quiz-game.utils';

const theme: QuizThemeLike = {
  _id: 't1',
  animeTitle: 'Romaji Title',
  animeTitleEnglish: 'English Title',
  animeTitleAlternative: ['Alt Title'],
  songTitle: 'The Song',
  artistName: 'The Artist',
};

describe('getThemeValue (web getThemeValue / getCorrectValue)', () => {
  it('derives anime answers preferring the English title', () => {
    expect(getThemeValue(theme, 'anime')).toBe('English Title');
    expect(getThemeValue({ ...theme, animeTitleEnglish: null }, 'anime')).toBe(
      'Romaji Title',
    );
    expect(
      getThemeValue(
        { ...theme, animeTitleEnglish: null, animeTitle: null },
        'anime',
      ),
    ).toBe('Alt Title');
    expect(
      getThemeValue(
        {
          ...theme,
          animeTitleEnglish: null,
          animeTitle: null,
          animeTitleAlternative: [],
        },
        'anime',
      ),
    ).toBe('Unknown Anime');
  });

  it('derives song/title and artist answers with web fallbacks', () => {
    expect(getThemeValue(theme, 'song')).toBe('The Song');
    expect(getThemeValue(theme, 'title')).toBe('The Song');
    expect(getThemeValue({ ...theme, songTitle: null }, 'song')).toBe(
      'Unknown Song',
    );
    expect(getThemeValue(theme, 'artist')).toBe('The Artist');
    expect(getThemeValue({ ...theme, artistName: null }, 'artist')).toBe(
      'Unknown Artist',
    );
    expect(getThemeValue(null, 'anime')).toBe('Unknown');
  });
});

describe('option derivation', () => {
  const distractors: QuizThemeLike[] = [
    { _id: 'd1', animeTitleEnglish: 'Other A' },
    { _id: 'd2', animeTitleEnglish: 'Other B' },
    { _id: 'd3', animeTitleEnglish: 'Other A' }, // duplicate value
    { _id: 'd4', animeTitleEnglish: 'English Title' }, // same as correct
    { _id: 'd5', animeTitleEnglish: 'Other C' },
    { _id: 'd6', animeTitleEnglish: 'Other D' },
  ];

  it('room options dedupe values, drop the correct value, keep 4', () => {
    const options = buildRoundOptions(theme, 'anime', distractors, () => 0.99);
    expect(options).toHaveLength(4);
    expect(new Set(options).size).toBe(4);
    expect(options).toContain('English Title');
    expect(options.filter((o) => o === 'English Title')).toHaveLength(1);
    expect(options).toEqual(
      expect.arrayContaining(['Other A', 'Other B', 'Other C']),
    );
  });

  it('solo options keep the web route’s no-dedup quirk (exactly 3 sampled)', () => {
    const options = buildSoloOptions(
      theme,
      'anime',
      distractors.slice(0, 3),
      () => 0.99,
    );
    expect(options).toHaveLength(4);
    // d1 and d3 both carry 'Other A' — the solo route does not dedupe.
    expect(options.filter((o) => o === 'Other A')).toHaveLength(2);
  });
});

describe('solo scoring (web QuizClient formula)', () => {
  it('scores ceil(secondsRemaining * (1 + streak * 0.1))', () => {
    expect(soloScoreFor(true, 20, 0)).toBe(20);
    expect(soloScoreFor(true, 13, 2)).toBe(Math.ceil(13 * 1.2)); // 16
    expect(soloScoreFor(true, 7, 5)).toBe(Math.ceil(7 * 1.5)); // 11
    expect(soloScoreFor(true, 0, 9)).toBe(0);
  });

  it('scores zero for wrong answers regardless of speed/streak', () => {
    expect(soloScoreFor(false, 20, 0)).toBe(0);
    expect(soloScoreFor(false, 19, 12)).toBe(0);
  });
});

describe('secondsRemainingAt (web answer-route measurement)', () => {
  it('subtracts whole elapsed seconds and floors at 0', () => {
    const start = new Date('2026-11-07T00:00:00.000Z');
    expect(
      secondsRemainingAt(start, 30, new Date('2026-11-07T00:00:10.900Z')),
    ).toBe(20);
    expect(
      secondsRemainingAt(start, 30, new Date('2026-11-07T00:00:45.000Z')),
    ).toBe(0);
    expect(
      secondsRemainingAt(start, 20, new Date('2026-11-07T00:00:00.000Z')),
    ).toBe(20);
  });
});

describe('solo playback-start credit (owner timing fix, 2026-11-10)', () => {
  const draw = new Date('2026-11-10T00:00:00.000Z');

  it('credits nothing when playback was never signalled', () => {
    expect(creditedLoadMs(draw, null)).toBe(0);
    expect(creditedLoadMs(draw, undefined)).toBe(0);
    expect(effectiveQuestionStart(draw, null)).toEqual(draw);
  });

  it('credits the real load time under the cap', () => {
    const played = new Date(draw.getTime() + 2300);
    expect(creditedLoadMs(draw, played)).toBe(2300);
    expect(effectiveQuestionStart(draw, played)).toEqual(played);
  });

  it('caps the credit at SOLO_LOAD_CREDIT_CAP_MS, however late the signal', () => {
    const late = new Date(draw.getTime() + 45_000);
    expect(SOLO_LOAD_CREDIT_CAP_MS).toBe(5000);
    expect(creditedLoadMs(draw, late)).toBe(5000);
    expect(effectiveQuestionStart(draw, late)).toEqual(
      new Date(draw.getTime() + 5000),
    );
  });

  it('never credits negative load (a signal stamped before the draw)', () => {
    const early = new Date(draw.getTime() - 1000);
    expect(creditedLoadMs(draw, early)).toBe(0);
    expect(effectiveQuestionStart(draw, early)).toEqual(draw);
  });
});

describe('multiplayer scoring (owner formula, spec 2026-11-10)', () => {
  it('correct = secondsRemaining × (players not yet answered + 1)', () => {
    // First answerer in a 4-player room: nobody has answered, so
    // 3 others are pending → multiplier 4.
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 12,
        playerCount: 4,
        answeredCount: 0,
      }),
    ).toEqual({ baseScore: 48, bonusScore: 0, totalScoreGained: 48 });
    // Second answerer: 2 pending → multiplier 3.
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 9,
        playerCount: 4,
        answeredCount: 1,
      }),
    ).toEqual({ baseScore: 27, bonusScore: 0, totalScoreGained: 27 });
    // Duel, first answer: 1 pending → multiplier 2.
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 17,
        playerCount: 2,
        answeredCount: 0,
      }),
    ).toEqual({ baseScore: 34, bonusScore: 0, totalScoreGained: 34 });
  });

  it('the LAST correct answerer still earns remaining time × 1 (the +1)', () => {
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 6,
        playerCount: 4,
        answeredCount: 3,
      }),
    ).toEqual({ baseScore: 6, bonusScore: 0, totalScoreGained: 6 });
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 6,
        playerCount: 2,
        answeredCount: 1,
      }),
    ).toEqual({ baseScore: 6, bonusScore: 0, totalScoreGained: 6 });
  });

  it('wrong answers earn 0 (no negative scoring, no bonus)', () => {
    expect(
      multiplayerScoreFor({
        correct: false,
        secondsRemaining: 17,
        playerCount: 4,
        answeredCount: 0,
      }),
    ).toEqual({ baseScore: 0, bonusScore: 0, totalScoreGained: 0 });
    // A correct answer at 0 seconds remaining also earns 0.
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 0,
        playerCount: 4,
        answeredCount: 0,
      }).totalScoreGained,
    ).toBe(0);
  });
});

describe('shouldAutoLock (web answer route)', () => {
  it('locks the last party player once all-but-one answered', () => {
    expect(
      shouldAutoLock({
        answeredCount: 2,
        playerCount: 3,
        roomType: 'party',
        hasCorrectAnswer: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoLock({
        answeredCount: 1,
        playerCount: 3,
        roomType: 'party',
        hasCorrectAnswer: false,
      }),
    ).toBe(false);
  });

  it('never locks when everyone has answered or the room is solo-sized', () => {
    expect(
      shouldAutoLock({
        answeredCount: 3,
        playerCount: 3,
        roomType: 'party',
        hasCorrectAnswer: true,
      }),
    ).toBe(false);
  });

  it('duel exception: last duelist survives until a correct answer exists', () => {
    expect(
      shouldAutoLock({
        answeredCount: 1,
        playerCount: 2,
        roomType: 'duel',
        hasCorrectAnswer: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoLock({
        answeredCount: 1,
        playerCount: 2,
        roomType: 'duel',
        hasCorrectAnswer: true,
      }),
    ).toBe(true);
  });
});

describe('generateRoomCode (web create route)', () => {
  it('makes 6-char A–Z0–9 codes', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateRoomCode()).toMatch(/^[A-Z0-9]{6}$/);
    }
    expect(generateRoomCode(() => 0)).toBe('AAAAAA');
  });
});

describe('rank math (web lib/rank-utils.ts)', () => {
  it('maps RP to tiers and divisions', () => {
    expect(getTierFromRP(0)).toEqual({
      tier: 'academy',
      division: null,
      newFloor: 0,
    });
    expect(getTierFromRP(399).tier).toBe('academy');
    // Genin spans 400–799 in 3 divisions: bottom is division III.
    expect(getTierFromRP(400)).toEqual({
      tier: 'genin',
      division: 3,
      newFloor: 400,
    });
    expect(getTierFromRP(799).division).toBe(1);
    expect(getTierFromRP(3200)).toEqual({
      tier: 'kage',
      division: null,
      newFloor: 3200,
    });
    expect(getTierFromRP(99999).tier).toBe('kage');
  });

  it('placement RP tables — owner spec 2026-11-10, by mode + player count', () => {
    // Duel.
    expect(getBaseRP(1, 2, 'duel')).toBe(10);
    expect(getBaseRP(2, 2, 'duel')).toBe(-10);
    // Party of 4.
    expect(getBaseRP(1, 4, 'party')).toBe(10);
    expect(getBaseRP(2, 4, 'party')).toBe(5);
    expect(getBaseRP(3, 4, 'party')).toBe(-3);
    expect(getBaseRP(4, 4, 'party')).toBe(-7);
    // Party of 3 (2nd place is the 0 → draw row).
    expect(getBaseRP(1, 3, 'party')).toBe(7);
    expect(getBaseRP(2, 3, 'party')).toBe(0);
    expect(getBaseRP(3, 3, 'party')).toBe(-5);
    // Party of 2.
    expect(getBaseRP(1, 2, 'party')).toBe(5);
    expect(getBaseRP(2, 2, 'party')).toBe(-5);
    // Legacy oversized room (pre-cap): reads the 4-player table,
    // placements past 4th take the last row's value.
    expect(getBaseRP(1, 6, 'party')).toBe(10);
    expect(getBaseRP(6, 6, 'party')).toBe(-7);
  });

  it('win streak bonuses step at 2/3/4/5+', () => {
    expect(getStreakBonus(0)).toBe(0);
    expect(getStreakBonus(1)).toBe(0);
    expect(getStreakBonus(2)).toBe(5);
    expect(getStreakBonus(3)).toBe(10);
    expect(getStreakBonus(4)).toBe(15);
    expect(getStreakBonus(5)).toBe(20);
    expect(getStreakBonus(11)).toBe(20);
  });
});

describe('ladderForRp (app 24-rank ladder, owner spec 2026-11-10)', () => {
  it('has the locked 24 thresholds in ascending order', () => {
    expect(LADDER_RANKS).toHaveLength(24);
    expect(LADDER_RANKS.map((r) => r.min)).toEqual([
      0, 100, 250, 450, 700, 1000, 1400, 1900, 2500, 3200, 4000, 4900,
      5900, 7000, 8200, 9500, 14000, 15700, 19400, 21400, 23500, 25700,
      28000, 30000,
    ]);
    expect(LADDER_RANKS.map((r) => r.rank)).toEqual([
      'academy-student', 'scout', 'mizunoto', 'genin', 'chunin',
      'shinobi', 'assassin', 'firebender', 'kitsune', 'lone-wolf',
      'karasu', 'jonin', 'ronin', 'shogun', 'anbu', 'pilot', 'sannin',
      'berserk', 'wizard-king', 'jinchuriki', 'newtype', 'overlord',
      'shadow-monarch', 'pirate-king',
    ]);
  });

  it('derives the rank at every threshold boundary (min-1, min, min+1)', () => {
    // The progress target is the rank AFTER next (the approved
    // designs' rule — see ladderForRp): target(i) = LADDER[i+2],
    // falling back to LADDER[i+1] for Shadow Monarch.
    const targetOf = (i: number) =>
      LADDER_RANKS[i + 2] ?? LADDER_RANKS[i + 1] ?? null;
    LADDER_RANKS.forEach((entry, i) => {
      const at = ladderForRp(entry.min);
      expect(at.rank).toBe(entry.rank);
      expect(at.index).toBe(i);
      const target = targetOf(i);
      if (target) {
        // At the threshold: fraction 0 toward the target.
        expect(at.nextRank).toBe(target.rank);
        expect(at.toNext).toBe(target.min - entry.min);
        expect(at.fraction).toBe(0);
        // One above the threshold: still this rank.
        const above = ladderForRp(entry.min + 1);
        expect(above.rank).toBe(entry.rank);
        expect(above.toNext).toBe(target.min - entry.min - 1);
      } else {
        // Pirate King's own threshold: terminal standing.
        expect(at.nextRank).toBeNull();
        expect(at.toNext).toBe(0);
        expect(at.fraction).toBe(1);
      }
      if (i > 0) {
        // One below the threshold: the previous rank, whose
        // target is the rank after IT (targetOf(i-1)); at the
        // top that target is Pirate King itself.
        const belowTarget = targetOf(i - 1)!;
        const below = ladderForRp(entry.min - 1);
        expect(below.rank).toBe(LADDER_RANKS[i - 1].rank);
        expect(below.index).toBe(i - 1);
        expect(below.nextRank).toBe(belowTarget.rank);
        expect(below.toNext).toBe(belowTarget.min - (entry.min - 1));
      }
    });
  });

  it('matches the spec worked example: 5,340 RP -> Jonin', () => {
    const s = ladderForRp(5340);
    expect(s.rank).toBe('jonin');
    expect(s.index).toBe(11);
    expect(s.nextRank).toBe('shogun');
    expect(s.toNext).toBe(1660);
    expect(s.fraction).toBeCloseTo(440 / 2100, 10);
  });

  it('treats Pirate King as open-ended', () => {
    for (const rp of [30000, 30001, 31240, 999999]) {
      const s = ladderForRp(rp);
      expect(s.rank).toBe('pirate-king');
      expect(s.index).toBe(23);
      expect(s.nextRank).toBeNull();
      expect(s.toNext).toBe(0);
      expect(s.fraction).toBe(1);
    }
    const belowTop = ladderForRp(29999);
    expect(belowTop.rank).toBe('shadow-monarch');
    expect(belowTop.toNext).toBe(1);
  });

  it('floors at Academy Student for zero and negative RP', () => {
    for (const rp of [0, -1, -5000]) {
      const s = ladderForRp(rp);
      expect(s.rank).toBe('academy-student');
      expect(s.index).toBe(0);
      // Target is Mizunoto (250) — the rank after next.
      expect(s.nextRank).toBe('mizunoto');
      expect(s.toNext).toBe(250 - Math.max(0, rp));
    }
  });
});

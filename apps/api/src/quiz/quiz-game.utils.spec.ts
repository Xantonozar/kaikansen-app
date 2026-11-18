import {
  buildRoundOptions,
  buildSoloOptions,
  creditedLoadMs,
  distractorFilterFor,
  distinctDistractorValues,
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
  SOLO_LOAD_CREDIT_CAP_MS,
  soloRpForCorrectCount,
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

describe('distractorFilterFor scopes (personal-pool options, 2026-11-12)', () => {
  it('the default call is exactly the web shape (rooms / random regression pin)', () => {
    expect(distractorFilterFor(theme, 'anime')).toEqual({
      _id: { $ne: 't1' },
      isPopular: true,
      videoUrl: { $nin: [null, ''] },
      animeTitle: { $ne: 'Romaji Title' },
    });
    expect(distractorFilterFor(theme, 'song')).toEqual({
      _id: { $ne: 't1' },
      isPopular: true,
      videoUrl: { $nin: [null, ''] },
      songTitle: { $nin: [null, '', 'Unknown', 'The Song'] },
    });
    expect(distractorFilterFor(theme, 'artist')).toEqual({
      _id: { $ne: 't1' },
      isPopular: true,
      videoUrl: { $nin: [null, ''] },
      artistName: { $nin: [null, '', 'Unknown', 'The Artist'] },
    });
  });

  it('the scoped call drops isPopular, carries the pool $or, and keeps the value exclusions', () => {
    const poolOr = [{ anilistId: { $in: [11, 22] } }];
    const scoped = distractorFilterFor(theme, 'anime', {
      popularOnly: false,
      poolOr,
    });
    expect(scoped).toEqual({
      _id: { $ne: 't1' },
      videoUrl: { $nin: [null, ''] },
      $or: poolOr,
      animeTitle: { $ne: 'Romaji Title' },
    });
    expect(scoped).not.toHaveProperty('isPopular');
    expect(
      distractorFilterFor(theme, 'artist', { popularOnly: false, poolOr }),
    ).toEqual({
      _id: { $ne: 't1' },
      videoUrl: { $nin: [null, ''] },
      $or: poolOr,
      artistName: { $nin: [null, '', 'Unknown', 'The Artist'] },
    });
  });
});

describe('distinctDistractorValues (shared selection semantics)', () => {
  const candidates: QuizThemeLike[] = [
    { _id: 'd1', animeTitleEnglish: 'Other A' },
    { _id: 'd2', animeTitleEnglish: 'Other B' },
    { _id: 'd3', animeTitleEnglish: 'Other A' }, // duplicate value
    { _id: 'd4', animeTitleEnglish: 'English Title' }, // the correct value
    { _id: 'd5', animeTitleEnglish: 'Other C' },
    { _id: 'd6', animeTitleEnglish: 'Other D' },
  ];

  it('keeps the first 3 distinct values, correct value excluded', () => {
    expect(distinctDistractorValues(theme, 'anime', candidates)).toEqual([
      'Other A',
      'Other B',
      'Other C',
    ]);
  });

  it('honours excludeValues and a smaller limit (the popular top-up shape)', () => {
    expect(
      distinctDistractorValues(theme, 'anime', candidates, ['Other A'], 2),
    ).toEqual(['Other B', 'Other C']);
    expect(distinctDistractorValues(theme, 'anime', candidates, [], 1)).toEqual([
      'Other A',
    ]);
  });
});

describe('solo scoring (web QuizClient formula + owner negative marking, 2026-11-12)', () => {
  it('scores ceil(secondsRemaining * (1 + streak * 0.1))', () => {
    expect(soloScoreFor(true, 20, 0, true)).toBe(20);
    expect(soloScoreFor(true, 13, 2, true)).toBe(Math.ceil(13 * 1.2)); // 16
    expect(soloScoreFor(true, 7, 5, true)).toBe(Math.ceil(7 * 1.5)); // 11
    expect(soloScoreFor(true, 0, 9, true)).toBe(0);
  });

  it('a wrong SUBMITTED answer costs −half the would-be correct score, rounded up', () => {
    // wouldBe = ceil(19 * 1.1) = 21 → −ceil(21 / 2) = −11.
    expect(soloScoreFor(false, 19, 1, true)).toBe(-11);
    // wouldBe = 20 at no streak → −10.
    expect(soloScoreFor(false, 20, 0, true)).toBe(-10);
    // The streak BEFORE the answer feeds the penalty too:
    // wouldBe = ceil(20 * 1.5) = 30 → −15.
    expect(soloScoreFor(false, 20, 5, true)).toBe(-15);
    // wouldBe = 0 (no time left) → no penalty either.
    expect(soloScoreFor(false, 0, 3, true)).toBe(0);
  });

  it('skip/timeout (no submission) still scores 0, never a penalty', () => {
    expect(soloScoreFor(false, 20, 0, false)).toBe(0);
    expect(soloScoreFor(false, 19, 12, false)).toBe(0);
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

  it('a wrong SUBMITTED answer costs −half the would-be correct score, rounded up', () => {
    // First answerer in a 4-player room at 17s: wouldBe = 17 × 4
    // = 68 → −34, carried in baseScore; bonusScore stays 0.
    expect(
      multiplayerScoreFor({
        correct: false,
        secondsRemaining: 17,
        playerCount: 4,
        answeredCount: 0,
      }),
    ).toEqual({ baseScore: -34, bonusScore: 0, totalScoreGained: -34 });
    // The LAST answerer (×1): wouldBe = 9 → −ceil(9 / 2) = −5.
    expect(
      multiplayerScoreFor({
        correct: false,
        secondsRemaining: 9,
        playerCount: 4,
        answeredCount: 3,
      }),
    ).toEqual({ baseScore: -5, bonusScore: 0, totalScoreGained: -5 });
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

describe('soloRpForCorrectCount (owner tiered solo RP, 2026-11-16)', () => {
  it('pays the picked table across the whole 0–10 range', () => {
    expect(soloRpForCorrectCount(10)).toBe(10);
    expect(soloRpForCorrectCount(9)).toBe(10);
    expect(soloRpForCorrectCount(8)).toBe(5);
    expect(soloRpForCorrectCount(7)).toBe(5);
    expect(soloRpForCorrectCount(6)).toBe(2);
    expect(soloRpForCorrectCount(5)).toBe(2);
    // "Under 5 negative" — the built split: 3–4 → −3, 0–2 → −5.
    expect(soloRpForCorrectCount(4)).toBe(-3);
    expect(soloRpForCorrectCount(3)).toBe(-3);
    expect(soloRpForCorrectCount(2)).toBe(-5);
    expect(soloRpForCorrectCount(1)).toBe(-5);
    expect(soloRpForCorrectCount(0)).toBe(-5);
  });
});

describe('ladderForRp (app 24-rank ladder, spec RANK-RP-PLAN-2026-11-11)', () => {
  it('has the locked 24 thresholds in ascending order', () => {
    expect(LADDER_RANKS).toHaveLength(24);
    expect(LADDER_RANKS.map((r) => r.min)).toEqual([
      0, 100, 250, 450, 700, 1100, 1600, 2300, 3200, 4200, 5400, 6800,
      8400, 10200, 12200, 14500, 17000, 19800, 22800, 25800, 28800, 31800,
      33400, 35000,
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
    // The progress target is the NEXT rank (owner decision
    // 2026-11-11 — spec RANK-RP-PLAN-2026-11-11.md):
    // target(i) = LADDER[i+1].
    const targetOf = (i: number) => LADDER_RANKS[i + 1] ?? null;
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
        // target is THIS rank (targetOf(i-1)); at the top that
        // target is Pirate King itself.
        const belowTarget = targetOf(i - 1)!;
        const below = ladderForRp(entry.min - 1);
        expect(below.rank).toBe(LADDER_RANKS[i - 1].rank);
        expect(below.index).toBe(i - 1);
        expect(below.nextRank).toBe(belowTarget.rank);
        expect(below.toNext).toBe(belowTarget.min - (entry.min - 1));
      }
    });
  });

  it('matches the plan worked examples (spec RANK-RP-PLAN-2026-11-11)', () => {
    // 710 RP → Chunin, 390 to Shinobi, fraction (710−700)/(1100−700).
    const zadid = ladderForRp(710);
    expect(zadid.rank).toBe('chunin');
    expect(zadid.index).toBe(4);
    expect(zadid.nextRank).toBe('shinobi');
    expect(zadid.toNext).toBe(390);
    expect(zadid.fraction).toBeCloseTo(10 / 400, 10);
    // 600 RP → Genin, 100 to Chunin (the NEXT rank), fraction
    // (600−450)/(700−450). NOTE: the plan spec's sketch says
    // "toNext 500, next Shinobi" for 600 RP — that pair belongs
    // to the retired aim-ahead rule (Shinobi at 1,100 is the rank
    // after next from Genin); under the plan's own Decision 6
    // (progress target = NEXT rank) the values are Chunin / 100.
    const ddd = ladderForRp(600);
    expect(ddd.rank).toBe('genin');
    expect(ddd.index).toBe(3);
    expect(ddd.nextRank).toBe('chunin');
    expect(ddd.toNext).toBe(100);
    expect(ddd.fraction).toBeCloseTo(150 / 250, 10);
    // 195 RP → Scout, 55 to Mizunoto (the NEXT rank; the plan
    // sketch's "255 to Genin" is the same aim-ahead slip as the
    // 600 RP line — Genin at 450 is two steps from Scout).
    const ccc = ladderForRp(195);
    expect(ccc.rank).toBe('scout');
    expect(ccc.index).toBe(1);
    expect(ccc.nextRank).toBe('mizunoto');
    expect(ccc.toNext).toBe(55);
    expect(ccc.fraction).toBeCloseTo(95 / 150, 10);
  });

  it('has NO floor: an RP drop below a threshold demotes the derived rank', () => {
    // The owner dropped the rank floor (2026-11-11): the
    // derivation is a pure function of CURRENT RP — nothing
    // remembers that 710 was once Chunin.
    expect(ladderForRp(710).rank).toBe('chunin');
    expect(ladderForRp(690).rank).toBe('genin');
    expect(ladderForRp(690).index).toBe(3);
    expect(ladderForRp(699).rank).toBe('genin');
    expect(ladderForRp(700).rank).toBe('chunin');
  });

  it('treats Pirate King as open-ended', () => {
    for (const rp of [35000, 35001, 41240, 999999]) {
      const s = ladderForRp(rp);
      expect(s.rank).toBe('pirate-king');
      expect(s.index).toBe(23);
      expect(s.nextRank).toBeNull();
      expect(s.toNext).toBe(0);
      expect(s.fraction).toBe(1);
    }
    const belowTop = ladderForRp(34999);
    expect(belowTop.rank).toBe('shadow-monarch');
    expect(belowTop.toNext).toBe(1);
  });

  it('floors at Academy Student for zero and negative RP', () => {
    for (const rp of [0, -1, -5000]) {
      const s = ladderForRp(rp);
      expect(s.rank).toBe('academy-student');
      expect(s.index).toBe(0);
      // Target is Scout (100) — the next rank.
      expect(s.nextRank).toBe('scout');
      expect(s.toNext).toBe(100 - Math.max(0, rp));
    }
  });
});

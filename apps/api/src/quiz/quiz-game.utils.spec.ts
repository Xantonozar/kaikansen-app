import {
  buildRoundOptions,
  buildSoloOptions,
  generateRoomCode,
  getBaseRP,
  getStreakBonus,
  getThemeValue,
  getTierFromRP,
  multiplayerScoreFor,
  secondsRemainingAt,
  shouldAutoLock,
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

describe('multiplayer scoring (web answer route)', () => {
  it('correct answers earn +secondsRemaining, wrong answers lose it', () => {
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 17,
        roomType: 'duel',
        playerCount: 2,
        isFirstCorrect: true,
      }),
    ).toEqual({ baseScore: 17, bonusScore: 0, totalScoreGained: 17 });
    expect(
      multiplayerScoreFor({
        correct: false,
        secondsRemaining: 17,
        roomType: 'party',
        playerCount: 4,
        isFirstCorrect: false,
      }),
    ).toEqual({ baseScore: -17, bonusScore: 0, totalScoreGained: -17 });
  });

  it('party first-correct earns 10 × playerCount, later corrects do not', () => {
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 10,
        roomType: 'party',
        playerCount: 4,
        isFirstCorrect: true,
      }),
    ).toEqual({ baseScore: 10, bonusScore: 40, totalScoreGained: 50 });
    expect(
      multiplayerScoreFor({
        correct: true,
        secondsRemaining: 10,
        roomType: 'party',
        playerCount: 4,
        isFirstCorrect: false,
      }).bonusScore,
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

  it('placement RP tables for duel and party', () => {
    expect(getBaseRP(1, 2, 'duel')).toBe(20);
    expect(getBaseRP(2, 2, 'duel')).toBe(-15);
    expect(getBaseRP(1, 6, 'party')).toBe(20);
    expect(getBaseRP(2, 6, 'party')).toBe(10);
    expect(getBaseRP(3, 6, 'party')).toBe(0);
    expect(getBaseRP(4, 6, 'party')).toBe(-5);
    expect(getBaseRP(5, 6, 'party')).toBe(-10);
    expect(getBaseRP(6, 6, 'party')).toBe(-15);
    expect(getBaseRP(9, 9, 'party')).toBe(-15);
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

import { currentSeason, previousSeason } from './season';

describe('currentSeason', () => {
  it.each([
    // [date, expected season, expected year]
    [new Date(2026, 0, 15), 'WINTER', 2026], // mid-January
    [new Date(2026, 1, 28), 'WINTER', 2026], // late February
    [new Date(2026, 2, 1), 'SPRING', 2026], // March
    [new Date(2026, 4, 31), 'SPRING', 2026], // late May
    [new Date(2026, 5, 1), 'SUMMER', 2026], // June
    [new Date(2026, 7, 31), 'SUMMER', 2026], // late August
    [new Date(2026, 8, 1), 'FALL', 2026], // September
    [new Date(2026, 10, 7), 'FALL', 2026], // today in the project timeline
    [new Date(2026, 11, 3), 'WINTER', 2027], // December → next year's WINTER
    [new Date(2026, 11, 31), 'WINTER', 2027], // New Year's Eve
  ] as const)('%s → %s %i', (date, season, year) => {
    expect(currentSeason(date)).toEqual({ season, year });
  });
});

describe('previousSeason', () => {
  it.each([
    // [given, expected] — one step back, chronologically
    [{ season: 'FALL', year: 2026 }, { season: 'SUMMER', year: 2026 }],
    [{ season: 'SUMMER', year: 2026 }, { season: 'SPRING', year: 2026 }],
    [{ season: 'SPRING', year: 2026 }, { season: 'WINTER', year: 2026 }],
    // WINTER spans Dec of the year before, so its predecessor is
    // the FALL of the year before.
    [{ season: 'WINTER', year: 2026 }, { season: 'FALL', year: 2025 }],
    [{ season: 'WINTER', year: 2027 }, { season: 'FALL', year: 2026 }],
  ] as const)('%o → %o', (given, expected) => {
    expect(previousSeason(given)).toEqual(expected);
  });

  it('walking back from FALL 2026 visits every season in order', () => {
    const walk: string[] = [];
    let cursor: { season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'; year: number } =
      { season: 'FALL', year: 2026 };
    for (let i = 0; i < 5; i++) {
      cursor = previousSeason(cursor);
      walk.push(`${cursor.season} ${cursor.year}`);
    }
    expect(walk).toEqual([
      'SUMMER 2026',
      'SPRING 2026',
      'WINTER 2026',
      'FALL 2025',
      'SUMMER 2025',
    ]);
  });
});

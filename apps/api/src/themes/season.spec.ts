import { currentSeason } from './season';

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

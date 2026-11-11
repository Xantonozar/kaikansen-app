import { beforeEach, describe, expect, it } from '@jest/globals';
import type { RankLeaderboardEntry } from '@kaikansen/contracts';
import {
  clearBoardMemory,
  planBoardLoad,
  rememberBoard,
  rememberedBoard,
} from './leaderboardMemory';

/* The leaderboard paint-first memory's pure seams (owner
   addendum, 2026-11-11): per-scope remember/recall, the plan
   decision (paint instantly when memory exists; error only
   when it doesn't), success-only storage discipline at the
   seam level, and clear. */

const entry = (userId: string, rp: number): RankLeaderboardEntry =>
  ({ userId, rp }) as unknown as RankLeaderboardEntry;

beforeEach(() => {
  clearBoardMemory();
});

describe('rememberedBoard / rememberBoard', () => {
  it('starts empty for both scopes', () => {
    expect(rememberedBoard('all-time')).toBeNull();
    expect(rememberedBoard('weekly')).toBeNull();
  });

  it('remembers per scope, independently', () => {
    const allTime = [entry('a', 100), entry('b', 90)];
    const weekly = [entry('c', 12)];
    rememberBoard('all-time', allTime);
    rememberBoard('weekly', weekly);
    expect(rememberedBoard('all-time')).toEqual(allTime);
    expect(rememberedBoard('weekly')).toEqual(weekly);
  });

  it('a later success replaces the remembered board', () => {
    rememberBoard('weekly', [entry('a', 1)]);
    const fresher = [entry('a', 2), entry('b', 1)];
    rememberBoard('weekly', fresher);
    expect(rememberedBoard('weekly')).toEqual(fresher);
  });

  it('an empty successful board is remembered as a board, not as nothing', () => {
    rememberBoard('weekly', []);
    expect(rememberedBoard('weekly')).toEqual([]);
    expect(planBoardLoad('weekly').showErrorOnFailure).toBe(false);
  });
});

describe('planBoardLoad', () => {
  it('cold scope: no paint, failures surface the error state', () => {
    expect(planBoardLoad('all-time')).toEqual({
      paint: null,
      showErrorOnFailure: true,
    });
  });

  it('warm scope: paints the remembered rows and stays silent on failure', () => {
    const board = [entry('a', 100)];
    rememberBoard('all-time', board);
    expect(planBoardLoad('all-time')).toEqual({
      paint: board,
      showErrorOnFailure: false,
    });
  });

  it("one scope's memory never warms the other", () => {
    rememberBoard('all-time', [entry('a', 100)]);
    expect(planBoardLoad('weekly')).toEqual({
      paint: null,
      showErrorOnFailure: true,
    });
  });
});

describe('clearBoardMemory', () => {
  it('drops every scope', () => {
    rememberBoard('all-time', [entry('a', 1)]);
    rememberBoard('weekly', [entry('b', 1)]);
    clearBoardMemory();
    expect(rememberedBoard('all-time')).toBeNull();
    expect(rememberedBoard('weekly')).toBeNull();
  });
});

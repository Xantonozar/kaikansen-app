import { describe, expect, it } from '@jest/globals';
import { reconcileResync } from './roomSession';

describe('reconcileResync — finished-match ephemera vs authoritative state (C1)', () => {
  it('a waiting room drops a held game-over event and the old ranks (the ghost case)', () => {
    // The bug: the room screen was reused for a freshly created
    // (waiting) room while still holding the previous match's
    // gameOver round-ended event — phase stayed "ended".
    expect(
      reconcileResync('waiting', {
        roundEndedPresent: true,
        roundEndedGameOver: true,
      }),
    ).toEqual({ dropRoundEnded: true, dropRanks: true });
  });

  it('a waiting room with nothing held drops nothing', () => {
    expect(
      reconcileResync('waiting', {
        roundEndedPresent: false,
        roundEndedGameOver: false,
      }),
    ).toEqual({ dropRoundEnded: false, dropRanks: true });
  });

  it('an in-progress room after a rematch drops the finished game’s event and ranks', () => {
    expect(
      reconcileResync('in_progress', {
        roundEndedPresent: true,
        roundEndedGameOver: true,
      }),
    ).toEqual({ dropRoundEnded: true, dropRanks: true });
  });

  it('an in-progress room mid-reveal keeps its live round-ended event', () => {
    expect(
      reconcileResync('in_progress', {
        roundEndedPresent: true,
        roundEndedGameOver: false,
      }),
    ).toEqual({ dropRoundEnded: false, dropRanks: true });
  });

  it('an ended room keeps both — they are its standings and RP lines', () => {
    expect(
      reconcileResync('ended', {
        roundEndedPresent: true,
        roundEndedGameOver: true,
      }),
    ).toEqual({ dropRoundEnded: false, dropRanks: false });
  });
});

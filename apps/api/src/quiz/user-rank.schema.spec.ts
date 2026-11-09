import * as mongoose from 'mongoose';
import { UserRankSchema } from './user-rank.schema';

/**
 * Bug 2 (multi-user matrix, 2026-11-09) — the deployed build's
 * RankService threw `Cannot read properties of undefined (reading
 * 'totalGames')` on every finished game: a UserRank document
 * created through this schema carried NO stats/season subdocuments
 * (single nested subdocs declared without a default are not
 * instantiated by Mongoose), so the first `stats.totalGames += 1`
 * died before any save and the scheduler's catch swallowed it.
 *
 * These tests construct documents from the REAL schema (no DB
 * needed — construction applies defaults) and pin the invariant
 * the write path depends on.
 */
describe('UserRank schema — stats/season subdocuments always exist', () => {
  const Model = mongoose.model('UserRankSchemaSpec', UserRankSchema);

  it('a freshly created rank doc carries zeroed stats and season', () => {
    const doc = new Model({ userId: 'user-1' });
    expect(doc.stats).toBeDefined();
    expect(doc.stats.totalGames).toBe(0);
    expect(doc.stats.wins).toBe(0);
    expect(doc.stats.peakTier).toBe('academy');
    expect(doc.season).toBeDefined();
    expect(doc.season.seasonId).toBe('all-time');
    expect(doc.season.seasonRP).toBe(0);
  });

  it('a stored row missing the subdocuments hydrates with defaults', async () => {
    // Legacy/shared-DB rows may predate the fields entirely; the
    // write path mutates the subdocs, so they must materialise.
    const hydrated = new Model();
    await hydrated.init({
      _id: new mongoose.Types.ObjectId(),
      userId: 'legacy-user',
      rp: 120,
      tier: 'academy',
      tierFloor: 0,
      currentWinStreak: 0,
      longestWinStreak: 0,
    });
    expect(hydrated.stats).toBeDefined();
    expect(hydrated.stats.totalGames).toBe(0);
    expect(hydrated.season).toBeDefined();
  });
});

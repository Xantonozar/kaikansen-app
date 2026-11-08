import { ServiceUnavailableException } from '@nestjs/common';
import { StatsService } from './stats.service';

/**
 * StatsService unit tests (Slice S8). All four models are in-memory
 * fakes (no live DB); the fake history model's aggregate genuinely
 * runs the $match/$group/$sort/$limit pipeline over its rows, so
 * the top-artists fold is exercised for real.
 */

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.sort = () => q;
  q.skip = () => q;
  q.limit = () => q;
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

function makeModels() {
  const users: Record<string, unknown>[] = [
    { _id: 'user-1', username: 'one', avatarUrl: 'https://img/1.png' },
    { _id: 'user-2', username: 'two', avatarUrl: null },
    { _id: 'user-3', username: 'three', avatarUrl: 'https://img/3.png' },
  ];
  const history: Record<string, unknown>[] = [];
  const themes: Record<string, unknown>[] = [];
  const artists: Record<string, unknown>[] = [];

  const userModel = {
    docs: users,
    countDocuments: jest.fn(() => queryOf(users.length)),
    find: jest.fn((filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] } | undefined)?.$in;
      let rows = users;
      if (inList) {
        rows = rows.filter((u) =>
          inList.some((id) => String(id) === String(u._id)),
        );
      }
      if (filter.avatarUrl) {
        rows = rows.filter((u) => u.avatarUrl != null);
      }
      // A small chain that genuinely applies the service's .limit(3).
      const q: Record<string, unknown> = {};
      q.limit = (n: number) => {
        rows = rows.slice(0, n);
        return q;
      };
      q.select = () => q;
      q.lean = () => q;
      q.exec = async () => rows;
      return q;
    }),
  };

  const historyModel = {
    docs: history,
    distinct: jest.fn((field: string, filter: Record<string, unknown>) => {
      const gt = (filter.viewedAt as { $gt: Date }).$gt;
      const values = history
        .filter((h) => (h.viewedAt as Date) > gt)
        .map((h) => h[field]);
      return queryOf([...new Set(values)]);
    }),
    aggregate: jest.fn(async (pipeline: Record<string, unknown>[]) => {
      const match = (pipeline[0] as { $match: { userId: unknown } }).$match;
      const rows = history.filter(
        (h) => String(h.userId) === String(match.userId),
      );
      const counts = new Map<unknown, number>();
      for (const r of rows) {
        counts.set(r.themeId, (counts.get(r.themeId) ?? 0) + 1);
      }
      const grouped = [...counts.entries()].map(([_id, count]) => ({
        _id,
        count,
      }));
      grouped.sort((a, b) => b.count - a.count);
      const limit = (pipeline[3] as { $limit: number }).$limit;
      return grouped.slice(0, limit);
    }),
  };

  const themeModel = {
    docs: themes,
    find: jest.fn((filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] }).$in;
      return queryOf(
        themes.filter((t) =>
          inList.some((id) => String(id) === String(t._id)),
        ),
      );
    }),
  };

  const artistModel = {
    docs: artists,
    find: jest.fn((filter: Record<string, unknown>) => {
      const inList = (filter.slug as { $in: unknown[] }).$in;
      return queryOf(artists.filter((a) => inList.includes(a.slug)));
    }),
  };

  return { userModel, historyModel, themeModel, artistModel };
}

function makeService() {
  const models = makeModels();
  const service = new StatsService(
    models.userModel as never,
    models.historyModel as never,
    models.themeModel as never,
    models.artistModel as never,
  );
  return { models, service };
}

describe('StatsService — no database configured', () => {
  const service = new StatsService(undefined, undefined, undefined, undefined);

  it('answers 503 from every method', async () => {
    await expect(service.getLiveStats()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getTopArtists('u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('StatsService.getLiveStats', () => {
  it('counts ALL users as "active" (the web’s mislabel) and adds 0–4 noise to the distinct listeners', async () => {
    const { models, service } = makeService();
    const now = Date.now();
    models.historyModel.docs.push(
      { userId: 'user-1', viewedAt: new Date(now - 60_000) },
      { userId: 'user-1', viewedAt: new Date(now - 30_000) },
      { userId: 'user-3', viewedAt: new Date(now - 5 * 60_000) },
      // Outside the 10-minute window: not a listener.
      { userId: 'user-2', viewedAt: new Date(now - 30 * 60_000) },
    );

    const res = await service.getLiveStats();

    expect(res.activeUsers).toBe(3);
    // 2 distinct recent listeners + the web's random 0–4 noise.
    expect(res.listeningNow).toBeGreaterThanOrEqual(2);
    expect(res.listeningNow).toBeLessThanOrEqual(6);
    expect(models.historyModel.distinct).toHaveBeenCalledWith(
      'userId',
      expect.objectContaining({ viewedAt: expect.anything() }),
    );
    const windowArg = (
      models.historyModel.distinct.mock.calls[0][1] as {
        viewedAt: { $gt: Date };
      }
    ).viewedAt.$gt;
    expect(Date.now() - windowArg.getTime()).toBeGreaterThanOrEqual(
      10 * 60 * 1000 - 1000,
    );
    expect(Date.now() - windowArg.getTime()).toBeLessThanOrEqual(
      10 * 60 * 1000 + 1000,
    );
    // Avatars of the recent listeners who HAVE one (user-2 has none,
    // and is not recent anyway), capped at 3.
    expect(res.listeningAvatars).toEqual([
      'https://img/1.png',
      'https://img/3.png',
    ]);
  });

  it('falls back to the web’s three DiceBear avatars when nobody is listening', async () => {
    const { service } = makeService();
    const res = await service.getLiveStats();
    expect(res.activeUsers).toBe(3);
    expect(res.listeningNow).toBeGreaterThanOrEqual(0);
    expect(res.listeningNow).toBeLessThanOrEqual(4);
    expect(res.listeningAvatars).toEqual([
      'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix',
      'https://api.dicebear.com/7.x/avataaars/svg?seed=Anya',
      'https://api.dicebear.com/7.x/avataaars/svg?seed=Shinji',
    ]);
  });
});

describe('StatsService.getTopArtists', () => {
  it('answers an empty list for a caller with no history', async () => {
    const { models, service } = makeService();
    await expect(service.getTopArtists('user-1')).resolves.toEqual({
      artists: [],
    });
    expect(models.themeModel.find).not.toHaveBeenCalled();
  });

  it('folds the top themes into artists, sums plays, enriches images', async () => {
    const { models, service } = makeService();
    models.themeModel.docs.push(
      { _id: 'theme-a', artistName: 'Artist One', artistSlugs: ['artist_one'] },
      { _id: 'theme-b', artistName: 'Artist One', artistSlugs: ['artist_one'] },
      { _id: 'theme-c', artistName: 'Artist Two', artistSlugs: [] },
      { _id: 'theme-d', artistName: null, artistSlugs: [] },
    );
    models.artistModel.docs.push({
      slug: 'artist_one',
      imageUrl: 'https://img/artist-one.png',
    });
    const plays: [string, number][] = [
      ['theme-a', 3],
      ['theme-b', 2],
      ['theme-c', 4],
      ['theme-d', 1],
    ];
    for (const [themeId, count] of plays) {
      for (let i = 0; i < count; i++) {
        models.historyModel.docs.push({
          userId: 'user-1',
          themeId,
          viewedAt: new Date(),
        });
      }
    }
    // Another user's plays never enter the caller's aggregation.
    models.historyModel.docs.push({
      userId: 'user-2',
      themeId: 'theme-c',
      viewedAt: new Date(),
    });

    const res = await service.getTopArtists('user-1');

    expect(models.historyModel.aggregate).toHaveBeenCalledWith([
      { $match: { userId: 'user-1' } },
      { $group: { _id: '$themeId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);
    // Artist One: 3 + 2 = 5 plays across two themes; Artist Two: 4,
    // slug '' (theme stored none) and no cache row → image null.
    // The null-artist theme contributes nothing.
    expect(res.artists).toEqual([
      {
        name: 'Artist One',
        plays: 5,
        slug: 'artist_one',
        image: 'https://img/artist-one.png',
      },
      { name: 'Artist Two', plays: 4, slug: '', image: null },
    ]);
  });

  it('caps the list at the web’s 6 artists', async () => {
    const { models, service } = makeService();
    for (let i = 1; i <= 7; i++) {
      models.themeModel.docs.push({
        _id: `theme-${i}`,
        artistName: `Artist ${i}`,
        artistSlugs: [`artist_${i}`],
      });
      for (let p = 0; p < i; p++) {
        models.historyModel.docs.push({
          userId: 'user-1',
          themeId: `theme-${i}`,
          viewedAt: new Date(),
        });
      }
    }

    const res = await service.getTopArtists('user-1');
    expect(res.artists).toHaveLength(6);
    expect(res.artists.map((a) => a.plays)).toEqual([7, 6, 5, 4, 3, 2]);
  });
});

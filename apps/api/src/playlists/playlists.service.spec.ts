import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PlaylistsService } from './playlists.service';

/**
 * PlaylistsService unit tests. Both models are in-memory fakes (no
 * live DB); the fake Playlist model applies $set/$push/$pull and
 * bumps updatedAt like Mongoose timestamps do, so list ordering and
 * counter (themes-array) end-states can be asserted for real.
 */

/* Chainable Mongoose-query stand-in that applies sort/skip/limit. */
function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, jest.Mock> = {};
  q.sort = jest.fn((spec: Record<string, number>) => {
    const keys = Object.entries(spec);
    result.sort((a, b) => {
      for (const [key, dir] of keys) {
        const av = a[key] as never;
        const bv = b[key] as never;
        if (av < bv) return -dir;
        if (av > bv) return dir;
      }
      return 0;
    });
    return q;
  });
  q.skip = jest.fn((n: number) => {
    result = result.slice(n);
    return q;
  });
  q.limit = jest.fn((n: number) => {
    result = result.slice(0, n);
    return q;
  });
  q.lean = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';
const THEME_C = '507f1f77bcf86cd799439013';
const THEME_D = '507f1f77bcf86cd799439014';
const DANGLING = '507f1f77bcf86cd799439099';

function makeTheme(overrides: Record<string, unknown> = {}) {
  return {
    _id: THEME_A,
    slug: 'anime_a-op1-1',
    animethemesId: 1,
    songTitle: 'Song A',
    animeTitle: 'Anime A',
    animeTitleEnglish: 'Anime A EN',
    artistName: 'Artist A',
    allArtists: ['Artist A'],
    artistSlugs: ['artist_a'],
    artistRoles: ['performer'],
    anilistId: 42,
    kitsuId: null,
    animeTitleAlternative: [],
    animeSeason: 'FALL',
    animeSeasonYear: 2026,
    animeCoverImage: 'https://example.com/a.jpg',
    animeCoverImageSmall: 'https://example.com/a-small.jpg',
    animeGrillImage: null,
    animeStudios: [],
    animeSeries: [],
    type: 'OP',
    sequence: 1,
    entries: [{ atEntryId: 11, duration: 60 }],
    videoUrl: 'https://example.com/a.webm',
    audioUrl: null,
    mood: [],
    embedding: null,
    avgRating: 0,
    totalRatings: 0,
    totalWatches: 10,
    totalListens: 4,
    duration: 90,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    isPopular: false,
    popularRank: null,
    featuredAt: null,
    ...overrides,
  };
}

function applyPlaylistUpdate(
  doc: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(update)) {
    if (key === '$set') {
      Object.assign(doc, value as Record<string, unknown>);
    } else if (key === '$push') {
      const pushes = value as Record<string, unknown>;
      for (const [field, v] of Object.entries(pushes)) {
        (doc[field] as unknown[]).push(v);
      }
    } else if (key === '$pull') {
      const pulls = value as Record<string, unknown>;
      for (const [field, v] of Object.entries(pulls)) {
        doc[field] = (doc[field] as unknown[]).filter(
          (x) => String(x) !== String(v),
        );
      }
    }
  }
}

function makeModels() {
  const themes: Record<string, unknown>[] = [
    makeTheme(),
    makeTheme({
      _id: THEME_B,
      slug: 'anime_b-ed1-2',
      songTitle: 'Song B',
      animeTitle: 'Anime B',
      type: 'ED',
      animeCoverImage: 'https://example.com/b.jpg',
    }),
    makeTheme({
      _id: THEME_C,
      slug: 'anime_c-op2-3',
      songTitle: 'Song C',
      animeTitle: 'Anime C',
      animeCoverImage: null,
      animeCoverImageSmall: null,
    }),
    makeTheme({
      _id: THEME_D,
      slug: 'anime_d-op1-4',
      songTitle: 'Song D',
      animeTitle: 'Anime D',
      // Same cover as A (mosaic dedupe) and an unknown duration.
      animeCoverImage: 'https://example.com/a.jpg',
      duration: null,
    }),
  ];
  const playlists: Record<string, unknown>[] = [];
  let seq = 0;
  let clock = Date.parse('2026-11-07T00:00:00.000Z');

  const byIdAndUser = (filter: Record<string, unknown>) =>
    playlists.find(
      (p) =>
        String(p._id) === String(filter._id) &&
        String(p.userId) === String(filter.userId),
    ) ?? null;

  const playlistModel = {
    docs: playlists,
    create: jest.fn(async (data: Record<string, unknown>) => {
      const now = new Date((clock += 1000));
      const doc = {
        _id: `507f1f77bcf86cd79943${String(1000 + ++seq)}`,
        createdAt: now,
        updatedAt: now,
        ...data,
        themes: [...((data.themes as unknown[]) ?? [])],
      };
      playlists.push(doc);
      return doc;
    }),
    find: jest.fn((filter: Record<string, unknown>) =>
      chain(
        playlists.filter((p) => String(p.userId) === String(filter.userId)),
      ),
    ),
    findOne: jest.fn((filter: Record<string, unknown>) =>
      queryOf(byIdAndUser(filter)),
    ),
    findById: jest.fn((id: unknown) =>
      queryOf(playlists.find((p) => String(p._id) === String(id)) ?? null),
    ),
    findOneAndUpdate: jest.fn(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const doc = byIdAndUser(filter);
        if (doc) {
          applyPlaylistUpdate(doc, update);
          doc.updatedAt = new Date((clock += 1000));
        }
        return queryOf(doc);
      },
    ),
    deleteOne: jest.fn((filter: Record<string, unknown>) => ({
      exec: async () => {
        const idx = playlists.findIndex(
          (p) =>
            String(p._id) === String(filter._id) &&
            String(p.userId) === String(filter.userId),
        );
        if (idx < 0) return { acknowledged: true, deletedCount: 0 };
        playlists.splice(idx, 1);
        return { acknowledged: true, deletedCount: 1 };
      },
    })),
  };

  const themeModel = {
    docs: themes,
    findOne: jest.fn((filter: Record<string, unknown>) =>
      queryOf(themes.find((t) => t.slug === filter.slug) ?? null),
    ),
    find: jest.fn((filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] }).$in;
      return queryOf(
        themes.filter((t) => inList.some((id) => String(id) === String(t._id))),
      );
    }),
  };

  const users: Record<string, unknown>[] = [
    { _id: 'user-1', username: 'zadid', displayName: 'Zadid' },
    { _id: 'user-2', username: 'other_user', displayName: 'Other User' },
  ];
  const userModel = {
    docs: users,
    findById: jest.fn((id: unknown) =>
      queryOf(users.find((u) => String(u._id) === String(id)) ?? null),
    ),
  };

  const playlistActivities: Record<string, unknown>[] = [];
  const playlistActivityModel = {
    docs: playlistActivities,
    create: jest.fn(async (data: Record<string, unknown>) => {
      const now = new Date((clock += 1000));
      const doc = {
        _id: `507f1f77bcf86cd79943${String(2000 + ++seq)}`,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      playlistActivities.push(doc);
      return doc;
    }),
  };

  return { playlistModel, themeModel, userModel, playlistActivityModel };
}

function makeService() {
  const models = makeModels();
  const service = new PlaylistsService(
    models.playlistModel as never,
    models.themeModel as never,
    models.userModel as never,
    models.playlistActivityModel as never,
  );
  return { models, service };
}

describe('PlaylistsService — no database configured', () => {
  const service = new PlaylistsService(undefined, undefined);

  it('answers 503 from every method', async () => {
    await expect(
      service.createPlaylist('u', { name: 'x' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.listMyPlaylists('u')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getPlaylist('507f1f77bcf86cd799439011')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      service.updatePlaylist('u', '507f1f77bcf86cd799439011', {}),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.deletePlaylist('u', '507f1f77bcf86cd799439011'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.addItem('u', '507f1f77bcf86cd799439011', { slug: 's' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      service.removeItem('u', '507f1f77bcf86cd799439011', 's'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('PlaylistsService — create', () => {
  it('creates with the web defaults (empty description, public, no items)', async () => {
    const { service, models } = makeService();
    const created = await service.createPlaylist('user-1', { name: 'My Mix' });
    expect(created.name).toBe('My Mix');
    expect(created.description).toBe('');
    expect(created.isPublic).toBe(true);
    expect(created.themeCount).toBe(0);
    expect(created.items).toEqual([]);
    expect(created.coverImage).toBeNull();
    expect(created.userId).toBe('user-1');
    expect(models.playlistModel.docs).toHaveLength(1);
    expect(models.playlistModel.docs[0].themes).toEqual([]);
  });

  it('honours explicit description and isPublic=false', async () => {
    const { service } = makeService();
    const created = await service.createPlaylist('user-1', {
      name: 'Quiet',
      description: 'for later',
      isPublic: false,
    });
    expect(created.description).toBe('for later');
    expect(created.isPublic).toBe(false);
  });

  it('rejects a missing or blank name with the web’s 400 message', async () => {
    const { service } = makeService();
    for (const bad of [undefined, '', '   ']) {
      await expect(
        service.createPlaylist('user-1', { name: bad as never }),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        message: 'Name is required',
      });
    }
  });

  it('rejects over-length name/description (the web’s schema caps)', async () => {
    const { service } = makeService();
    await expect(
      service.createPlaylist('user-1', { name: 'x'.repeat(101) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createPlaylist('user-1', {
        name: 'ok',
        description: 'x'.repeat(301),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PlaylistsService — list mine', () => {
  it('returns only the caller’s playlists, most recently updated first, with covers', async () => {
    const { service } = makeService();
    const first = await service.createPlaylist('user-1', { name: 'First' });
    await service.createPlaylist('user-2', { name: 'Not mine' });
    const second = await service.createPlaylist('user-1', { name: 'Second' });
    await service.addItem('user-1', first.id, { slug: 'anime_b-ed1-2' });

    const list = await service.listMyPlaylists('user-1');
    expect(list.playlists.map((p) => p.name)).toEqual(['First', 'Second']);
    expect(list.playlists[0].themeCount).toBe(1);
    expect(list.playlists[0].coverImage).toBe('https://example.com/b.jpg');
    expect(list.playlists[0].coverImages).toEqual([
      'https://example.com/b.jpg',
    ]);
    expect(list.playlists[0].totalDurationSeconds).toBe(90);
    expect(list.playlists[1].id).toBe(second.id);
    expect(list.playlists[1].coverImage).toBeNull();
    expect(list.playlists[1].coverImages).toEqual([]);
    expect(list.playlists[1].totalDurationSeconds).toBeNull();
  });

  it('derives mosaic covers (distinct, stored order) and known-duration sums', async () => {
    const { service } = makeService();
    const created = await service.createPlaylist('user-1', {
      name: 'Mixed',
    });
    expect(created.coverImages).toEqual([]);
    expect(created.totalDurationSeconds).toBeNull();
    // A (cover a.jpg, 90s) + D (same cover, unknown duration)
    // + C (no cover, 90s): one distinct cover, 180 known seconds.
    await service.addItem('user-1', created.id, { slug: 'anime_a-op1-1' });
    await service.addItem('user-1', created.id, { slug: 'anime_d-op1-4' });
    const withItems = await service.addItem('user-1', created.id, {
      slug: 'anime_c-op2-3',
    });
    expect(withItems.coverImages).toEqual(['https://example.com/a.jpg']);
    expect(withItems.totalDurationSeconds).toBe(180);

    const onlyUnknown = await service.createPlaylist('user-1', {
      name: 'Unknown lengths',
    });
    const filled = await service.addItem('user-1', onlyUnknown.id, {
      slug: 'anime_d-op1-4',
    });
    expect(filled.coverImages).toEqual(['https://example.com/a.jpg']);
    expect(filled.totalDurationSeconds).toBeNull();
  });
});

describe('PlaylistsService — owner identity (detail)', () => {
  it("resolves the owner's displayName + username from the user document", async () => {
    const { service } = makeService();
    const created = await service.createPlaylist('user-1', { name: 'Mine' });
    expect(created.ownerDisplayName).toBe('Zadid');
    expect(created.ownerUsername).toBe('zadid');
  });

  it("carries the OWNER's name on a public read of someone else's playlist", async () => {
    const { service } = makeService();
    const owned = await service.createPlaylist('user-2', { name: 'Theirs' });
    const read = await service.getPlaylist(owned.id);
    expect(read.ownerDisplayName).toBe('Other User');
    expect(read.ownerUsername).toBe('other_user');
  });

  it('yields nulls when the owner no longer resolves (deleted account)', async () => {
    const { service } = makeService();
    const created = await service.createPlaylist('user-9', { name: 'Ghost' });
    expect(created.ownerDisplayName).toBeNull();
    expect(created.ownerUsername).toBeNull();
  });

  it('yields nulls when no user model is wired (best-effort decoration)', async () => {
    const models = makeModels();
    const service = new PlaylistsService(
      models.playlistModel as never,
      models.themeModel as never,
    );
    const created = await service.createPlaylist('user-1', { name: 'Solo' });
    expect(created.ownerDisplayName).toBeNull();
    expect(created.ownerUsername).toBeNull();
  });
});

describe('PlaylistsService — public read', () => {
  it('serves another user’s PRIVATE playlist with items in stored order (web quirk)', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-2', {
      name: 'Secret',
      isPublic: false,
    });
    await service.addItem('user-2', owned.id, { slug: 'anime_b-ed1-2' });
    await service.addItem('user-2', owned.id, { slug: 'anime_a-op1-1' });

    // No caller identity is even passed — the web route is unauthenticated.
    const read = await service.getPlaylist(owned.id);
    expect(read.isPublic).toBe(false);
    expect(read.userId).toBe('user-2');
    expect(read.items.map((i) => i.slug)).toEqual([
      'anime_b-ed1-2',
      'anime_a-op1-1',
    ]);
    expect(models.playlistModel.docs).toHaveLength(1);
  });

  it('drops dangling stored ids from items but keeps them in themeCount (web populate)', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Gaps' });
    // A dangling id can only arrive via the web's blind push — seed it directly.
    models.playlistModel.docs[0].themes = [DANGLING, THEME_A];
    const read = await service.getPlaylist(owned.id);
    expect(read.themeCount).toBe(2);
    expect(read.items.map((i) => i.slug)).toEqual(['anime_a-op1-1']);
    expect(read.coverImage).toBe('https://example.com/a.jpg');
  });

  it('answers the web’s 404 for unknown and malformed ids', async () => {
    const { service } = makeService();
    await expect(
      service.getPlaylist('507f1f77bcf86cd799439777'),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      message: 'Playlist not found',
    });
    await expect(service.getPlaylist('not-an-id')).rejects.toMatchObject({
      constructor: NotFoundException,
      message: 'Playlist not found',
    });
  });
});

describe('PlaylistsService — owner-only writes', () => {
  it('edits metadata partially, keeping omitted fields', async () => {
    const { service } = makeService();
    const owned = await service.createPlaylist('user-1', {
      name: 'Old',
      description: 'keep me',
      isPublic: true,
    });
    const edited = await service.updatePlaylist('user-1', owned.id, {
      name: 'New',
      isPublic: false,
    });
    expect(edited.name).toBe('New');
    expect(edited.description).toBe('keep me');
    expect(edited.isPublic).toBe(false);
  });

  it('folds non-owner and unknown ids into the web’s one 404', async () => {
    const { service } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mine' });
    for (const [userId, id] of [
      ['user-2', owned.id],
      ['user-1', '507f1f77bcf86cd799439777'],
      ['user-1', 'junk'],
    ] as const) {
      await expect(
        service.updatePlaylist(userId, id, { name: 'X' }),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        message: 'Playlist not found or access denied',
      });
      await expect(service.deletePlaylist(userId, id)).rejects.toMatchObject({
        constructor: NotFoundException,
        message: 'Playlist not found or access denied',
      });
      await expect(
        service.addItem(userId, id, { slug: 'anime_a-op1-1' }),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        message: 'Playlist not found or access denied',
      });
      await expect(
        service.removeItem(userId, id, 'anime_a-op1-1'),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        message: 'Playlist not found or access denied',
      });
    }
    // Nothing was touched by any of the rejected writes.
    const read = await service.getPlaylist(owned.id);
    expect(read.name).toBe('Mine');
    expect(read.themeCount).toBe(0);
  });

  it('rejects a blank rename with the web’s 400 message', async () => {
    const { service } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mine' });
    await expect(
      service.updatePlaylist('user-1', owned.id, { name: '  ' }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: 'Name is required',
    });
  });

  it('deletes for the owner, then 404s on repeat', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mine' });
    await expect(service.deletePlaylist('user-1', owned.id)).resolves.toEqual({
      id: owned.id,
      deleted: true,
    });
    expect(models.playlistModel.docs).toHaveLength(0);
    await expect(service.deletePlaylist('user-1', owned.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getPlaylist(owned.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PlaylistsService — items', () => {
  it('adds in order, no-ops a duplicate, and the count end-state is exact', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mix' });

    await service.addItem('user-1', owned.id, { slug: 'anime_c-op2-3' });
    const two = await service.addItem('user-1', owned.id, {
      slug: 'anime_a-op1-1',
    });
    expect(two.items.map((i) => i.slug)).toEqual([
      'anime_c-op2-3',
      'anime_a-op1-1',
    ]);
    expect(two.themeCount).toBe(2);

    // Duplicate: success, nothing written (the web's early return).
    const dup = await service.addItem('user-1', owned.id, {
      slug: 'anime_c-op2-3',
    });
    expect(dup.themeCount).toBe(2);
    expect(models.playlistModel.docs[0].themes).toHaveLength(2);
    // The stored end-state IS the counter — no other doc moved.
    expect(models.themeModel.docs.map((t) => t.totalWatches)).toEqual([
      10, 10, 10, 10,
    ]);
  });

  it('validates the theme exists (404) and the slug is present (400)', async () => {
    const { service } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mix' });
    await expect(
      service.addItem('user-1', owned.id, { slug: 'nope' }),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      message: 'Theme not found: nope',
    });
    await expect(
      service.addItem('user-1', owned.id, {} as never),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: 'slug is required',
    });
    await expect(
      service.removeItem('user-1', owned.id, 'nope'),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      message: 'Theme not found: nope',
    });
  });

  it('removes stored items and no-ops ones that are not stored', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mix' });
    await service.addItem('user-1', owned.id, { slug: 'anime_a-op1-1' });
    await service.addItem('user-1', owned.id, { slug: 'anime_b-ed1-2' });

    const afterRemove = await service.removeItem(
      'user-1',
      owned.id,
      'anime_a-op1-1',
    );
    expect(afterRemove.items.map((i) => i.slug)).toEqual(['anime_b-ed1-2']);
    expect(afterRemove.themeCount).toBe(1);

    // Not stored anymore: still a success, state unchanged (web filter).
    const noop = await service.removeItem('user-1', owned.id, 'anime_a-op1-1');
    expect(noop.themeCount).toBe(1);
    expect(models.playlistModel.docs[0].themes).toEqual([THEME_B]);
  });
});

describe('PlaylistsService — playlist-add activity records', () => {
  it('records one event per real add, with the name snapshot', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'My Mix' });
    await service.addItem('user-1', owned.id, { slug: 'anime_a-op1-1' });
    await service.addItem('user-1', owned.id, { slug: 'anime_b-ed1-2' });

    const docs = models.playlistActivityModel.docs;
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      userId: 'user-1',
      playlistId: owned.id,
      playlistName: 'My Mix',
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
    });
    expect(docs[1]).toMatchObject({
      playlistName: 'My Mix',
      themeId: THEME_B,
      themeSlug: 'anime_b-ed1-2',
    });
  });

  it('records nothing for a duplicate (no-op) add', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mix' });
    await service.addItem('user-1', owned.id, { slug: 'anime_a-op1-1' });
    await service.addItem('user-1', owned.id, { slug: 'anime_a-op1-1' });
    expect(models.playlistActivityModel.docs).toHaveLength(1);
  });

  it('records a fresh event when a removed theme is re-added', async () => {
    const { service, models } = makeService();
    const owned = await service.createPlaylist('user-1', { name: 'Mix' });
    await service.addItem('user-1', owned.id, { slug: 'anime_a-op1-1' });
    await service.removeItem('user-1', owned.id, 'anime_a-op1-1');
    await service.addItem('user-1', owned.id, { slug: 'anime_a-op1-1' });
    // Two real adds happened (the remove itself records nothing).
    expect(models.playlistActivityModel.docs).toHaveLength(2);
  });

  it('still adds when no activity model is wired', async () => {
    const models = makeModels();
    const bare = new PlaylistsService(
      models.playlistModel as never,
      models.themeModel as never,
      models.userModel as never,
    );
    const owned = await bare.createPlaylist('user-1', { name: 'Mix' });
    const after = await bare.addItem('user-1', owned.id, {
      slug: 'anime_a-op1-1',
    });
    expect(after.themeCount).toBe(1);
    expect(models.playlistActivityModel.docs).toHaveLength(0);
  });
});

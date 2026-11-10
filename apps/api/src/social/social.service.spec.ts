import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SocialService } from './social.service';

/**
 * SocialService unit tests. All six models are in-memory fakes (no
 * live DB). The fakes implement the filter operators the service
 * uses (equality, $in, $and/$or, $regex) and apply sort/skip/limit
 * like Mongoose, so ordering, caps, counter end-states and the
 * notification side effects are asserted for real.
 */

/* ------------------------------------------------------------------ */
/* Filter matching — the subset of Mongo semantics the service uses.   */
/* ------------------------------------------------------------------ */

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (typeof a === 'object' || typeof b === 'object') {
    return String(a) === String(b);
  }
  return false;
}

function fieldMatches(docValue: unknown, condition: unknown): boolean {
  if (
    condition !== null &&
    typeof condition === 'object' &&
    !(condition instanceof Date)
  ) {
    const c = condition as Record<string, unknown>;
    if ('$in' in c) {
      return (c.$in as unknown[]).some((v) => valueEquals(docValue, v));
    }
    if ('$regex' in c) {
      const re = new RegExp(String(c.$regex), String(c.$options ?? ''));
      return re.test(String(docValue ?? ''));
    }
    return valueEquals(docValue, condition);
  }
  return valueEquals(docValue, condition);
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') {
      return (condition as Record<string, unknown>[]).every((f) =>
        matches(doc, f),
      );
    }
    if (key === '$or') {
      return (condition as Record<string, unknown>[]).some((f) =>
        matches(doc, f),
      );
    }
    return fieldMatches(doc[key], condition);
  });
}

/* Chainable Mongoose-query stand-in that applies sort/skip/limit. */
function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, unknown> = {};
  q.sort = (spec: Record<string, number>) => {
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
  };
  q.skip = (n: number) => {
    result = result.slice(n);
    return q;
  };
  q.limit = (n: number) => {
    result = result.slice(0, n);
    return q;
  };
  q.lean = () => q;
  q.select = () => q;
  q.exec = async () => result;
  return q;
}

function queryOf(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => result;
  return q;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390b2';
const CAROL = '507f1f77bcf86cd7994390c3';
const GHOST = '507f1f77bcf86cd7994390d4';
const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';
const THEME_GONE = '507f1f77bcf86cd799439099';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: ALICE,
    username: 'alice',
    displayName: 'Alice A',
    email: 'alice@example.com',
    passwordHash: 'bcrypt-hash-never-served',
    avatarUrl: 'https://example.com/alice.png',
    bio: 'Alice bio',
    totalRatings: 0,
    totalFollowers: 0,
    totalFollowing: 0,
    totalTime: 0,
    isPublic: true,
    anilist: {
      accessToken: 'anilist-secret-token',
      userId: 42,
      username: 'AliceAni',
    },
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

function makeTheme(overrides: Record<string, unknown> = {}) {
  return {
    _id: THEME_A,
    slug: 'anime_a-op1-1',
    songTitle: 'Song A',
    animeTitle: 'Anime A',
    animeTitleEnglish: 'Anime A EN',
    artistName: 'Artist A',
    allArtists: ['Artist A'],
    type: 'OP',
    sequence: 1,
    animeSeason: 'SPRING',
    animeSeasonYear: 2026,
    animeCoverImage: 'https://example.com/a.jpg',
    animeCoverImageSmall: 'https://example.com/a-small.jpg',
    avgRating: 8.5,
    totalRatings: 10,
    totalWatches: 100,
    totalListens: 40,
    isPopular: false,
    popularRank: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Fake models                                                         */
/* ------------------------------------------------------------------ */

function makeModels() {
  const users: Record<string, unknown>[] = [
    makeUser(),
    makeUser({
      _id: BOB,
      username: 'bob',
      displayName: 'Bob B',
      email: 'bob@example.com',
      avatarUrl: null,
      bio: '',
      anilist: undefined,
    }),
    makeUser({
      _id: CAROL,
      username: 'carol',
      displayName: 'Carol C',
      email: 'carol@example.com',
      avatarUrl: null,
      bio: 'Carol bio',
      isPublic: false, // private account: hidden from search only
      anilist: undefined,
    }),
  ];
  const follows: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const ratings: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const themes: Record<string, unknown>[] = [
    makeTheme(),
    makeTheme({ _id: THEME_B, slug: 'anime_b-ed1-2', songTitle: 'Song B' }),
  ];
  let seq = 0;
  let clock = T0;

  const userModel = {
    docs: users,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(users.find((u) => matches(u, filter)) ?? null),
    find: (filter: Record<string, unknown>) =>
      chain(users.filter((u) => matches(u, filter))),
    countDocuments: (filter: Record<string, unknown>) =>
      queryOf(users.filter((u) => matches(u, filter)).length),
    findByIdAndUpdate: (
      id: unknown,
      update: { $inc?: Record<string, number> },
    ) => {
      const doc = users.find((u) => valueEquals(u._id, id));
      if (doc && update.$inc) {
        for (const [field, delta] of Object.entries(update.$inc)) {
          doc[field] = ((doc[field] as number) ?? 0) + delta;
        }
      }
      return queryOf(doc ?? null);
    },
  };

  const followModel = {
    docs: follows,
    /** Test hook: make the next create lose the unique-index race. */
    failNextCreate: false as boolean | { code: number },
    find: (filter: Record<string, unknown>) =>
      chain(follows.filter((f) => matches(f, filter))),
    findOne: (filter: Record<string, unknown>) =>
      queryOf(follows.find((f) => matches(f, filter)) ?? null),
    findOneAndDelete: (filter: Record<string, unknown>) => ({
      exec: async () => {
        const idx = follows.findIndex((f) => matches(f, filter));
        if (idx === -1) return null;
        return follows.splice(idx, 1)[0];
      },
    }),
    create: async (data: Record<string, unknown>) => {
      if (followModel.failNextCreate) {
        const err = followModel.failNextCreate;
        followModel.failNextCreate = false;
        throw err;
      }
      const dup = follows.some(
        (f) =>
          valueEquals(f.followerId, data.followerId) &&
          valueEquals(f.followeeId, data.followeeId),
      );
      if (dup) {
        throw { code: 11000 };
      }
      const now = new Date((clock += 1000));
      const doc = {
        _id: `follow-${++seq}`,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      follows.push(doc);
      return doc;
    },
    seed: (data: Record<string, unknown>) => {
      const doc = { _id: `follow-${++seq}`, ...data };
      follows.push(doc);
      return doc;
    },
  };

  const notificationModel = {
    docs: notifications,
    find: (filter: Record<string, unknown>) =>
      chain(notifications.filter((n) => matches(n, filter))),
    create: async (data: Record<string, unknown>) => {
      const now = new Date((clock += 1000));
      const doc = {
        _id: `notif-${++seq}`,
        entityId: null,
        entityMeta: null,
        read: false,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      notifications.push(doc);
      return doc;
    },
    updateMany: (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ) => ({
      exec: async () => {
        let modifiedCount = 0;
        for (const doc of notifications) {
          if (matches(doc, filter)) {
            Object.assign(doc, update.$set);
            modifiedCount++;
          }
        }
        return { modifiedCount };
      },
    }),
    seed: (data: Record<string, unknown>) => {
      const doc = {
        _id: `notif-${++seq}`,
        entityId: null,
        entityMeta: null,
        read: false,
        ...data,
      };
      notifications.push(doc);
      return doc;
    },
  };

  const ratingModel = {
    docs: ratings,
    find: (filter: Record<string, unknown>) =>
      chain(ratings.filter((r) => matches(r, filter))),
    seed: (data: Record<string, unknown>) => {
      const doc = { _id: `rating-${++seq}`, ...data };
      ratings.push(doc);
      return doc;
    },
  };

  const historyModel = {
    docs: history,
    find: (filter: Record<string, unknown>) =>
      chain(history.filter((h) => matches(h, filter))),
    seed: (data: Record<string, unknown>) => {
      const doc = { _id: `hist-${++seq}`, ...data };
      history.push(doc);
      return doc;
    },
  };

  const themeModel = {
    docs: themes,
    find: (filter: Record<string, unknown>) =>
      chain(themes.filter((t) => matches(t, filter))),
  };

  const ranks: Record<string, unknown>[] = [];
  const userRankModel = {
    docs: ranks,
    find: (filter: Record<string, unknown>) =>
      chain(ranks.filter((r) => matches(r, filter))),
    seed: (data: Record<string, unknown>) => {
      ranks.push(data);
      return data;
    },
  };

  const playlistActivities: Record<string, unknown>[] = [];
  const playlistActivityModel = {
    docs: playlistActivities,
    find: (filter: Record<string, unknown>) =>
      chain(
        playlistActivities.filter((a) => matches(a, filter)),
      ),
    seed: (data: Record<string, unknown>) => {
      const doc = { _id: `pact-${++seq}`, ...data };
      playlistActivities.push(doc);
      return doc;
    },
  };

  return {
    userModel,
    followModel,
    notificationModel,
    ratingModel,
    historyModel,
    themeModel,
    userRankModel,
    playlistActivityModel,
  };
}

type Models = ReturnType<typeof makeModels>;

const TOKENS: Record<string, { userId: string }> = {
  'tok-alice': { userId: ALICE },
  'tok-bob': { userId: BOB },
  'tok-carol': { userId: CAROL },
};

function makeService(models?: Models) {
  const m = models ?? makeModels();
  const auth = {
    verifyAccessToken: (token: string) => {
      const payload = TOKENS[token];
      return payload
        ? { ...payload, username: 'x', email: 'x@example.com', tokenType: 'access' as const }
        : null;
    },
  };
  const service = new SocialService(
    auth as never,
    m.userModel as never,
    m.followModel as never,
    m.notificationModel as never,
    m.ratingModel as never,
    m.historyModel as never,
    m.themeModel as never,
    m.userRankModel as never,
    m.playlistActivityModel as never,
  );
  return { service, models: m };
}

const bearer = (token: string) => `Bearer ${token}`;

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

describe('SocialService — profiles', () => {
  it('serves the web profile projection and nothing private', async () => {
    const { service } = makeService();
    const profile = await service.getProfile('alice');
    expect(profile).toEqual({
      id: ALICE,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
      bio: 'Alice bio',
      totalRatings: 0,
      totalFollowers: 0,
      totalFollowing: 0,
      createdAt: at(0).toISOString(),
      // The listening aggregates ride along (empty fixtures →
      // the zero state: null mean, no themes, no seconds).
      stats: {
        meanRating: null,
        themesListened: 0,
        totalListenedSeconds: 0,
        followersCount: 0,
        followingCount: 0,
      },
    });
    const raw = JSON.stringify(profile);
    expect(raw).not.toContain('alice@example.com');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('bcrypt-hash-never-served');
    expect(raw).not.toContain('anilist-secret-token');
    expect(raw).not.toContain('AliceAni');
  });

  it('looks usernames up lower-cased, like the web', async () => {
    const { service } = makeService();
    const profile = await service.getProfile('ALICE');
    expect(profile.username).toBe('alice');
  });

  it('serves private accounts too — isPublic only gates search', async () => {
    const { service } = makeService();
    const profile = await service.getProfile('carol');
    expect(profile.username).toBe('carol');
  });

  it('404s unknown usernames with the web message', async () => {
    const { service } = makeService();
    await expect(service.getProfile('nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getProfile('nobody')).rejects.toThrow(
      'User not found',
    );
  });

  it('serves stats with the web || 0 fallbacks', async () => {
    const models = makeModels();
    models.userModel.docs[0].totalFollowers = 7;
    models.userModel.docs[0].totalFollowing = 3;
    models.userModel.docs[0].totalTime = 3600;
    models.userModel.docs[0].totalRatings = 12;
    delete models.userModel.docs[1].totalTime; // older doc: field absent
    const { service } = makeService(models);
    await expect(service.getStats('alice')).resolves.toEqual({
      totalFollowers: 7,
      totalFollowing: 3,
      totalTime: 3600,
      totalRatings: 12,
    });
    await expect(service.getStats('bob')).resolves.toMatchObject({
      totalTime: 0,
    });
    await expect(service.getStats('nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers 503 when booted without models', async () => {
    const service = new SocialService({ verifyAccessToken: () => null } as never);
    await expect(service.getProfile('alice')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.getNetwork('alice')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.searchUsers('al')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Network lists                                                       */
/* ------------------------------------------------------------------ */

describe('SocialService — network lists', () => {
  it('returns both lists populated, in follow-storage order', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: BOB, followeeId: ALICE, createdAt: at(1) });
    models.followModel.seed({ followerId: CAROL, followeeId: ALICE, createdAt: at(2) });
    models.followModel.seed({ followerId: ALICE, followeeId: BOB, createdAt: at(3) });
    const { service } = makeService(models);

    const network = await service.getNetwork('alice');
    expect(network.followers.map((u) => u?.username)).toEqual(['bob', 'carol']);
    expect(network.following.map((u) => u?.username)).toEqual(['bob']);
    expect(network.followers[0]).toEqual({
      id: BOB,
      username: 'bob',
      displayName: 'Bob B',
      avatarUrl: null,
      bio: '',
      // App enrichment: no rank document → the default tier; the
      // anonymous read carries no isFollowing field at all.
      tier: 'academy',
    });
    expect(network.followers[0]).not.toHaveProperty('isFollowing');
    // The projection never leaks private fields.
    const raw = JSON.stringify(network);
    expect(raw).not.toContain('@example.com');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('anilist-secret-token');
  });

  it('maps a deleted account in a list to null, like populate', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: GHOST, followeeId: ALICE });
    const { service } = makeService(models);
    const network = await service.getNetwork('alice');
    expect(network.followers).toEqual([null]);
  });

  it('enriches rows with rank tiers — the document’s tier, academy without one', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: BOB, followeeId: ALICE });
    models.followModel.seed({ followerId: CAROL, followeeId: ALICE });
    models.userRankModel.seed({ userId: CAROL, tier: 'chunin', rp: 900 });
    const { service } = makeService(models);
    const network = await service.getNetwork('alice');
    expect(network.followers[0]).toMatchObject({
      username: 'bob',
      tier: 'academy',
    });
    expect(network.followers[1]).toMatchObject({
      username: 'carol',
      tier: 'chunin',
    });
    // The enrichment is a read: it never materialises rank docs.
    expect(models.userRankModel.docs).toHaveLength(1);
  });

  it('enriches rows with the CALLER’s follow state when signed in', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: BOB, followeeId: ALICE });
    models.followModel.seed({ followerId: CAROL, followeeId: ALICE });
    models.followModel.seed({ followerId: ALICE, followeeId: BOB });
    models.followModel.seed({ followerId: BOB, followeeId: CAROL });
    const { service } = makeService(models);

    // Bob views Alice's network: he follows Carol, not himself.
    const asBob = await service.getNetwork('alice', bearer('tok-bob'));
    expect(asBob.followers[0]).toMatchObject({
      username: 'bob',
      isFollowing: false,
    });
    expect(asBob.followers[1]).toMatchObject({
      username: 'carol',
      isFollowing: true,
    });
    expect(asBob.following[0]).toMatchObject({
      username: 'bob',
      isFollowing: false,
    });

    // A forged token is anonymous: no isFollowing field anywhere.
    const forged = await service.getNetwork('alice', bearer('tok-forged'));
    expect(forged.followers[0]).not.toHaveProperty('isFollowing');
    expect(forged.followers[0]).toHaveProperty('tier');
  });

  it('404s unknown usernames', async () => {
    const { service } = makeService();
    await expect(service.getNetwork('nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Follow / unfollow                                                   */
/* ------------------------------------------------------------------ */

describe('SocialService — follow state + follow/unfollow', () => {
  it('answers anonymous callers isFollowing:false without a lookup', async () => {
    const { service } = makeService();
    await expect(
      service.getFollowState(undefined, 'alice'),
    ).resolves.toEqual({ username: 'alice', isFollowing: false });
    // Even for unknown usernames — the web answers before looking up.
    await expect(
      service.getFollowState(undefined, 'nobody'),
    ).resolves.toEqual({ username: 'nobody', isFollowing: false });
    // A token that does not verify is anonymous too.
    await expect(
      service.getFollowState(bearer('tok-forged'), 'alice'),
    ).resolves.toMatchObject({ isFollowing: false });
  });

  it('404s unknown targets for signed-in callers only', async () => {
    const { service } = makeService();
    await expect(
      service.getFollowState(bearer('tok-alice'), 'nobody'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.getFollowState(bearer('tok-alice'), 'bob'),
    ).resolves.toEqual({ username: 'bob', isFollowing: false });
  });

  it('follows: row created, counters inc, follow notification created', async () => {
    const { service, models } = makeService();
    const state = await service.followUser(ALICE, 'bob');
    expect(state).toEqual({ username: 'bob', isFollowing: true });

    expect(models.followModel.docs).toHaveLength(1);
    expect(models.followModel.docs[0]).toMatchObject({
      followerId: ALICE,
      followeeId: BOB,
    });
    const alice = models.userModel.docs.find((u) => u._id === ALICE);
    const bob = models.userModel.docs.find((u) => u._id === BOB);
    expect(alice?.totalFollowing).toBe(1);
    expect(alice?.totalFollowers).toBe(0);
    expect(bob?.totalFollowers).toBe(1);
    expect(bob?.totalFollowing).toBe(0);

    expect(models.notificationModel.docs).toHaveLength(1);
    expect(models.notificationModel.docs[0]).toMatchObject({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
    });

    await expect(
      service.getFollowState(bearer('tok-alice'), 'bob'),
    ).resolves.toEqual({ username: 'bob', isFollowing: true });
  });

  it('treats a duplicate follow as a silent success — nothing moves twice', async () => {
    const { service, models } = makeService();
    await service.followUser(ALICE, 'bob');
    const again = await service.followUser(ALICE, 'bob');
    expect(again).toEqual({ username: 'bob', isFollowing: true });
    expect(models.followModel.docs).toHaveLength(1);
    expect(models.notificationModel.docs).toHaveLength(1);
    const bob = models.userModel.docs.find((u) => u._id === BOB);
    expect(bob?.totalFollowers).toBe(1);
  });

  it('rejects self-follow with the web 400 message and writes nothing', async () => {
    const { service, models } = makeService();
    await expect(service.followUser(ALICE, 'alice')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.followUser(ALICE, 'alice')).rejects.toThrow(
      'Cannot follow yourself',
    );
    expect(models.followModel.docs).toHaveLength(0);
    expect(models.notificationModel.docs).toHaveLength(0);
  });

  it('404s following an unknown user', async () => {
    const { service } = makeService();
    await expect(service.followUser(ALICE, 'nobody')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('survives losing the unique-index race: row exists, counters untouched', async () => {
    const { service, models } = makeService();
    models.followModel.failNextCreate = { code: 11000 };
    const state = await service.followUser(ALICE, 'bob');
    expect(state).toEqual({ username: 'bob', isFollowing: true });
    const bob = models.userModel.docs.find((u) => u._id === BOB);
    expect(bob?.totalFollowers).toBe(0); // the race winner applies them
    expect(models.notificationModel.docs).toHaveLength(0);
  });

  it('unfollows: row removed, counters decremented, notification kept', async () => {
    const { service, models } = makeService();
    await service.followUser(ALICE, 'bob');
    const state = await service.unfollowUser(ALICE, 'bob');
    expect(state).toEqual({ username: 'bob', isFollowing: false });
    expect(models.followModel.docs).toHaveLength(0);
    const alice = models.userModel.docs.find((u) => u._id === ALICE);
    const bob = models.userModel.docs.find((u) => u._id === BOB);
    expect(alice?.totalFollowing).toBe(0);
    expect(bob?.totalFollowers).toBe(0);
    // The web never deletes the follow notification on unfollow.
    expect(models.notificationModel.docs).toHaveLength(1);
  });

  it('treats unfollowing a non-followee as a success no-op', async () => {
    const { service, models } = makeService();
    const state = await service.unfollowUser(ALICE, 'bob');
    expect(state).toEqual({ username: 'bob', isFollowing: false });
    const bob = models.userModel.docs.find((u) => u._id === BOB);
    expect(bob?.totalFollowers).toBe(0); // not -1: no row, no decrement
  });

  it('404s unfollowing an unknown user', async () => {
    const { service } = makeService();
    await expect(
      service.unfollowUser(ALICE, 'nobody'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* ------------------------------------------------------------------ */
/* Per-user activity                                                   */
/* ------------------------------------------------------------------ */

function seedActivity(models: Models) {
  models.ratingModel.seed({
    userId: ALICE,
    themeId: THEME_A,
    themeSlug: 'anime_a-op1-1',
    score: 9,
    mode: 'watch',
    createdAt: at(100),
  });
  models.historyModel.seed({
    userId: ALICE,
    themeId: THEME_B,
    themeSlug: 'anime_b-ed1-2',
    atEntryId: 5,
    mode: 'listen',
    viewedAt: at(200),
  });
  models.ratingModel.seed({
    userId: ALICE,
    themeId: THEME_GONE,
    themeSlug: 'gone-op1-1',
    score: 4,
    mode: 'listen',
    createdAt: at(300),
  });
}

describe('SocialService — per-user activity gate', () => {
  it('serves the owner their own merged activity, newest first', async () => {
    const models = makeModels();
    seedActivity(models);
    const { service } = makeService(models);
    const res = await service.getUserActivity(bearer('tok-alice'), 'alice');
    expect(res.activity.map((a) => a.activityType)).toEqual([
      'rating',
      'watch',
      'rating',
    ]);
    expect(res.activity[0]).toMatchObject({
      themeSlug: 'gone-op1-1',
      score: 4,
      mode: 'listen',
      theme: null, // theme left the catalogue — populate null
    });
    expect(res.activity[1]).toMatchObject({
      themeSlug: 'anime_b-ed1-2',
      score: null,
      theme: { slug: 'anime_b-ed1-2', songTitle: 'Song B' },
    });
    expect(res.activity[2]).toMatchObject({ score: 9, mode: 'watch' });
  });

  it('hides activity from anonymous callers and non-followed callers', async () => {
    const models = makeModels();
    seedActivity(models);
    const { service } = makeService(models);
    await expect(
      service.getUserActivity(undefined, 'alice'),
    ).resolves.toEqual({ activity: [] });
    // Bob follows nobody relevant: alice does not follow bob.
    await expect(
      service.getUserActivity(bearer('tok-bob'), 'alice'),
    ).resolves.toEqual({ activity: [] });
    // Even a forged token is just anonymous here.
    await expect(
      service.getUserActivity(bearer('tok-forged'), 'alice'),
    ).resolves.toEqual({ activity: [] });
  });

  it('serves activity when the OWNER follows the caller (web direction)', async () => {
    const models = makeModels();
    seedActivity(models);
    models.followModel.seed({ followerId: ALICE, followeeId: BOB });
    const { service } = makeService(models);
    const res = await service.getUserActivity(bearer('tok-bob'), 'alice');
    expect(res.activity).toHaveLength(3);
  });

  it('still 404s unknown usernames before the gate', async () => {
    const { service } = makeService();
    await expect(
      service.getUserActivity(bearer('tok-alice'), 'nobody'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('caps each kind at 10 and the merged list at 15', async () => {
    const models = makeModels();
    for (let i = 0; i < 12; i++) {
      models.ratingModel.seed({
        userId: ALICE,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        score: 5,
        mode: 'watch',
        createdAt: at(1000 + i),
      });
      models.historyModel.seed({
        userId: ALICE,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        atEntryId: 1,
        mode: 'watch',
        viewedAt: at(2000 + i),
      });
    }
    const { service } = makeService(models);
    const res = await service.getUserActivity(bearer('tok-alice'), 'alice');
    expect(res.activity).toHaveLength(15);
    expect(
      res.activity.filter((a) => a.activityType === 'watch'),
    ).toHaveLength(10);
  });
});

/* ------------------------------------------------------------------ */
/* Friends-activity feed                                               */
/* ------------------------------------------------------------------ */

describe('SocialService — friends-activity feed', () => {
  it('answers anonymous callers and follow-nobodies an empty feed', async () => {
    const { service } = makeService();
    await expect(service.getFriendsActivity(undefined)).resolves.toEqual({
      activities: [],
      isGlobal: false,
    });
    await expect(
      service.getFriendsActivity(bearer('tok-alice')),
    ).resolves.toEqual({ activities: [], isGlobal: false });
  });

  it('composes watches + ratings of followees, merged newest first', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: ALICE, followeeId: BOB });
    models.followModel.seed({ followerId: ALICE, followeeId: CAROL });
    // Alice also follows a since-deleted account: its rows ARE
    // fetched, then dropped by the web's 'unknown' user filter.
    models.followModel.seed({ followerId: ALICE, followeeId: GHOST });
    // Bob watched recently; Carol rated earlier; Bob rated earliest.
    models.historyModel.seed({
      userId: BOB,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 1,
      mode: 'watch',
      viewedAt: at(300),
    });
    models.ratingModel.seed({
      userId: CAROL,
      themeId: THEME_B,
      themeSlug: 'anime_b-ed1-2',
      score: 8,
      mode: 'watch',
      createdAt: at(200),
    });
    models.ratingModel.seed({
      userId: BOB,
      themeId: THEME_GONE,
      themeSlug: 'gone-op1-1',
      score: 3,
      mode: 'listen',
      createdAt: at(100),
    });
    // Alice's OWN activity is not in her feed (she doesn't follow herself),
    // and a ghost's rows are dropped.
    models.historyModel.seed({
      userId: ALICE,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 1,
      mode: 'watch',
      viewedAt: at(400),
    });
    models.historyModel.seed({
      userId: GHOST,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 1,
      mode: 'watch',
      viewedAt: at(500),
    });

    const { service } = makeService(models);
    const feed = await service.getFriendsActivity(bearer('tok-alice'), '10');
    expect(feed.isGlobal).toBe(false);
    expect(feed.activities.map((a) => [a.user.username, a.type])).toEqual([
      ['bob', 'listening'],
      ['carol', 'liked'],
      ['bob', 'liked'],
    ]);
    // Bob and Carol have no stored avatar — the web's DiceBear
    // fallback (seeded by username) applies to both.
    expect(feed.activities[0].user.avatar).toBe(
      'https://api.dicebear.com/7.x/avataaars/svg?seed=bob',
    );
    expect(feed.activities[1].user.avatar).toBe(
      'https://api.dicebear.com/7.x/avataaars/svg?seed=carol',
    );
    // A theme that left the catalogue keeps the stored slug +
    // fallback title; the enrichment degrades to nulls — except
    // the score, which lives on the rating row itself (Bob's 3).
    expect(feed.activities[2].item).toEqual({
      title: 'Unknown Title',
      slug: 'gone-op1-1',
      artist: null,
      anime: null,
      cover: null,
      score: 3,
      playlistName: null,
    });
    // A catalogue theme enriches fully: artist + anime + cover
    // resolved, and a watch carries no score (Carol's 'liked' row
    // below carries her stored 8).
    expect(feed.activities[0].item).toEqual({
      title: 'Song A',
      slug: 'anime_a-op1-1',
      artist: 'Artist A',
      anime: 'Anime A',
      cover: 'https://example.com/a.jpg',
      score: null,
      playlistName: null,
    });
    expect(feed.activities[1].item.score).toBe(8);
  });

  it('honours the limit: per-kind fetch, merge, slice', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: ALICE, followeeId: BOB });
    for (let i = 0; i < 4; i++) {
      models.historyModel.seed({
        userId: BOB,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        atEntryId: 1,
        mode: 'watch',
        viewedAt: at(100 + i),
      });
    }
    const { service } = makeService(models);
    const feed = await service.getFriendsActivity(bearer('tok-alice'), '2');
    expect(feed.activities).toHaveLength(2);
    // The newest two survive.
    expect(feed.activities[0].timestamp).toBe(at(103).toISOString());
    // Default limit is 3; garbage falls back to it.
    const def = await service.getFriendsActivity(bearer('tok-alice'));
    expect(def.activities).toHaveLength(3);
    const junk = await service.getFriendsActivity(bearer('tok-alice'), 'abc');
    expect(junk.activities).toHaveLength(3);
  });

  it('ignores activity by users the caller does not follow', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: ALICE, followeeId: BOB });
    models.historyModel.seed({
      userId: CAROL,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 1,
      mode: 'watch',
      viewedAt: at(100),
    });
    const { service } = makeService(models);
    await expect(
      service.getFriendsActivity(bearer('tok-alice'), '10'),
    ).resolves.toEqual({ activities: [], isGlobal: false });
  });

  it('merges playlist-add events in timestamp order, with the playlist name', async () => {
    const models = makeModels();
    models.followModel.seed({ followerId: ALICE, followeeId: BOB });
    // Bob watched at 300, added Song B to 'Bob Mix' at 250, rated
    // Song A at 100, and added a since-removed theme to 'Oldies'
    // at 50. Carol's add at 400 is the newest event overall —
    // but Alice does not follow Carol, so it never appears.
    models.historyModel.seed({
      userId: BOB,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      atEntryId: 1,
      mode: 'watch',
      viewedAt: at(300),
    });
    models.playlistActivityModel.seed({
      userId: BOB,
      playlistId: '507f1f77bcf86cd799439021',
      playlistName: 'Bob Mix',
      themeId: THEME_B,
      themeSlug: 'anime_b-ed1-2',
      createdAt: at(250),
    });
    models.ratingModel.seed({
      userId: BOB,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      score: 7,
      mode: 'watch',
      createdAt: at(100),
    });
    models.playlistActivityModel.seed({
      userId: BOB,
      playlistId: '507f1f77bcf86cd799439022',
      playlistName: 'Oldies',
      themeId: THEME_GONE,
      themeSlug: 'gone-op1-1',
      createdAt: at(50),
    });
    models.playlistActivityModel.seed({
      userId: CAROL,
      playlistId: '507f1f77bcf86cd799439023',
      playlistName: 'Carol Mix',
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      createdAt: at(400),
    });

    const { service } = makeService(models);
    const feed = await service.getFriendsActivity(bearer('tok-alice'), '10');
    expect(feed.activities.map((a) => a.type)).toEqual([
      'listening',
      'playlist_add',
      'liked',
      'playlist_add',
    ]);
    // The playlist-add row: theme enriched like every other kind,
    // the playlist's name snapshotted on the record, no score.
    expect(feed.activities[1].user.username).toBe('bob');
    expect(feed.activities[1].item).toEqual({
      title: 'Song B',
      slug: 'anime_b-ed1-2',
      artist: 'Artist A',
      anime: 'Anime A',
      cover: 'https://example.com/a.jpg',
      score: null,
      playlistName: 'Bob Mix',
    });
    expect(feed.activities[1].timestamp).toBe(at(250).toISOString());
    // A theme that left the catalogue: stored slug + fallback
    // title, null enrichment — the snapshotted name still serves.
    expect(feed.activities[3].item).toEqual({
      title: 'Unknown Title',
      slug: 'gone-op1-1',
      artist: null,
      anime: null,
      cover: null,
      score: null,
      playlistName: 'Oldies',
    });
  });

  it('falls back to the small cover when the large cover is missing', async () => {
    const models = makeModels();
    models.themeModel.docs.push(
      makeTheme({
        _id: '507f1f77bcf86cd799439014',
        slug: 'anime_d-op1-4',
        songTitle: 'Song D',
        animeCoverImage: null,
        animeCoverImageSmall: 'https://example.com/d-small.jpg',
      }),
    );
    models.followModel.seed({ followerId: ALICE, followeeId: BOB });
    models.historyModel.seed({
      userId: BOB,
      themeId: '507f1f77bcf86cd799439014',
      themeSlug: 'anime_d-op1-4',
      atEntryId: 1,
      mode: 'listen',
      viewedAt: at(100),
    });
    const { service } = makeService(models);
    const feed = await service.getFriendsActivity(bearer('tok-alice'), '10');
    expect(feed.activities).toHaveLength(1);
    expect(feed.activities[0].item.cover).toBe(
      'https://example.com/d-small.jpg',
    );
  });
});

/* ------------------------------------------------------------------ */
/* User search / discovery                                             */
/* ------------------------------------------------------------------ */

describe('SocialService — user search', () => {
  it('rejects queries under 2 characters with the web message', async () => {
    const { service } = makeService();
    await expect(service.searchUsers('a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.searchUsers('a')).rejects.toThrow(
      'Query too short — minimum 2 characters',
    );
    await expect(service.searchUsers('  ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.searchUsers(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('matches username or display name, case-insensitively', async () => {
    const { service } = makeService();
    const byName = await service.searchUsers('ALI');
    expect(byName.users.map((u) => u.username)).toEqual(['alice']);
    expect(byName.users[0]).toEqual({
      id: ALICE,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
      bio: 'Alice bio',
    });
    const byDisplay = await service.searchUsers('bob b');
    expect(byDisplay.users.map((u) => u.username)).toEqual(['bob']);
  });

  it('requires EVERY word to match (the web $and of $or branches)', async () => {
    const { service } = makeService();
    const both = await service.searchUsers('alice a');
    expect(both.users.map((u) => u.username)).toEqual(['alice']);
    const split = await service.searchUsers('alice bob');
    expect(split.users).toEqual([]);
    expect(split.total).toBe(0);
  });

  it('hides private accounts (isPublic filter)', async () => {
    const { service } = makeService();
    const res = await service.searchUsers('carol');
    expect(res.users).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('escapes regex metacharacters in the query', async () => {
    const models = makeModels();
    models.userModel.docs.push(
      makeUser({
        _id: '507f1f77bcf86cd7994390e5',
        username: 'drwho',
        displayName: 'Dr. Who',
        email: 'dr@example.com',
        anilist: undefined,
      }),
    );
    const { service } = makeService(models);
    const literal = await service.searchUsers('dr.');
    expect(literal.users.map((u) => u.username)).toEqual(['drwho']);
    // '.' must not act as a wildcard: 'drx' is not a substring anywhere.
    const wild = await service.searchUsers('drx');
    expect(wild.users).toEqual([]);
  });

  it('paginates 20 per page with the web hasMore formula', async () => {
    const models = makeModels();
    for (let i = 0; i < 25; i++) {
      models.userModel.docs.push(
        makeUser({
          _id: `507f1f77bcf86cd79944${String(1000 + i)}`,
          username: `fan${String(i).padStart(2, '0')}`,
          displayName: `Fan ${i}`,
          email: `fan${i}@example.com`,
          anilist: undefined,
        }),
      );
    }
    const { service } = makeService(models);
    const page1 = await service.searchUsers('fan', '1');
    expect(page1.users).toHaveLength(20);
    expect(page1.total).toBe(25);
    expect(page1.hasMore).toBe(true);
    const page2 = await service.searchUsers('fan', '2');
    expect(page2.users).toHaveLength(5);
    expect(page2.hasMore).toBe(false);
    // A garbage page falls back to page 1.
    const junk = await service.searchUsers('fan', 'xyz');
    expect(junk.page).toBe(1);
    expect(junk.users).toHaveLength(20);
  });

  it('returns an empty page when the query parses as a theme modifier', async () => {
    const { service } = makeService();
    // Even though 'op' would substring-match nothing anyway, the
    // web skips the USERS branch wholesale when a modifier parses.
    await expect(service.searchUsers('op')).resolves.toEqual({
      query: 'op',
      users: [],
      page: 1,
      total: 0,
      hasMore: false,
    });
    await expect(service.searchUsers('op 9')).resolves.toMatchObject({
      users: [],
      total: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

describe('SocialService — notifications', () => {
  it('lists only the caller’s notifications, newest first, actors resolved', async () => {
    const models = makeModels();
    models.notificationModel.seed({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
      createdAt: at(100),
      updatedAt: at(100),
    });
    models.notificationModel.seed({
      recipientId: BOB,
      actorId: GHOST, // actor account deleted since
      type: 'follow',
      read: true,
      entityId: THEME_A,
      entityMeta: { note: 'kept verbatim' },
      createdAt: at(200),
      updatedAt: at(200),
    });
    models.notificationModel.seed({
      recipientId: ALICE, // someone else's — must not appear
      actorId: BOB,
      type: 'follow',
      read: false,
      createdAt: at(300),
      updatedAt: at(300),
    });
    const { service } = makeService(models);
    const res = await service.listNotifications(BOB);
    expect(res.notifications).toHaveLength(2);
    expect(res.notifications[0]).toMatchObject({
      actor: null, // ghost actor → populate null
      entityId: THEME_A,
      entityMeta: { note: 'kept verbatim' },
      read: true,
    });
    expect(res.notifications[1]).toMatchObject({
      actor: {
        id: ALICE,
        username: 'alice',
        displayName: 'Alice A',
        avatarUrl: 'https://example.com/alice.png',
      },
      entityId: null,
      read: false,
    });
    expect(res.notifications[1].createdAt).toBe(at(100).toISOString());
  });

  it('caps the list at the web’s 50 most recent', async () => {
    const models = makeModels();
    for (let i = 0; i < 55; i++) {
      models.notificationModel.seed({
        recipientId: BOB,
        actorId: ALICE,
        type: 'follow',
        createdAt: at(100 + i),
        updatedAt: at(100 + i),
      });
    }
    const { service } = makeService(models);
    const res = await service.listNotifications(BOB);
    expect(res.notifications).toHaveLength(50);
    expect(res.notifications[0].createdAt).toBe(at(154).toISOString());
    expect(res.notifications[49].createdAt).toBe(at(105).toISOString());
  });

  it('marks only the given ids, and only the caller’s own', async () => {
    const models = makeModels();
    const mine = models.notificationModel.seed({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
      createdAt: at(1),
      updatedAt: at(1),
    });
    const alsoMine = models.notificationModel.seed({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
      createdAt: at(2),
      updatedAt: at(2),
    });
    const alices = models.notificationModel.seed({
      recipientId: ALICE,
      actorId: BOB,
      type: 'follow',
      read: false,
      createdAt: at(3),
      updatedAt: at(3),
    });
    const { service } = makeService(models);
    const res = await service.markNotificationsRead(BOB, [
      mine._id,
      alices._id, // not Bob's — must not be marked
    ]);
    expect(res).toEqual({ markedRead: true });
    const byId = (id: unknown) =>
      models.notificationModel.docs.find((n) => n._id === id);
    expect(byId(mine._id)?.read).toBe(true);
    expect(byId(alsoMine._id)?.read).toBe(false);
    expect(byId(alices._id)?.read).toBe(false);
  });

  it('marks all of the caller’s unread when no id array is given', async () => {
    const models = makeModels();
    models.notificationModel.seed({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
    });
    models.notificationModel.seed({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
    });
    models.notificationModel.seed({
      recipientId: ALICE,
      actorId: BOB,
      type: 'follow',
      read: false,
    });
    const { service } = makeService(models);
    await service.markNotificationsRead(BOB, undefined);
    const bobs = models.notificationModel.docs.filter(
      (n) => n.recipientId === BOB,
    );
    expect(bobs.every((n) => n.read === true)).toBe(true);
    const alices = models.notificationModel.docs.filter(
      (n) => n.recipientId === ALICE,
    );
    expect(alices[0].read).toBe(false);
  });

  it('treats a non-array body field as mark-all, like the web', async () => {
    const models = makeModels();
    models.notificationModel.seed({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
    });
    const { service } = makeService(models);
    await service.markNotificationsRead(BOB, 'not-an-array');
    expect(models.notificationModel.docs[0].read).toBe(true);
  });

  it('an empty id array marks nothing (the web takes the array branch)', async () => {
    const models = makeModels();
    models.notificationModel.seed({
      recipientId: BOB,
      actorId: ALICE,
      type: 'follow',
      read: false,
    });
    const { service } = makeService(models);
    await service.markNotificationsRead(BOB, []);
    expect(models.notificationModel.docs[0].read).toBe(false);
  });
});

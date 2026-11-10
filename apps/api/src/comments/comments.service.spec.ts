import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CommentsService } from './comments.service';

/**
 * CommentsService unit tests. All three models are in-memory fakes
 * (no live DB); the fake Comment model applies sort/skip/limit
 * like Mongoose, so list ordering and paging can be asserted for
 * real.
 */

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

const THEME_A = '507f1f77bcf86cd799439011';
const THEME_B = '507f1f77bcf86cd799439012';
const USER_1 = '507f1f77bcf86cd7994390a1';
const USER_2 = '507f1f77bcf86cd7994390b2';
const GHOST = '507f1f77bcf86cd7994390c3';

function makeTheme(overrides: Record<string, unknown> = {}) {
  return {
    _id: THEME_A,
    slug: 'anime_a-op1-1',
    songTitle: 'Song A',
    animeTitle: 'Anime A',
    ...overrides,
  };
}

function makeModels() {
  const themes: Record<string, unknown>[] = [
    makeTheme(),
    makeTheme({ _id: THEME_B, slug: 'anime_b-ed1-2' }),
  ];
  const users: Record<string, unknown>[] = [
    {
      _id: USER_1,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
    },
    {
      _id: USER_2,
      username: 'bob',
      displayName: 'Bob B',
      avatarUrl: undefined, // older account: no avatar stored
    },
  ];
  const comments: Record<string, unknown>[] = [];
  let seq = 0;
  let clock = Date.parse('2026-11-07T00:00:00.000Z');

  const commentModel = {
    docs: comments,
    find: (filter: Record<string, unknown>) =>
      chain(comments.filter((c) => c.themeSlug === filter.themeSlug)),
    countDocuments: (filter: Record<string, unknown>) => ({
      exec: async () =>
        comments.filter((c) => c.themeSlug === filter.themeSlug).length,
    }),
    create: async (data: Record<string, unknown>) => {
      const now = new Date((clock += 1000));
      const doc = {
        _id: `comment-${++seq}`,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      comments.push(doc);
      return doc;
    },
    /** Test helper: insert a comment with an explicit timestamp. */
    seed: (data: Record<string, unknown>) => {
      const doc = { _id: `comment-${++seq}`, ...data };
      comments.push(doc);
      return doc;
    },
  };

  const themeModel = {
    docs: themes,
    findOne: (filter: Record<string, unknown>) =>
      queryOf(themes.find((t) => t.slug === filter.slug) ?? null),
  };

  const userModel = {
    docs: users,
    find: (filter: Record<string, unknown>) => {
      const inList = (filter._id as { $in: unknown[] }).$in;
      return queryOf(
        users.filter((u) => inList.some((id) => String(id) === String(u._id))),
      );
    },
  };

  return { commentModel, themeModel, userModel };
}

function makeService() {
  const models = makeModels();
  const service = new CommentsService(
    models.commentModel as never,
    models.themeModel as never,
    models.userModel as never,
  );
  return { models, service };
}

/** Await a promise expected to reject and return the error. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('CommentsService — no database configured', () => {
  const service = new CommentsService(undefined, undefined, undefined);

  it('answers 503 from every method', async () => {
    await expect(service.listComments('s')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      service.createComment('u', 's', { content: 'hi' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('CommentsService — listing', () => {
  it('404s an unknown theme slug (existence-check tightening)', async () => {
    const { service } = makeService();
    const err = await rejection(service.listComments('nope'));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Theme not found: nope');
  });

  it('returns an empty list for a theme with no comments', async () => {
    const { service } = makeService();
    await expect(service.listComments('anime_a-op1-1')).resolves.toEqual({
      comments: [],
      page: 1,
      limit: 50,
      total: 0,
      hasMore: false,
    });
  });

  it('lists newest first, only the theme’s own comments, authors resolved', async () => {
    const { models, service } = makeService();
    const t = (iso: string) => new Date(iso);
    models.commentModel.seed({
      userId: USER_1,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      content: 'oldest',
      createdAt: t('2026-11-01T00:00:00.000Z'),
      updatedAt: t('2026-11-01T00:00:00.000Z'),
    });
    models.commentModel.seed({
      userId: USER_2,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      content: 'newest',
      createdAt: t('2026-11-05T00:00:00.000Z'),
      updatedAt: t('2026-11-05T00:00:00.000Z'),
    });
    models.commentModel.seed({
      userId: USER_1,
      themeId: THEME_B,
      themeSlug: 'anime_b-ed1-2',
      content: 'other theme',
      createdAt: t('2026-11-06T00:00:00.000Z'),
      updatedAt: t('2026-11-06T00:00:00.000Z'),
    });

    const res = await service.listComments('anime_a-op1-1');
    expect(res.comments.map((c) => c.content)).toEqual(['newest', 'oldest']);
    expect(res.comments[0].author).toEqual({
      id: USER_2,
      username: 'bob',
      displayName: 'Bob B',
      avatarUrl: null, // absent on the user doc → null, as projected
    });
    expect(res.comments[1].author).toEqual({
      id: USER_1,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
    });
    expect(res.comments[0].themeSlug).toBe('anime_a-op1-1');
    expect(res.comments[0].createdAt).toBe('2026-11-05T00:00:00.000Z');
  });

  it('serves author null for a comment whose author account is gone', async () => {
    const { models, service } = makeService();
    const now = new Date('2026-11-03T00:00:00.000Z');
    models.commentModel.seed({
      userId: GHOST,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      content: 'from a deleted account',
      createdAt: now,
      updatedAt: now,
    });
    const res = await service.listComments('anime_a-op1-1');
    expect(res.comments).toHaveLength(1);
    expect(res.comments[0].author).toBeNull();
  });

  it('pages the list — default 50, next slices with no dupes/gaps, honest meta (fix batch 2026-11-11)', async () => {
    const { models, service } = makeService();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 105; i++) {
      const at = new Date(base + i * 1000);
      models.commentModel.seed({
        userId: USER_1,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        content: `c${i}`,
        createdAt: at,
        updatedAt: at,
      });
    }
    // Default call: page 1 at the default size 50, meta honest.
    const p1 = await service.listComments('anime_a-op1-1');
    expect(p1).toMatchObject({ page: 1, limit: 50, total: 105, hasMore: true });
    expect(p1.comments).toHaveLength(50);
    expect(p1.comments[0].content).toBe('c104'); // newest first
    expect(p1.comments[49].content).toBe('c55');

    // Page 2 is the NEXT slice — no overlap, no gap.
    const p2 = await service.listComments('anime_a-op1-1', { page: '2' });
    expect(p2).toMatchObject({ page: 2, limit: 50, total: 105, hasMore: true });
    expect(p2.comments[0].content).toBe('c54');
    expect(p2.comments[49].content).toBe('c5');

    // Page 3 is the tail; hasMore closes.
    const p3 = await service.listComments('anime_a-op1-1', { page: '3' });
    expect(p3).toMatchObject({ page: 3, total: 105, hasMore: false });
    expect(p3.comments.map((c) => c.content)).toEqual([
      'c4',
      'c3',
      'c2',
      'c1',
      'c0',
    ]);

    // The three pages partition the full set exactly once.
    const all = [...p1.comments, ...p2.comments, ...p3.comments].map(
      (c) => c.id,
    );
    expect(new Set(all).size).toBe(105);
  });

  it('a limit=100 call reproduces the web’s old single-shot cap exactly', async () => {
    const { models, service } = makeService();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 105; i++) {
      const at = new Date(base + i * 1000);
      models.commentModel.seed({
        userId: USER_1,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        content: `c${i}`,
        createdAt: at,
        updatedAt: at,
      });
    }
    const res = await service.listComments('anime_a-op1-1', { limit: '100' });
    expect(res.comments).toHaveLength(100);
    expect(res.comments[0].content).toBe('c104'); // newest kept
    expect(res.comments[99].content).toBe('c5'); // c0–c4 fall off
    // …but the meta now says there ARE more — the old silence is gone.
    expect(res).toMatchObject({ total: 105, hasMore: true });
  });

  it('parses garbage paging params to the defaults', async () => {
    const { service } = makeService();
    const res = await service.listComments('anime_a-op1-1', {
      page: 'banana',
      limit: '-3',
    });
    expect(res).toMatchObject({ page: 1, limit: 50 });
    const capped = await service.listComments('anime_a-op1-1', {
      limit: '999',
    });
    expect(capped.limit).toBe(100);
  });

  it('orders stably across pages when createdAt ties (the _id tie-break)', async () => {
    const { models, service } = makeService();
    const same = new Date('2026-11-02T00:00:00.000Z');
    for (let i = 0; i < 3; i++) {
      models.commentModel.seed({
        userId: USER_1,
        themeId: THEME_A,
        themeSlug: 'anime_a-op1-1',
        content: `tied-${i}`,
        createdAt: same,
        updatedAt: same,
      });
    }
    const p1 = await service.listComments('anime_a-op1-1', { limit: '2' });
    const p2 = await service.listComments('anime_a-op1-1', {
      page: '2',
      limit: '2',
    });
    const ids = [...p1.comments, ...p2.comments].map((c) => c.id);
    expect(new Set(ids).size).toBe(3); // every tied comment exactly once
  });
});

describe('CommentsService — posting', () => {
  it('creates a comment: trimmed, linked to theme + author, returned populated', async () => {
    const { models, service } = makeService();
    const created = await service.createComment(USER_1, 'anime_a-op1-1', {
      content: '  Great OP!  ',
    });
    expect(created.content).toBe('Great OP!');
    expect(created.themeSlug).toBe('anime_a-op1-1');
    expect(created.author).toEqual({
      id: USER_1,
      username: 'alice',
      displayName: 'Alice A',
      avatarUrl: 'https://example.com/alice.png',
    });
    expect(created.createdAt).not.toBe('');

    const stored = models.commentModel.docs;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      userId: USER_1,
      themeId: THEME_A,
      themeSlug: 'anime_a-op1-1',
      content: 'Great OP!',
    });

    // And it is the newest entry in the list.
    const list = await service.listComments('anime_a-op1-1');
    expect(list.comments[0].id).toBe(created.id);
  });

  it('404s an unknown theme slug', async () => {
    const { service } = makeService();
    const err = await rejection(
      service.createComment(USER_1, 'nope', { content: 'hi' }),
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toBe('Theme not found: nope');
  });

  it('rejects missing, non-string and blank content with the web’s 400', async () => {
    const { service } = makeService();
    for (const bad of [undefined, null, 42, '', '   ', '\n\t ']) {
      const err = await rejection(
        service.createComment(USER_1, 'anime_a-op1-1', {
          content: bad as never,
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe('Comment content is required');
    }
    await expect(
      service.createComment(USER_1, 'anime_a-op1-1', undefined as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces the web’s 1000-char cap, measured on the untrimmed string', async () => {
    const { service } = makeService();
    const tooLong = await rejection(
      service.createComment(USER_1, 'anime_a-op1-1', {
        content: 'x'.repeat(1001),
      }),
    );
    expect(tooLong).toBeInstanceOf(BadRequestException);
    expect(tooLong.message).toBe('Comment is too long (max 1000 chars)');
    // Trims to 1 char but is 1001 long raw — still too long (web quirk).
    await expect(
      service.createComment(USER_1, 'anime_a-op1-1', {
        content: `x${' '.repeat(1000)}`,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Exactly 1000 passes.
    const ok = await service.createComment(USER_1, 'anime_a-op1-1', {
      content: 'x'.repeat(1000),
    });
    expect(ok.content).toHaveLength(1000);
  });

  it('validates content before the theme lookup, like the web', async () => {
    const { service } = makeService();
    await expect(
      service.createComment(USER_1, 'nope', { content: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CommentsService — follower activity notifications', () => {
  it('fans a posted comment out to the commenter’s followers', async () => {
    const models = makeModels();
    const notifyFollowers = jest.fn(async () => {});
    const service = new CommentsService(
      models.commentModel as never,
      models.themeModel as never,
      models.userModel as never,
      { notifyFollowers } as never,
    );

    const created = await service.createComment(USER_1, 'anime_a-op1-1', {
      content: 'Great OP!',
    });
    expect(created.content).toBe('Great OP!');
    expect(notifyFollowers).toHaveBeenCalledTimes(1);
    expect(notifyFollowers).toHaveBeenCalledWith({
      actorId: USER_1,
      type: 'comment',
      entityId: THEME_A,
      entityMeta: { themeTitle: 'Song A' },
    });
  });

  it('does not fan out a rejected comment', async () => {
    const models = makeModels();
    const notifyFollowers = jest.fn(async () => {});
    const service = new CommentsService(
      models.commentModel as never,
      models.themeModel as never,
      models.userModel as never,
      { notifyFollowers } as never,
    );

    await expect(
      service.createComment(USER_1, 'anime_a-op1-1', { content: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(notifyFollowers).not.toHaveBeenCalled();
  });
});

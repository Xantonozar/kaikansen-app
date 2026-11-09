import { FollowerActivityService } from './follower-activity.service';

/**
 * FollowerActivityService unit tests. Follow and Notification are
 * in-memory fakes implementing exactly the queries the service
 * issues (followers by followee; the unread-dedupe read with its
 * $in / equality / read:false filter; bulk insertMany), so the
 * fan-out, the actor exclusion, the dedupe window and the
 * failure-swallowing are exercised for real.
 */

type Row = Record<string, unknown>;

/** Chainable query stand-in: select/lean return it, exec resolves. */
function chain(rows: Row[]) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = () => q;
  q.exec = async () => rows;
  return q;
}

function fieldMatches(value: unknown, condition: unknown): boolean {
  if (
    condition !== null &&
    typeof condition === 'object' &&
    '$in' in (condition as Record<string, unknown>)
  ) {
    const list = (condition as { $in: unknown[] }).$in;
    return list.some((v) => String(v) === String(value));
  }
  return String(value) === String(condition);
}

function matches(doc: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, condition]) =>
    fieldMatches(doc[key], condition),
  );
}

function makeModels() {
  const follows: Row[] = [];
  const notifications: Row[] = [];
  let seq = 0;

  const followModel = {
    docs: follows,
    find: (filter: Row) =>
      chain(follows.filter((f) => matches(f, filter))),
  };

  const notificationModel = {
    docs: notifications,
    find: (filter: Row) =>
      chain(notifications.filter((n) => matches(n, filter))),
    insertMany: jest.fn(async (docs: Row[]) => {
      const inserted = docs.map((d) => ({
        _id: `notif-${++seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...d,
      }));
      notifications.push(...inserted);
      return inserted;
    }),
  };

  return { follows, notifications, followModel, notificationModel };
}

function makeService() {
  const models = makeModels();
  const service = new FollowerActivityService(
    models.followModel as never,
    models.notificationModel as never,
  );
  return { models, service };
}

const RATED = {
  actorId: 'actor',
  type: 'theme_rated' as const,
  entityId: 'theme-1',
  entityMeta: { themeTitle: 'Test Song', score: 9 },
};

describe('FollowerActivityService — fan-out', () => {
  it('notifies every follower of the actor in one bulk insert', async () => {
    const { models, service } = makeService();
    models.follows.push(
      { followerId: 'fan-1', followeeId: 'actor' },
      { followerId: 'fan-2', followeeId: 'actor' },
      // Someone else's follower — not the actor's.
      { followerId: 'fan-3', followeeId: 'other-user' },
      // A duplicate follow row must not double-notify.
      { followerId: 'fan-1', followeeId: 'actor' },
    );

    await service.notifyFollowers(RATED);

    expect(models.notificationModel.insertMany).toHaveBeenCalledTimes(1);
    const batch = models.notificationModel.insertMany.mock
      .calls[0][0] as Row[];
    expect(batch.map((d) => d.recipientId).sort()).toEqual([
      'fan-1',
      'fan-2',
    ]);
    for (const doc of batch) {
      expect(doc).toMatchObject({
        actorId: 'actor',
        type: 'theme_rated',
        entityId: 'theme-1',
        entityMeta: { themeTitle: 'Test Song', score: 9 },
        read: false,
      });
    }
    expect(models.notifications).toHaveLength(2);
  });

  it('never notifies the actor, even with a self-follow row', async () => {
    const { models, service } = makeService();
    models.follows.push(
      { followerId: 'actor', followeeId: 'actor' },
      { followerId: 'fan-1', followeeId: 'actor' },
    );

    await service.notifyFollowers(RATED);

    expect(
      models.notifications.map((n) => n.recipientId),
    ).toEqual(['fan-1']);
  });

  it('is a no-op when the actor has no followers', async () => {
    const { models, service } = makeService();

    await service.notifyFollowers(RATED);

    expect(models.notificationModel.insertMany).not.toHaveBeenCalled();
    expect(models.notifications).toHaveLength(0);
  });
});

describe('FollowerActivityService — unread dedupe', () => {
  it('skips a follower who already has the identical notification unread', async () => {
    const { models, service } = makeService();
    models.follows.push(
      { followerId: 'fan-1', followeeId: 'actor' },
      { followerId: 'fan-2', followeeId: 'actor' },
    );
    models.notifications.push({
      recipientId: 'fan-1',
      actorId: 'actor',
      type: 'theme_rated',
      entityId: 'theme-1',
      entityMeta: { themeTitle: 'Test Song', score: 7 },
      read: false,
    });

    await service.notifyFollowers(RATED);

    // fan-1 was covered by the unread row; only fan-2 is inserted.
    expect(models.notifications).toHaveLength(2);
    expect(models.notifications[1].recipientId).toBe('fan-2');
  });

  it('stacks nothing while the row stays unread, then notifies again once read', async () => {
    const { models, service } = makeService();
    models.follows.push({ followerId: 'fan-1', followeeId: 'actor' });

    await service.notifyFollowers(RATED);
    // A re-rate with a new score still dedupes on (recipient, actor,
    // type, entity) while the first row is unread.
    await service.notifyFollowers({
      ...RATED,
      entityMeta: { themeTitle: 'Test Song', score: 10 },
    });
    expect(models.notifications).toHaveLength(1);

    models.notifications[0].read = true;
    await service.notifyFollowers({
      ...RATED,
      entityMeta: { themeTitle: 'Test Song', score: 10 },
    });
    expect(models.notifications).toHaveLength(2);
    expect(models.notifications[1].entityMeta).toEqual({
      themeTitle: 'Test Song',
      score: 10,
    });
  });

  it('treats a different entity or type as a different notification', async () => {
    const { models, service } = makeService();
    models.follows.push({ followerId: 'fan-1', followeeId: 'actor' });
    models.notifications.push(
      {
        recipientId: 'fan-1',
        actorId: 'actor',
        type: 'theme_rated',
        entityId: 'theme-2',
        read: false,
      },
      {
        recipientId: 'fan-1',
        actorId: 'actor',
        type: 'comment',
        entityId: 'theme-1',
        read: false,
      },
    );

    await service.notifyFollowers(RATED);

    expect(models.notifications).toHaveLength(3);
  });
});

describe('FollowerActivityService — failure discipline', () => {
  it('swallows a failing follower lookup', async () => {
    const { models, service } = makeService();
    models.followModel.find = () => {
      throw new Error('db down');
    };

    await expect(service.notifyFollowers(RATED)).resolves.toBeUndefined();
  });

  it('swallows a failing bulk insert', async () => {
    const { models, service } = makeService();
    models.follows.push({ followerId: 'fan-1', followeeId: 'actor' });
    models.notificationModel.insertMany.mockRejectedValue(
      new Error('db down'),
    );

    await expect(service.notifyFollowers(RATED)).resolves.toBeUndefined();
    expect(models.notifications).toHaveLength(0);
  });

  it('is a silent no-op when built without models (no database)', async () => {
    const service = new FollowerActivityService(undefined, undefined);
    await expect(service.notifyFollowers(RATED)).resolves.toBeUndefined();
  });
});

import { Types } from 'mongoose';
import { ChatPushService } from './chat-push.service';
import { ChatPresence } from './chat-presence';

/**
 * ChatPushService tests: the decision matrix is pure; delivery
 * runs against a mocked global fetch (NO real network); token
 * storage is an in-memory fake implementing the chained query
 * shape the service uses.
 */

type Doc = Record<string, unknown>;

class FakeTokenModel {
  docs: Doc[] = [];
  private seq = 0;

  private matches(doc: Doc, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => {
      if (value !== null && typeof value === 'object' && '$in' in (value as object)) {
        return ((value as { $in: unknown[] }).$in).includes(doc[key]);
      }
      return String(doc[key]) === String(value);
    });
  }

  find(filter: Record<string, unknown>) {
    const rows = this.docs.filter((d) => this.matches(d, filter));
    return { lean: () => ({ exec: async () => rows }) };
  }

  findOne(filter: Record<string, unknown>) {
    const row = this.docs.find((d) => this.matches(d, filter)) ?? null;
    return { lean: () => ({ exec: async () => row }) };
  }

  async create(doc: Doc) {
    const created = {
      _id: new Types.ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...doc,
    };
    this.docs.push(created);
    return created;
  }

  updateOne(filter: Record<string, unknown>, update: { $set: Doc }) {
    const row = this.docs.find((d) => this.matches(d, filter));
    if (row) Object.assign(row, update.$set);
    return { exec: async () => ({ modifiedCount: row ? 1 : 0 }) };
  }

  deleteOne(filter: Record<string, unknown>) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !this.matches(d, filter));
    return { exec: async () => ({ deletedCount: before - this.docs.length }) };
  }

  deleteMany(filter: Record<string, unknown>) {
    return this.deleteOne(filter);
  }

  async createIndexes() {
    return [];
  }
}

const ME = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390a2';
const TOKEN = 'ExponentPushToken[abc123]';

function makeService() {
  const model = new FakeTokenModel();
  const presence = new ChatPresence();
  const metricEvents: string[] = [];
  const metrics = {
    inc: (event: string) => {
      metricEvents.push(event);
    },
  };
  const service = new ChatPushService(
    model as never,
    presence as never,
    metrics as never,
  );
  return { service, model, presence, metricEvents };
}

describe('ChatPushService.decide — the push decision matrix', () => {
  const base = {
    kind: 'active' as const,
    muted: false,
    recipientOnline: false,
    isFirstMessage: false,
    lastPushAt: null,
    now: 1_000_000,
  };

  it('sends for an offline recipient in an unmuted active conversation', () => {
    expect(ChatPushService.decide(base)).toEqual({ send: true, reason: 'ok' });
  });

  it('never sends for a muted conversation', () => {
    expect(ChatPushService.decide({ ...base, muted: true })).toEqual({
      send: false,
      reason: 'muted',
    });
  });

  it('skips when the recipient has a live chat socket', () => {
    expect(ChatPushService.decide({ ...base, recipientOnline: true })).toEqual({
      send: false,
      reason: 'recipient-online',
    });
  });

  it('coalesces active-conversation pushes inside 30s per conversation', () => {
    expect(ChatPushService.decide({ ...base, lastPushAt: base.now - 10_000 })).toEqual({
      send: false,
      reason: 'cooldown',
    });
    expect(ChatPushService.decide({ ...base, lastPushAt: base.now - 31_000 })).toEqual({
      send: true,
      reason: 'ok',
    });
  });

  it('requests push only for the FIRST message of the request', () => {
    expect(
      ChatPushService.decide({ ...base, kind: 'request', isFirstMessage: true }),
    ).toEqual({ send: true, reason: 'ok' });
    expect(
      ChatPushService.decide({ ...base, kind: 'request', isFirstMessage: false }),
    ).toEqual({ send: false, reason: 'request-not-first' });
  });
});

describe('ChatPushService — tokens + delivery', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchOk() {
    const calls: { url: string; body: unknown }[] = [];
    global.fetch = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const batch = JSON.parse(init.body) as unknown[];
      return {
        ok: true,
        json: async () => ({
          data: batch.map(() => ({ status: 'ok' })),
        }),
      };
    }) as never;
    return calls;
  }

  it('registers, reassigns and unregisters tokens', async () => {
    const { service, model } = makeService();
    await service.registerToken(ME, TOKEN);
    expect(model.docs).toHaveLength(1);
    // Same physical device, new account → the row moves.
    await service.registerToken(OTHER, TOKEN);
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0].userId).toBe(OTHER);
    await service.unregisterToken(OTHER, TOKEN);
    expect(model.docs).toHaveLength(0);
    // Garbage tokens are rejected, never stored.
    await expect(service.registerToken(ME, 'not-a-token')).rejects.toThrow(
      'valid Expo push token',
    );
    expect(model.docs).toHaveLength(0);
  });

  it('delivers a generic, body-free payload to the recipient tokens', async () => {
    const { service } = makeService();
    const calls = mockFetchOk();
    await service.registerToken(OTHER, TOKEN);
    await service.notifyNewMessage({
      recipientId: OTHER,
      conversationId: '507f1f77bcf86cd7994390c1',
      kind: 'active',
      muted: false,
      senderUsername: 'zadid',
      messageType: 'text',
      isFirstMessage: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('exp.host');
    const sent = (calls[0].body as Record<string, unknown>[])[0];
    expect(sent.to).toBe(TOKEN);
    expect(sent.title).toBe('New message');
    expect(sent.body).toBe('New message from @zadid');
    expect(sent.channelId).toBe('chat-messages');
    expect(JSON.stringify(sent)).not.toContain('secret');
  });

  it('theme shares use the ♪ copy; requests use the request copy', async () => {
    const { service } = makeService();
    const calls = mockFetchOk();
    await service.registerToken(OTHER, TOKEN);
    await service.notifyNewMessage({
      recipientId: OTHER,
      conversationId: '507f1f77bcf86cd7994390c2',
      kind: 'active',
      muted: false,
      senderUsername: 'zadid',
      messageType: 'theme',
      isFirstMessage: false,
    });
    expect((calls[0].body as Record<string, unknown>[])[0].body).toBe('♪ @zadid shared a theme');
  });

  it('drops tokens Expo reports as DeviceNotRegistered', async () => {
    const { service, model, metricEvents } = makeService();
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      }),
    })) as never;
    await service.registerToken(OTHER, TOKEN);
    expect(model.docs).toHaveLength(1);
    await service.notifyNewMessage({
      recipientId: OTHER,
      conversationId: '507f1f77bcf86cd7994390c3',
      kind: 'active',
      muted: false,
      senderUsername: 'zadid',
      messageType: 'text',
      isFirstMessage: false,
    });
    expect(model.docs).toHaveLength(0);
    expect(metricEvents).toContain('pushTokensDropped');
  });

  it('no-ops silently with no tokens and never throws on fetch failure', async () => {
    const { service } = makeService();
    global.fetch = (async () => {
      throw new Error('network down');
    }) as never;
    await expect(
      service.notifyNewMessage({
        recipientId: OTHER,
        conversationId: '507f1f77bcf86cd7994390c4',
        kind: 'active',
        muted: false,
        senderUsername: 'zadid',
        messageType: 'text',
        isFirstMessage: false,
      }),
    ).resolves.toBeUndefined();
    await service.registerToken(OTHER, TOKEN);
    await expect(
      service.notifyNewMessage({
        recipientId: OTHER,
        conversationId: '507f1f77bcf86cd7994390c4',
        kind: 'active',
        muted: false,
        senderUsername: 'zadid',
        messageType: 'text',
        isFirstMessage: false,
      }),
    ).resolves.toBeUndefined();
  });
});

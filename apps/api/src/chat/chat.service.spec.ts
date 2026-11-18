import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatPresence } from './chat-presence';

/**
 * ChatService unit tests. All models are in-memory fakes (no live
 * DB) implementing the filter operators the service uses
 * (equality, array-contains, $in/$ne/$gt/$lt, $and/$or, $regex)
 * plus sort/limit chains and update/delete ops, so the requests
 * model rules, receipts discipline, unread counts and people
 * derivation are asserted for real.
 */

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' || typeof b === 'object') return String(a) === String(b);
  return false;
}

function compare(a: unknown, b: unknown): number {
  // Nulls sort smallest (so descending sorts put them last).
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  return (av as never) < (bv as never) ? -1 : 1;
}

function getPath(doc: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | null)?.[part], doc);
}

function fieldMatches(docValue: unknown, condition: unknown): boolean {
  if (Array.isArray(docValue) && (typeof condition !== 'object' || condition === null)) {
    return docValue.some((v) => valueEquals(v, condition));
  }
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    const c = condition as Record<string, unknown>;
    if ('$in' in c) return (c.$in as unknown[]).some((v) => valueEquals(docValue, v));
    if ('$ne' in c) return !valueEquals(docValue, c.$ne);
    if ('$gt' in c) return compare(docValue, c.$gt) > 0;
    if ('$gte' in c) return compare(docValue, c.$gte) >= 0;
    if ('$lt' in c) return compare(docValue, c.$lt) < 0;
    if ('$lte' in c) return compare(docValue, c.$lte) <= 0;
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
    if (key === '$and') return (condition as Record<string, unknown>[]).every((f) => matches(doc, f));
    if (key === '$or') return (condition as Record<string, unknown>[]).some((f) => matches(doc, f));
    return fieldMatches(doc[key], condition);
  });
}

function chain(docs: Record<string, unknown>[]) {
  let result = [...docs];
  const q: Record<string, unknown> = {};
  q.sort = (spec: Record<string, number>) => {
    const keys = Object.entries(spec);
    result.sort((a, b) => {
      for (const [key, dir] of keys) {
        const c = compare(getPath(a, key), getPath(b, key));
        if (c !== 0) return c * dir;
      }
      return 0;
    });
    return q;
  };
  q.skip = (n: number) => { result = result.slice(n); return q; };
  q.limit = (n: number) => { result = result.slice(0, n); return q; };
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

class FakeModel {
  docs: Record<string, unknown>[] = [];
  private seq = 0;
  constructor(private readonly prefix: string) {}

  private nextId(): string {
    // ObjectId-shaped (24 hex chars) so the service's id-shape
    // guards behave like they do against real Mongoose.
    this.seq += 1;
    return this.seq.toString(16).padStart(24, '0');
  }

  find(filter: Record<string, unknown> = {}) {
    return chain(this.docs.filter((d) => matches(d, filter)));
  }
  findOne(filter: Record<string, unknown> = {}) {
    return queryOf(this.docs.find((d) => matches(d, filter)) ?? null);
  }
  findById(id: unknown) {
    return queryOf(this.docs.find((d) => String(d._id) === String(id)) ?? null);
  }
  async create(doc: Record<string, unknown>) {
    const now = new Date();
    const created = { _id: this.nextId(), createdAt: now, updatedAt: now, ...doc };
    this.docs.push(created);
    return created;
  }
  updateOne(
    filter: Record<string, unknown>,
    update: { $set?: Record<string, unknown> },
    _options?: { timestamps?: boolean },
  ) {
    return {
      exec: async () => {
        const doc = this.docs.find((d) => matches(d, filter));
        if (doc && update.$set) Object.assign(doc, update.$set);
        return { modifiedCount: doc ? 1 : 0 };
      },
    };
  }
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: { $set?: Record<string, unknown> },
  ) {
    const q: Record<string, unknown> = {};
    q.lean = () => q;
    q.select = () => q;
    q.exec = async () => {
      const doc = this.docs.find((d) => matches(d, filter));
      if (!doc) return null;
      if (update.$set) Object.assign(doc, update.$set);
      return doc;
    };
    return q;
  }
  aggregate(pipeline: Record<string, unknown>[]) {
    return {
      exec: async () => {
        let rows: Record<string, unknown>[] = [...this.docs];
        for (const stage of pipeline) {
          if ('$match' in stage) {
            rows = rows.filter((d) =>
              matches(d, stage.$match as Record<string, unknown>),
            );
          } else if ('$group' in stage) {
            const spec = stage.$group as { _id: string };
            const keyField = spec._id.replace(/^\$/, '');
            const grouped = new Map<string, number>();
            for (const row of rows) {
              const key = String(row[keyField]);
              grouped.set(key, (grouped.get(key) ?? 0) + 1);
            }
            return [...grouped.entries()].map(([_id, count]) => ({
              _id,
              count,
            }));
          }
        }
        return rows;
      },
    };
  }
  updateMany(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) {
    return {
      exec: async () => {
        let n = 0;
        for (const doc of this.docs) {
          if (matches(doc, filter)) { if (update.$set) Object.assign(doc, update.$set); n += 1; }
        }
        return { modifiedCount: n };
      },
    };
  }
  deleteMany(filter: Record<string, unknown>) {
    return { exec: async () => { const before = this.docs.length; this.docs = this.docs.filter((d) => !matches(d, filter)); return { deletedCount: before - this.docs.length }; } };
  }
  deleteOne(filter: Record<string, unknown>) {
    return { exec: async () => { const i = this.docs.findIndex((d) => matches(d, filter)); if (i >= 0) this.docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; } };
  }
  countDocuments(filter: Record<string, unknown> = {}) {
    return { exec: async () => this.docs.filter((d) => matches(d, filter)).length };
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ME = '507f1f77bcf86cd7994390a1';
const MOCHI = '507f1f77bcf86cd7994390a2';
const SAKURA = '507f1f77bcf86cd7994390a3';
const LOFI = '507f1f77bcf86cd7994390a4';

interface World {
  service: ChatService;
  presence: ChatPresence;
  emitted: { userId: string; event: string; payload: never }[];
  pushes: Record<string, unknown>[];
  users: FakeModel;
  follows: FakeModel;
  userRanks: FakeModel;
  rankHistories: FakeModel;
  themes: FakeModel;
  conversations: FakeModel;
  messages: FakeModel;
  blocks: FakeModel;
  declines: FakeModel;
  reports: FakeModel;
}

function makeWorld(): World {
  const users = new FakeModel('u');
  users.docs = [
    { _id: ME, username: 'zadid', displayName: 'Zadid', avatarUrl: 'https://img/me.png', isPublic: true, totalFollowers: 10 },
    { _id: MOCHI, username: 'mochichan', displayName: 'MochiChan', avatarUrl: 'https://img/mochi.png', isPublic: true, totalFollowers: 50 },
    { _id: SAKURA, username: 'sakura.wav', displayName: 'sakura.wav', avatarUrl: null, isPublic: true, totalFollowers: 30 },
    { _id: LOFI, username: 'lofisenpai', displayName: 'LofiSenpai', avatarUrl: null, isPublic: true, totalFollowers: 5 },
  ];
  const follows = new FakeModel('f');
  const userRanks = new FakeModel('r');
  userRanks.docs = [
    { _id: 'r1', userId: MOCHI, rp: 2340 },
    { _id: 'r2', userId: ME, rp: 710 },
  ];
  const rankHistories = new FakeModel('h');
  const themes = new FakeModel('t');
  themes.docs = [
    { _id: 't1', slug: 'gurenge', songTitle: 'Gurenge', artistName: 'LiSA', animeTitle: 'Demon Slayer', type: 'OP', sequence: 1, animeCoverImage: 'https://img/gurenge-big.png', animeCoverImageSmall: 'https://img/gurenge-small.png' },
  ];
  const conversations = new FakeModel('c');
  const messages = new FakeModel('m');
  const blocks = new FakeModel('b');
  const declines = new FakeModel('d');
  const reports = new FakeModel('rp');
  const emitted: World['emitted'] = [];
  const pushes: World['pushes'] = [];
  const broadcaster = {
    register: () => undefined,
    emitToUser: (userId: string, event: string, payload: never) => { emitted.push({ userId, event, payload }); },
  };
  const push = {
    notifyNewMessage: async (input: Record<string, unknown>) => { pushes.push(input); },
  };
  const metrics = { inc: () => undefined, snapshot: () => ({}) };
  const presence = new ChatPresence();
  const service = new ChatService(
    broadcaster as never,
    presence as never,
    users as never,
    follows as never,
    userRanks as never,
    rankHistories as never,
    themes as never,
    conversations as never,
    messages as never,
    blocks as never,
    declines as never,
    reports as never,
    push as never,
    metrics as never,
  );
  return { service, presence, emitted, pushes, users, follows, userRanks, rankHistories, themes, conversations, messages, blocks, declines, reports };
}

function follow(world: World, followerId: string, followeeId: string) {
  world.follows.docs.push({ _id: `f-${followerId}-${followeeId}`, followerId, followeeId, createdAt: new Date() });
}

/* ------------------------------------------------------------------ */

describe('ChatService — open conversation / requests model', () => {
  it('starts ACTIVE when the receiver follows the sender', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME); // Mochi follows me → my DM to her is no request
    const res = await w.service.openConversation(ME, MOCHI);
    expect(res.created).toBe(true);
    expect(res.conversation.status).toBe('active');
    expect(res.conversation.requestedBy).toBeNull();
    expect(res.conversation.other.username).toBe('mochichan');
    expect(res.conversation.other.rp).toBe(2340);
    expect(res.conversation.other.ladder.rank).toBeDefined();
  });

  it('starts as REQUEST when the receiver does not follow the sender', async () => {
    const w = makeWorld();
    const res = await w.service.openConversation(ME, SAKURA);
    expect(res.conversation.status).toBe('request');
    expect(res.conversation.requestedBy).toBe(ME);
  });

  it('is a get-or-create: a second open returns the same conversation (pair uniqueness)', async () => {
    const w = makeWorld();
    const first = await w.service.openConversation(ME, MOCHI);
    const second = await w.service.openConversation(MOCHI, ME);
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(w.conversations.docs).toHaveLength(1);
  });

  it('rejects self-messaging, unknown users and blocked pairs', async () => {
    const w = makeWorld();
    await expect(w.service.openConversation(ME, ME)).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.service.openConversation(ME, '507f1f77bcf86cd7994390ff')).rejects.toBeInstanceOf(NotFoundException);
    w.blocks.docs.push({ _id: 'b1', blockerId: SAKURA, blockedId: ME });
    await expect(w.service.openConversation(ME, SAKURA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.service.openConversation(SAKURA, ME)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ChatService — sending + request rules', () => {
  it('lets the requester send in a request, but never the receiver', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    const msg = await w.service.sendMessage(ME, conversation.id, { type: 'text', text: '  hi there  ' });
    expect(msg.text).toBe('hi there');
    expect(msg.readAt).toBeNull();
    await expect(
      w.service.sendMessage(SAKURA, conversation.id, { type: 'text', text: 'reply' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // the receiver got the realtime delivery
    expect(w.emitted).toContainEqual(
      expect.objectContaining({ userId: SAKURA, event: 'chat:message' }),
    );
  });

  it('validates text (empty after trim, too long) and theme slugs', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    await expect(w.service.sendMessage(ME, conversation.id, { type: 'text', text: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'x'.repeat(2001) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.service.sendMessage(ME, conversation.id, { type: 'theme', themeSlug: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('freezes a theme snapshot onto theme messages', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    const msg = await w.service.sendMessage(ME, conversation.id, { type: 'theme', themeSlug: 'gurenge' });
    expect(msg.type).toBe('theme');
    expect(msg.theme).toEqual({
      slug: 'gurenge',
      songTitle: 'Gurenge',
      artistName: 'LiSA',
      animeTitle: 'Demon Slayer',
      type: 'OP',
      sequence: 1,
      coverImage: 'https://img/gurenge-small.png',
    });
    const inbox = await w.service.listConversations(MOCHI);
    expect(inbox.conversations[0].lastMessage?.themeTitle).toBe('Gurenge');
  });
});

describe('ChatService — read receipts discipline', () => {
  it('marks read + emits chat:read in an ACTIVE conversation', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    follow(w, ME, MOCHI);
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'one' });
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'two' });
    await w.service.markRead(MOCHI, conversation.id);
    const stored = w.messages.docs;
    expect(stored.every((m) => m.readAt instanceof Date)).toBe(true);
    expect(w.emitted).toContainEqual(
      expect.objectContaining({ userId: ME, event: 'chat:read' }),
    );
    const page = await w.service.listMessages(ME, conversation.id);
    expect(page.messages.every((m) => m.readAt !== null)).toBe(true);
  });

  it('in a REQUEST the receiver read leaves NO trace: no readAt, no event', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hello?' });
    const emittedBefore = w.emitted.length;
    await w.service.markRead(SAKURA, conversation.id);
    expect(w.messages.docs[0].readAt).toBeNull();
    expect(w.emitted.length).toBe(emittedBefore); // silence
    const page = await w.service.listMessages(ME, conversation.id);
    expect(page.messages[0].readAt).toBeNull(); // sender cannot see it either
    expect(page.status).toBe('request');
  });
});

describe('ChatService — unread counts + inbox/requests split', () => {
  it('counts unread for the receiver, splits requests out of the inbox', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    const active = await w.service.openConversation(ME, MOCHI);
    await w.service.sendMessage(ME, active.conversation.id, { type: 'text', text: 'a' });
    await w.service.sendMessage(ME, active.conversation.id, { type: 'text', text: 'b' });
    const req = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, req.conversation.id, { type: 'text', text: 'please' });

    const mochiInbox = await w.service.listConversations(MOCHI);
    expect(mochiInbox.conversations).toHaveLength(1);
    expect(mochiInbox.conversations[0].unreadCount).toBe(2);
    expect(mochiInbox.totalUnread).toBe(2);
    expect(mochiInbox.requestCount).toBe(0);

    const sakuraInbox = await w.service.listConversations(SAKURA);
    expect(sakuraInbox.conversations).toHaveLength(0);
    expect(sakuraInbox.requestCount).toBe(1);
    const requests = await w.service.listRequests(SAKURA);
    expect(requests.requests).toHaveLength(1);
    expect(requests.requests[0].lastMessage?.text).toBe('please');

    await w.service.markRead(MOCHI, active.conversation.id);
    const after = await w.service.listConversations(MOCHI);
    expect(after.totalUnread).toBe(0);
  });
});

describe('ChatService — accept / decline / block', () => {
  it('accept flips to active, notifies the requester, and unlocks replies + receipts', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' });
    const accepted = await w.service.acceptRequest(SAKURA, conversation.id);
    expect(accepted.status).toBe('active');
    expect(w.emitted).toContainEqual(
      expect.objectContaining({ userId: ME, event: 'chat:request-accepted' }),
    );
    const reply = await w.service.sendMessage(SAKURA, conversation.id, { type: 'text', text: 'ok hi' });
    expect(reply.text).toBe('ok hi');
    await expect(w.service.acceptRequest(SAKURA, conversation.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the requester cannot accept or decline their own request', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await expect(w.service.acceptRequest(ME, conversation.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.service.declineRequest(ME, conversation.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('decline deletes everything and is SILENT (no event to the sender)', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' });
    const emittedBefore = [...w.emitted];
    await w.service.declineRequest(SAKURA, conversation.id);
    expect(w.conversations.docs).toHaveLength(0);
    expect(w.messages.docs).toHaveLength(0);
    expect(w.emitted).toEqual(emittedBefore);
    const inbox = await w.service.listConversations(ME);
    expect(inbox.conversations).toHaveLength(0);
  });

  it('block closes the conversation for both sides and prevents re-opening', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' });
    await w.service.blockUser(SAKURA, ME);
    expect(w.conversations.docs[0].status).toBe('blocked');
    await expect(w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'again' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.service.openConversation(ME, SAKURA)).rejects.toBeInstanceOf(ForbiddenException);
    const inbox = await w.service.listConversations(ME);
    expect(inbox.conversations).toHaveLength(0);
  });
});

describe('ChatService — typing relay', () => {
  it('relays typing only inside active conversations', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    const active = await w.service.openConversation(ME, MOCHI);
    await w.service.relayTyping(ME, active.conversation.id, true);
    expect(w.emitted).toContainEqual(
      expect.objectContaining({ userId: MOCHI, event: 'chat:typing', payload: { conversationId: active.conversation.id, typing: true } }),
    );
    const req = await w.service.openConversation(ME, SAKURA);
    const before = w.emitted.length;
    await w.service.relayTyping(ME, req.conversation.id, true);
    await w.service.relayTyping(SAKURA, req.conversation.id, true);
    expect(w.emitted.length).toBe(before);
  });
});

describe('ChatService — people', () => {
  it('derives quiz-room people from shared RankHistory roomIds', async () => {
    const w = makeWorld();
    const t = new Date();
    w.rankHistories.docs = [
      { _id: 'h1', userId: ME, roomId: 'room-1', playedAt: t },
      { _id: 'h2', userId: MOCHI, roomId: 'room-1', playedAt: t },
      { _id: 'h3', userId: SAKURA, roomId: 'room-1', playedAt: t },
      { _id: 'h4', userId: ME, roomId: 'room-2', playedAt: t },
      { _id: 'h5', userId: LOFI, roomId: 'room-2', playedAt: t },
      { _id: 'h6', userId: LOFI, roomId: 'room-9', playedAt: t }, // a room I was not in
    ];
    follow(w, ME, LOFI);
    const people = await w.service.people(ME);
    expect(people.quizRoomPeople.map((p) => p.id).sort()).toEqual([LOFI, MOCHI, SAKURA].sort());
    // Lofi is already a quiz-room person → not duplicated in suggested
    expect(people.suggested.map((p) => p.id)).not.toContain(LOFI);
    expect(people.suggested.map((p) => p.id)).not.toContain(ME);
  });

  it('search matches username/displayName words, excludes self and blocked', async () => {
    const w = makeWorld();
    w.blocks.docs.push({ _id: 'b1', blockerId: ME, blockedId: LOFI });
    const res = await w.service.searchPeople(ME, 'lofi');
    expect(res.users).toHaveLength(0); // blocked → hidden
    const res2 = await w.service.searchPeople(ME, 'mochi');
    expect(res2.users.map((u) => u.id)).toEqual([MOCHI]);
    await expect(w.service.searchPeople(ME, 'm')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ChatService — message pagination', () => {
  it('pages newest-first chunks, ascending inside the page, with hasMore', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    follow(w, ME, MOCHI);
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    for (let i = 1; i <= 5; i += 1) {
      await w.service.sendMessage(ME, conversation.id, { type: 'text', text: `msg-${i}` });
    }
    const page1 = await w.service.listMessages(MOCHI, conversation.id, undefined, '2');
    expect(page1.messages.map((m) => m.text)).toEqual(['msg-4', 'msg-5']);
    expect(page1.hasMore).toBe(true);
    const page2 = await w.service.listMessages(MOCHI, conversation.id, page1.messages[0].id, '2');
    expect(page2.messages.map((m) => m.text)).toEqual(['msg-2', 'msg-3']);
    const page3 = await w.service.listMessages(MOCHI, conversation.id, page2.messages[0].id, '2');
    expect(page3.messages.map((m) => m.text)).toEqual(['msg-1']);
    expect(page3.hasMore).toBe(false);
  });

  it('hides conversations from non-participants', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    await expect(w.service.listMessages(LOFI, conversation.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.service.sendMessage(LOFI, conversation.id, { type: 'text', text: 'intrude' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

/* ------------------------------------------------------------------ */
/* Audit regressions (2026-11-18 fix-all)                              */
/* ------------------------------------------------------------------ */

describe('ChatService — race-safe open + airtight block', () => {
  it('openConversation recovers when its create loses the pairKey race (11000 → re-read)', async () => {
    const w = makeWorld();
    const realCreate = w.conversations.create.bind(w.conversations);
    let raced = false;
    w.conversations.create = async (doc: Record<string, unknown>) => {
      if (!raced) {
        raced = true;
        const winner = await realCreate(doc); // the concurrent caller won
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
        // eslint-disable-next-line no-unreachable
        return winner;
      }
      return realCreate(doc);
    };
    const res = await w.service.openConversation(ME, MOCHI);
    expect(res.created).toBe(false);
    expect(w.conversations.docs).toHaveLength(1);
    expect(res.conversation.id).toBe(String(w.conversations.docs[0]._id));
  });

  it('blockUser closes EVERY duplicate record for the pair (updateMany)', async () => {
    const w = makeWorld();
    const pairKey = ChatService.pairKeyFor(ME, SAKURA);
    const base = {
      participantIds: [ME, SAKURA].sort(),
      pairKey,
      status: 'active',
      requestedBy: null,
      blockedBy: null,
      hiddenFor: null,
      lastMessage: null,
      readAtFirst: null,
      readAtSecond: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // Two records for one pair — the pre-unique-index race residue.
    w.conversations.docs.push({ _id: '507f1f77bcf86cd7994390d1', ...base });
    w.conversations.docs.push({ _id: '507f1f77bcf86cd7994390d2', ...base });
    await w.service.blockUser(SAKURA, ME);
    expect(w.conversations.docs.every((d) => d.status === 'blocked')).toBe(true);
  });

  it('a blocks-collection row alone closes sends/reads even if the record still says active', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    w.blocks.docs.push({ _id: 'bX', blockerId: MOCHI, blockedId: ME });
    await expect(
      w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.service.listMessages(ME, conversation.id)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ChatService — decline/send race gate', () => {
  it('a send whose conversation is deleted mid-flight leaves no orphan and emits nothing', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    // Simulate the decline landing between the message insert and
    // the commit gate: the conversation vanishes under the send.
    const realCreate = w.messages.create.bind(w.messages);
    w.messages.create = async (doc: Record<string, unknown>) => {
      const created = await realCreate(doc);
      w.conversations.docs = w.conversations.docs.filter(
        (d) => String(d._id) !== conversation.id,
      );
      return created;
    };
    await expect(
      w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'racing' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(w.messages.docs).toHaveLength(0); // the service removed its orphan
    expect(w.emitted.filter((e) => e.event === 'chat:message')).toHaveLength(0);
  });
});

describe('ChatService — id validation + cursor hardening', () => {
  it('malformed ids fold into 404s, never CastError 500s', async () => {
    const w = makeWorld();
    await expect(w.service.openConversation(ME, 'not-an-id')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.service.listMessages(ME, 'garbage-id')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.service.sendMessage(ME, 'garbage-id', { type: 'text', text: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.service.markRead(ME, 'garbage-id')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.service.blockUser(ME, 'garbage-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a foreign or garbage `before` cursor is a 400, not a silent page 1', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    follow(w, SAKURA, ME);
    const a = await w.service.openConversation(ME, MOCHI);
    const b = await w.service.openConversation(ME, SAKURA);
    const foreign = await w.service.sendMessage(ME, b.conversation.id, { type: 'text', text: 'in B' });
    await expect(
      w.service.listMessages(ME, a.conversation.id, foreign.id),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      w.service.listMessages(ME, a.conversation.id, 'junk-cursor'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      w.service.listMessages(ME, a.conversation.id, '507f1f77bcf86cd7994390ff'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ChatService — read markers do not reorder the inbox', () => {
  it('markRead writes the marker with timestamps:false', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' });
    const realUpdateOne = w.conversations.updateOne.bind(w.conversations);
    let seenOptions: { timestamps?: boolean } | undefined;
    w.conversations.updateOne = (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
      options?: { timestamps?: boolean },
    ) => {
      seenOptions = options;
      return realUpdateOne(filter, update, options);
    };
    await w.service.markRead(MOCHI, conversation.id);
    expect(seenOptions).toEqual(expect.objectContaining({ timestamps: false }));
  });

  it('inbox order follows last-message time even when updatedAt disagrees', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    follow(w, SAKURA, ME);
    const a = await w.service.openConversation(ME, MOCHI);
    const b = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, a.conversation.id, { type: 'text', text: 'older' });
    await w.service.sendMessage(ME, b.conversation.id, { type: 'text', text: 'newer' });
    // Scramble: A's updatedAt is the newest (e.g. a read bumped
    // it) but B's last message is the newest — B must stay first.
    const docA = w.conversations.docs.find((d) => String(d._id) === a.conversation.id) as Record<string, unknown>;
    const docB = w.conversations.docs.find((d) => String(d._id) === b.conversation.id) as Record<string, unknown>;
    docA.updatedAt = new Date(Date.now() + 60000);
    docA.lastMessage = { type: 'text', text: 'older', themeTitle: null, themeArtist: null, senderId: ME, createdAt: new Date(Date.now() - 60000).toISOString() };
    docB.lastMessage = { type: 'text', text: 'newer', themeTitle: null, themeArtist: null, senderId: ME, createdAt: new Date().toISOString() };
    const inbox = await w.service.listConversations(ME);
    expect(inbox.conversations[0].id).toBe(b.conversation.id);
  });
});

describe('ChatService — send idempotency (clientId)', () => {
  it('re-sending with the same clientId returns the stored message — no duplicate, no second event', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME);
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    const first = await w.service.sendMessage(
      ME, conversation.id, { type: 'text', text: 'hello' }, 'client-42',
    );
    expect(first.clientId).toBe('client-42');
    const emittedAfterFirst = w.emitted.length;
    // The REST fallback path carries the id in the body instead.
    const second = await w.service.sendMessage(
      ME, conversation.id, { type: 'text', text: 'hello', clientId: 'client-42' },
    );
    expect(second.id).toBe(first.id);
    expect(w.messages.docs).toHaveLength(1);
    expect(w.emitted.length).toBe(emittedAfterFirst);
    // A different clientId is a different message.
    const third = await w.service.sendMessage(
      ME, conversation.id, { type: 'text', text: 'hello' }, 'client-43',
    );
    expect(third.id).not.toBe(first.id);
    expect(w.messages.docs).toHaveLength(2);
  });
});

describe('ChatService — decline tombstones', () => {
  async function declinedWorld() {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' });
    await w.service.declineRequest(SAKURA, conversation.id);
    return w;
  }

  it('decline writes a tombstone for the pair', async () => {
    const w = await declinedWorld();
    expect(w.declines.docs).toHaveLength(1);
    expect(w.declines.docs[0].declinerId).toBe(SAKURA);
    expect(w.declines.docs[0].requesterId).toBe(ME);
  });

  it('a fresh re-request is hidden from the decliner but fully works for the sender — silently', async () => {
    const w = await declinedWorld();
    const reopened = await w.service.openConversation(ME, SAKURA);
    expect(reopened.created).toBe(true);
    expect(reopened.conversation.status).toBe('request');
    const emittedBefore = w.emitted.length;
    const msg = await w.service.sendMessage(ME, reopened.conversation.id, { type: 'text', text: 'please?' });
    expect(msg.text).toBe('please?'); // sender's side works, no error
    expect(w.emitted.length).toBe(emittedBefore); // NO event to the decliner
    // The decliner sees nothing, anywhere.
    expect((await w.service.listRequests(SAKURA)).requests).toHaveLength(0);
    const sakuraInbox = await w.service.listConversations(SAKURA);
    expect(sakuraInbox.conversations).toHaveLength(0);
    expect(sakuraInbox.requestCount).toBe(0);
    await expect(w.service.listMessages(SAKURA, reopened.conversation.id)).rejects.toBeInstanceOf(NotFoundException);
    // The sender's side is completely normal.
    const myInbox = await w.service.listConversations(ME);
    expect(myInbox.conversations.map((c) => c.id)).toContain(reopened.conversation.id);
    const myPage = await w.service.listMessages(ME, reopened.conversation.id);
    expect(myPage.messages.map((m) => m.text)).toContain('please?');
  });

  it('the decliner engaging clears the tombstone and surfaces the conversation as active', async () => {
    const w = await declinedWorld();
    const reopened = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, reopened.conversation.id, { type: 'text', text: 'please?' });
    const engaged = await w.service.openConversation(SAKURA, ME);
    expect(engaged.conversation.status).toBe('active');
    expect(w.declines.docs).toHaveLength(0);
    const sakuraInbox = await w.service.listConversations(SAKURA);
    expect(sakuraInbox.conversations.map((c) => c.id)).toContain(reopened.conversation.id);
    const reply = await w.service.sendMessage(SAKURA, reopened.conversation.id, { type: 'text', text: 'ok fine' });
    expect(reply.text).toBe('ok fine');
  });

  it('after 30 days the tombstone expires and a send surfaces as a normal fresh request', async () => {
    const w = await declinedWorld();
    const reopened = await w.service.openConversation(ME, SAKURA);
    w.declines.docs[0].createdAt = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const emittedBefore = w.emitted.length;
    await w.service.sendMessage(ME, reopened.conversation.id, { type: 'text', text: 'a month later' });
    expect(w.declines.docs).toHaveLength(0); // cleared on the expiring send
    expect(w.emitted.length).toBeGreaterThan(emittedBefore); // delivered again
    const requests = await w.service.listRequests(SAKURA);
    expect(requests.requests.map((r) => r.id)).toContain(reopened.conversation.id);
  });
});

describe('ChatService — people privacy + counts window', () => {
  it('people rows (sections + search) carry NO presence fields', async () => {
    const w = makeWorld();
    w.presence.add(MOCHI, 'socket-1'); // Mochi is "online" right now
    const people = await w.service.people(ME);
    expect(people.suggested.length).toBeGreaterThan(0);
    for (const row of [...people.quizRoomPeople, ...people.suggested]) {
      // Runtime check (the contract type omits these fields entirely).
      expect((row as unknown as Record<string, unknown>).online).toBeUndefined();
      expect((row as unknown as Record<string, unknown>).lastActiveAt).toBeUndefined();
    }
    const search = await w.service.searchPeople(ME, 'mochi');
    expect((search.users[0] as unknown as Record<string, unknown>).online).toBeUndefined();
    expect((search.users[0] as unknown as Record<string, unknown>).lastActiveAt).toBeUndefined();
    // …while conversation summaries (partner surface) still carry it.
    follow(w, MOCHI, ME);
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    expect(conversation.other.online).toBe(true);
  });

  it('totalUnread is computed across ALL conversations, not just the 100-row page', async () => {
    const w = makeWorld();
    const TOTAL = 105;
    for (let i = 0; i < TOTAL; i += 1) {
      const id = `507f1f77bcf86cd7994${i.toString(16).padStart(5, '0')}`;
      w.users.docs.push({ _id: id, username: `user${i}`, displayName: `User ${i}`, avatarUrl: null, isPublic: true, totalFollowers: 0 });
      follow(w, ME, id); // I (the receiver) follow them → their open starts ACTIVE, so their sends count as unread
      const { conversation } = await w.service.openConversation(id, ME);
      await w.service.sendMessage(id, conversation.id, { type: 'text', text: `msg ${i}` });
    }
    const inbox = await w.service.listConversations(ME);
    expect(inbox.conversations).toHaveLength(100); // the page is still capped
    expect(inbox.totalUnread).toBe(TOTAL); // …but the count is not
    const counts = await w.service.counts(ME);
    expect(counts.totalUnread).toBe(TOTAL);
    expect(counts.requestCount).toBe(0);
  });
});

describe('ChatService — pending-request cap (deep-analysis fix pass)', () => {
  it('allows 3 messages in request state; the 4th is refused until accept', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    expect(conversation.status).toBe('request');
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'one' });
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'two' });
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'three' }, 'cap-3');
    await expect(
      w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'four' }),
    ).rejects.toThrow('Waiting for them to accept your request');
    // A retry of an allowed message (same clientId) still resolves
    // even though the cap is now full — idempotency runs first.
    await expect(
      w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'three' }, 'cap-3'),
    ).resolves.toMatchObject({ text: 'three' });
    // After accept, sending is uncapped.
    await w.service.acceptRequest(SAKURA, conversation.id);
    const fourth = await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'four' });
    expect(fourth.text).toBe('four');
  });
});

describe('ChatService — empty conversations are invisible to the receiver', () => {
  it('an opened-but-unsent request shows nowhere for the receiver until the first message', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    expect(conversation.status).toBe('request');
    expect((await w.service.listRequests(SAKURA)).requests).toHaveLength(0);
    expect((await w.service.listConversations(SAKURA)).requestCount).toBe(0);
    expect((await w.service.counts(SAKURA)).requestCount).toBe(0);
    // The sender keeps their thread.
    const myInbox = await w.service.listConversations(ME);
    expect(myInbox.conversations.map((c) => c.id)).toContain(conversation.id);
    // First message → the request surfaces everywhere it should.
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' });
    expect((await w.service.listRequests(SAKURA)).requests.map((r) => r.id)).toContain(conversation.id);
    expect((await w.service.counts(SAKURA)).requestCount).toBe(1);
  });
});

describe('ChatService — first-contact daily limit', () => {
  function addUsers(w: World, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = `507f1f77bcf86cd79951${i.toString(16).padStart(4, '0')}`;
      w.users.docs.push({ _id: id, username: `fresh${i}`, displayName: `Fresh ${i}`, avatarUrl: null, isPublic: true, totalFollowers: 0 });
      ids.push(id);
    }
    return ids;
  }

  it('accounts under 7 days old may start at most 10 new conversations per day', async () => {
    const w = makeWorld();
    w.users.docs[0].createdAt = new Date(); // ME registered today
    const ids = addUsers(w, 11);
    for (const id of ids.slice(0, 10)) {
      await w.service.openConversation(ME, id);
    }
    // Re-opening an existing conversation does not count again.
    await w.service.openConversation(ME, ids[0]);
    await expect(w.service.openConversation(ME, ids[10])).rejects.toThrow(
      'daily limit for starting new conversations',
    );
  });

  it('established accounts get the 50/day allowance', async () => {
    const w = makeWorld();
    w.users.docs[0].createdAt = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const ids = addUsers(w, 11);
    for (const id of ids) {
      await w.service.openConversation(ME, id);
    }
    expect(w.conversations.docs).toHaveLength(11);
  });
});

describe('ChatService — unblock + blocked list', () => {
  it('unblock reopens a conversation that has messages and restores sending', async () => {
    const w = makeWorld();
    follow(w, MOCHI, ME); // Mochi follows me → my open starts ACTIVE
    const { conversation } = await w.service.openConversation(ME, MOCHI);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'hi' });
    await w.service.blockUser(ME, MOCHI);
    const blocked = await w.service.listBlockedUsers(ME);
    expect(blocked.users.map((u) => u.id)).toContain(MOCHI);
    expect(blocked.users[0].blockedAt).toBeTruthy();
    await w.service.unblockUser(ME, MOCHI);
    expect((await w.service.listBlockedUsers(ME)).users).toHaveLength(0);
    const reopened = await w.service.openConversation(ME, MOCHI);
    expect(reopened.conversation.status).toBe('active');
    const msg = await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'again' });
    expect(msg.text).toBe('again');
  });

  it('unblock deletes a still-empty blocked conversation record', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await w.service.blockUser(ME, SAKURA);
    expect(w.conversations.docs).toHaveLength(1);
    await w.service.unblockUser(ME, SAKURA);
    expect(w.conversations.docs).toHaveLength(0);
    expect(conversation.id).toBeTruthy();
  });
});

describe('ChatService — per-user conversation state', () => {
  async function activeWithMessage(w: World) {
    follow(w, ME, MOCHI); // I (the receiver) follow Mochi → her open starts ACTIVE
    const { conversation } = await w.service.openConversation(MOCHI, ME);
    await w.service.sendMessage(MOCHI, conversation.id, { type: 'text', text: 'yo' });
    return conversation;
  }

  it('mute excludes the conversation unread from badge counts but keeps the row', async () => {
    const w = makeWorld();
    const conversation = await activeWithMessage(w);
    expect((await w.service.counts(ME)).totalUnread).toBe(1);
    const summary = await w.service.setConversationState(ME, conversation.id, { muted: true });
    expect(summary.muted).toBe(true);
    expect((await w.service.counts(ME)).totalUnread).toBe(0);
    const inbox = await w.service.listConversations(ME);
    expect(inbox.conversations.map((c) => c.id)).toContain(conversation.id);
    expect(inbox.totalUnread).toBe(0);
    await w.service.setConversationState(ME, conversation.id, { muted: false });
    expect((await w.service.counts(ME)).totalUnread).toBe(1);
  });

  it('archive hides the conversation until a new message arrives', async () => {
    const w = makeWorld();
    const conversation = await activeWithMessage(w);
    await w.service.setConversationState(ME, conversation.id, { archived: true });
    let inbox = await w.service.listConversations(ME);
    expect(inbox.conversations.map((c) => c.id)).not.toContain(conversation.id);
    expect(inbox.archivedCount).toBe(1);
    const archived = await w.service.listArchived(ME);
    expect(archived.conversations.map((c) => c.id)).toContain(conversation.id);
    await w.service.sendMessage(MOCHI, conversation.id, { type: 'text', text: 'wake up' });
    inbox = await w.service.listConversations(ME);
    expect(inbox.conversations.map((c) => c.id)).toContain(conversation.id);
    expect(inbox.archivedCount).toBe(0);
  });

  it('delete-for-me hides history for me only; a newer message revives the thread', async () => {
    const w = makeWorld();
    const conversation = await activeWithMessage(w);
    await w.service.sendMessage(MOCHI, conversation.id, { type: 'text', text: 'second' });
    await w.service.clearConversation(ME, conversation.id);
    expect((await w.service.listMessages(ME, conversation.id)).messages).toHaveLength(0);
    expect((await w.service.listConversations(ME)).conversations).toHaveLength(0);
    // The other side is untouched.
    expect((await w.service.listMessages(MOCHI, conversation.id)).messages).toHaveLength(2);
    expect((await w.service.listConversations(MOCHI)).conversations.map((c) => c.id)).toContain(conversation.id);
    // A newer message revives it for me, showing only what is newer.
    await w.service.sendMessage(MOCHI, conversation.id, { type: 'text', text: 'third' });
    const page = await w.service.listMessages(ME, conversation.id);
    expect(page.messages.map((m) => m.text)).toEqual(['third']);
    expect((await w.service.listConversations(ME)).conversations.map((c) => c.id)).toContain(conversation.id);
  });
});

describe('ChatService — reports', () => {
  async function threadWithFive(w: World) {
    follow(w, SAKURA, ME); // Sakura follows me → my open starts ACTIVE
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    for (const text of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      await w.service.sendMessage(ME, conversation.id, { type: 'text', text });
    }
    const page = await w.service.listMessages(ME, conversation.id);
    return { conversation, messages: page.messages };
  }

  it('a message report freezes the reported message plus up to 5 surrounding', async () => {
    const w = makeWorld();
    const { conversation, messages } = await threadWithFive(w);
    const report = await w.service.reportUser(ME, {
      reportedUserId: SAKURA,
      conversationId: conversation.id,
      messageId: messages[2].id,
      reason: 'spam',
    });
    expect(report.reason).toBe('spam');
    expect(report.context.map((m) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    // Frozen: later messages never enter the snapshot.
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'm6' });
    expect(w.reports.docs[0].context).toHaveLength(5);
  });

  it('a bare user report carries no context; non-participants cannot anchor reports', async () => {
    const w = makeWorld();
    const { conversation, messages } = await threadWithFive(w);
    const bare = await w.service.reportUser(ME, { reportedUserId: SAKURA, reason: 'other' });
    expect(bare.context).toEqual([]);
    await expect(
      w.service.reportUser(LOFI, {
        reportedUserId: SAKURA,
        conversationId: conversation.id,
        messageId: messages[0].id,
        reason: 'spam',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the operator read is gated by ADMIN_USER_IDS', async () => {
    const w = makeWorld();
    await w.service.reportUser(ME, { reportedUserId: SAKURA, reason: 'harassment' });
    await expect(w.service.listReports(ME)).rejects.toBeInstanceOf(ForbiddenException);
    process.env.ADMIN_USER_IDS = ME;
    try {
      const list = await w.service.listReports(ME);
      expect(list.reports).toHaveLength(1);
      expect(list.reports[0].reason).toBe('harassment');
    } finally {
      delete process.env.ADMIN_USER_IDS;
    }
  });
});

describe('ChatService — list pagination contract', () => {
  it('listConversations pages by cursor with a nextCursor until the end', async () => {
    const w = makeWorld();
    follow(w, ME, MOCHI);
    follow(w, ME, SAKURA);
    follow(w, ME, LOFI);
    for (const other of [MOCHI, SAKURA, LOFI]) {
      const { conversation } = await w.service.openConversation(other, ME);
      await w.service.sendMessage(other, conversation.id, { type: 'text', text: `from ${other}` });
    }
    const page1 = await w.service.listConversations(ME, undefined, '2');
    expect(page1.conversations).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await w.service.listConversations(ME, page1.nextCursor ?? undefined, '2');
    expect(page2.conversations).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const all = new Set([...page1.conversations, ...page2.conversations].map((c) => c.id));
    expect(all.size).toBe(3);
  });
});

describe('ChatService — read-sync + push wiring', () => {
  it('markRead emits chat:read-sync to the reader as well as chat:read to the partner', async () => {
    const w = makeWorld();
    follow(w, ME, MOCHI);
    const { conversation } = await w.service.openConversation(MOCHI, ME);
    await w.service.sendMessage(MOCHI, conversation.id, { type: 'text', text: 'yo' });
    w.emitted.length = 0;
    await w.service.markRead(ME, conversation.id);
    expect(w.emitted.some((e) => e.event === 'chat:read' && e.userId === MOCHI)).toBe(true);
    expect(w.emitted.some((e) => e.event === 'chat:read-sync' && e.userId === ME)).toBe(true);
  });

  it('a send notifies the push service with kind + mute state, body-free', async () => {
    const w = makeWorld();
    const { conversation } = await w.service.openConversation(ME, SAKURA);
    await w.service.sendMessage(ME, conversation.id, { type: 'text', text: 'secret body' });
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]).toMatchObject({
      recipientId: SAKURA,
      conversationId: conversation.id,
      kind: 'request',
      muted: false,
      isFirstMessage: true,
    });
    expect(JSON.stringify(w.pushes[0])).not.toContain('secret body');
  });
});

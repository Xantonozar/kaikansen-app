import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import * as jwt from 'jsonwebtoken';
import { io, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { AccessTokenGuard } from './../src/auth/access-token.guard';
import { AnilistClient } from './../src/auth/anilist.client';
import { AuthService } from './../src/auth/auth.service';
import { User } from './../src/auth/user.schema';
import { Follow } from './../src/social/follow.schema';
import { Favorite } from './../src/library/favorite.schema';
import { Rating } from './../src/library/rating.schema';
import { WatchHistory } from './../src/library/watch-history.schema';
import { ThemeCache } from './../src/themes/theme-cache.schema';
import { UserRank } from './../src/quiz/user-rank.schema';
import { RankHistory } from './../src/quiz/rank-history.schema';
import { ChatController } from './../src/chat/chat.controller';
import { ChatService } from './../src/chat/chat.service';
import { ChatGateway } from './../src/chat/chat.gateway';
import { ChatBroadcaster } from './../src/chat/chat-broadcaster';
import { ChatPresence } from './../src/chat/chat-presence';
import { ChatConversation } from './../src/chat/chat-conversation.schema';
import { ChatMessage } from './../src/chat/chat-message.schema';
import { ChatBlock } from './../src/chat/chat-block.schema';
import { ChatDecline } from './../src/chat/chat-decline.schema';
import { ChatPushToken } from './../src/chat/chat-push-token.schema';
import { ChatPushService } from './../src/chat/chat-push.service';
import { ChatReport } from './../src/chat/chat-report.schema';
import { ChatMetrics } from './../src/chat/chat-metrics';
import { CHAT_THROTTLER_OPTIONS } from './../src/chat/chat-throttle';
import { ThrottlerModule } from '@nestjs/throttler';

/**
 * Chat integration (e2e): the REAL controller + service + gateway
 * over a real HTTP server, driven by fetch and real socket.io
 * clients, against in-memory model stand-ins. Covers the full DM
 * loop — open (requests model) → socket send + ack + delivery →
 * receiver lockout → accept → replies → read receipts → typing →
 * presence — plus silent decline over the wire.
 */

/* ---------------- in-memory model fakes (same kit as the unit spec) ---------------- */

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' || typeof b === 'object') return String(a) === String(b);
  return false;
}
function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  return (av as never) < (bv as never) ? -1 : 1;
}
function getPath(doc: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | null)?.[part], doc);
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
    // ObjectId-shaped so the service's id-shape guards behave.
    this.seq += 1;
    return this.seq.toString(16).padStart(24, '0');
  }
  find(filter: Record<string, unknown> = {}) { return chain(this.docs.filter((d) => matches(d, filter))); }
  findOne(filter: Record<string, unknown> = {}) { return queryOf(this.docs.find((d) => matches(d, filter)) ?? null); }
  findById(id: unknown) { return queryOf(this.docs.find((d) => String(d._id) === String(id)) ?? null); }
  async create(doc: Record<string, unknown>) {
    const now = new Date();
    const created = { _id: this.nextId(), createdAt: now, updatedAt: now, ...doc };
    this.docs.push(created);
    return created;
  }
  updateOne(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }, _options?: { timestamps?: boolean }) {
    return { exec: async () => { const doc = this.docs.find((d) => matches(d, filter)); if (doc && update.$set) Object.assign(doc, update.$set); return { modifiedCount: doc ? 1 : 0 }; } };
  }
  findOneAndUpdate(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) {
    const q: Record<string, unknown> = {};
    q.lean = () => q;
    q.select = () => q;
    q.exec = async () => { const doc = this.docs.find((d) => matches(d, filter)); if (!doc) return null; if (update.$set) Object.assign(doc, update.$set); return doc; };
    return q;
  }
  aggregate(pipeline: Record<string, unknown>[]) {
    return {
      exec: async () => {
        let rows: Record<string, unknown>[] = [...this.docs];
        for (const stage of pipeline) {
          if ('$match' in stage) {
            rows = rows.filter((d) => matches(d, stage.$match as Record<string, unknown>));
          } else if ('$group' in stage) {
            const spec = stage.$group as { _id: string };
            const keyField = spec._id.replace(/^\$/, '');
            const grouped = new Map<string, number>();
            for (const row of rows) { const key = String(row[keyField]); grouped.set(key, (grouped.get(key) ?? 0) + 1); }
            return [...grouped.entries()].map(([_id, count]) => ({ _id, count }));
          }
        }
        return rows;
      },
    };
  }
  updateMany(filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) {
    return { exec: async () => { let n = 0; for (const doc of this.docs) { if (matches(doc, filter)) { if (update.$set) Object.assign(doc, update.$set); n += 1; } } return { modifiedCount: n }; } };
  }
  deleteMany(filter: Record<string, unknown>) {
    return { exec: async () => { const before = this.docs.length; this.docs = this.docs.filter((d) => !matches(d, filter)); return { deletedCount: before - this.docs.length }; } };
  }
  deleteOne(filter: Record<string, unknown>) {
    return { exec: async () => { const i = this.docs.findIndex((d) => matches(d, filter)); if (i >= 0) this.docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; } };
  }
  countDocuments(filter: Record<string, unknown> = {}) { return { exec: async () => this.docs.filter((d) => matches(d, filter)).length }; }
}

/* ---------------- fixtures ---------------- */

const E2E_SECRET = 'chat-e2e-secret';
const ALICE = '507f1f77bcf86cd7994390a1';
const BOB = '507f1f77bcf86cd7994390a2';
const CAROL = '507f1f77bcf86cd7994390a3';
const DAVE = '507f1f77bcf86cd7994390a4';

function tokenFor(userId: string, username: string): string {
  return jwt.sign(
    { userId, username, email: `${username}@example.com`, tokenType: 'access' },
    E2E_SECRET,
    { expiresIn: '15m' },
  );
}

const models = {
  users: new FakeModel('u'),
  follows: new FakeModel('f'),
  userRanks: new FakeModel('r'),
  rankHistories: new FakeModel('h'),
  themes: new FakeModel('t'),
  conversations: new FakeModel('c'),
  messages: new FakeModel('m'),
  blocks: new FakeModel('b'),
  declines: new FakeModel('d'),
  reports: new FakeModel('rp'),
  pushTokens: new FakeModel('pt'),
  empty: new FakeModel('e'),
};

function seed() {
  models.users.docs = [
    { _id: ALICE, username: 'alice', displayName: 'Alice', avatarUrl: null, isPublic: true, totalFollowers: 3 },
    { _id: BOB, username: 'bob', displayName: 'Bob', avatarUrl: 'https://img/bob.png', isPublic: true, totalFollowers: 9 },
    { _id: CAROL, username: 'carol', displayName: 'Carol', avatarUrl: null, isPublic: true, totalFollowers: 1 },
    { _id: DAVE, username: 'dave', displayName: 'Dave', avatarUrl: null, isPublic: true, totalFollowers: 0 },
  ];
  models.userRanks.docs = [{ _id: 'r1', userId: BOB, rp: 1120 }];
  models.rankHistories.docs = [
    { _id: 'h1', userId: ALICE, roomId: 'room-1', playedAt: new Date() },
    { _id: 'h2', userId: BOB, roomId: 'room-1', playedAt: new Date() },
  ];
  models.themes.docs = [
    { _id: 't1', slug: 'unravel', songTitle: 'unravel', artistName: 'TK from Ling tosite sigure', animeTitle: 'Tokyo Ghoul', type: 'OP', sequence: 1, animeCoverImage: 'big.png', animeCoverImageSmall: 'small.png' },
  ];
}

describe('Chat (e2e)', () => {
  let app: INestApplication;
  let port: number;
  const clients: Socket[] = [];

  const api = async (userId: string, username: string, path: string, init?: RequestInit) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenFor(userId, username)}`,
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  const connect = async (token: string): Promise<Socket> => {
    const socket = io(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 5000);
      socket.on('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    });
    return socket;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emitAck = (socket: Socket, event: string, payload: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.emit(event, payload, (ack: any) => { clearTimeout(timer); resolve(ack); });
    });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waitFor = (socket: Socket, event: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`event timeout: ${event}`)), 5000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket.once(event, (payload: any) => { clearTimeout(timer); resolve(payload); });
    });

  beforeAll(async () => {
    process.env.JWT_SECRET = E2E_SECRET;
    process.env.JWT_REFRESH_SECRET = 'chat-e2e-refresh-secret';
    seed();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot(CHAT_THROTTLER_OPTIONS),
      ],
      controllers: [ChatController],
      providers: [
        ChatService,
        ChatGateway,
        ChatBroadcaster,
        ChatPresence,
        ChatPushService,
        ChatMetrics,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        { provide: getModelToken(User.name), useValue: models.users },
        { provide: getModelToken(Follow.name), useValue: models.follows },
        { provide: getModelToken(UserRank.name), useValue: models.userRanks },
        { provide: getModelToken(RankHistory.name), useValue: models.rankHistories },
        { provide: getModelToken(ThemeCache.name), useValue: models.themes },
        { provide: getModelToken(ChatConversation.name), useValue: models.conversations },
        { provide: getModelToken(ChatMessage.name), useValue: models.messages },
        { provide: getModelToken(ChatBlock.name), useValue: models.blocks },
        { provide: getModelToken(ChatDecline.name), useValue: models.declines },
        { provide: getModelToken(ChatPushToken.name), useValue: models.pushTokens },
        { provide: getModelToken(ChatReport.name), useValue: models.reports },
        { provide: getModelToken(Rating.name), useValue: models.empty },
        { provide: getModelToken(WatchHistory.name), useValue: models.empty },
        { provide: getModelToken(Favorite.name), useValue: models.empty },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 30000);

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await app.close();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_REFRESH_SECRET;
  });

  it('rejects unauthenticated REST and bad socket handshakes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat/conversations`);
    expect(res.status).toBe(401);
    const bad = io(`http://127.0.0.1:${port}`, {
      auth: { token: 'not-a-real-token' },
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(bad);
    const reason = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 4000);
      bad.on('disconnect', (r) => { clearTimeout(timer); resolve(r); });
      bad.on('connect_error', () => { clearTimeout(timer); resolve('connect_error'); });
    });
    expect(['io server disconnect', 'connect_error']).toContain(reason);
  }, 10000);

  it('runs the full DM loop: request → send → accept → reply → read → typing → presence', async () => {
    // Alice opens a conversation with Bob; Bob does not follow Alice → request.
    const opened = await api(ALICE, 'alice', '/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: BOB }),
    });
    expect(opened.status).toBe(201);
    expect(opened.body.conversation.status).toBe('request');
    const conversationId: string = opened.body.conversation.id;

    const alice = await connect(tokenFor(ALICE, 'alice'));
    // Bob connecting notifies Alice (presence) because they share a conversation.
    const presencePromise = waitFor(alice, 'chat:presence');
    const bob = await connect(tokenFor(BOB, 'bob'));
    const presence = await presencePromise;
    expect(presence).toEqual({ userId: BOB, online: true });

    // Alice sends over the socket; ack carries the saved message,
    // Bob receives chat:message with the clientId echoed.
    const deliveredPromise = waitFor(bob, 'chat:message');
    const ack = await emitAck(alice, 'chat:send', {
      conversationId,
      type: 'text',
      text: 'that OP lives in my head rent free',
      clientId: 'opt-1',
    });
    expect(ack.ok).toBe(true);
    expect(ack.message.text).toBe('that OP lives in my head rent free');
    const delivered = await deliveredPromise;
    expect(delivered.clientId).toBe('opt-1');
    expect(delivered.senderId).toBe(ALICE);

    // Bob (request receiver) cannot reply yet — over socket or REST.
    const bobAck = await emitAck(bob, 'chat:send', {
      conversationId,
      type: 'text',
      text: 'reply?',
      clientId: 'opt-2',
    });
    expect(bobAck.ok).toBe(false);
    const bobRest = await api(BOB, 'bob', `/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ type: 'text', text: 'reply?' }),
    });
    expect(bobRest.status).toBe(403);

    // Bob's inbox hides the request; his requests list shows it.
    const bobInbox = await api(BOB, 'bob', '/chat/conversations');
    expect(bobInbox.body.conversations).toHaveLength(0);
    expect(bobInbox.body.requestCount).toBe(1);
    const bobRequests = await api(BOB, 'bob', '/chat/requests');
    expect(bobRequests.body.requests).toHaveLength(1);

    // Bob reads the request thread: Alice must NOT get a read receipt.
    let aliceRead = false;
    alice.on('chat:read', () => { aliceRead = true; });
    await api(BOB, 'bob', `/chat/conversations/${conversationId}/read`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 250));
    expect(aliceRead).toBe(false);
    const aliceView = await api(ALICE, 'alice', `/chat/conversations/${conversationId}/messages`);
    expect(aliceView.body.messages[0].readAt).toBeNull();

    // Bob accepts → Alice is notified; the conversation goes active.
    const acceptedPromise = waitFor(alice, 'chat:request-accepted');
    const accepted = await api(BOB, 'bob', `/chat/conversations/${conversationId}/accept`, { method: 'POST' });
    expect(accepted.body.status).toBe('active');
    await acceptedPromise;

    // Bob can now reply; Alice sees it unread, then reads → receipt flows back.
    const bobMsgPromise = waitFor(alice, 'chat:message');
    const bobAck2 = await emitAck(bob, 'chat:send', {
      conversationId,
      type: 'theme',
      themeSlug: 'unravel',
      clientId: 'opt-3',
    });
    expect(bobAck2.ok).toBe(true);
    expect(bobAck2.message.theme.songTitle).toBe('unravel');
    await bobMsgPromise;
    const aliceInbox = await api(ALICE, 'alice', '/chat/conversations');
    expect(aliceInbox.body.totalUnread).toBe(1);
    const readPromise = waitFor(bob, 'chat:read');
    await api(ALICE, 'alice', `/chat/conversations/${conversationId}/read`, { method: 'POST' });
    const readEvent = await readPromise;
    expect(readEvent.readerId).toBe(ALICE);
    const bobView = await api(BOB, 'bob', `/chat/conversations/${conversationId}/messages`);
    const bobsMessage = bobView.body.messages.find((m: { senderId: string }) => m.senderId === BOB);
    expect(bobsMessage.readAt).not.toBeNull();

    // Typing relays now that the conversation is active.
    const typingPromise = waitFor(bob, 'chat:typing');
    alice.emit('chat:typing', { conversationId, typing: true });
    const typing = await typingPromise;
    expect(typing).toEqual({ conversationId, typing: true });
  }, 20000);

  it('decline is silent and final; people come from quiz-room history', async () => {
    // Carol requests Alice (Alice does not follow Carol).
    const opened = await api(CAROL, 'carol', '/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: ALICE }),
    });
    const conversationId: string = opened.body.conversation.id;
    await api(CAROL, 'carol', `/chat/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ type: 'text', text: 'hi alice' }),
    });
    const requests = await api(ALICE, 'alice', '/chat/requests');
    expect(requests.body.requests.map((r: { id: string }) => r.id)).toContain(conversationId);
    const declined = await api(ALICE, 'alice', `/chat/conversations/${conversationId}/decline`, { method: 'POST' });
    expect(declined.body).toEqual({ declined: true });
    // Gone for both sides, no trace in Carol's inbox.
    const carolInbox = await api(CAROL, 'carol', '/chat/conversations');
    expect(carolInbox.body.conversations.map((c: { id: string }) => c.id)).not.toContain(conversationId);
    const aliceRequests = await api(ALICE, 'alice', '/chat/requests');
    expect(aliceRequests.body.requests).toHaveLength(0);

    const people = await api(ALICE, 'alice', '/chat/people');
    expect(people.body.quizRoomPeople.map((p: { id: string }) => p.id)).toContain(BOB);
  }, 15000);

  it('audit regressions: REST clientId dedupe, malformed ids → 404, meta for blocked, counts endpoint', async () => {
    // Fresh pair: Carol → Bob (Bob does not follow Carol → request).
    const opened = await api(CAROL, 'carol', '/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: BOB }),
    });
    const conversationId: string = opened.body.conversation.id;

    // The same clientId sent twice over REST (socket attempt +
    // fallback after a lost ack) stores ONE message.
    const sendBody = JSON.stringify({ type: 'text', text: 'sent once', clientId: 'e2e-dupe-1' });
    const first = await api(CAROL, 'carol', `/chat/conversations/${conversationId}/messages`, { method: 'POST', body: sendBody });
    const second = await api(CAROL, 'carol', `/chat/conversations/${conversationId}/messages`, { method: 'POST', body: sendBody });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const page = await api(CAROL, 'carol', `/chat/conversations/${conversationId}/messages`);
    expect(page.body.messages.filter((m: { text: string }) => m.text === 'sent once')).toHaveLength(1);

    // Malformed ids are clean 404s over the wire, not 500s.
    const badThread = await api(CAROL, 'carol', '/chat/conversations/not-a-real-id/messages');
    expect(badThread.status).toBe(404);
    const badOpen = await api(CAROL, 'carol', '/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: 'also-not-real' }),
    });
    expect(badOpen.status).toBe(404);
    const badCursor = await api(CAROL, 'carol', `/chat/conversations/${conversationId}/messages?before=junk`);
    expect(badCursor.status).toBe(400);

    // Counts endpoint: Bob has Carol's request pending.
    const counts = await api(BOB, 'bob', '/chat/counts');
    expect(counts.status).toBe(200);
    expect(counts.body.requestCount).toBe(1);

    // Bob blocks Carol: messages endpoint closes (403), but the
    // meta endpoint still answers so the client can render the
    // closed state instead of an endless load error.
    const blocked = await api(BOB, 'bob', `/chat/users/${CAROL}/block`, { method: 'POST', body: '{}' });
    expect(blocked.status).toBe(201);
    const closedPage = await api(CAROL, 'carol', `/chat/conversations/${conversationId}/messages`);
    expect(closedPage.status).toBe(403);
    const meta = await api(CAROL, 'carol', `/chat/conversations/${conversationId}/meta`);
    expect(meta.status).toBe(200);
    expect(meta.body.status).toBe('blocked');
    expect(meta.body.other.username).toBe('bob');
    expect(meta.body.messages).toBeUndefined();
  }, 15000);

  it('hardening pass: unblock, reports, state, push token, pagination over the wire', async () => {
    // Dave ↔ Alice: follow makes Alice's open to Dave ACTIVE.
    models.follows.docs.push({ _id: 'f-dave-alice', followerId: DAVE, followeeId: ALICE, createdAt: new Date() });
    const opened = await api(ALICE, 'alice', '/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: DAVE }),
    });
    expect(opened.status).toBe(201);
    expect(opened.body.conversation.status).toBe('active');
    const conversationId: string = opened.body.conversation.id;

    const send = (text: string) =>
      api(ALICE, 'alice', `/chat/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ type: 'text', text }),
      });
    expect((await send('wire one')).status).toBe(201);
    expect((await send('wire two')).status).toBe(201);

    // Report a message → snapshot frozen; operator read is gated.
    const page = await api(ALICE, 'alice', `/chat/conversations/${conversationId}/messages`);
    const target = page.body.messages[0];
    const report = await api(ALICE, 'alice', '/chat/reports', {
      method: 'POST',
      body: JSON.stringify({
        reportedUserId: DAVE,
        conversationId,
        messageId: target.id,
        reason: 'spam',
      }),
    });
    expect(report.status).toBe(201);
    expect(report.body.context.map((m: { text: string }) => m.text)).toEqual(['wire one', 'wire two']);
    const gated = await api(ALICE, 'alice', '/chat/reports');
    expect(gated.status).toBe(403);
    process.env.ADMIN_USER_IDS = ALICE;
    try {
      const queue = await api(ALICE, 'alice', '/chat/reports');
      expect(queue.status).toBe(200);
      expect(queue.body.reports).toHaveLength(1);
    } finally {
      delete process.env.ADMIN_USER_IDS;
    }

    // Push token register + unregister.
    const token = 'ExponentPushToken[wire-test]';
    const registered = await api(DAVE, 'dave', '/chat/push-token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(registered.status).toBe(201);
    expect(models.pushTokens.docs).toHaveLength(1);
    const unregistered = await api(DAVE, 'dave', '/chat/push-token', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    });
    expect(unregistered.status).toBe(200);
    expect(models.pushTokens.docs).toHaveLength(0);

    // Conversation state: mute shows on the summary; delete-for-me hides.
    const muted = await api(DAVE, 'dave', `/chat/conversations/${conversationId}/state`, {
      method: 'POST',
      body: JSON.stringify({ muted: true }),
    });
    expect(muted.status).toBe(201);
    expect(muted.body.muted).toBe(true);
    const cleared = await api(DAVE, 'dave', `/chat/conversations/${conversationId}/delete-for-me`, {
      method: 'POST',
      body: '{}',
    });
    expect(cleared.status).toBe(201);
    const daveInbox = await api(DAVE, 'dave', '/chat/conversations');
    expect(daveInbox.body.conversations.map((c: { id: string }) => c.id)).not.toContain(conversationId);
    const aliceInbox = await api(ALICE, 'alice', '/chat/conversations');
    expect(aliceInbox.body.conversations.map((c: { id: string }) => c.id)).toContain(conversationId);

    // Block → blocked list → unblock reopens the pair.
    const blockedRes = await api(ALICE, 'alice', `/chat/users/${DAVE}/block`, { method: 'POST', body: '{}' });
    expect(blockedRes.status).toBe(201);
    const blockedList = await api(ALICE, 'alice', '/chat/users/blocked');
    expect(blockedList.status).toBe(200);
    expect(blockedList.body.users.map((u: { id: string }) => u.id)).toContain(DAVE);
    const unblocked = await api(ALICE, 'alice', `/chat/users/${DAVE}/unblock`, { method: 'POST', body: '{}' });
    expect(unblocked.status).toBe(201);
    expect((await api(ALICE, 'alice', '/chat/users/blocked')).body.users).toHaveLength(0);
    const reopened = await api(ALICE, 'alice', '/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: DAVE }),
    });
    expect(reopened.body.conversation.status).toBe('active');

    // Pagination: the inbox answers with a nextCursor field.
    const inbox = await api(ALICE, 'alice', '/chat/conversations?limit=1');
    expect(inbox.status).toBe(200);
    expect(inbox.body).toHaveProperty('nextCursor');
    expect(inbox.body).toHaveProperty('archivedCount');
  }, 20000);

  it('people search is throttled per user (31st call in a minute is a 429)', async () => {
    // Dave is used ONLY here so no other test eats his budget.
    let lastStatus = 0;
    for (let i = 0; i < 31; i += 1) {
      const res = await api(DAVE, 'dave', '/chat/people/search?q=al');
      lastStatus = res.status;
      if (i < 30) expect(res.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
  }, 20000);
});

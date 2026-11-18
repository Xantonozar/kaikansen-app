import { describe, expect, it } from '@jest/globals';
import type {
  ChatLastMessage,
  ChatUserSummary,
  LadderStanding,
} from '@kaikansen/contracts';
import {
  applyInboxAccepted,
  applyInboxMessage,
  applyInboxPresence,
  applyIncoming,
  applyReadReceipt,
  buildThreadItems,
  chatPushRoute,
  dayLabel,
  deliveryStatus,
  failLocal,
  formatInboxTime,
  headerLine,
  mergeCatchUp,
  messagePreview,
  rankRpLine,
  resolveLocal,
  retryLocal,
  timeOfDay,
  type LocalMessage,
} from './chatLogic';
import type { ChatConversationSummary, ChatMessage } from '@kaikansen/contracts';

const ME = 'user-me';
const OTHER = 'user-other';
const NOW = new Date('2026-11-17T15:00:00');

const ladder: LadderStanding = {
  rank: 'jonin',
  index: 11,
  nextRank: 'ronin',
  toNext: 660,
  fraction: 0.78,
};

const other: ChatUserSummary = {
  id: OTHER,
  username: 'mochichan',
  displayName: 'MochiChan',
  avatarUrl: null,
  rp: 2340,
  ladder,
  online: true,
  lastActiveAt: null,
};

let seq = 0;
function msg(partial: Partial<LocalMessage> = {}): LocalMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    senderId: OTHER,
    type: 'text',
    text: `text-${seq}`,
    theme: null,
    createdAt: '2026-11-17T14:00:00.000Z',
    readAt: null,
    ...partial,
  };
}

describe('messagePreview', () => {
  it('renders text verbatim and themes as ♪ Title — Artist', () => {
    const text: ChatLastMessage = {
      id: 'm0',
      type: 'text',
      text: 'gg last game',
      themeTitle: null,
      themeArtist: null,
      senderId: OTHER,
      createdAt: '2026-11-17T14:00:00.000Z',
    };
    expect(messagePreview(text)).toBe('gg last game');
    const theme: ChatLastMessage = {
      ...text,
      type: 'theme',
      text: null,
      themeTitle: 'Gurenge',
      themeArtist: 'LiSA',
    };
    expect(messagePreview(theme)).toBe('♪ Gurenge — LiSA');
    expect(messagePreview(null)).toBe('');
  });
});

describe('formatInboxTime / dayLabel / timeOfDay', () => {
  it('walks the mock ladder: minutes, hours, Yesterday, weekday, date', () => {
    expect(formatInboxTime('2026-11-17T14:58:00', NOW)).toBe('2m');
    expect(formatInboxTime('2026-11-17T14:00:00', NOW)).toBe('1h');
    expect(formatInboxTime('2026-11-16T20:00:00', NOW)).toBe('Yesterday');
    expect(formatInboxTime('2026-11-14T12:00:00', NOW)).toBe('Sat');
    expect(formatInboxTime('2026-10-01T12:00:00', NOW)).toContain('2026');
  });

  it('labels days and formats 24h times', () => {
    expect(dayLabel('2026-11-17T09:00:00', NOW)).toBe('Today');
    expect(dayLabel('2026-11-16T09:00:00', NOW)).toBe('Yesterday');
    expect(timeOfDay('2026-11-17T14:02:00')).toBe('14:02');
    expect(timeOfDay('2026-11-17T09:05:00')).toBe('09:05');
  });
});

describe('rank / presence lines', () => {
  it('formats "<Rank> · <RP> RP" and the header line', () => {
    expect(rankRpLine(other)).toBe('Jonin · 2,340 RP');
    expect(headerLine(other)).toBe('Jonin · Online');
    expect(headerLine({ ...other, online: false, lastActiveAt: '2026-11-17T10:00:00.000Z' })).toBe(
      'Jonin · Active recently',
    );
    expect(headerLine({ ...other, online: false, lastActiveAt: null })).toBe('Jonin · Offline');
  });
});

describe('deliveryStatus', () => {
  it('is null for the other side and derives mine from local state then readAt', () => {
    expect(deliveryStatus(msg({ senderId: OTHER }), ME)).toBeNull();
    expect(deliveryStatus(msg({ senderId: ME, localStatus: 'sending' }), ME)).toBe('sending');
    expect(deliveryStatus(msg({ senderId: ME, localStatus: 'failed' }), ME)).toBe('failed');
    expect(deliveryStatus(msg({ senderId: ME }), ME)).toBe('sent');
    expect(
      deliveryStatus(msg({ senderId: ME, readAt: '2026-11-17T14:30:00.000Z' }), ME),
    ).toBe('read');
  });
});

describe('optimistic send state machine', () => {
  it('append → resolve swaps in the server copy', () => {
    const optimistic: LocalMessage = {
      ...msg({ senderId: ME, text: 'hi' }),
      id: 'local-1',
      clientId: 'client-1',
      localStatus: 'sending',
    };
    const list = [optimistic];
    const server = msg({ senderId: ME, text: 'hi' });
    const resolved = resolveLocal(list, 'client-1', server);
    expect(resolved[0].id).toBe(server.id);
    expect(resolved[0].localStatus).toBeUndefined();
  });

  it('append → fail → retry → resolve keeps one bubble throughout', () => {
    let list: LocalMessage[] = [
      { ...msg({ senderId: ME }), id: 'local-9', clientId: 'c-9', localStatus: 'sending' },
    ];
    list = failLocal(list, 'c-9');
    expect(list[0].localStatus).toBe('failed');
    list = retryLocal(list, 'c-9');
    expect(list[0].localStatus).toBe('sending');
    list = resolveLocal(list, 'c-9', msg({ senderId: ME }));
    expect(list).toHaveLength(1);
    expect(list[0].localStatus).toBeUndefined();
  });

  it('applyIncoming resolves echoes by clientId and dedupes by id', () => {
    const optimistic: LocalMessage = {
      ...msg({ senderId: ME }),
      id: 'local-1',
      clientId: 'c-1',
      localStatus: 'sending',
    };
    const serverCopy = { ...msg({ senderId: ME }), clientId: 'c-1' };
    const after = applyIncoming([optimistic], serverCopy);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(serverCopy.id);
    // Same server message delivered twice → still one copy.
    expect(applyIncoming(after, serverCopy)).toHaveLength(1);
    // A genuinely new incoming message appends.
    const fresh = msg({ senderId: OTHER });
    expect(applyIncoming(after, fresh)).toHaveLength(2);
  });
});

describe('applyReadReceipt', () => {
  it('marks only my messages up to the receipt instant', () => {
    const mine1 = msg({ senderId: ME, createdAt: '2026-11-17T14:00:00.000Z' });
    const mine2 = msg({ senderId: ME, createdAt: '2026-11-17T14:50:00.000Z' });
    const theirs = msg({ senderId: OTHER, createdAt: '2026-11-17T14:10:00.000Z' });
    const out = applyReadReceipt([mine1, mine2, theirs], OTHER, '2026-11-17T14:30:00.000Z');
    expect(out[0].readAt).toBe('2026-11-17T14:30:00.000Z');
    expect(out[1].readAt).toBeNull();
    expect(out[2].readAt).toBeNull();
  });
});

describe('mergeCatchUp (reconnect catch-up)', () => {
  it('adds missed messages, refreshes held ones, keeps older pages, stays ordered', () => {
    const held1 = msg({ id: 'srv-1', text: 'one', createdAt: '2026-11-17T10:00:00.000Z' });
    const held3 = msg({ id: 'srv-3', text: 'three', createdAt: '2026-11-17T10:02:00.000Z' });
    const page: ChatMessage[] = [
      { ...held1, readAt: '2026-11-17T10:05:00.000Z' },
      msg({ id: 'srv-2', text: 'two (missed)', createdAt: '2026-11-17T10:01:00.000Z' }),
      held3,
    ];
    const merged = mergeCatchUp([held1, held3], page);
    expect(merged.map((m) => m.id)).toEqual(['srv-1', 'srv-2', 'srv-3']);
    expect(merged[0].readAt).toBe('2026-11-17T10:05:00.000Z'); // server copy wins
    expect(merged[1].text).toBe('two (missed)');
  });
});

describe('inbox local patching', () => {
  function row(partial: Partial<ChatConversationSummary> = {}): ChatConversationSummary {
    return {
      id: 'conv-1',
      other,
      status: 'active',
      requestedBy: null,
      lastMessage: null,
      unreadCount: 0,
      muted: false,
      archived: false,
      updatedAt: '2026-11-17T10:00:00.000Z',
      ...partial,
    };
  }
  function chatMsg(partial: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'srv-9',
      conversationId: 'conv-1',
      senderId: OTHER,
      type: 'text',
      text: 'new!',
      theme: null,
      createdAt: '2026-11-17T11:00:00.000Z',
      readAt: null,
      ...partial,
    };
  }

  it('applyInboxMessage updates preview/unread and moves the row to the top', () => {
    const rows = [row({ id: 'conv-2' }), row()];
    const res = applyInboxMessage(rows, chatMsg());
    expect(res.handled).toBe(true);
    expect(res.unreadDelta).toBe(1);
    expect(res.rows[0].id).toBe('conv-1');
    expect(res.rows[0].unreadCount).toBe(1);
    expect(res.rows[0].lastMessage?.text).toBe('new!');
    // My own message (from another device) does not raise unread.
    const own = applyInboxMessage(rows, chatMsg({ senderId: ME }));
    expect(own.unreadDelta).toBe(0);
    // Unknown conversation → not handled (caller refetches).
    const unknown = applyInboxMessage(rows, chatMsg({ conversationId: 'conv-x' }));
    expect(unknown.handled).toBe(false);
  });

  it('applyInboxPresence flips only the matching row dot; applyInboxAccepted flips status', () => {
    const someoneElse: ChatUserSummary = { ...other, id: 'user-third', username: 'third' };
    const rows = [row(), row({ id: 'conv-2', other: someoneElse })];
    const flipped = applyInboxPresence(rows, { userId: OTHER, online: false });
    expect(flipped[0].other.online).toBe(false);
    expect(flipped[1].other.online).toBe(true); // untouched row keeps its summary
    expect(applyInboxPresence(rows, { userId: 'nobody', online: false })).toBe(rows);
    const accepted = applyInboxAccepted([row({ status: 'request', requestedBy: ME })], 'conv-1');
    expect(accepted[0].status).toBe('active');
  });
});

describe('buildThreadItems', () => {
  it('inserts a day divider before each new day', () => {
    const a = msg({ createdAt: '2026-11-16T22:00:00' });
    const b = msg({ createdAt: '2026-11-17T09:00:00' });
    const c = msg({ createdAt: '2026-11-17T09:05:00' });
    const items = buildThreadItems([a, b, c], NOW);
    expect(items.map((i) => i.type)).toEqual([
      'day',
      'message',
      'day',
      'message',
      'message',
    ]);
    const labels = items
      .filter((i) => i.type === 'day')
      .map((i) => (i.type === 'day' ? i.label : ''));
    expect(labels).toEqual(['Yesterday', 'Today']);
  });
});

describe('chatPushRoute (push tap routing)', () => {
  it('a message push opens its conversation', () => {
    expect(
      chatPushRoute({ kind: 'chat-message', conversationId: 'conv-9' }),
    ).toBe('/chat/conv-9');
  });

  it('a request push opens the requests screen', () => {
    expect(
      chatPushRoute({ kind: 'chat-request', conversationId: 'conv-9' }),
    ).toBe('/chat/requests');
  });

  it('anything unrecognised routes nowhere', () => {
    expect(chatPushRoute(null)).toBeNull();
    expect(chatPushRoute(undefined)).toBeNull();
    expect(chatPushRoute({})).toBeNull();
    expect(chatPushRoute({ kind: 'chat-message' })).toBeNull();
    expect(chatPushRoute({ kind: 'chat-message', conversationId: '' })).toBeNull();
    expect(chatPushRoute({ kind: 'something-else', conversationId: 'c' })).toBeNull();
  });
});

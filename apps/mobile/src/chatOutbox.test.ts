import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addToOutbox,
  clearDraft,
  getDraft,
  getOutbox,
  loadDraft,
  removeFromOutbox,
  resetChatOutbox,
  setDraft,
  updateOutbox,
  whenOutboxPersisted,
} from './chatOutbox';
import type { LocalMessage } from './chatLogic';

/**
 * The outbox holds pending/failed bubbles outside component
 * state so they survive leaving and re-entering a thread.
 */

let seq = 0;
function bubble(conversationId: string): LocalMessage {
  seq += 1;
  return {
    id: `local-${seq}`,
    clientId: `client-${seq}`,
    conversationId,
    senderId: 'me',
    type: 'text',
    text: `draft ${seq}`,
    theme: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    readAt: null,
    localStatus: 'sending',
  };
}

describe('chatOutbox', () => {
  it('adds, patches and removes bubbles per conversation', () => {
    const a = bubble('conv-a');
    const b = bubble('conv-b');
    addToOutbox('conv-a', a);
    addToOutbox('conv-b', b);
    expect(getOutbox('conv-a')).toEqual([a]);
    expect(getOutbox('conv-b')).toEqual([b]);
    expect(getOutbox('conv-none')).toEqual([]);

    updateOutbox('conv-a', a.clientId!, { localStatus: 'failed' });
    expect(getOutbox('conv-a')[0].localStatus).toBe('failed');
    // Retry re-arms the SAME bubble (same clientId → server dedupe).
    updateOutbox('conv-a', a.clientId!, { localStatus: 'sending' });
    expect(getOutbox('conv-a')[0].localStatus).toBe('sending');
    expect(getOutbox('conv-a')[0].clientId).toBe(a.clientId);

    removeFromOutbox('conv-a', a.clientId!);
    expect(getOutbox('conv-a')).toEqual([]);
    expect(getOutbox('conv-b')).toEqual([b]); // other conversation untouched
  });

  it('returns a stable empty array for unknown conversations', () => {
    expect(getOutbox('conv-x')).toBe(getOutbox('conv-y'));
  });
});

describe('chatOutbox durability (deep-analysis fix pass)', () => {
  const CONV = 'conv-persist-1';

  function failedBubble(clientId: string, text: string): LocalMessage {
    return {
      id: clientId,
      clientId,
      conversationId: CONV,
      senderId: 'me',
      type: 'text',
      text,
      theme: null,
      createdAt: '2026-11-18T10:00:00.000Z',
      readAt: null,
      localStatus: 'failed',
    };
  }

  beforeEach(async () => {
    resetChatOutbox();
    await whenOutboxPersisted();
  });

  it('a failed bubble round-trips through AsyncStorage', async () => {
    addToOutbox(CONV, failedBubble('c-1', 'hello darkness'));
    await whenOutboxPersisted();
    const raw = await AsyncStorage.getItem('kaikansen.chatOutbox.v1');
    expect(raw).toContain('hello darkness');
    const parsed = JSON.parse(raw as string) as Record<string, LocalMessage[]>;
    expect(parsed[CONV][0].clientId).toBe('c-1');
    expect(parsed[CONV][0].localStatus).toBe('failed');
  });

  it('removing a bubble cleans its storage entry', async () => {
    addToOutbox(CONV, failedBubble('c-2', 'gone soon'));
    await whenOutboxPersisted();
    removeFromOutbox(CONV, 'c-2');
    await whenOutboxPersisted();
    const raw = await AsyncStorage.getItem('kaikansen.chatOutbox.v1');
    expect(raw ?? '').not.toContain('gone soon');
  });

  it('reset drops bubbles AND drafts from memory and storage', async () => {
    addToOutbox(CONV, failedBubble('c-3', 'session one'));
    setDraft(CONV, 'a draft');
    await whenOutboxPersisted();
    resetChatOutbox();
    await whenOutboxPersisted();
    expect(getOutbox(CONV)).toHaveLength(0);
    expect(getDraft(CONV)).toBe('');
    expect(await AsyncStorage.getItem('kaikansen.chatOutbox.v1')).toBeNull();
    expect(await AsyncStorage.getItem('kaikansen.chatDrafts.v1')).toBeNull();
  });

  it('drafts persist and load back', async () => {
    setDraft(CONV, 'half-typed thought');
    await whenOutboxPersisted();
    const raw = await AsyncStorage.getItem('kaikansen.chatDrafts.v1');
    expect(raw).toContain('half-typed thought');
    expect(await loadDraft(CONV)).toBe('half-typed thought');
    clearDraft(CONV);
    expect(getDraft(CONV)).toBe('');
  });
});

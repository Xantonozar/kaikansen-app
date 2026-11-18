import { useSyncExternalStore } from 'react';
import type { LocalMessage } from './chatLogic';
import { plainStorage } from './storage';

/**
 * The chat outbox — optimistic (sending) and failed bubbles,
 * held OUTSIDE the thread screen's component state, keyed by
 * conversation. Leaving a thread and coming back restores its
 * pending/failed bubbles with tap-to-retry intact, instead of
 * silently discarding a failed send on unmount.
 *
 * DURABLE (deep-analysis fix pass): the boxes are mirrored to
 * AsyncStorage on every mutation and rehydrated at app start
 * (hydrateChatOutbox), so a failed bubble survives the app
 * PROCESS dying too, not just navigation. Only localStatus
 * bubbles live here (server messages refetch); a bubble leaves
 * the outbox the moment its send resolves. Per-conversation
 * composer DRAFTS persist alongside (same storage family).
 *
 * resetChatOutbox() is the session-teardown hook: one account's
 * pending bubbles and drafts must never surface in another's
 * session.
 */

const EMPTY: LocalMessage[] = [];
const boxes = new Map<string, LocalMessage[]>();
const listeners = new Set<() => void>();

const OUTBOX_KEY = 'kaikansen.chatOutbox.v1';
const DRAFTS_KEY = 'kaikansen.chatDrafts.v1';

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---------------- persistence ---------------- */

let persistChain: Promise<void> = Promise.resolve();

function persistOutbox(): void {
  const snapshot: Record<string, LocalMessage[]> = {};
  for (const [id, list] of boxes) {
    if (list.length > 0) snapshot[id] = list;
  }
  // Serialised writes: rapid mutations can't land out of order.
  persistChain = persistChain
    .then(() => plainStorage.set(OUTBOX_KEY, JSON.stringify(snapshot)))
    .catch(() => {
      // Storage failure (quota, platform) — the in-memory store
      // still works for this session; durability is best-effort.
    });
}

/** Resolves when every queued outbox write has landed (test seam). */
export function whenOutboxPersisted(): Promise<void> {
  return persistChain;
}

let hydrated = false;

/**
 * Loads persisted bubbles into the in-memory store (app start).
 * Idempotent; in-memory entries win over stale disk copies.
 */
export async function hydrateChatOutbox(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await plainStorage.get(OUTBOX_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, LocalMessage[]>;
    let changed = false;
    for (const [id, list] of Object.entries(parsed)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      if (!boxes.has(id)) {
        // A bubble still marked 'sending' at hydrate time was
        // interrupted mid-flight — it is retryable, not sending.
        boxes.set(
          id,
          list.map((m) =>
            m.localStatus === 'sending' ? { ...m, localStatus: 'failed' } : m,
          ),
        );
        changed = true;
      }
    }
    if (changed) notify();
  } catch {
    // Corrupt snapshot: start empty rather than crash the thread.
  }
}

/** Session teardown: drops every box + draft, in memory and on disk. */
export function resetChatOutbox(): void {
  boxes.clear();
  drafts.clear();
  notify();
  persistChain = persistChain
    .then(async () => {
      await plainStorage.remove(OUTBOX_KEY);
      await plainStorage.remove(DRAFTS_KEY);
    })
    .catch(() => undefined);
}

/* ---------------- bubbles ---------------- */

export function getOutbox(conversationId: string): LocalMessage[] {
  return boxes.get(conversationId) ?? EMPTY;
}

export function addToOutbox(conversationId: string, msg: LocalMessage): void {
  boxes.set(conversationId, [...getOutbox(conversationId), msg]);
  persistOutbox();
  notify();
}

/** Patches one outbox bubble (e.g. sending → failed, failed → sending on retry). */
export function updateOutbox(
  conversationId: string,
  clientId: string,
  patch: Partial<LocalMessage>,
): void {
  const list = getOutbox(conversationId);
  if (!list.some((m) => m.clientId === clientId)) return;
  boxes.set(
    conversationId,
    list.map((m) => (m.clientId === clientId ? { ...m, ...patch } : m)),
  );
  persistOutbox();
  notify();
}

export function removeFromOutbox(
  conversationId: string,
  clientId: string,
): void {
  const list = getOutbox(conversationId);
  if (!list.some((m) => m.clientId === clientId)) return;
  boxes.set(
    conversationId,
    list.filter((m) => m.clientId !== clientId),
  );
  persistOutbox();
  notify();
}

/** React binding: the conversation's pending/failed bubbles, live. */
export function useOutbox(conversationId: string): LocalMessage[] {
  return useSyncExternalStore(
    subscribe,
    () => getOutbox(conversationId),
    () => getOutbox(conversationId),
  );
}

/* ---------------- drafts ---------------- */

const drafts = new Map<string, string>();
let draftsLoaded: Promise<void> | null = null;

function loadDrafts(): Promise<void> {
  if (!draftsLoaded) {
    draftsLoaded = (async () => {
      try {
        const raw = await plainStorage.get(DRAFTS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, string>;
        for (const [id, text] of Object.entries(parsed)) {
          if (typeof text === 'string' && !drafts.has(id)) {
            drafts.set(id, text);
          }
        }
      } catch {
        // Corrupt snapshot: no drafts.
      }
    })();
  }
  return draftsLoaded;
}

/** The saved composer draft for a conversation (after loadDrafts has run). */
export function getDraft(conversationId: string): string {
  return drafts.get(conversationId) ?? '';
}

/** Ensures drafts are loaded from disk, then returns one. */
export async function loadDraft(conversationId: string): Promise<string> {
  await loadDrafts();
  return getDraft(conversationId);
}

export function setDraft(conversationId: string, text: string): void {
  if (text) drafts.set(conversationId, text);
  else drafts.delete(conversationId);
  const snapshot: Record<string, string> = {};
  for (const [id, value] of drafts) snapshot[id] = value;
  persistChain = persistChain
    .then(() => plainStorage.set(DRAFTS_KEY, JSON.stringify(snapshot)))
    .catch(() => undefined);
}

export function clearDraft(conversationId: string): void {
  setDraft(conversationId, '');
}

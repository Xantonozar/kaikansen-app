import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

/**
 * Request deadlines (perf problem 13B) against a scripted global
 * fetch + Jest fake timers:
 *
 *  - a never-settling fetch aborts when its class deadline elapses
 *    and the rejection is the EXISTING error shape — an
 *    ApiTimeoutError that extends TypeError, the class a dead
 *    network rejects with today (no new UI state anywhere);
 *  - each deadline class keeps its own constant (STANDARD fires at
 *    25s and not before; the AniList page-1 LONG read is still
 *    pending at 25s and fires at 45s);
 *  - the 401 refresh-retry gets its OWN clock: a retry issued just
 *    before the FIRST attempt's deadline would have fired still
 *    completes, because its clock started at the retry, not at the
 *    original send — and a retry that itself hangs times out on
 *    its own schedule.
 */

// api.ts imports the fixture bundle; stub it so the suite stays
// hermetic (same pattern as api.test.ts).
jest.mock('./fixtures/popularThemes', () => ({ popularThemesFixture: [] }));

// (libraryApi is deliberately NOT imported here: under Jest the
// API URL is unset, so its functions short-circuit in fixture mode
// before any network — the LONG-class test below drives the exact
// apiJson call its AniList page-1 read makes.)

import {
  ApiTimeoutError,
  apiJson,
  fetchWithDeadline,
  invalidateAfterMutation,
  REQUEST_DEADLINE_MS,
} from './api';
import {
  registerRefreshHandler,
  setAccessToken,
  setSessionUserId,
} from './session';
import { appCache } from './apiCache';

type FetchInit = { signal?: AbortSignal } | undefined;
type FetchFn = (url: string, init?: FetchInit) => Promise<unknown>;

const fetchMock = jest.fn<FetchFn>();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * A fetch that never settles on its own — it rejects the way real
 * fetch does when its signal aborts. Every signal it receives is
 * recorded so tests can tell the attempts apart. The mock is
 * UNTYPED on purpose: apiJson's internal fetch call passes a full
 * RequestInit while fetchWithDeadline tests pass minimal inits —
 * one loose signature serves both (the harness-wide global stub is
 * cast once, below).
 *
 * NOTE the abort listener is attached to the FETCH's signal (the
 * controller fetchWithDeadline hands in), never to a caller-passed
 * signal: fetchWithDeadline replaces the caller's signal with its
 * own controller's and links the two internally — exactly like
 * real fetch consumes only the signal it is given.
 */
function neverSettlingFetch(receivedSignals: (AbortSignal | undefined)[]) {
  fetchMock.mockImplementation((...args: unknown[]) => {
    const init = args[1] as FetchInit;
    return new Promise((_resolve, reject) => {
      receivedSignals.push(init?.signal);
      init?.signal?.addEventListener('abort', () => reject(abortError()));
    });
  });
}

/** Flush pending microtasks without touching the fake timers. */
const flushMicrotasks = async (rounds = 25) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  appCache.clear();
  setAccessToken('test-token');
  setSessionUserId('deadline-test-user');
  registerRefreshHandler(null);
});

afterEach(() => {
  registerRefreshHandler(null);
  jest.useRealTimers();
});

describe('deadline constants', () => {
  it('are the spec classes: STANDARD 25s, LONG 45s', () => {
    expect(REQUEST_DEADLINE_MS.STANDARD).toBe(25_000);
    expect(REQUEST_DEADLINE_MS.LONG).toBe(45_000);
  });
});

describe('a never-settling fetch under the deadline', () => {
  it('aborts at the deadline and surfaces the existing error shape', async () => {
    neverSettlingFetch([]);
    const pending = apiJson('/season?season=FALL&year=2026&page=1');
    const rejection = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
    // Not a moment before the STANDARD clock runs out.
    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS.STANDARD - 1);
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1);
    await rejection;
    const err = await pending.catch((e: unknown) => e);
    // The existing shape: a TypeError (dead-network class), an
    // Error — NOT an ApiRequestError (no HTTP status was answered).
    expect(err).toBeInstanceOf(TypeError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('ApiTimeoutError');
  });

  it('fetchWithDeadline converts OUR abort but never a foreign one', async () => {
    const receivedSignals: (AbortSignal | undefined)[] = [];
    neverSettlingFetch(receivedSignals);
    const foreign = new AbortController();
    const pending = fetchWithDeadline(
      'https://example.invalid/x',
      { signal: foreign.signal },
      REQUEST_DEADLINE_MS.LONG,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    // fetchWithDeadline hands fetch its OWN controller's signal,
    // linked to the foreign one — fetch never sees the foreign
    // signal itself.
    expect(receivedSignals[0]).toBeDefined();
    expect(receivedSignals[0]).not.toBe(foreign.signal);
    // The foreign signal fires long before the deadline: it aborts
    // the attempt through the link, and the raw AbortError stands —
    // it is not re-labelled a timeout.
    foreign.abort();
    await rejection;
  });

  it('a fetch that settles inside the deadline resolves untouched', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));
    await expect(
      fetchWithDeadline('https://example.invalid/x', undefined, 1_000),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('the LONG class (first AniList sync)', () => {
  it('page 1 is still pending at STANDARD and fires at LONG', async () => {
    const receivedSignals: (AbortSignal | undefined)[] = [];
    neverSettlingFetch(receivedSignals);
    // The FIRST network load of this key may already have run in
    // another test (module-level cache singleton): drop the key
    // through the real mutation-invalidation path so this read is
    // a genuine cache miss that reaches the network.
    invalidateAfterMutation('POST', '/library/history');
    // Fixture mode (no EXPO_PUBLIC_API_URL under Jest) makes the
    // library client resolve its honest empty shape WITHOUT any
    // network — call apiJson directly with the very init
    // fetchAnilistThemesPage(1) sends (same path, same LONG
    // deadline — apiJson never branches on fixtureMode).
    let settledWith: unknown = null;
    const pending = apiJson(
      '/library/themes?source=anilist&page=1&limit=10',
      { deadline: 'LONG' },
    ).catch((e: unknown) => {
      settledWith = e;
      return e;
    });
    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS.STANDARD);
    await flushMicrotasks();
    expect(settledWith).toBeNull();
    // Something must have reached the (never-settling) network…
    expect(receivedSignals.length).toBeGreaterThan(0);
    // …and at STANDARD its clock has NOT fired (LONG class).
    expect(receivedSignals[0]?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(
      REQUEST_DEADLINE_MS.LONG - REQUEST_DEADLINE_MS.STANDARD,
    );
    await pending;
    expect(settledWith).toBeInstanceOf(ApiTimeoutError);
  });
});

describe('the 401 refresh-retry clock', () => {
  it('the retry gets a fresh clock — the first deadline does not kill it', async () => {
    registerRefreshHandler(async () => 'fresh-token');
    const calls: { at: number; signal?: AbortSignal }[] = [];
    fetchMock.mockImplementation((...args: unknown[]) => {
      const init = args[1] as FetchInit;
      calls.push({ at: Date.now(), signal: init?.signal });
      if (calls.length === 1) {
        // Attempt 1 hangs until t=20s, then answers 401 (expired).
        return new Promise((resolve) => {
          setTimeout(
            () => resolve(jsonResponse({ message: 'expired' }, 401)),
            20_000,
          );
        });
      }
      // The retry hangs until t=40s, then answers 200. Under a
      // SHARED clock started at t=0 it would have been aborted at
      // t=25s; under its own clock (t=20s + 25s) it completes.
      return new Promise((resolve) => {
        setTimeout(() => resolve(jsonResponse({ retried: true })), 20_000);
      });
    });

    const pending = apiJson('/season?season=FALL&year=2026&page=1');
    await jest.advanceTimersByTimeAsync(20_000); // attempt 1 → 401, refresh, retry sent
    await flushMicrotasks();
    expect(calls.length).toBe(2);
    await jest.advanceTimersByTimeAsync(5_000); // t=25s: attempt-1 deadline passes
    await flushMicrotasks();
    expect(calls[1].signal?.aborted).toBe(false); // retry untouched by it
    await jest.advanceTimersByTimeAsync(15_000); // t=40s: retry answers
    await expect(pending).resolves.toEqual({ retried: true });
  });

  it('a retry that itself hangs times out on its OWN schedule', async () => {
    registerRefreshHandler(async () => 'fresh-token');
    let attempt = 0;
    fetchMock.mockImplementation((...args: unknown[]) => {
      const init = args[1] as FetchInit;
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve(jsonResponse({ message: 'expired' }, 401));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      });
    });

    const pending = apiJson('/season?season=FALL&year=2026&page=1');
    const rejection = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
    await flushMicrotasks(); // 401 → refresh → retry sent (its clock starts now)
    expect(attempt).toBe(2);
    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS.STANDARD - 1);
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it('a timeout on attempt 1 never reaches the refresh path (no 401 answered)', async () => {
    const refresh = jest.fn(async () => 'fresh-token');
    registerRefreshHandler(refresh);
    neverSettlingFetch([]);
    const pending = apiJson('/season?season=FALL&year=2026&page=1');
    const rejection = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError);
    await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS.STANDARD);
    await rejection;
    expect(refresh).not.toHaveBeenCalled();
  });
});

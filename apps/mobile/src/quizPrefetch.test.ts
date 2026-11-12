import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Quiz slice prefetch (part 6, 2026-11-11) against an in-memory
 * fake of expo-file-system: a Map is the disk, and the resumable
 * download is a scripted two-chunk transfer whose cancel keeps
 * the partial file — the native semantics the module relies on
 * (downloads.ts precedent). No real filesystem, no network.
 */

const mockFileSizes = new Map<string, number>();
const mockDeleted: string[] = [];
const mockTransfers = new Map<
  string,
  { totalBytes: number; fail?: boolean; httpStatus?: number }
>();
const mockTasks: {
  url: string;
  destUri: string;
  cancelled: boolean;
  cancelCalls: number;
}[] = [];

/** Mutable API base for the phase 2 derivation (fixture mode = undefined). */
const mockApiBase: { value: string | undefined } = {
  value: 'https://api.test',
};

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

jest.mock('./api', () => ({
  get apiBaseUrl() {
    return mockApiBase.value;
  },
}));

jest.mock('expo-file-system', () => {
  class MockDirectory {
    uri: string;
    exists = true;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}${name}/`;
    }
    create(): void {
      // The fake disk always has the directory.
    }
  }
  class MockFile {
    uri: string;
    constructor(dir: { uri: string }, name: string) {
      this.uri = `${dir.uri}${name}`;
    }
    get exists(): boolean {
      return mockFileSizes.has(this.uri);
    }
    get size(): number {
      return mockFileSizes.get(this.uri) ?? 0;
    }
    delete(): void {
      mockDeleted.push(this.uri);
      mockFileSizes.delete(this.uri);
    }
  }
  return {
    Paths: {
      cache: { uri: 'file:///cache/' },
      document: { uri: 'file:///docs/' },
    },
    Directory: MockDirectory,
    File: MockFile,
  };
});

jest.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: (
    url: string,
    destUri: string,
    _options: unknown,
    callback?: (data: {
      totalBytesWritten: number;
      totalBytesExpectedToWrite: number;
    }) => void,
  ) => {
    const script = mockTransfers.get(url) ?? { totalBytes: 0 };
    const record = { url, destUri, cancelled: false, cancelCalls: 0 };
    mockTasks.push(record);
    const emit = (written: number) => {
      mockFileSizes.set(destUri, written);
      callback?.({
        totalBytesWritten: written,
        totalBytesExpectedToWrite: script.totalBytes,
      });
    };
    return {
      downloadAsync: async () => {
        if (script.fail) throw new Error('network down');
        // Two chunks (60%, then the rest); a cancel landing
        // between them resolves undefined with the partial kept.
        emit(Math.floor(script.totalBytes * 0.6));
        if (record.cancelled) return undefined;
        emit(script.totalBytes);
        if (record.cancelled) return undefined;
        return { status: script.httpStatus ?? 200, uri: destUri };
      },
      cancelAsync: async () => {
        record.cancelled = true;
        record.cancelCalls += 1;
      },
    };
  },
}));

import {
  QUIZ_SLICE_CAP_BYTES,
  QUIZ_SLICE_GRACE_MS,
  QUIZ_SLICE_MIN_BYTES,
  clearQuizSlices,
  getQuizSliceState,
  getQuizSliceUri,
  headCacheUrlFor,
  isQuizSliceUri,
  pinQuizSlice,
  prefetchQuizSlice,
  quizRemoteChain,
  quizSliceCandidates,
  sliceCapReached,
  sliceFileNameFor,
  sliceGraceApplies,
  sliceIsUsable,
  sliceSourceUrls,
  whenQuizSliceSettles,
} from './quizPrefetch';

const OGG_A = 'https://a.example/AnimeA-OP1.ogg';
const OGG_B = 'https://a.example/AnimeB-OP1.ogg';
const OGG_C = 'https://a.example/AnimeC-OP1.ogg';
const VIDEO_A = 'https://v.example/AnimeA-OP1.webm';

function script(url: string, totalBytes: number, fail = false): void {
  mockTransfers.set(url, { totalBytes, fail });
}

function scriptHttp(url: string, totalBytes: number, httpStatus: number): void {
  mockTransfers.set(url, { totalBytes, httpStatus });
}

beforeEach(() => {
  clearQuizSlices();
  mockFileSizes.clear();
  mockDeleted.length = 0;
  mockTasks.length = 0;
  mockTransfers.clear();
  mockApiBase.value = 'https://api.test';
});

describe('pure slice decisions', () => {
  it('the cap decision trips exactly at the cap', () => {
    // 1.5 MB since phase 2 (2026-11-12): the head cache's
    // head size, ~36–40s at the newest bitrates.
    expect(QUIZ_SLICE_CAP_BYTES).toBe(1_500_000);
    expect(sliceCapReached(QUIZ_SLICE_CAP_BYTES - 1)).toBe(false);
    expect(sliceCapReached(QUIZ_SLICE_CAP_BYTES)).toBe(true);
    expect(sliceCapReached(QUIZ_SLICE_CAP_BYTES + 1)).toBe(true);
  });

  it('the minimum-size decision discards slivers', () => {
    expect(QUIZ_SLICE_MIN_BYTES).toBe(64 * 1024);
    expect(sliceIsUsable(QUIZ_SLICE_MIN_BYTES - 1)).toBe(false);
    expect(sliceIsUsable(QUIZ_SLICE_MIN_BYTES)).toBe(true);
  });

  it('file names are sanitised mediaKeys with a load-bearing .ogg', () => {
    expect(sliceFileNameFor('game-1:3')).toBe('game-1_3.ogg');
    expect(sliceFileNameFor('a/b c:9')).toBe('a_b_c_9.ogg');
  });

  it('slice URIs are file:// .ogg only', () => {
    expect(isQuizSliceUri('file:///cache/quiz-slices/g_3.ogg')).toBe(true);
    expect(isQuizSliceUri('https://a.example/x.ogg')).toBe(false);
    expect(isQuizSliceUri('file:///cache/quiz-slices/g_3.webm')).toBe(false);
    expect(isQuizSliceUri(null)).toBe(false);
  });
});

describe('quizSliceCandidates (slice-first chain construction)', () => {
  it('the slice leads, the remote chain follows in order', () => {
    expect(
      quizSliceCandidates('file:///cache/quiz-slices/g_2.ogg', [OGG_A, VIDEO_A]),
    ).toEqual(['file:///cache/quiz-slices/g_2.ogg', OGG_A, VIDEO_A]);
  });

  it('no slice reproduces the old chain exactly (deduped, nulls dropped)', () => {
    expect(quizSliceCandidates(null, [OGG_A, null, VIDEO_A, OGG_A])).toEqual([
      OGG_A,
      VIDEO_A,
    ]);
    expect(quizSliceCandidates(null, [null, null])).toEqual([]);
  });

  it('a slice equal to a chain entry is not duplicated', () => {
    expect(quizSliceCandidates(OGG_A, [OGG_A, VIDEO_A])).toEqual([
      OGG_A,
      VIDEO_A,
    ]);
  });
});

describe('prefetchQuizSlice', () => {
  it('a full small download becomes a ready slice under the cache dir', async () => {
    script(OGG_A, 300_000);
    await prefetchQuizSlice('game:2', OGG_A);
    const uri = getQuizSliceUri('game:2');
    expect(uri).toBe('file:///cache/quiz-slices/game_2.ogg');
    expect(mockTasks).toHaveLength(1);
    expect(mockTasks[0].cancelCalls).toBe(0);
  });

  it('the transfer is cancelled at the byte cap and the partial is the slice', async () => {
    script(OGG_A, 3_500_000); // a whole .ogg — must NOT fully land
    await prefetchQuizSlice('game:2', OGG_A);
    expect(mockTasks[0].cancelCalls).toBe(1);
    const uri = getQuizSliceUri('game:2');
    expect(uri).not.toBeNull();
    // The fake's coarse 60% chunk overshoots the cap before the
    // cancel lands; the cap DECISION is pinned in the pure tests.
    const landed = mockFileSizes.get(uri!) ?? 0;
    expect(landed).toBeLessThan(3_500_000);
    expect(sliceIsUsable(landed)).toBe(true);
  });

  it('a slice under the minimum is discarded and its file deleted', async () => {
    script(OGG_A, 10_000);
    await prefetchQuizSlice('game:2', OGG_A);
    expect(getQuizSliceUri('game:2')).toBeNull();
    expect(mockDeleted).toContain('file:///cache/quiz-slices/game_2.ogg');
    expect(mockFileSizes.has('file:///cache/quiz-slices/game_2.ogg')).toBe(
      false,
    );
  });

  it('a failed transfer leaves nothing — and a later reveal may retry', async () => {
    script(OGG_A, 300_000, true);
    await prefetchQuizSlice('game:2', OGG_A);
    expect(getQuizSliceUri('game:2')).toBeNull();
    script(OGG_A, 300_000);
    await prefetchQuizSlice('game:2', OGG_A);
    expect(getQuizSliceUri('game:2')).not.toBeNull();
    expect(mockTasks).toHaveLength(2);
  });

  it('dedupe: the same key + URL is never restarted (both reveals fire it)', async () => {
    script(OGG_A, 300_000);
    await Promise.all([
      prefetchQuizSlice('game:2', OGG_A), // early reveal
      prefetchQuizSlice('game:2', OGG_A), // feedback reveal
    ]);
    await prefetchQuizSlice('game:2', OGG_A); // already ready
    expect(mockTasks).toHaveLength(1);
  });

  it('a new prefetch evicts the previous unpinned slice', async () => {
    script(OGG_A, 300_000);
    script(OGG_B, 300_000);
    await prefetchQuizSlice('game:2', OGG_A);
    await prefetchQuizSlice('game:3', OGG_B);
    expect(getQuizSliceUri('game:2')).toBeNull();
    expect(mockDeleted).toContain('file:///cache/quiz-slices/game_2.ogg');
    expect(getQuizSliceUri('game:3')).not.toBeNull();
  });

  it('the pinned (live) slice survives eviction; the unpinned next does not', async () => {
    script(OGG_A, 300_000);
    script(OGG_B, 300_000);
    script(OGG_C, 300_000);
    await prefetchQuizSlice('game:2', OGG_A);
    pinQuizSlice('game:2'); // question 2 went live
    await prefetchQuizSlice('game:3', OGG_B);
    expect(getQuizSliceUri('game:2')).not.toBeNull();
    expect(getQuizSliceUri('game:3')).not.toBeNull();
    await prefetchQuizSlice('game:4', OGG_C);
    expect(getQuizSliceUri('game:2')).not.toBeNull(); // still pinned
    expect(getQuizSliceUri('game:3')).toBeNull(); // evicted
    expect(getQuizSliceUri('game:4')).not.toBeNull();
  });

  it('clearQuizSlices removes everything, pinned or not', async () => {
    script(OGG_A, 300_000);
    script(OGG_B, 300_000);
    await prefetchQuizSlice('game:2', OGG_A);
    pinQuizSlice('game:2');
    await prefetchQuizSlice('game:3', OGG_B);
    clearQuizSlices();
    expect(getQuizSliceUri('game:2')).toBeNull();
    expect(getQuizSliceUri('game:3')).toBeNull();
    expect(mockFileSizes.size).toBe(0);
  });
});

describe('F6 grace support (2026-11-12)', () => {
  it('the grace is ~3 s and applies ONLY to an in-flight slice', () => {
    expect(QUIZ_SLICE_GRACE_MS).toBe(3_000);
    expect(sliceGraceApplies('fetching')).toBe(true);
    // 'ready' freezes immediately with the slice — no wait.
    expect(sliceGraceApplies('ready')).toBe(false);
    // 'none' must never wait: nothing is coming, and holding
    // would delay the question's own load/verdict for nothing.
    expect(sliceGraceApplies('none')).toBe(false);
  });

  it('state + settle accessors track a real transfer', async () => {
    script(OGG_A, 300_000);
    expect(getQuizSliceState('game:2')).toBe('none');
    expect(whenQuizSliceSettles('game:2')).toBeNull();

    const inflight = prefetchQuizSlice('game:2', OGG_A);
    // Synchronously after the call the transfer is in flight.
    expect(getQuizSliceState('game:2')).toBe('fetching');
    const settles = whenQuizSliceSettles('game:2');
    expect(settles).not.toBeNull();
    // The settle handle IS the prefetch's own promise (the
    // grace waits on the real transfer, not a stand-in).
    expect(settles).toBe(inflight);

    await settles;
    expect(getQuizSliceState('game:2')).toBe('ready');
    expect(whenQuizSliceSettles('game:2')).toBeNull();
    expect(getQuizSliceUri('game:2')).not.toBeNull();
  });

  it('the dedupe path returns the in-flight promise, not a resolved stand-in', async () => {
    script(OGG_A, 300_000);
    const first = prefetchQuizSlice('game:2', OGG_A);
    const second = prefetchQuizSlice('game:2', OGG_A);
    expect(second).toBe(first);
    await second;
    expect(getQuizSliceState('game:2')).toBe('ready');
    expect(mockTasks).toHaveLength(1); // still never restarted
  });

  it('a settle that ends in failure leaves state none (the grace then freezes slice-less)', async () => {
    script(OGG_A, 300_000, true);
    const settles = prefetchQuizSlice('game:2', OGG_A);
    expect(getQuizSliceState('game:2')).toBe('fetching');
    await settles; // never rejects
    expect(getQuizSliceState('game:2')).toBe('none');
    expect(getQuizSliceUri('game:2')).toBeNull();
  });
});

describe('phase 2 head cache derivation (2026-11-12)', () => {
  const AT_A = 'https://a.animethemes.moe/AnimeA-OP1.ogg';
  const HEAD_A = 'https://api.test/quiz-heads/AnimeA-OP1.ogg';
  const AT_VIDEO = 'https://v.animethemes.moe/AnimeA-OP1.webm';

  it('an AnimeThemes audio URL derives the API head URL by rule', () => {
    expect(headCacheUrlFor(AT_A)).toBe(HEAD_A);
  });

  it('underivable addresses stay on the plain origin chain (null)', () => {
    expect(headCacheUrlFor(AT_VIDEO)).toBeNull(); // video, not audio
    expect(headCacheUrlFor('https://cdn.example/AnimeA-OP1.ogg')).toBeNull();
    expect(headCacheUrlFor('https://a.animethemes.moe/nested/AnimeA.ogg')).toBeNull();
    expect(headCacheUrlFor('https://a.animethemes.moe/AnimeA-OP1.webm')).toBeNull();
    expect(headCacheUrlFor(null)).toBeNull();
    expect(headCacheUrlFor(undefined)).toBeNull();
  });

  it('fixture mode (no API configured) derives nothing', () => {
    mockApiBase.value = undefined;
    expect(headCacheUrlFor(AT_A)).toBeNull();
    expect(sliceSourceUrls(AT_A)).toEqual([AT_A]);
    expect(quizRemoteChain(AT_A, AT_VIDEO)).toEqual([null, AT_A, AT_VIDEO]);
  });

  it('slice sources are head-first, origin as the fallback', () => {
    expect(sliceSourceUrls(AT_A)).toEqual([HEAD_A, AT_A]);
    expect(sliceSourceUrls(OGG_A)).toEqual([OGG_A]); // a.example — no head
  });

  it('the remote chain leads with the head, origin chain behind, exactly once', () => {
    expect(quizRemoteChain(AT_A, AT_VIDEO)).toEqual([HEAD_A, AT_A, AT_VIDEO]);
    // Composed the way both solo chain sites build it (Q1's
    // setup freeze passes a null slice; a live question's
    // freeze passes its ready slice):
    expect(quizSliceCandidates(null, quizRemoteChain(AT_A, AT_VIDEO))).toEqual([
      HEAD_A,
      AT_A,
      AT_VIDEO,
    ]);
    expect(
      quizSliceCandidates(
        'file:///cache/quiz-slices/g_1.ogg',
        quizRemoteChain(AT_A, AT_VIDEO),
      ),
    ).toEqual(['file:///cache/quiz-slices/g_1.ogg', HEAD_A, AT_A, AT_VIDEO]);
    // An underivable theme's chain is byte-identical to before.
    expect(quizSliceCandidates(null, quizRemoteChain(OGG_A, VIDEO_A))).toEqual([
      OGG_A,
      VIDEO_A,
    ]);
  });
});

describe('prefetch source order (phase 2)', () => {
  const AT_A = 'https://a.animethemes.moe/AnimeA-OP1.ogg';
  const HEAD_A = 'https://api.test/quiz-heads/AnimeA-OP1.ogg';

  it('a healthy head source is the ONLY transfer — the origin is untouched', async () => {
    script(HEAD_A, 300_000);
    script(AT_A, 300_000);
    await prefetchQuizSlice('game:2', AT_A);
    expect(getQuizSliceUri('game:2')).not.toBeNull();
    expect(mockTasks.map((t) => t.url)).toEqual([HEAD_A]);
  });

  it('a dead head source falls back to the origin, in order', async () => {
    script(HEAD_A, 300_000, true); // network-level failure
    script(AT_A, 300_000);
    await prefetchQuizSlice('game:2', AT_A);
    expect(getQuizSliceUri('game:2')).not.toBeNull();
    expect(mockTasks.map((t) => t.url)).toEqual([HEAD_A, AT_A]);
  });

  it('an HTTP-error head landing is rejected by STATUS, however big the body', async () => {
    // The 404 body here is deliberately slice-sized: size
    // alone would call it usable — the status must rule it out,
    // and the ORIGIN's bytes (200 KB) are what land.
    scriptHttp(HEAD_A, 300_000, 404);
    script(AT_A, 200_000);
    await prefetchQuizSlice('game:2', AT_A);
    const uri = getQuizSliceUri('game:2');
    expect(uri).not.toBeNull();
    expect(mockTasks.map((t) => t.url)).toEqual([HEAD_A, AT_A]);
    expect(mockFileSizes.get(uri!)).toBe(200_000);
  });

  it('when every source fails the prefetch leaves nothing, as before', async () => {
    script(HEAD_A, 300_000, true);
    script(AT_A, 300_000, true);
    await prefetchQuizSlice('game:2', AT_A);
    expect(getQuizSliceUri('game:2')).toBeNull();
    expect(getQuizSliceState('game:2')).toBe('none');
    expect(mockTasks.map((t) => t.url)).toEqual([HEAD_A, AT_A]);
  });
});

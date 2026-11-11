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
const mockTransfers = new Map<string, { totalBytes: number; fail?: boolean }>();
const mockTasks: {
  url: string;
  destUri: string;
  cancelled: boolean;
  cancelCalls: number;
}[] = [];

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

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
        return { status: 200, uri: destUri };
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
  QUIZ_SLICE_MIN_BYTES,
  clearQuizSlices,
  getQuizSliceUri,
  isQuizSliceUri,
  pinQuizSlice,
  prefetchQuizSlice,
  quizSliceCandidates,
  sliceCapReached,
  sliceFileNameFor,
  sliceIsUsable,
} from './quizPrefetch';

const OGG_A = 'https://a.example/AnimeA-OP1.ogg';
const OGG_B = 'https://a.example/AnimeB-OP1.ogg';
const OGG_C = 'https://a.example/AnimeC-OP1.ogg';
const VIDEO_A = 'https://v.example/AnimeA-OP1.webm';

function script(url: string, totalBytes: number, fail = false): void {
  mockTransfers.set(url, { totalBytes, fail });
}

beforeEach(() => {
  clearQuizSlices();
  mockFileSizes.clear();
  mockDeleted.length = 0;
  mockTasks.length = 0;
  mockTransfers.clear();
});

describe('pure slice decisions', () => {
  it('the cap decision trips exactly at the cap', () => {
    expect(QUIZ_SLICE_CAP_BYTES).toBe(1_000_000);
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

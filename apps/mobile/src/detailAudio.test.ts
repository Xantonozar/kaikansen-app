import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Detail Listen prepare cache (buffer package, 2026-11-11)
 * against an in-memory fake of expo-file-system — the quiz
 * part-6 suite's pattern: a Map is the disk, and the resumable
 * download is a scripted two-chunk transfer (with a yield
 * between chunks, so a cancel can land mid-flight) whose cancel
 * keeps the partial file — the native semantics the module
 * relies on (downloads.ts precedent). No real filesystem, no
 * network.
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
        // Two chunks (60%, then the rest) with a yield between
        // them, so a cancel landing mid-flight resolves
        // undefined with the partial kept — the native shape.
        emit(Math.floor(script.totalBytes * 0.6));
        await Promise.resolve();
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
  DETAIL_AUDIO_RETAIN_COUNT,
  DETAIL_AUDIO_STALL_MS,
  abandonDetailAudio,
  clearDetailAudioCache,
  detailAudioFileNameFor,
  detailAudioFraction,
  detailAudioStallShouldTrip,
  detailListenCandidates,
  getDetailAudioEntry,
  getDetailAudioProgressSnapshot,
  prepareDetailAudio,
  unpinDetailAudio,
} from './detailAudio';

const OGG = 'https://a.example/theme-OP1.ogg';
const OGG2 = 'https://a.example/theme-ED1.ogg';
const VIDEO = 'https://v.example/theme-OP1.webm';
const LIBRARY_FILE = 'file:///document/downloads/theme--1--listen.ogg';
const PREPARED_FILE = 'file:///cache/detail-audio/theme_1_listen.ogg';

function script(url: string, totalBytes: number, fail = false): void {
  mockTransfers.set(url, { totalBytes, fail });
}

/** Let every in-flight fake transfer settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  clearDetailAudioCache();
  mockFileSizes.clear();
  mockDeleted.length = 0;
  mockTasks.length = 0;
  mockTransfers.clear();
});

describe('detail listen candidate plan (buffer package)', () => {
  it('a completed library download wins outright', () => {
    expect(
      detailListenCandidates({
        libraryUri: LIBRARY_FILE,
        preparedUri: PREPARED_FILE,
        remoteChain: [OGG, VIDEO],
      }),
    ).toEqual([LIBRARY_FILE]);
  });

  it('the prepared file leads once its download completed', () => {
    expect(
      detailListenCandidates({
        libraryUri: null,
        preparedUri: PREPARED_FILE,
        remoteChain: [OGG, VIDEO],
      }),
    ).toEqual([PREPARED_FILE, OGG, VIDEO]);
  });

  it('no prepared file — the remote chain stands unchanged', () => {
    expect(
      detailListenCandidates({
        libraryUri: null,
        preparedUri: null,
        remoteChain: [OGG, OGG2, VIDEO],
      }),
    ).toEqual([OGG, OGG2, VIDEO]);
  });

  it('no-audio themes stay empty — a prepared file never invents a chain', () => {
    expect(
      detailListenCandidates({
        libraryUri: null,
        preparedUri: null,
        remoteChain: [],
      }),
    ).toEqual([]);
    expect(
      detailListenCandidates({
        libraryUri: null,
        preparedUri: PREPARED_FILE,
        remoteChain: [],
      }),
    ).toEqual([]);
  });

  it('a prepared uri already in the chain is not duplicated', () => {
    expect(
      detailListenCandidates({
        libraryUri: null,
        preparedUri: OGG,
        remoteChain: [OGG, VIDEO],
      }),
    ).toEqual([OGG, VIDEO]);
  });
});

describe('detail audio prepare fraction', () => {
  it('reports the delivered share of a known total', () => {
    expect(detailAudioFraction(500, 1000)).toBe(0.5);
    expect(detailAudioFraction(0, 1000)).toBe(0);
    expect(detailAudioFraction(1000, 1000)).toBe(1);
  });

  it('clamps over-delivery and rejects unknown totals', () => {
    expect(detailAudioFraction(1500, 1000)).toBe(1);
    expect(detailAudioFraction(500, 0)).toBeNull();
    expect(detailAudioFraction(500, -1)).toBeNull();
    expect(detailAudioFraction(Number.NaN, 1000)).toBeNull();
    expect(detailAudioFraction(500, Number.NaN)).toBeNull();
  });
});

describe('detail audio download stall watchdog', () => {
  const base = {
    status: 'fetching' as const,
    lastProgressAt: 100_000,
    playbackStarted: false,
  };

  it('trips after the full silent budget', () => {
    expect(
      detailAudioStallShouldTrip({
        ...base,
        now: 100_000 + DETAIL_AUDIO_STALL_MS,
      }),
    ).toBe(true);
    expect(DETAIL_AUDIO_STALL_MS).toBe(30_000);
  });

  it('does not trip inside the budget', () => {
    expect(
      detailAudioStallShouldTrip({
        ...base,
        now: 100_000 + DETAIL_AUDIO_STALL_MS - 1,
      }),
    ).toBe(false);
  });

  it('progress resets the clock — a recent stamp never trips', () => {
    expect(
      detailAudioStallShouldTrip({
        ...base,
        lastProgressAt: 500_000,
        now: 500_000 + DETAIL_AUDIO_STALL_MS - 1,
      }),
    ).toBe(false);
  });

  it('a landed file has no stall to judge', () => {
    expect(
      detailAudioStallShouldTrip({
        ...base,
        status: 'ready',
        now: 100_000 + DETAIL_AUDIO_STALL_MS * 10,
      }),
    ).toBe(false);
  });

  it('a started playback is immune', () => {
    expect(
      detailAudioStallShouldTrip({
        ...base,
        playbackStarted: true,
        now: 100_000 + DETAIL_AUDIO_STALL_MS * 10,
      }),
    ).toBe(false);
  });

  it('an unstamped transfer is never judged', () => {
    expect(
      detailAudioStallShouldTrip({
        ...base,
        lastProgressAt: 0,
        now: 10_000_000,
      }),
    ).toBe(false);
  });
});

describe('detail audio file names', () => {
  it('sanitises the claim key and keeps the source extension', () => {
    expect(detailAudioFileNameFor('my theme:12:listen', OGG)).toBe(
      'my_theme_12_listen.ogg',
    );
    expect(
      detailAudioFileNameFor('slug:3:listen', 'https://a.example/x.mp3?sig=1'),
    ).toBe('slug_3_listen.mp3');
  });

  it('falls back to .ogg when the url has no usable extension', () => {
    expect(detailAudioFileNameFor('slug:3:listen', 'https://a.example/x')).toBe(
      'slug_3_listen.ogg',
    );
  });
});

describe('detail audio prepare registry', () => {
  it('a prepared download lands ready under the detail-audio cache dir', async () => {
    script(OGG, 1000);
    prepareDetailAudio('slug:1:listen', OGG);
    await flush();
    const entry = getDetailAudioEntry('slug:1:listen');
    expect(entry?.status).toBe('ready');
    expect(entry?.uri).toBe('file:///cache/detail-audio/slug_1_listen.ogg');
    expect(entry?.pinned).toBe(true);
    expect(getDetailAudioProgressSnapshot('slug:1:listen')).toEqual({
      status: 'ready',
      fraction: 1,
    });
    expect(mockTasks).toHaveLength(1);
    expect(mockTasks[0].cancelCalls).toBe(0);
  });

  it('the progress snapshot tracks the transfer and is identity-stable between changes', async () => {
    script(OGG, 1000);
    prepareDetailAudio('slug:1:listen', OGG);
    // The fake's first chunk (60%) lands synchronously.
    const mid = getDetailAudioProgressSnapshot('slug:1:listen');
    expect(mid).toEqual({ status: 'fetching', fraction: 0.6 });
    expect(getDetailAudioProgressSnapshot('slug:1:listen')).toBe(mid);
    await flush();
    const done = getDetailAudioProgressSnapshot('slug:1:listen');
    expect(done).toEqual({ status: 'ready', fraction: 1 });
    expect(done).not.toBe(mid);
  });

  it('dedupe: the same key + URL is never restarted', async () => {
    script(OGG, 1000);
    prepareDetailAudio('slug:1:listen', OGG);
    prepareDetailAudio('slug:1:listen', OGG);
    await flush();
    prepareDetailAudio('slug:1:listen', OGG); // already ready
    expect(mockTasks).toHaveLength(1);
  });

  it('a new URL for the same key evicts the old entry and its file', async () => {
    script(OGG, 1000);
    script(OGG2, 1000);
    prepareDetailAudio('slug:1:listen', OGG);
    await flush();
    const oldUri = getDetailAudioEntry('slug:1:listen')?.uri;
    prepareDetailAudio('slug:1:listen', OGG2);
    await flush();
    const entry = getDetailAudioEntry('slug:1:listen');
    expect(entry?.url).toBe(OGG2);
    expect(entry?.status).toBe('ready');
    expect(mockDeleted).toContain(oldUri);
    expect(mockTasks).toHaveLength(2);
  });

  it('a failed transfer leaves no entry — and a later claim may retry', async () => {
    script(OGG, 1000, true);
    prepareDetailAudio('slug:1:listen', OGG);
    await flush();
    expect(getDetailAudioEntry('slug:1:listen')).toBeNull();
    expect(getDetailAudioProgressSnapshot('slug:1:listen')).toBeNull();
    script(OGG, 1000);
    prepareDetailAudio('slug:1:listen', OGG);
    await flush();
    expect(getDetailAudioEntry('slug:1:listen')?.status).toBe('ready');
    expect(mockTasks).toHaveLength(2);
  });

  it('retention: the pinned claim plus the newest few unpinned survive', async () => {
    expect(DETAIL_AUDIO_RETAIN_COUNT).toBe(2);
    for (const n of [1, 2, 3, 4]) {
      const url = `https://a.example/theme-${n}.ogg`;
      script(url, 1000);
      prepareDetailAudio(`slug:${n}:listen`, url);
      await flush();
    }
    // The oldest theme fell out of the retained set.
    expect(getDetailAudioEntry('slug:1:listen')).toBeNull();
    expect(mockDeleted).toContain(
      'file:///cache/detail-audio/slug_1_listen.ogg',
    );
    expect(getDetailAudioEntry('slug:2:listen')?.pinned).toBe(false);
    expect(getDetailAudioEntry('slug:3:listen')?.pinned).toBe(false);
    expect(getDetailAudioEntry('slug:4:listen')?.pinned).toBe(true);
  });

  it('unpin keeps the entry warm but retention-eligible', async () => {
    script(OGG, 1000);
    prepareDetailAudio('slug:1:listen', OGG);
    await flush();
    unpinDetailAudio('slug:1:listen');
    const entry = getDetailAudioEntry('slug:1:listen');
    expect(entry?.status).toBe('ready');
    expect(entry?.pinned).toBe(false);
  });

  it('abandon cancels the transfer, deletes the partial, drops the entry', async () => {
    script(OGG, 1000);
    prepareDetailAudio('slug:1:listen', OGG);
    abandonDetailAudio('slug:1:listen');
    expect(getDetailAudioEntry('slug:1:listen')).toBeNull();
    expect(mockTasks[0].cancelCalls).toBe(1);
    expect(mockDeleted).toContain(
      'file:///cache/detail-audio/slug_1_listen.ogg',
    );
    await flush();
    // The cancelled transfer never resurrects the entry.
    expect(getDetailAudioEntry('slug:1:listen')).toBeNull();
  });
});

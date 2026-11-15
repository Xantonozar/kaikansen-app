import { beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Queue Listen prepare cache (owner order 2026-11-15) against
 * the same in-memory expo-file-system fake as the detail
 * cache's suite: a Map is the disk, the resumable download is
 * a scripted two-chunk transfer whose cancel keeps the
 * partial. No real filesystem, no network.
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
  QUEUE_AUDIO_MAX_ENTRIES,
  QUEUE_AUDIO_STALL_MS,
  abandonQueueAudio,
  clearQueueAudioCache,
  getQueueAudioEntry,
  getQueueAudioProgressSnapshot,
  pinQueueAudioWindow,
  prepareQueueAudio,
  queueAudioStallShouldTrip,
  queueListenCandidates,
  shouldPrepareSecondNext,
} from './queueAudio';

const OGG = 'https://a.example/next-OP1.ogg';
const OGG2 = 'https://a.example/second-ED1.ogg';
const VIDEO = 'https://v.example/next-OP1.webm';
const LIBRARY_FILE = 'file:///document/downloads/theme--1--listen.ogg';
const PREPARED_FILE = 'file:///cache/queue-audio/queue_next_1.ogg';

function script(url: string, totalBytes: number, fail = false): void {
  mockTransfers.set(url, { totalBytes, fail });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  clearQueueAudioCache();
  mockFileSizes.clear();
  mockDeleted.length = 0;
  mockTasks.length = 0;
  mockTransfers.clear();
});

describe('rolling second decision (sequential + metered)', () => {
  it('prepares N+2 only once N+1 is ready on an unmetered connection', () => {
    expect(
      shouldPrepareSecondNext({
        hasSecond: true,
        firstStatus: 'ready',
        metered: false,
      }),
    ).toBe(true);
  });

  it('never prepares N+2 while N+1 is still fetching (never parallel)', () => {
    expect(
      shouldPrepareSecondNext({
        hasSecond: true,
        firstStatus: 'fetching',
        metered: false,
      }),
    ).toBe(false);
    expect(
      shouldPrepareSecondNext({
        hasSecond: true,
        firstStatus: null,
        metered: false,
      }),
    ).toBe(false);
  });

  it('never prepares N+2 on a metered connection (N+1 still prepares)', () => {
    expect(
      shouldPrepareSecondNext({
        hasSecond: true,
        firstStatus: 'ready',
        metered: true,
      }),
    ).toBe(false);
  });

  it('no second item, no preparation', () => {
    expect(
      shouldPrepareSecondNext({
        hasSecond: false,
        firstStatus: 'ready',
        metered: false,
      }),
    ).toBe(false);
  });
});

describe('queue listen candidate plan (shared with detailAudio)', () => {
  it('a completed library download wins outright', () => {
    expect(
      queueListenCandidates({
        libraryUri: LIBRARY_FILE,
        preparedUri: PREPARED_FILE,
        remoteChain: [OGG, VIDEO],
      }),
    ).toEqual([LIBRARY_FILE]);
  });

  it('the landed queue prepare file leads the chain', () => {
    expect(
      queueListenCandidates({
        libraryUri: null,
        preparedUri: PREPARED_FILE,
        remoteChain: [OGG, VIDEO],
      }),
    ).toEqual([PREPARED_FILE, OGG, VIDEO]);
  });

  it('no prepared file — the remote chain stands unchanged', () => {
    expect(
      queueListenCandidates({
        libraryUri: null,
        preparedUri: null,
        remoteChain: [OGG, OGG2, VIDEO],
      }),
    ).toEqual([OGG, OGG2, VIDEO]);
  });
});

describe('queue audio stall verdict (30s no-progress, shared rule)', () => {
  const base = {
    status: 'fetching' as const,
    lastProgressAt: 100_000,
    playbackStarted: false,
  };

  it('trips after the full silent budget, not inside it', () => {
    expect(QUEUE_AUDIO_STALL_MS).toBe(30_000);
    expect(
      queueAudioStallShouldTrip({
        ...base,
        now: 100_000 + QUEUE_AUDIO_STALL_MS,
      }),
    ).toBe(true);
    expect(
      queueAudioStallShouldTrip({
        ...base,
        now: 100_000 + QUEUE_AUDIO_STALL_MS - 1,
      }),
    ).toBe(false);
  });

  it('a landed file and a started playback are immune', () => {
    expect(
      queueAudioStallShouldTrip({
        ...base,
        status: 'ready',
        now: 100_000 + QUEUE_AUDIO_STALL_MS * 10,
      }),
    ).toBe(false);
    expect(
      queueAudioStallShouldTrip({
        ...base,
        playbackStarted: true,
        now: 100_000 + QUEUE_AUDIO_STALL_MS * 10,
      }),
    ).toBe(false);
  });
});

describe('queue audio prepare registry', () => {
  it('a prepared download lands ready under the queue-audio cache dir', async () => {
    script(OGG, 1000);
    prepareQueueAudio('queue:next:1', OGG);
    await flush();
    const entry = getQueueAudioEntry('queue:next:1');
    expect(entry?.status).toBe('ready');
    expect(entry?.uri).toBe('file:///cache/queue-audio/queue_next_1.ogg');
    expect(getQueueAudioProgressSnapshot('queue:next:1')).toEqual({
      status: 'ready',
      fraction: 1,
    });
    expect(mockTasks).toHaveLength(1);
  });

  it('dedupe: the same key + URL is never restarted', async () => {
    script(OGG, 1000);
    prepareQueueAudio('queue:next:1', OGG);
    prepareQueueAudio('queue:next:1', OGG);
    await flush();
    prepareQueueAudio('queue:next:1', OGG);
    expect(mockTasks).toHaveLength(1);
  });

  it('a new URL for the same key evicts the old entry and its file', async () => {
    script(OGG, 1000);
    script(OGG2, 1000);
    prepareQueueAudio('queue:next:1', OGG);
    await flush();
    const oldUri = getQueueAudioEntry('queue:next:1')?.uri;
    prepareQueueAudio('queue:next:1', OGG2);
    await flush();
    expect(getQueueAudioEntry('queue:next:1')?.url).toBe(OGG2);
    expect(mockDeleted).toContain(oldUri);
    expect(mockTasks).toHaveLength(2);
  });

  it('a failed transfer leaves no entry — a later claim may retry', async () => {
    script(OGG, 1000, true);
    prepareQueueAudio('queue:next:1', OGG);
    await flush();
    expect(getQueueAudioEntry('queue:next:1')).toBeNull();
    script(OGG, 1000);
    prepareQueueAudio('queue:next:1', OGG);
    await flush();
    expect(getQueueAudioEntry('queue:next:1')?.status).toBe('ready');
  });

  it('retention: capped at the max, oldest unpinned evicted first', async () => {
    expect(QUEUE_AUDIO_MAX_ENTRIES).toBe(5);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const url = `https://a.example/theme-${n}.ogg`;
      script(url, 1000);
      prepareQueueAudio(`queue:theme-${n}:first`, url);
      await flush();
    }
    expect(getQueueAudioEntry('queue:theme-1:first')).toBeNull();
    expect(mockDeleted).toContain(
      'file:///cache/queue-audio/queue_theme-1_first.ogg',
    );
    for (const n of [2, 3, 4, 5, 6]) {
      expect(getQueueAudioEntry(`queue:theme-${n}:first`)?.status).toBe(
        'ready',
      );
    }
  });

  it('the pinned window is eviction-exempt even when oldest', async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const url = `https://a.example/theme-${n}.ogg`;
      script(url, 1000);
      prepareQueueAudio(`queue:theme-${n}:first`, url);
      await flush();
      if (n === 1) pinQueueAudioWindow(['queue:theme-1:first']);
    }
    // theme-1 (pinned) survives; theme-2, the oldest unpinned, went.
    expect(getQueueAudioEntry('queue:theme-1:first')?.status).toBe('ready');
    expect(getQueueAudioEntry('queue:theme-2:first')).toBeNull();
  });

  it('abandon cancels the transfer, deletes the partial, drops the entry', async () => {
    script(OGG, 1000);
    prepareQueueAudio('queue:next:1', OGG);
    abandonQueueAudio('queue:next:1');
    expect(getQueueAudioEntry('queue:next:1')).toBeNull();
    expect(mockTasks[0].cancelCalls).toBe(1);
    expect(mockDeleted).toContain(
      'file:///cache/queue-audio/queue_next_1.ogg',
    );
    await flush();
    expect(getQueueAudioEntry('queue:next:1')).toBeNull();
  });
});

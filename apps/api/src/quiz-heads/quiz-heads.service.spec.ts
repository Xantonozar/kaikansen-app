import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QUIZ_HEAD_BYTES,
  headFileNameForAudioUrl,
  isValidHeadFileName,
  parseRangeHeader,
  QuizHeadCacheService,
} from './quiz-heads.service';

/**
 * Phase 2 head cache (2026-11-12) against a REAL temp
 * directory and a scripted origin fetch (the origin is the
 * only network this module has, and it is never real here).
 * The fake fetch answers with genuine web ReadableStreams, so
 * the service's stream-to-disk path runs its production code.
 */

interface FetchCall {
  url: string;
  range: string | undefined;
}

function streamOf(bytes: Buffer, chunkSize = 64 * 1024): ReadableStream {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const next = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(new Uint8Array(bytes.subarray(offset, next)));
      offset = next;
    },
  });
}

function fakeFetch(
  handler: (url: string) => { status: number; body?: Buffer } | null,
  calls: FetchCall[],
): typeof fetch {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, range: init?.headers?.Range });
    const answer = handler(url);
    if (!answer) return { status: 404, body: null } as Response;
    return {
      status: answer.status,
      body: answer.body ? streamOf(answer.body) : null,
    } as Response;
  }) as typeof fetch;
}

const FILE_A = 'AnimeA-OP1.ogg';
const FILE_B = 'AnimeB-OP1.ogg';
const FILE_C = 'AnimeC-OP1.ogg';
const URL_A = `https://a.animethemes.moe/${FILE_A}`;

describe('QuizHeadCacheService', () => {
  let dir: string;
  let calls: FetchCall[];

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'quiz-heads-'));
    calls = [];
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  function service(
    handler: (url: string) => { status: number; body?: Buffer } | null,
    extra?: { maxBytes?: number },
  ): QuizHeadCacheService {
    return new QuizHeadCacheService({
      cacheDir: dir,
      fetchImpl: fakeFetch(handler, calls),
      ...extra,
    });
  }

  it('a miss pulls the head range ONCE from the hard-coded origin, stores it, and serves it', async () => {
    const bytes = Buffer.alloc(300_000, 7);
    const svc = service(() => ({ status: 206, body: bytes }));

    const entry = await svc.ensureHead(FILE_A);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_A);
    expect(calls[0].range).toBe(`bytes=0-${QUIZ_HEAD_BYTES - 1}`);
    expect(entry).not.toBeNull();
    expect(entry!.size).toBe(bytes.length);
    const onDisk = await fsp.readFile(path.join(dir, FILE_A));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('a hit never re-pulls the origin', async () => {
    const svc = service(() => ({ status: 206, body: Buffer.alloc(1000, 1) }));
    await svc.ensureHead(FILE_A);
    const again = await svc.ensureHead(FILE_A);
    expect(again).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('concurrent fills for the same file share ONE origin pull', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetchCount = 0;
    const gatedFetch = (async (url: string) => {
      fetchCount += 1;
      expect(url).toBe(URL_A);
      await gate;
      return {
        status: 206,
        body: streamOf(Buffer.alloc(5000, 3)),
      } as Response;
    }) as typeof fetch;
    const svc = new QuizHeadCacheService({
      cacheDir: dir,
      fetchImpl: gatedFetch,
    });

    const first = svc.ensureHead(FILE_A);
    const second = svc.ensureHead(FILE_A);
    // Let both callers reach the fill before the origin answers.
    await new Promise((r) => setTimeout(r, 25));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(fetchCount).toBe(1);
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it('an origin 404 stores NOTHING and is not cached as a verdict', async () => {
    const svc = service(() => null);
    expect(await svc.ensureHead(FILE_A)).toBeNull();
    await expect(fsp.readdir(dir)).resolves.toEqual([]);
    // A later call retries the origin (the fallback's decision
    // may change; a cached failure could pin a song out).
    expect(await svc.ensureHead(FILE_A)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('a 200 (origin ignored the Range) is truncated at the head cap', async () => {
    const bytes = Buffer.alloc(QUIZ_HEAD_BYTES + 100_000, 9);
    const svc = service(() => ({ status: 200, body: bytes }));
    const entry = await svc.ensureHead(FILE_A);
    expect(entry!.size).toBe(QUIZ_HEAD_BYTES);
    const onDisk = await fsp.readFile(path.join(dir, FILE_A));
    expect(onDisk.length).toBe(QUIZ_HEAD_BYTES);
    expect(onDisk.equals(bytes.subarray(0, QUIZ_HEAD_BYTES))).toBe(true);
  });

  it('invalid names are refused without any origin contact', async () => {
    const svc = service(() => ({ status: 206, body: Buffer.alloc(10) }));
    for (const bad of [
      '../secret.ogg',
      'a/b.ogg',
      'a\\b.ogg',
      'song.mp3',
      'song.ogg/extra',
      '',
      '.ogg',
      'two words.ogg',
    ]) {
      expect(await svc.ensureHead(bad)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('eviction drops the least-recently-used heads once over the cap', async () => {
    const svc = service(() => ({ status: 206, body: Buffer.alloc(1000, 5) }), {
      maxBytes: 2500,
    });
    await svc.ensureHead(FILE_A);
    // Age A decisively so the LRU order is not wall-clock luck.
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(path.join(dir, FILE_A), old, old);
    await svc.ensureHead(FILE_B);
    await svc.ensureHead(FILE_C); // 3000 > 2500 → A (oldest) goes
    const names = (await fsp.readdir(dir)).sort();
    expect(names).toEqual([FILE_B, FILE_C]);
  });

  it('the head whose store triggers eviction is never its own victim', async () => {
    const svc = service(() => ({ status: 206, body: Buffer.alloc(1000, 5) }), {
      maxBytes: 500, // smaller than a single head
    });
    const entry = await svc.ensureHead(FILE_A);
    expect(entry).not.toBeNull();
    await expect(fsp.readdir(dir)).resolves.toEqual([FILE_A]);
  });

  it('warm() fills underivable-safe: a derivable URL warms, anything else is a no-op', async () => {
    const svc = service(() => ({ status: 206, body: Buffer.alloc(2000, 2) }));
    svc.warm('https://v.animethemes.moe/AnimeA-OP1.webm'); // video — no
    svc.warm('https://other.example/AnimeA-OP1.ogg'); // other host — no
    svc.warm(null);
    svc.warm(undefined);
    expect(calls).toHaveLength(0);

    svc.warm(URL_A);
    // Join the in-flight fill through ensureHead (dedupe) to
    // observe completion without racing the fire-and-forget.
    const entry = await svc.ensureHead(FILE_A);
    expect(entry).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_A);
  });
});

describe('head name + URL rules', () => {
  it('valid names are single .ogg segments', () => {
    expect(isValidHeadFileName('RakudaiKenja-OP1.ogg')).toBe(true);
    expect(isValidHeadFileName('a_b-c.d.ogg')).toBe(true);
    expect(isValidHeadFileName('../x.ogg')).toBe(false);
    expect(isValidHeadFileName('x/y.ogg')).toBe(false);
    expect(isValidHeadFileName('x.webm')).toBe(false);
    expect(isValidHeadFileName(42)).toBe(false);
    expect(isValidHeadFileName(null)).toBe(false);
  });

  it('the file name derives only from the AnimeThemes audio host', () => {
    expect(headFileNameForAudioUrl(URL_A)).toBe(FILE_A);
    expect(
      headFileNameForAudioUrl('https://v.animethemes.moe/AnimeA-OP1.webm'),
    ).toBeNull();
    expect(
      headFileNameForAudioUrl('https://a.animethemes.moe/nested/AnimeA.ogg'),
    ).toBeNull();
    expect(headFileNameForAudioUrl('https://cdn.example/AnimeA-OP1.ogg')).toBeNull();
    expect(headFileNameForAudioUrl(null)).toBeNull();
    expect(headFileNameForAudioUrl(undefined)).toBeNull();
  });
});

describe('parseRangeHeader', () => {
  const SIZE = 1_500_000;

  it('no header (or an unparsable one) means the whole head', () => {
    expect(parseRangeHeader(undefined, SIZE)).toBeNull();
    expect(parseRangeHeader('items=0-10', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=0-10,20-30', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=-', SIZE)).toBeNull();
  });

  it('bounded and open ranges clamp to the body', () => {
    expect(parseRangeHeader('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-', SIZE)).toEqual({
      start: 100,
      end: SIZE - 1,
    });
    expect(parseRangeHeader(`bytes=0-${SIZE + 500}`, SIZE)).toEqual({
      start: 0,
      end: SIZE - 1,
    });
  });

  it('suffix ranges take the tail', () => {
    expect(parseRangeHeader('bytes=-50', SIZE)).toEqual({
      start: SIZE - 50,
      end: SIZE - 1,
    });
    expect(parseRangeHeader(`bytes=-${SIZE + 1}`, SIZE)).toEqual({
      start: 0,
      end: SIZE - 1,
    });
  });

  it('impossible ranges are unsatisfiable', () => {
    expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=500-499', SIZE)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', SIZE)).toBe('unsatisfiable');
  });
});

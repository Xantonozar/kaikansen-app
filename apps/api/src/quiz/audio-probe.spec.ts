import { HttpAudioProbe } from './audio-probe';

/**
 * Part 7 probe unit tests — global fetch is stubbed throughout:
 * NO test in this file touches the real network.
 */

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string> };
}

function stubFetch(
  handler: (url: string) => Promise<{ status: number }> | { status: number },
) {
  const calls: FetchCall[] = [];
  const fetchMock = jest.fn(
    async (url: string, init?: FetchCall['init']) => {
      calls.push({ url, init: init ?? {} });
      const res = await handler(url);
      return {
        status: res.status,
        body: { cancel: async () => undefined },
      };
    },
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as never;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const OGG = 'https://a.animethemes.moe/SomeAnime-OP1.ogg';

describe('HttpAudioProbe — verdicts', () => {
  it('206 and 200 mean the file exists', async () => {
    for (const status of [206, 200]) {
      const stub = stubFetch(() => ({ status }));
      try {
        const probe = new HttpAudioProbe();
        await expect(probe.probe(OGG, 1000)).resolves.toBe('ok');
        // The probe is a ranged GET — AnimeThemes 403s HEAD,
        // and only the status is ever wanted.
        expect(stub.calls).toHaveLength(1);
        expect(stub.calls[0].init.method).toBe('GET');
        expect(stub.calls[0].init.headers?.Range).toBe('bytes=0-1023');
      } finally {
        stub.restore();
      }
    }
  });

  it('404 — and only 404 — means missing', async () => {
    const stub = stubFetch(() => ({ status: 404 }));
    try {
      const probe = new HttpAudioProbe();
      await expect(probe.probe(OGG, 1000)).resolves.toBe('missing');
    } finally {
      stub.restore();
    }
  });

  it('other statuses are doubt (unknown), never missing', async () => {
    for (const status of [500, 403, 301]) {
      const stub = stubFetch(() => ({ status }));
      try {
        const probe = new HttpAudioProbe();
        await expect(probe.probe(OGG, 1000)).resolves.toBe('unknown');
      } finally {
        stub.restore();
      }
    }
  });

  it('a network failure is doubt, not a verdict', async () => {
    const stub = stubFetch(() => {
      throw new Error('ECONNRESET');
    });
    try {
      const probe = new HttpAudioProbe();
      await expect(probe.probe(OGG, 1000)).resolves.toBe('unknown');
    } finally {
      stub.restore();
    }
  });

  it('a slow fetch is cut off at the timeout and reads as doubt', async () => {
    const original = globalThis.fetch;
    // A fetch that never answers on its own — it only rejects
    // when the caller's AbortSignal fires (as real fetch does).
    globalThis.fetch = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('AbortError')),
          );
        }),
    ) as never;
    try {
      const probe = new HttpAudioProbe();
      const started = Date.now();
      await expect(probe.probe(OGG, 25)).resolves.toBe('unknown');
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('HttpAudioProbe — cache', () => {
  it('a cached verdict is not re-probed', async () => {
    const stub = stubFetch(() => ({ status: 206 }));
    try {
      const probe = new HttpAudioProbe();
      await expect(probe.probe(OGG, 1000)).resolves.toBe('ok');
      await expect(probe.probe(OGG, 1000)).resolves.toBe('ok');
      expect(stub.calls).toHaveLength(1);
      expect(probe.cacheSize).toBe(1);
    } finally {
      stub.restore();
    }
  });

  it('missing verdicts cache too (a phantom stays avoided)', async () => {
    const stub = stubFetch(() => ({ status: 404 }));
    try {
      const probe = new HttpAudioProbe();
      await expect(probe.probe(OGG, 1000)).resolves.toBe('missing');
      await expect(probe.probe(OGG, 1000)).resolves.toBe('missing');
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('doubt is never cached — the next probe asks again', async () => {
    const stub = stubFetch(() => ({ status: 500 }));
    try {
      const probe = new HttpAudioProbe();
      await expect(probe.probe(OGG, 1000)).resolves.toBe('unknown');
      await expect(probe.probe(OGG, 1000)).resolves.toBe('unknown');
      expect(stub.calls).toHaveLength(2);
      expect(probe.cacheSize).toBe(0);
    } finally {
      stub.restore();
    }
  });

  it('an expired verdict is re-probed', async () => {
    const stub = stubFetch(() => ({ status: 206 }));
    try {
      const probe = new HttpAudioProbe(30); // 30 ms TTL
      await expect(probe.probe(OGG, 1000)).resolves.toBe('ok');
      await new Promise((r) => setTimeout(r, 50));
      await expect(probe.probe(OGG, 1000)).resolves.toBe('ok');
      expect(stub.calls).toHaveLength(2);
    } finally {
      stub.restore();
    }
  });
});

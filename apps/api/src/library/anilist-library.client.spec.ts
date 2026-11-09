import { AnilistLibraryClient } from './anilist-library.client';

/**
 * The library AniList client, with the network stubbed — no test
 * ever touches the live AniList API. Covers the widened source
 * (owner-ordered 2026-11-08): the GraphQL request asks for
 * COMPLETED + CURRENT in one collection call, ids from BOTH
 * statuses merge into the returned set, and the web's
 * fail-to-null contract is unchanged.
 */
describe('AnilistLibraryClient.fetchLibraryMediaIds', () => {
  const realFetch = global.fetch;
  const client = new AnilistLibraryClient();

  afterEach(() => {
    global.fetch = realFetch;
  });

  function stubFetch(payload: unknown, ok = true) {
    const fetchMock = jest.fn(async () => ({
      ok,
      json: async () => payload,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('asks AniList for COMPLETED + CURRENT (watching) in a single status_in query', async () => {
    const fetchMock = stubFetch({
      data: { MediaListCollection: { lists: [] } },
    });

    await client.fetchLibraryMediaIds('token-x', 42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://graphql.anilist.co');
    expect(init.headers.Authorization).toBe('Bearer token-x');
    const body = JSON.parse(init.body) as {
      query: string;
      variables: { userId: number };
    };
    expect(body.query).toContain('status_in: [COMPLETED, CURRENT]');
    expect(body.query).not.toContain('status: COMPLETED');
    expect(body.variables).toEqual({ userId: 42 });
  });

  it('merges ids from the completed AND watching lists into one deduped set', async () => {
    stubFetch({
      data: {
        MediaListCollection: {
          lists: [
            // The COMPLETED list.
            { entries: [{ mediaId: 11 }, { mediaId: 22 }] },
            // The CURRENT (watching) list.
            { entries: [{ mediaId: 33 }, { mediaId: 44 }] },
            // A stray duplicate must not survive the merge.
            { entries: [{ mediaId: 22 }] },
          ],
        },
      },
    });

    await expect(client.fetchLibraryMediaIds('token-x', 42)).resolves.toEqual([
      11, 22, 33, 44,
    ]);
  });

  it('resolves null on a non-OK AniList response (the web’s fail-soft contract)', async () => {
    stubFetch({}, false);
    await expect(client.fetchLibraryMediaIds('token-x', 42)).resolves.toBeNull();
  });

  it('resolves null when the network call itself throws', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(client.fetchLibraryMediaIds('token-x', 42)).resolves.toBeNull();
  });

  it('resolves an empty set (not null) when the collection has no lists', async () => {
    stubFetch({ data: { MediaListCollection: { lists: [] } } });
    await expect(client.fetchLibraryMediaIds('token-x', 42)).resolves.toEqual(
      [],
    );
  });
});

describe('AnilistLibraryClient.fetchLibraryEntries', () => {
  const realFetch = global.fetch;
  const client = new AnilistLibraryClient();

  afterEach(() => {
    global.fetch = realFetch;
  });

  function stubFetch(payload: unknown, ok = true) {
    const fetchMock = jest.fn(async () => ({
      ok,
      json: async () => payload,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('asks for COMPLETED + CURRENT with progress, POINT_10 score and media fields', async () => {
    const fetchMock = stubFetch({
      data: { MediaListCollection: { lists: [] } },
    });

    await client.fetchLibraryEntries('token-x', 42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe('https://graphql.anilist.co');
    expect(init.headers.Authorization).toBe('Bearer token-x');
    const body = JSON.parse(init.body) as {
      query: string;
      variables: { userId: number };
    };
    expect(body.query).toContain('status_in: [COMPLETED, CURRENT]');
    expect(body.query).toContain('score(format: POINT_10)');
    expect(body.query).toContain('progress');
    expect(body.variables).toEqual({ userId: 42 });
  });

  it('maps entries: status kept, english title preferred, score 0 → null, dedupe by media', async () => {
    stubFetch({
      data: {
        MediaListCollection: {
          lists: [
            {
              status: 'CURRENT',
              entries: [
                {
                  status: 'CURRENT',
                  progress: 18,
                  score: 0,
                  media: {
                    id: 101,
                    format: 'TV',
                    episodes: 28,
                    title: { romaji: 'Sousou no Frieren', english: 'Frieren' },
                    coverImage: { large: 'https://img/l101.jpg', medium: 'https://img/m101.jpg' },
                  },
                },
              ],
            },
            {
              status: 'COMPLETED',
              entries: [
                {
                  status: 'COMPLETED',
                  progress: 12,
                  score: 8,
                  media: {
                    id: 102,
                    format: 'TV',
                    episodes: 12,
                    title: { romaji: 'Romaji Only', english: null },
                    coverImage: { large: null, medium: 'https://img/m102.jpg' },
                  },
                },
                // A duplicate media id must not survive.
                {
                  status: 'COMPLETED',
                  progress: 12,
                  score: 8,
                  media: {
                    id: 102,
                    format: 'TV',
                    episodes: 12,
                    title: { romaji: 'Romaji Only', english: null },
                    coverImage: { large: null, medium: null },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    await expect(client.fetchLibraryEntries('token-x', 42)).resolves.toEqual([
      {
        mediaId: 101,
        status: 'CURRENT',
        title: 'Frieren',
        coverImage: 'https://img/l101.jpg',
        format: 'TV',
        episodes: 28,
        progress: 18,
        score: null,
      },
      {
        mediaId: 102,
        status: 'COMPLETED',
        title: 'Romaji Only',
        coverImage: 'https://img/m102.jpg',
        format: 'TV',
        episodes: 12,
        progress: 12,
        score: 8,
      },
    ]);
  });

  it('resolves null on a non-OK response and when the network throws', async () => {
    stubFetch({}, false);
    await expect(client.fetchLibraryEntries('token-x', 42)).resolves.toBeNull();

    global.fetch = jest.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(client.fetchLibraryEntries('token-x', 42)).resolves.toBeNull();
  });
});

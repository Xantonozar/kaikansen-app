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

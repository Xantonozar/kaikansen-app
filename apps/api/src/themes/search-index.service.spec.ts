import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Model } from 'mongoose';
import type { AnimeCacheDocument } from '../sync/anime-cache.schema';
import type { ArtistCacheDocument } from '../sync/artist-cache.schema';
import { SEARCH_INDEX_DEFINITIONS } from './search-index-definitions';
import { SearchIndexService } from './search-index.service';
import type { ThemeCacheDocument } from './theme-cache.schema';

/**
 * The readiness probe + ensure service, against mocked native
 * collections: `collection.listSearchIndexes()` shape per the
 * installed mongodb driver 7.x (an aggregation cursor over raw
 * `$listSearchIndexes` docs — top-level `queryable` boolean and a
 * `statusHistory` array; there is NO top-level `status`, so the
 * service derives it from the newest history entry).
 */

type RawDoc = Record<string, unknown>;

interface FakeCollection {
  list: jest.Mock;
  create: jest.Mock;
  listSearchIndexes: () => { toArray: () => Promise<RawDoc[]> };
  createSearchIndex: (spec: Record<string, unknown>) => Promise<string>;
}

function fakeModel(docs: RawDoc[] | (() => Promise<RawDoc[]>)) {
  // The cursor's toArray is where a real probe failure surfaces
  // (the driver's listSearchIndexes() itself returns the cursor
  // synchronously), so the failure case THROWS there — a throwing
  // listSearchIndexes would be an unhandled rejection instead.
  const list = jest.fn(() => ({
    toArray: async () => {
      if (typeof docs === 'function') return docs();
      return docs;
    },
  }));
  const create = jest.fn(async (_spec: Record<string, unknown>) => 'created');
  const collection = {
    listSearchIndexes: list,
    createSearchIndex: create,
  };
  return {
    model: { collection } as unknown as Model<ThemeCacheDocument>,
    collection: collection as unknown as FakeCollection,
    list,
    create,
  };
}

const readyDoc = (name: string): RawDoc => ({
  name,
  queryable: true,
  statusHistory: [
    { status: 'BUILDING', date: new Date('2026-11-10T10:00:00Z') },
    { status: 'READY', date: new Date('2026-11-10T10:05:00Z') },
  ],
});

const buildingDoc = (name: string): RawDoc => ({
  name,
  queryable: false,
  statusHistory: [{ status: 'BUILDING', date: new Date() }],
});

function serviceWith(theme: ReturnType<typeof fakeModel>) {
  return new SearchIndexService(theme.model);
}

describe('SearchIndexService — readiness normalisation', () => {
  it('READY = exists + queryable + newest statusHistory entry READY', async () => {
    const service = serviceWith(
      fakeModel([readyDoc('kaikansen_themes_search')]),
    );
    const statuses = await service.listStatuses('themes');
    expect(statuses).toEqual([
      {
        name: 'kaikansen_themes_search',
        model: 'themes',
        collection: 'themecaches',
        exists: true,
        queryable: true,
        status: 'READY',
        ready: true,
      },
    ]);
    await expect(
      service.isIndexReady('themes', 'kaikansen_themes_search'),
    ).resolves.toBe(true);
  });

  it('BUILDING is not ready, and neither is a non-queryable index', async () => {
    const service = serviceWith(
      fakeModel([buildingDoc('kaikansen_themes_search')]),
    );
    const statuses = await service.listStatuses('themes');
    expect(statuses[0]).toMatchObject({ status: 'BUILDING', ready: false });
    await expect(
      service.isIndexReady('themes', 'kaikansen_themes_search'),
    ).resolves.toBe(false);

    const notQueryable = serviceWith(
      fakeModel([
        {
          name: 'kaikansen_themes_search',
          queryable: false,
          statusHistory: [{ status: 'READY', date: new Date() }],
        },
      ]),
    );
    await expect(
      notQueryable.isIndexReady('themes', 'kaikansen_themes_search'),
    ).resolves.toBe(false);
  });

  it('honours a top-level status when the surface carries one', async () => {
    const service = serviceWith(
      fakeModel([
        { name: 'kaikansen_themes_search', queryable: true, status: 'READY' },
      ]),
    );
    await expect(
      service.isIndexReady('themes', 'kaikansen_themes_search'),
    ).resolves.toBe(true);
  });

  it('no indexes at all → empty list, nothing ready (the production state today)', async () => {
    const service = serviceWith(fakeModel([]));
    await expect(service.listStatuses('themes')).resolves.toEqual([]);
    await expect(
      service.isIndexReady('themes', 'kaikansen_themes_search'),
    ).resolves.toBe(false);
  });

  it('a probe failure reads as "no indexes" — never as ready', async () => {
    const service = serviceWith(
      fakeModel(async () => {
        throw new Error('listSearchIndexes exploded');
      }),
    );
    await expect(service.listStatuses('themes')).resolves.toEqual([]);
    await expect(
      service.isIndexReady('themes', 'kaikansen_themes_search'),
    ).resolves.toBe(false);
  });

  it('caches the probe per collection for the TTL — one driver call per window', async () => {
    const fake = fakeModel([readyDoc('kaikansen_themes_search')]);
    const service = serviceWith(fake);
    await service.isIndexReady('themes', 'kaikansen_themes_search');
    await service.isIndexReady('themes', 'kaikansen_themes_search');
    await service.listStatuses('themes');
    expect(fake.list).toHaveBeenCalledTimes(1);
    // A fresh read bypasses the cache (the ensure endpoint's
    // post-pass truth).
    await service.listStatuses('themes', true);
    expect(fake.list).toHaveBeenCalledTimes(2);
  });
});

describe('SearchIndexService — ensure', () => {
  it('creates only the missing indexes and reports honest post-pass state', async () => {
    // Themes already exists (READY); anime/artists absent. After
    // a create, the fake cluster reports the anime index as
    // BUILDING — the report must show exactly that, never READY.
    const created = new Set<string>();
    const docsFor = (existing: RawDoc[]) => {
      const extra: RawDoc[] = [];
      if (created.has('kaikansen_anime_search')) {
        extra.push(buildingDoc('kaikansen_anime_search'));
      }
      if (created.has('kaikansen_artists_search')) {
        extra.push(buildingDoc('kaikansen_artists_search'));
      }
      return [...existing, ...extra];
    };
    const themes = fakeModel(() =>
      Promise.resolve(docsFor([readyDoc('kaikansen_themes_search')])),
    );
    const anime = fakeModel(() => Promise.resolve(docsFor([])));
    const artists = fakeModel(() => Promise.resolve(docsFor([])));
    for (const fake of [themes, anime, artists]) {
      fake.create.mockImplementation(async (spec: { name: string }) => {
        created.add(spec.name);
        return spec.name;
      });
    }
    const service = new SearchIndexService(
      themes.model,
      anime.model as unknown as Model<AnimeCacheDocument>,
      artists.model as unknown as Model<ArtistCacheDocument>,
    );

    const rows = await service.ensureIndexes();

    expect(themes.create).not.toHaveBeenCalled();
    expect(anime.create).toHaveBeenCalledWith({
      name: 'kaikansen_anime_search',
      definition: SEARCH_INDEX_DEFINITIONS.find((d) => d.model === 'anime')
        ?.definition,
    });
    expect(artists.create).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      {
        name: 'kaikansen_themes_search',
        model: 'themes',
        collection: 'themecaches',
        exists: true,
        queryable: true,
        status: 'READY',
        ready: true,
        action: 'already-present',
      },
      {
        name: 'kaikansen_anime_search',
        model: 'anime',
        collection: 'animecaches',
        exists: true,
        queryable: false,
        status: 'BUILDING',
        ready: false,
        action: 'created',
      },
      {
        name: 'kaikansen_artists_search',
        model: 'artists',
        collection: 'artistcaches',
        exists: true,
        queryable: false,
        status: 'BUILDING',
        ready: false,
        action: 'created',
      },
    ]);
  });

  it('an already-exists create error is treated as present, not a failure', async () => {
    const themes = fakeModel(async () => [] as RawDoc[]);
    themes.create.mockRejectedValue(
      new Error('Index with name kaikansen_themes_search already exists'),
    );
    const service = serviceWith(themes);

    const rows = await service.ensureIndexes();

    const themesRow = rows.find((r) => r.model === 'themes');
    expect(themesRow?.action).toBe('created');
    // The post-pass probe still shows nothing — reported honestly
    // (exists falls back to the create outcome, never READY).
    expect(themesRow).toMatchObject({ exists: true, ready: false });
  });
});

describe('SEARCH_INDEX_DEFINITIONS — drift pin against the shipped JSON files', () => {
  it('the embedded definitions match apps/api/search-indexes/*.json exactly', () => {
    const dir = path.resolve(__dirname, '..', '..', 'search-indexes');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(files).toEqual([
      'kaikansen_anime_search.json',
      'kaikansen_artists_search.json',
      'kaikansen_themes_search.json',
    ]);
    for (const def of SEARCH_INDEX_DEFINITIONS) {
      const file = JSON.parse(
        fs.readFileSync(path.join(dir, `${def.name}.json`), 'utf8'),
      ) as { name: string; definition: Record<string, unknown> };
      expect(file.name).toBe(def.name);
      expect(file.definition).toEqual(def.definition);
    }
  });
});

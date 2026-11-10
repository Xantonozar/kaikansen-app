import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  AnimeCache,
  type AnimeCacheDocument,
} from '../sync/anime-cache.schema';
import {
  ArtistCache,
  type ArtistCacheDocument,
} from '../sync/artist-cache.schema';
import { ThemeCache, type ThemeCacheDocument } from './theme-cache.schema';
import {
  SEARCH_INDEX_DEFINITIONS,
  type SearchIndexDefinition,
} from './search-index-definitions';

/** Which catalogue collection a readiness/ensure entry describes. */
export type SearchIndexModel = 'themes' | 'anime' | 'artists';

/**
 * The minimal readiness surface ThemesService depends on. The
 * real SearchIndexService implements it via `listSearchIndexes`;
 * specs can stub it to drive the probe states (absent / building
 * / ready) without a cluster.
 */
export interface SearchReadinessProbe {
  isIndexReady(model: SearchIndexModel, indexName: string): Promise<boolean>;
}

/**
 * DI token for the readiness probe. Interfaces are erased at
 * runtime, so a constructor param typed `SearchReadinessProbe`
 * gives Nest NO token to resolve — the dependency silently
 * arrives undefined under @Optional (the 2026-11-10 production
 * hotfix: module-wired search ran probe-less and served empty
 * 'atlas' answers while no indexes existed). ThemesService
 * injects the probe through this token, and ThemesModule binds
 * it to SearchIndexService with a NON-optional provider, so a
 * missing binding fails boot instead of degrading silently.
 */
export const SEARCH_READINESS_PROBE = 'SEARCH_READINESS_PROBE';

/**
 * One collection's search-index state, as `listSearchIndexes`
 * reports it (defensively normalised — see currentStatus).
 */
export interface SearchIndexStatus {
  /** Index name, or null when no index definition carried one. */
  name: string;
  model: SearchIndexModel;
  collection: string;
  /** The index exists on the cluster. */
  exists: boolean;
  /** Atlas marks the index queryable (serves $search traffic). */
  queryable: boolean;
  /** Latest build status ('READY' | 'BUILDING' | 'FAILED' | …), null when unreported. */
  status: string | null;
  /**
   * The only state in which a $search against the index is safe:
   * it exists AND is queryable AND its latest status is READY.
   */
  ready: boolean;
}

/** The ensure endpoint's per-index report row. */
export interface EnsuredSearchIndex extends SearchIndexStatus {
  action: 'created' | 'already-present';
}

/**
 * How long a readiness probe result is trusted. Rollout builds an
 * index in well under a minute-to-minutes window; 60s keeps the
 * search hot path off the `$listSearchIndexes` aggregation while
 * the per-group 'atlas' flip still lands promptly once an index
 * becomes queryable.
 */
const PROBE_TTL_MS = 60_000;

/**
 * One raw `$listSearchIndexes` document (mongodb driver 7.x: the
 * driver's `collection.listSearchIndexes()` returns an aggregation
 * cursor over these). Only the fields read below are typed.
 */
interface RawSearchIndexDoc {
  name?: unknown;
  queryable?: unknown;
  status?: unknown;
  statusHistory?: unknown;
}

/**
 * The index's CURRENT status from a raw listSearchIndexes doc:
 * prefer a top-level `status` (some Atlas/driver surfaces carry
 * one); otherwise the newest `statusHistory` entry's status.
 */
function currentStatus(doc: RawSearchIndexDoc): string | null {
  if (typeof doc.status === 'string' && doc.status.length > 0) {
    return doc.status;
  }
  const history = doc.statusHistory;
  if (Array.isArray(history) && history.length > 0) {
    let newest: { status?: unknown; date?: unknown } | null = null;
    let newestTime = -Infinity;
    for (const entry of history as Array<{
      status?: unknown;
      date?: unknown;
    }>) {
      const time = entry?.date ? new Date(entry.date as string).getTime() : 0;
      if (time >= newestTime) {
        newestTime = time;
        newest = entry;
      }
    }
    if (newest && typeof newest.status === 'string') return newest.status;
  }
  return null;
}

/**
 * Readiness probe + ensure for the Option B MongoDB Search
 * indexes (spec 2026-11-10).
 *
 * ── THE EMPTY-$search TRAP (rollout finding 2026-11-10 ~18:47) ──
 * `$search` against a MISSING or still-BUILDING index does NOT
 * throw — Atlas answers an EMPTY result set. Any code that treats
 * "no error" as "Atlas answered" will serve empty groups and
 * label them 'atlas' while the real (regex) results exist. That
 * is why this probe exists and why search consults it BEFORE
 * choosing a matcher: a catalogue group may use its $search
 * pipeline ONLY when its index is proven ready here. Do not
 * "simplify" the matchers back to error-only fallback.
 *
 * Probe failure is always "not ready": the regex path is the
 * safe direction, and a probe that cannot answer must never
 * unlock Atlas.
 */
@Injectable()
export class SearchIndexService implements SearchReadinessProbe {
  constructor(
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(AnimeCache.name)
    private readonly animeModel?: Model<AnimeCacheDocument>,
    @Optional()
    @InjectModel(ArtistCache.name)
    private readonly artistModel?: Model<ArtistCacheDocument>,
  ) {}

  /** Per-collection probe cache: collection → { at, statuses }. */
  private readonly probeCache = new Map<
    string,
    { at: number; statuses: SearchIndexStatus[] }
  >();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modelFor(model: SearchIndexModel): Model<any> | undefined {
    switch (model) {
      case 'themes':
        return this.themeModel;
      case 'anime':
        return this.animeModel;
      case 'artists':
        return this.artistModel;
    }
  }

  /**
   * The collection's search indexes as Atlas reports them right
   * now (state at probe time is part of the contract — see the
   * class docblock for why "no answer" means not-ready). Cached
   * per collection for PROBE_TTL_MS; `fresh` bypasses the cache
   * (the ensure endpoint reports post-create truth, and its pass
   * refreshes the cache for the search path).
   */
  async listStatuses(
    model: SearchIndexModel,
    fresh = false,
  ): Promise<SearchIndexStatus[]> {
    const def = SEARCH_INDEX_DEFINITIONS.find((d) => d.model === model);
    const collection = def?.collection ?? model;
    if (!fresh) {
      const cached = this.probeCache.get(collection);
      if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
        return cached.statuses;
      }
    }
    const statuses = await this.probe(model, collection);
    this.probeCache.set(collection, { at: Date.now(), statuses });
    return statuses;
  }

  /** One uncached probe pass; ANY failure reads as "no indexes". */
  private async probe(
    model: SearchIndexModel,
    collection: string,
  ): Promise<SearchIndexStatus[]> {
    const m = this.modelFor(model);
    if (!m) return [];
    try {
      const docs = (await m.collection
        .listSearchIndexes()
        .toArray()) as RawSearchIndexDoc[];
      return docs.map((doc) => {
        const status = currentStatus(doc);
        const queryable = doc.queryable === true;
        return {
          name: typeof doc.name === 'string' ? doc.name : '',
          model,
          collection,
          exists: true,
          queryable,
          status,
          ready: queryable && status === 'READY',
        };
      });
    } catch {
      // No answer = not ready (see the class docblock).
      return [];
    }
  }

  /**
   * Is `indexName` on this collection ready to serve $search?
   * (Exists + queryable + latest status READY, via the cached
   * probe.)
   */
  async isIndexReady(
    model: SearchIndexModel,
    indexName: string,
  ): Promise<boolean> {
    const statuses = await this.listStatuses(model);
    return statuses.some((s) => s.name === indexName && s.ready);
  }

  /**
   * Idempotently create the three shipped indexes over this API's
   * own Mongoose connection (the deployment host is Atlas-
   * whitelisted; the operator's other machines are not — see the
   * spec's rollout section). Reports each index's post-pass state
   * from a FRESH probe: creation is asynchronous on Atlas's side,
   * so a just-created index honestly reports BUILDING / not yet
   * queryable — never a faked READY.
   */
  async ensureIndexes(): Promise<EnsuredSearchIndex[]> {
    const results: EnsuredSearchIndex[] = [];
    for (const def of SEARCH_INDEX_DEFINITIONS) {
      results.push(await this.ensureOne(def));
    }
    return results;
  }

  private async ensureOne(
    def: SearchIndexDefinition,
  ): Promise<EnsuredSearchIndex> {
    const m = this.modelFor(def.model);
    if (!m) {
      // Booted without a database: nothing can be created; report
      // the honest empty state (the guard already gated access).
      return {
        name: def.name,
        model: def.model,
        collection: def.collection,
        exists: false,
        queryable: false,
        status: null,
        ready: false,
        action: 'already-present',
      };
    }

    let action: EnsuredSearchIndex['action'] = 'already-present';
    const before = await this.listStatuses(def.model, true);
    if (!before.some((s) => s.name === def.name)) {
      try {
        await m.collection.createSearchIndex({
          name: def.name,
          definition: def.definition,
        });
        action = 'created';
      } catch (err) {
        // A create that loses the race (index appeared between
        // the probe and the create) fails with an already-exists
        // error — that IS the desired end state. This pass did
        // issue the create, so it still reports 'created'.
        if (!isAlreadyExistsError(err)) throw err;
        action = 'created';
      }
    }

    const after = await this.listStatuses(def.model, true);
    const current = after.find((s) => s.name === def.name);
    return {
      name: def.name,
      model: def.model,
      collection: def.collection,
      exists: current?.exists ?? action === 'created',
      queryable: current?.queryable ?? false,
      status: current?.status ?? null,
      ready: current?.ready ?? false,
      action,
    };
  }
}

/** Atlas/driver wordings for "this search index name is taken". */
function isAlreadyExistsError(err: unknown): boolean {
  const e = err as { codeName?: unknown; message?: unknown } | null;
  const text = `${typeof e?.codeName === 'string' ? e.codeName : ''} ${
    typeof e?.message === 'string' ? e.message : ''
  }`;
  return /already exists|IndexAlreadyExists|duplicate/i.test(text);
}

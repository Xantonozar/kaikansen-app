import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { SyncSecretGuard } from '../sync/sync-secret.guard';
import {
  SearchIndexService,
  type EnsuredSearchIndex,
} from '../themes/search-index.service';

/**
 * Internal search-index endpoints — deliberately NOT part of the
 * shared @kaikansen/contracts package: operator tooling, exactly
 * like the /internal/sync endpoints they mirror.
 *
 * Behind SyncSecretGuard (`x-sync-secret` header): SYNC_SECRET
 * unset → 503, wrong/missing secret → 401.
 */
@Controller('internal/search-indexes')
@UseGuards(SyncSecretGuard)
export class SearchIndexesController {
  constructor(private readonly indexes: SearchIndexService) {}

  /**
   * POST /internal/search-indexes/ensure — idempotently create
   * the three Option B MongoDB Search indexes from the shipped
   * definitions, over the API's own Mongoose connection.
   *
   * Why this exists (rollout, 2026-11-10): the deployment host
   * (Render) is on the Atlas IP whitelist, but the operator's
   * other machines are not and the Atlas UI needs a mailbox OTP
   * the operator's agent cannot read — so index creation rides
   * the API's own whitelisted connection instead. Creation is
   * asynchronous on Atlas's side: the response reports each
   * index's state AFTER the pass (fresh `listSearchIndexes`), so
   * a just-created index honestly shows BUILDING / queryable
   * false until Atlas finishes — poll a search response's
   * `searchType` to see groups flip to 'atlas' as they become
   * READY.
   *
   * Request: no body. Response 200:
   * `{ indexes: [{ name, collection, model, exists, queryable,
   *    status, ready, action }] }`
   * with `action` = 'created' | 'already-present' per index.
   */
  @Post('ensure')
  @HttpCode(HttpStatus.OK)
  async ensure(): Promise<{ indexes: EnsuredSearchIndex[] }> {
    return { indexes: await this.indexes.ensureIndexes() };
  }
}

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SyncSecretGuard } from '../sync/sync-secret.guard';
import {
  CountersService,
  type CounterRecountReport,
} from './counters.service';

/**
 * Internal counter-repair endpoint — operator tooling like the
 * sync endpoints, deliberately NOT part of the shared
 * @kaikansen/contracts package.
 *
 * Behind SyncSecretGuard (`x-sync-secret` header): SYNC_SECRET
 * unset → 503, wrong/missing secret → 401.
 *
 * Usage (against the deployed API, with SYNC_SECRET set there):
 *
 *   # Recount EVERY user's stored counters:
 *   curl -X POST https://<api-host>/internal/users/recount-counters \
 *     -H 'x-sync-secret: <SYNC_SECRET>' -H 'Content-Type: application/json' -d '{}'
 *
 *   # Recount one user:
 *   curl -X POST https://<api-host>/internal/users/recount-counters \
 *     -H 'x-sync-secret: <SYNC_SECRET>' -H 'Content-Type: application/json' \
 *     -d '{"userId": "<mongo id>"}'
 *
 * The response reports how many users were checked, how many
 * were corrected, and every field that changed (from → to).
 * Nothing runs this automatically — it is a deliberate repair
 * action for when drift is suspected (audit S3). Since perf
 * problem 4 it also backfills the stored profile-stats fields
 * (statsListenedThemes / statsListenedSeconds / statsRatingSum /
 * statsRatingCount) for users whose documents predate them —
 * the one-time backfill after that deploy is this same call.
 */
@Controller('internal/users')
@UseGuards(SyncSecretGuard)
export class CountersController {
  constructor(private readonly counters: CountersService) {}

  @Post('recount-counters')
  @HttpCode(HttpStatus.OK)
  recountCounters(
    @Body() body?: { userId?: string },
  ): Promise<CounterRecountReport> {
    return this.counters.recountCounters(body?.userId);
  }
}

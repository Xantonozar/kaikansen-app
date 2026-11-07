import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SyncSecretGuard } from './sync-secret.guard';
import { SyncService, type SyncStatus } from './sync.service';

/**
 * Internal sync endpoints — deliberately NOT part of the shared
 * @kaikansen/contracts package: they are operator tooling for the
 * GitHub Actions schedule (and manual runs), not app API surface.
 *
 * Every route is behind SyncSecretGuard (`x-sync-secret` header):
 * SYNC_SECRET unset → 503, wrong/missing secret → 401.
 */
@Controller('internal/sync')
@UseGuards(SyncSecretGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /**
   * Starts a themes job for `year` (default: the current year) and
   * returns the job status immediately — the job runs in the
   * background. 409 while any sync job is already running.
   */
  @Post('themes')
  @HttpCode(HttpStatus.ACCEPTED)
  startThemes(@Body() body?: { year?: number }): SyncStatus {
    const year = body?.year;
    if (year !== undefined && (!Number.isInteger(year) || year <= 0)) {
      throw new BadRequestException('year must be a positive integer');
    }
    return this.sync.startThemesSync(year);
  }

  /**
   * Starts the popular-flag job (match-first; see SyncService). 409
   * while any sync job is already running.
   */
  @Post('popular')
  @HttpCode(HttpStatus.ACCEPTED)
  startPopular(): SyncStatus {
    return this.sync.startPopularSync();
  }

  /** Current (or last) job's status. */
  @Get('status')
  getStatus(): SyncStatus {
    return this.sync.getStatus();
  }
}

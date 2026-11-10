import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Connection } from 'mongoose';
import type { HealthResponse } from '@kaikansen/contracts';

/**
 * GET /health — the API's liveness signal (the keep-alive pinger
 * and Render's checks read it). Originally a constant payload;
 * the fix batch (2026-11-11) makes it tell the truth about the
 * database: the Mongoose connection is checked (readyState) and,
 * when connected, confirmed with a driver-level admin ping —
 * cheap (no user collections touched). DB up → 200 with
 * db: 'ok'. DB down → 503 with db: 'down', thrown as an
 * HttpException carrying the payload so monitors see red.
 *
 * The connection is OPTIONAL: booted without MONGODB_URI there is
 * no connection provider at all, and health answers 200 with
 * db: 'not-configured' — the long-standing boot behaviour (the
 * data endpoints 503 in that posture, health does not).
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Optional()
    @InjectConnection()
    private readonly connection?: Connection,
  ) {}

  @Get()
  @ApiOkResponse({ description: 'Service is up and the database answers.' })
  async health(): Promise<HealthResponse> {
    const base = { status: 'ok' as const, service: 'kaikansen-api' };
    if (!this.connection) {
      return { ...base, db: 'not-configured' as const };
    }
    // readyState 1 = connected. Anything else (0 disconnected,
    // 2 connecting, 3 disconnecting, 99 uninitialized) is not
    // "the database answers" — report down without pinging.
    if (this.connection.readyState !== 1) {
      throw new HttpException(
        { ...base, db: 'down' as const },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    try {
      await this.connection.db?.admin().ping();
    } catch {
      throw new HttpException(
        { ...base, db: 'down' as const },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { ...base, db: 'ok' as const };
  }
}

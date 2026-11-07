import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/** Constant-time string comparison (lengths checked first). */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Gate for the /internal/* sync endpoints: the caller must present the
 * SYNC_SECRET env value in the `x-sync-secret` header.
 *
 * - SYNC_SECRET unset → 503 (the endpoints are not merely unauthenticated,
 *   they are OFF — the web's cron routes fail OPEN when their secret is
 *   unset; this gate deliberately fails closed instead).
 * - Header missing or not equal (constant-time comparison) → 401.
 */
@Injectable()
export class SyncSecretGuard implements CanActivate {
  constructor(@Optional() private readonly config?: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret =
      this.config?.get<string>('SYNC_SECRET') ?? process.env.SYNC_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Sync endpoints unavailable — SYNC_SECRET is not configured',
      );
    }
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const presented = request.headers['x-sync-secret'];
    if (typeof presented !== 'string' || !secretEquals(presented, secret)) {
      throw new UnauthorizedException('Invalid sync secret');
    }
    return true;
  }
}

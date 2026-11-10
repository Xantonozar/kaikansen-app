import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { cacheControlFor } from './cache-control.policy';

/**
 * Applies the Cache-Control policy (see cache-control.policy.ts)
 * to every HTTP response that does not already carry the header.
 *
 * Two deliberate mechanics:
 * - The header is set when the handler COMPLETES (tap on the
 *   result stream), not on the way in: Nest's exception filter
 *   builds error responses outside the interceptor's success path,
 *   so an error never inherits a success-only freshness hint —
 *   most importantly a catalogue 503 can never be stamped
 *   `private, max-age=60`.
 * - A handler that set its own Cache-Control always wins; this
 *   interceptor only fills a gap, it never overrides.
 *
 * Registered globally in http-setup.ts (not via APP_INTERCEPTOR)
 * so the e2e harness boots the identical pipeline.
 */
@Injectable()
export class CacheControlInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const value = cacheControlFor(req.method, req.path);
    if (value === null) return next.handle();
    return next.handle().pipe(
      tap(() => {
        if (!res.headersSent && !res.getHeader('Cache-Control')) {
          res.setHeader('Cache-Control', value);
        }
      }),
    );
  }
}

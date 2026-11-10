import type { INestApplication } from '@nestjs/common';
import compression from 'compression';
import type { Request, Response } from 'express';
import { CacheControlInterceptor } from './cache-control.interceptor';

/**
 * Shared HTTP-layer setup for the API (perf problem 10 —
 * API-PROJECTIONS-GZIP-2026-11-10): response compression + the
 * conservative Cache-Control policy. Called from main.ts AND from
 * the e2e harness that boots the real AppModule, so production and
 * tests exercise exactly the same wiring.
 */

/**
 * The gzip threshold: bodies under 1 KB pass through untouched —
 * compressing them costs more CPU than the bytes are worth (the
 * compression package's own default; named here because the spec
 * locks "~1 KB").
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * Response types compression must never touch: anything that is
 * not JSON. Today the API serves no binary or streaming route —
 * media bytes are URLs into the catalogue, never proxied — so this
 * filter is the guard rail for the day one appears: a future
 * download/stream endpoint stays byte-exact unless someone
 * deliberately revisits this list.
 */
const COMPRESSIBLE_JSON = /json/i;

function shouldCompress(req: Request, res: Response): boolean {
  // Socket.IO owns its transport: the polling handshake and the
  // upgrade live under /socket.io/ and its engine already negotiates
  // its own framing — compression middleware must not sit between
  // the gateway and its clients.
  if (req.path.startsWith('/socket.io')) return false;
  const type = res.getHeader('Content-Type');
  if (typeof type !== 'string') return true;
  return COMPRESSIBLE_JSON.test(type);
}

export function applyHttpSetup(app: INestApplication): void {
  app.use(
    compression({
      threshold: COMPRESSION_THRESHOLD_BYTES,
      filter: shouldCompress,
    }),
  );
  // The interceptor runs inside Nest's pipeline, after
  // compression's header wrapping is in place; the two compose —
  // the interceptor only ever SETS Cache-Control, compression only
  // ever transforms the body + encoding headers.
  app.useGlobalInterceptors(new CacheControlInterceptor());
}

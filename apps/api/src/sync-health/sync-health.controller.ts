import { Controller, Get, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

interface SecretFingerprint {
  present: boolean;
  length: number | null;
  sha256Prefix: string | null;
}

export interface SyncHealthResponse {
  status: 'ok';
  configService: SecretFingerprint;
  processEnv: SecretFingerprint;
}

/**
 * Fingerprint a secret value WITHOUT ever exposing it: presence,
 * length, and the first 6 hex chars of its SHA-256. Undefined or
 * empty string reads as "not present".
 */
function fingerprint(value: string | undefined): SecretFingerprint {
  if (typeof value !== 'string' || value.length === 0) {
    return { present: false, length: null, sha256Prefix: null };
  }
  const sha256Prefix = createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 6);
  return { present: true, length: value.length, sha256Prefix };
}

/**
 * TEMP DIAGNOSTIC for the SYNC_SECRET 401 investigation (2026-11-10):
 * POST /internal/search-indexes/ensure keeps returning 401 'Invalid
 * sync secret' even though the presented header matches the value set
 * in the hosting env. This endpoint reports how the app itself sees
 * SYNC_SECRET through EACH read path SyncSecretGuard uses
 * (ConfigService first, then process.env) — fingerprints only, never
 * the value. Unauthenticated by design so it can be curled against
 * production. REMOVE once the investigation closes.
 */
@Controller('sync-health')
export class SyncHealthController {
  // Same injection style as SyncSecretGuard: optional ConfigService,
  // so this fingerprint reflects exactly what the guard would see.
  constructor(@Optional() private readonly config?: ConfigService) {}

  @Get()
  syncHealth(): SyncHealthResponse {
    return {
      status: 'ok',
      configService: fingerprint(this.config?.get<string>('SYNC_SECRET')),
      processEnv: fingerprint(process.env.SYNC_SECRET),
    };
  }
}

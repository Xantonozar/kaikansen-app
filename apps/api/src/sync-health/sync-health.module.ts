import { Module } from '@nestjs/common';
import { SyncHealthController } from './sync-health.controller';

/**
 * TEMP DIAGNOSTIC for the SYNC_SECRET 401 investigation (2026-11-10).
 * No providers of its own: ConfigModule is global (see AppModule), so
 * the controller's optional ConfigService resolves exactly as it does
 * for SyncSecretGuard. REMOVE once the investigation closes.
 */
@Module({
  controllers: [SyncHealthController],
})
export class SyncHealthModule {}

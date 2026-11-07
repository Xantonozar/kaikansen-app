import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ThemeCache,
  ThemeCacheSchema,
} from '../themes/theme-cache.schema';
import { AnimeThemesClient } from './animethemes.client';
import { AnimeCache, AnimeCacheSchema } from './anime-cache.schema';
import { ArtistCache, ArtistCacheSchema } from './artist-cache.schema';
import { EnrichmentClient } from './enrichment.client';
import { EnrichmentService } from './enrichment.service';
import { SyncTiming } from './sync.constants';
import { SyncController } from './sync.controller';
import { SyncSecretGuard } from './sync-secret.guard';
import { SyncService } from './sync.service';

/**
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database (see
 * AppModule). Without one, SyncService is constructed model-less and job
 * starts answer 503 — /health and the status read keep working.
 *
 * Registering ThemeCache here a second time (ThemesModule has it too)
 * is safe: @nestjs/mongoose reuses the already-compiled model for a
 * name on the same connection.
 */
@Module({})
export class SyncModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: SyncModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: ThemeCache.name, schema: ThemeCacheSchema },
              { name: AnimeCache.name, schema: AnimeCacheSchema },
              { name: ArtistCache.name, schema: ArtistCacheSchema },
            ]),
          ]
        : [],
      controllers: [SyncController],
      providers: [
        SyncService,
        SyncSecretGuard,
        AnimeThemesClient,
        EnrichmentClient,
        EnrichmentService,
        SyncTiming,
      ],
    };
  }
}

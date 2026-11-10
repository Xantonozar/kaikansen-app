import { type DynamicModule, Module } from '@nestjs/common';
import { SyncSecretGuard } from '../sync/sync-secret.guard';
import { ThemesModule } from '../themes/themes.module';
import { SearchIndexesController } from './search-indexes.controller';

/**
 * The internal search-indexes endpoints. The probe/ensure service
 * (SearchIndexService) and the catalogue models live in
 * ThemesModule, which exports both services — this module only
 * adds the guarded controller, following the SyncModule shape.
 * ThemesModule.register is called with the same database flag so
 * its conditional Mongoose registration matches AppModule's.
 */
@Module({})
export class SearchIndexesModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: SearchIndexesModule,
      imports: [ThemesModule.register(withDatabase)],
      controllers: [SearchIndexesController],
      providers: [SyncSecretGuard],
    };
  }
}

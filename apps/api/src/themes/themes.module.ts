import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ThemeCache, ThemeCacheSchema } from './theme-cache.schema';
import { ThemesController } from './themes.controller';
import { ThemesService } from './themes.service';

/**
 * The Mongoose feature registration only exists when the app was booted
 * WITH a database (see AppModule): without MONGODB_URI there is no
 * connection for the model to attach to, so the module registers the
 * controller + service alone and the service answers 503.
 */
@Module({})
export class ThemesModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: ThemesModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: ThemeCache.name, schema: ThemeCacheSchema },
            ]),
          ]
        : [],
      controllers: [ThemesController],
      providers: [ThemesService],
    };
  }
}

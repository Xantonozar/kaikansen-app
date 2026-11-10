import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../auth/user.schema';
import {
  AnimeCache,
  AnimeCacheSchema,
} from '../sync/anime-cache.schema';
import {
  ArtistCache,
  ArtistCacheSchema,
} from '../sync/artist-cache.schema';
import { ThemeCache, ThemeCacheSchema } from './theme-cache.schema';
import { ThemesController } from './themes.controller';
import { ThemesService } from './themes.service';

/**
 * The Mongoose feature registration only exists when the app was booted
 * WITH a database (see AppModule): without MONGODB_URI there is no
 * connection for the model to attach to, so the module registers the
 * controller + service alone and the service answers 503.
 *
 * AnimeCache is registered here a second time (SyncModule has it
 * too) for the related-anime read — safe per the established
 * precedent: @nestjs/mongoose reuses the already-compiled model
 * for a name on the same connection. User is registered on the
 * same precedent (AuthModule / SocialModule have it too): since
 * 2026-11-10 GET /search serves a users group, read-only here.
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
              { name: AnimeCache.name, schema: AnimeCacheSchema },
              { name: ArtistCache.name, schema: ArtistCacheSchema },
              { name: User.name, schema: UserSchema },
            ]),
          ]
        : [],
      controllers: [ThemesController],
      providers: [ThemesService],
    };
  }
}

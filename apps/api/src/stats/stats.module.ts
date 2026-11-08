import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AnilistClient } from '../auth/anilist.client';
import { AuthService } from '../auth/auth.service';
import { User, UserSchema } from '../auth/user.schema';
import {
  WatchHistory,
  WatchHistorySchema,
} from '../library/watch-history.schema';
import {
  ArtistCache,
  ArtistCacheSchema,
} from '../sync/artist-cache.schema';
import {
  ThemeCache,
  ThemeCacheSchema,
} from '../themes/theme-cache.schema';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Slice S8 — stats reads (live counters + the caller's top artists).
 *
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database
 * (see AppModule). Without one, StatsService is constructed
 * model-less and the endpoints answer 503 — /health stays up
 * either way (the top-artists guard still 401s tokenless first).
 *
 * User, WatchHistory, ThemeCache and ArtistCache are registered
 * here again (AuthModule / LibraryModule / ThemesModule /
 * SyncModule have them too) — safe per the established precedent:
 * @nestjs/mongoose reuses the already-compiled model for a name on
 * the same connection.
 *
 * The guard chain (AccessTokenGuard → AuthService) is provided
 * here too, as in the other guarded modules: AuthService is
 * stateless, so a second instance verifies tokens identically.
 * AnilistClient is included because AuthService optionally depends
 * on it.
 */
@Module({})
export class StatsModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: StatsModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: User.name, schema: UserSchema },
              { name: WatchHistory.name, schema: WatchHistorySchema },
              { name: ThemeCache.name, schema: ThemeCacheSchema },
              { name: ArtistCache.name, schema: ArtistCacheSchema },
            ]),
          ]
        : [],
      controllers: [StatsController],
      providers: [
        StatsService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
      ],
    };
  }
}

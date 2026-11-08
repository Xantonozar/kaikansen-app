import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnilistClient } from '../auth/anilist.client';
import { AuthService } from '../auth/auth.service';
import { User, UserSchema } from '../auth/user.schema';
import { Rating, RatingSchema } from '../library/rating.schema';
import {
  WatchHistory,
  WatchHistorySchema,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  ThemeCacheSchema,
} from '../themes/theme-cache.schema';
import { AnilistHistoryClient } from './anilist-history.client';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Slice S6 — per-user history + ratings.
 *
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database
 * (see AppModule). Without one, UsersService is constructed
 * model-less and the endpoints answer 503 — /health stays up
 * either way.
 *
 * User, Rating, WatchHistory and ThemeCache are registered here
 * again (AuthModule / LibraryModule / SocialModule / ThemesModule
 * have them too) — safe per the established precedent:
 * @nestjs/mongoose reuses the already-compiled model for a name on
 * the same connection.
 *
 * AuthService is provided here too: UsersService verifies Bearer
 * tokens itself for the history route's optional auth (the merged
 * mode's owner check), where a guard's hard 401 would be wrong.
 * AnilistClient is included because AuthService optionally depends
 * on it. AnilistHistoryClient is the merged mode's AniList
 * completed-list fetch.
 */
@Module({})
export class UsersModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: UsersModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: User.name, schema: UserSchema },
              { name: Rating.name, schema: RatingSchema },
              { name: WatchHistory.name, schema: WatchHistorySchema },
              { name: ThemeCache.name, schema: ThemeCacheSchema },
            ]),
          ]
        : [],
      controllers: [UsersController],
      providers: [
        UsersService,
        AnilistHistoryClient,
        AuthService,
        AnilistClient,
      ],
    };
  }
}

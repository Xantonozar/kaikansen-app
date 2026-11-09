import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AnilistClient } from '../auth/anilist.client';
import { AuthService } from '../auth/auth.service';
import { User, UserSchema } from '../auth/user.schema';
import {
  ThemeCache,
  ThemeCacheSchema,
} from '../themes/theme-cache.schema';
import { AnilistLibraryClient } from './anilist-library.client';
import { Favorite, FavoriteSchema } from './favorite.schema';
import { Follow, FollowSchema } from '../social/follow.schema';
import {
  Notification,
  NotificationSchema,
} from '../social/notification.schema';
import { FollowerActivityService } from '../social/follower-activity.service';
import { HistoryCheckController } from './history-check.controller';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { Rating, RatingSchema } from './rating.schema';
import { WatchHistory, WatchHistorySchema } from './watch-history.schema';

/**
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database (see
 * AppModule). Without one, LibraryService is constructed model-less and
 * the library endpoints answer 503 — /health stays up either way.
 *
 * ThemeCache and User are registered here a second time (ThemesModule /
 * AuthModule have them too) — safe per the SyncModule precedent:
 * @nestjs/mongoose reuses the already-compiled model for a name on the
 * same connection.
 *
 * The guard chain (AccessTokenGuard → AuthService) is provided here
 * too, as the auth e2e suite composes it: AuthService is stateless, so
 * a second instance verifies tokens identically. AnilistClient is
 * included because AuthService optionally depends on it.
 *
 * S8 adds AnilistLibraryClient (the library-themes read's AniList
 * completed-ids fetch — a different client from the auth one) and
 * HistoryCheckController (the optional-auth history check, kept off
 * LibraryController's class-level guard).
 *
 * Follow + Notification are registered here so the rating and
 * favourite writes can fan follower-activity notifications out
 * through FollowerActivityService (SocialModule owns the models'
 * home registration; re-registration is the established pattern —
 * see above).
 */
@Module({})
export class LibraryModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: LibraryModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: ThemeCache.name, schema: ThemeCacheSchema },
              { name: User.name, schema: UserSchema },
              { name: Favorite.name, schema: FavoriteSchema },
              { name: Rating.name, schema: RatingSchema },
              { name: WatchHistory.name, schema: WatchHistorySchema },
              { name: Follow.name, schema: FollowSchema },
              { name: Notification.name, schema: NotificationSchema },
            ]),
          ]
        : [],
      controllers: [LibraryController, HistoryCheckController],
      providers: [
        LibraryService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
        AnilistLibraryClient,
        FollowerActivityService,
      ],
    };
  }
}

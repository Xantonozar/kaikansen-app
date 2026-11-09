import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AnilistClient } from '../auth/anilist.client';
import { AuthService } from '../auth/auth.service';
import { User, UserSchema } from '../auth/user.schema';
import { Rating, RatingSchema } from '../library/rating.schema';
import { UserRank, UserRankSchema } from '../quiz/user-rank.schema';
import {
  WatchHistory,
  WatchHistorySchema,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  ThemeCacheSchema,
} from '../themes/theme-cache.schema';
import { Follow, FollowSchema } from './follow.schema';
import {
  Notification,
  NotificationSchema,
} from './notification.schema';
import {
  PlaylistActivity,
  PlaylistActivitySchema,
} from '../playlists/playlist-activity.schema';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';

/**
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database
 * (see AppModule). Without one, SocialService is constructed
 * model-less and the social endpoints answer 503 — /health stays
 * up either way.
 *
 * User, Rating, WatchHistory and ThemeCache are registered here
 * again (AuthModule / LibraryModule / ThemesModule have them too)
 * — safe per the LibraryModule precedent: @nestjs/mongoose reuses
 * the already-compiled model for a name on the same connection.
 *
 * AuthService is provided here too: SocialService verifies Bearer
 * tokens itself for the optional-auth endpoints (follow status,
 * profile activity, friends feed), where the guard's hard 401
 * would be wrong. AnilistClient is included because AuthService
 * optionally depends on it.
 */
@Module({})
export class SocialModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: SocialModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: User.name, schema: UserSchema },
              { name: Follow.name, schema: FollowSchema },
              { name: Notification.name, schema: NotificationSchema },
              { name: Rating.name, schema: RatingSchema },
              { name: WatchHistory.name, schema: WatchHistorySchema },
              { name: ThemeCache.name, schema: ThemeCacheSchema },
              // Read-only here: the network rows' tier enrichment.
              { name: UserRank.name, schema: UserRankSchema },
              // Read-only here: the feed's 'playlist_add' events
              // (PlaylistsModule owns the writes).
              {
                name: PlaylistActivity.name,
                schema: PlaylistActivitySchema,
              },
            ]),
          ]
        : [],
      controllers: [SocialController],
      providers: [
        SocialService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
      ],
    };
  }
}

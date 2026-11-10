import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccessTokenGuard } from './access-token.guard';
import { AnilistClient } from './anilist.client';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_THROTTLER_OPTIONS } from './auth-throttle';
import { MailerService } from './mailer.service';
import { User, UserSchema } from './user.schema';
import { Rating, RatingSchema } from '../library/rating.schema';
import {
  WatchHistory,
  WatchHistorySchema,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  ThemeCacheSchema,
} from '../themes/theme-cache.schema';
import { Follow, FollowSchema } from '../social/follow.schema';

/**
 * Same conditional-registration pattern as ThemesModule: the Mongoose
 * feature only exists when the app booted WITH a database (see
 * AppModule). Without one, AuthService is constructed model-less and
 * the auth endpoints answer 503 — /health stays up either way.
 */
@Module({})
export class AuthModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: AuthModule,
      imports: [
        // Rate limiting for the auth surface (audit C1): the guard
        // itself hangs on AuthController; the module registration
        // only provides the buckets. Registered in both branches —
        // throttling must also hold on a model-less boot.
        ThrottlerModule.forRoot(AUTH_THROTTLER_OPTIONS),
        ...(withDatabase
          ? [
              MongooseModule.forFeature([
                { name: User.name, schema: UserSchema },
                // Read-only here: GET /auth/me's listening stats
                // (AuthService.withStats). Registered in the other
                // modules too — @nestjs/mongoose reuses the compiled
                // model per name on the same connection.
                { name: Rating.name, schema: RatingSchema },
                { name: WatchHistory.name, schema: WatchHistorySchema },
                { name: ThemeCache.name, schema: ThemeCacheSchema },
                { name: Follow.name, schema: FollowSchema },
              ]),
            ]
          : []),
      ],
      controllers: [AuthController],
      // AnilistClient is registered unconditionally (it holds no config);
      // AuthService answers 503 from the AniList endpoints when the
      // ANILIST_* env trio is unset, exactly as it does model-less.
      // MailerService likewise: it reads BREVO_API_KEY / MAIL_FROM from
      // the environment and fails closed (skips sending) when unset.
      providers: [AuthService, AccessTokenGuard, AnilistClient, MailerService],
    };
  }
}

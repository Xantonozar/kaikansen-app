import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AnilistClient } from '../auth/anilist.client';
import { AuthService } from '../auth/auth.service';
import { User, UserSchema } from '../auth/user.schema';
import { Favorite, FavoriteSchema } from '../library/favorite.schema';
import { Rating, RatingSchema } from '../library/rating.schema';
import {
  WatchHistory,
  WatchHistorySchema,
} from '../library/watch-history.schema';
import {
  ThemeCache,
  ThemeCacheSchema,
} from '../themes/theme-cache.schema';
import { QuizAttempt, QuizAttemptSchema } from './quiz-attempt.schema';
import { QuizRoom, QuizRoomSchema } from './quiz-room.schema';
import { RankHistory, RankHistorySchema } from './rank-history.schema';
import { UserRank, UserRankSchema } from './user-rank.schema';
import { QuizHeadsModule } from '../quiz-heads/quiz-heads.module';
import { HttpAudioProbe } from './audio-probe';
import { QuizController } from './quiz.controller';
import { QuizGateway } from './quiz.gateway';
import { QuizRoomsService } from './quiz-rooms.service';
import { RankService } from './rank.service';
import { RoomBroadcaster } from './room-broadcaster';
import { SoloQuizService } from './solo-quiz.service';

/**
 * Slice S4 — quiz: solo games over REST (QuizController /
 * SoloQuizService) and multiplayer rooms over this API's own
 * Socket.IO gateway (QuizGateway / QuizRoomsService), with the
 * web's rank maintenance (RankService) at game end.
 *
 * Same conditional-registration pattern as the other modules:
 * the Mongoose features only exist when the app booted WITH a
 * database. Without one, the services are constructed model-less
 * — solo endpoints answer 503, room actions ack the quiz-
 * unavailable error — while /health stays up.
 *
 * ThemeCache / User / WatchHistory / Rating / Favorite are
 * registered here again (other modules have them too) — safe per
 * the established precedent: @nestjs/mongoose reuses the
 * already-compiled model for a name on the same connection.
 * WatchHistory/Rating/Favorite feed the watched/common pool
 * resolution (the web's quiz-room-utils reads all three).
 *
 * The guard chain (AccessTokenGuard → AuthService) is provided
 * here too, as the other modules compose it; the gateway verifies
 * handshake tokens through the same AuthService.
 */
@Module({})
export class QuizModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: QuizModule,
      // QuizHeadsModule in both branches: the head cache has
      // no database dependency, and SoloQuizService injects
      // its exported QuizHeadCacheService as the deal-time
      // warmer (phase 2, 2026-11-12).
      imports: [
        QuizHeadsModule,
        ...(withDatabase
          ? [
              MongooseModule.forFeature([
                { name: QuizAttempt.name, schema: QuizAttemptSchema },
                { name: QuizRoom.name, schema: QuizRoomSchema },
                { name: UserRank.name, schema: UserRankSchema },
                { name: RankHistory.name, schema: RankHistorySchema },
                { name: ThemeCache.name, schema: ThemeCacheSchema },
                { name: User.name, schema: UserSchema },
                { name: WatchHistory.name, schema: WatchHistorySchema },
                { name: Rating.name, schema: RatingSchema },
                { name: Favorite.name, schema: FavoriteSchema },
              ]),
            ]
          : []),
      ],
      controllers: [QuizController],
      providers: [
        SoloQuizService,
        HttpAudioProbe,
        QuizRoomsService,
        RankService,
        RoomBroadcaster,
        QuizGateway,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
      ],
    };
  }
}

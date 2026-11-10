import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { AnilistClient } from '../auth/anilist.client';
import { AuthService } from '../auth/auth.service';
import { User, UserSchema } from '../auth/user.schema';
import { UserRank, UserRankSchema } from '../quiz/user-rank.schema';
import {
  RankHistory,
  RankHistorySchema,
} from '../quiz/rank-history.schema';
import {
  LeaderboardSnapshot,
  LeaderboardSnapshotSchema,
} from './leaderboard-snapshot.schema';
import { RankController } from './rank.controller';
import { RankReadService } from './rank-read.service';

/**
 * Slice S6 — rank reads (rank/me, rank/:userId, rank/leaderboard).
 *
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database
 * (see AppModule). Without one, RankReadService is constructed
 * model-less and the endpoints answer 503 — /health stays up
 * either way (the /rank/me guard still 401s tokenless first).
 *
 * UserRank is registered here again (QuizModule has it too) and
 * User again (AuthModule et al.) — safe per the established
 * precedent: @nestjs/mongoose reuses the already-compiled model
 * for a name on the same connection. The rank WRITE path stays in
 * QuizModule's RankService; this module only reads (plus the
 * web's own find-or-create on the two rank reads — see
 * RankReadService).
 */
@Module({})
export class RankModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: RankModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: UserRank.name, schema: UserRankSchema },
              { name: RankHistory.name, schema: RankHistorySchema },
              {
                name: LeaderboardSnapshot.name,
                schema: LeaderboardSnapshotSchema,
              },
              { name: User.name, schema: UserSchema },
            ]),
          ]
        : [],
      controllers: [RankController],
      providers: [
        RankReadService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
      ],
    };
  }
}

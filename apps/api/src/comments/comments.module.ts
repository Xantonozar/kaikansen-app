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
import { Comment, CommentSchema } from './comment.schema';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

/**
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database
 * (see AppModule). Without one, CommentsService is constructed
 * model-less and the comment endpoints answer 503 — /health stays
 * up either way.
 *
 * ThemeCache and User are registered here again (ThemesModule /
 * LibraryModule / AuthModule have them too) — safe per the
 * LibraryModule precedent: @nestjs/mongoose reuses the
 * already-compiled model for a name on the same connection.
 *
 * The guard chain (AccessTokenGuard → AuthService) is provided
 * here too, as the playlists module composes it: AuthService is
 * stateless, so a second instance verifies tokens identically.
 * AnilistClient is included because AuthService optionally depends
 * on it.
 */
@Module({})
export class CommentsModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: CommentsModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: Comment.name, schema: CommentSchema },
              { name: ThemeCache.name, schema: ThemeCacheSchema },
              { name: User.name, schema: UserSchema },
            ]),
          ]
        : [],
      controllers: [CommentsController],
      providers: [
        CommentsService,
        AuthService,
        AccessTokenGuard,
        AnilistClient,
      ],
    };
  }
}

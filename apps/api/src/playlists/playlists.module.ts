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
import { Playlist, PlaylistSchema } from './playlist.schema';
import {
  PlaylistActivity,
  PlaylistActivitySchema,
} from './playlist-activity.schema';
import { PlaylistsController } from './playlists.controller';
import { PlaylistsService } from './playlists.service';

/**
 * Same conditional-registration pattern as the other modules: the
 * Mongoose features only exist when the app booted WITH a database
 * (see AppModule). Without one, PlaylistsService is constructed
 * model-less and the playlist endpoints answer 503 — /health stays
 * up either way.
 *
 * ThemeCache is registered here a second time (ThemesModule /
 * LibraryModule have it too) — safe per the LibraryModule precedent:
 * @nestjs/mongoose reuses the already-compiled model for a name on
 * the same connection.
 *
 * The guard chain (AccessTokenGuard → AuthService) is provided here
 * too, as the library e2e suite composes it: AuthService is
 * stateless, so a second instance verifies tokens identically.
 * AnilistClient is included because AuthService optionally depends
 * on it. The User model is registered for PlaylistsService's owner
 * resolution (the detail's "by <owner>" line); AuthService's own
 * User dependency stays @Optional and unneeded — the guard only
 * verifies tokens.
 */
@Module({})
export class PlaylistsModule {
  static register(withDatabase: boolean): DynamicModule {
    return {
      module: PlaylistsModule,
      imports: withDatabase
        ? [
            MongooseModule.forFeature([
              { name: Playlist.name, schema: PlaylistSchema },
              { name: PlaylistActivity.name, schema: PlaylistActivitySchema },
              { name: ThemeCache.name, schema: ThemeCacheSchema },
              { name: User.name, schema: UserSchema },
            ]),
          ]
        : [],
      controllers: [PlaylistsController],
      providers: [PlaylistsService, AuthService, AccessTokenGuard, AnilistClient],
    };
  }
}

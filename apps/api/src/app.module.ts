import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthController } from './health/health.controller';
import { AppVersionController } from './app-version/app-version.controller';
import { ThemesModule } from './themes/themes.module';
import { AuthModule } from './auth/auth.module';
import { LibraryModule } from './library/library.module';
import { PlaylistsModule } from './playlists/playlists.module';
import { CommentsModule } from './comments/comments.module';
import { QuizModule } from './quiz/quiz.module';
import { RankModule } from './rank/rank.module';
import { SearchIndexesModule } from './search-indexes/search-indexes.module';
import { SocialModule } from './social/social.module';
import { StatsModule } from './stats/stats.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

/**
 * The database is OPTIONAL at boot: with no MONGODB_URI the API still
 * serves /health (and Swagger), while the theme read path answers 503.
 * The URI is read from process.env here — before ConfigModule initialises —
 * because the import list itself depends on it; deployments provide
 * MONGODB_URI as a real environment variable (see .env.example).
 */
const mongodbUri = process.env.MONGODB_URI;
const hasDatabase = typeof mongodbUri === 'string' && mongodbUri.length > 0;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ...(hasDatabase ? [MongooseModule.forRoot(mongodbUri as string)] : []),
    ThemesModule.register(hasDatabase),
    AuthModule.register(hasDatabase),
    LibraryModule.register(hasDatabase),
    PlaylistsModule.register(hasDatabase),
    CommentsModule.register(hasDatabase),
    QuizModule.register(hasDatabase),
    SocialModule.register(hasDatabase),
    UsersModule.register(hasDatabase),
    RankModule.register(hasDatabase),
    StatsModule.register(hasDatabase),
    SyncModule.register(hasDatabase),
    SearchIndexesModule.register(hasDatabase),
  ],
  controllers: [HealthController, AppVersionController],
})
export class AppModule {}

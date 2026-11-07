import { type DynamicModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessTokenGuard } from './access-token.guard';
import { AnilistClient } from './anilist.client';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User, UserSchema } from './user.schema';

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
      imports: withDatabase
        ? [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])]
        : [],
      controllers: [AuthController],
      // AnilistClient is registered unconditionally (it holds no config);
      // AuthService answers 503 from the AniList endpoints when the
      // ANILIST_* env trio is unset, exactly as it does model-less.
      providers: [AuthService, AccessTokenGuard, AnilistClient],
    };
  }
}

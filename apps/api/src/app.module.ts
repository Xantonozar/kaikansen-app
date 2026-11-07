import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthController } from './health/health.controller';
import { ThemesModule } from './themes/themes.module';
import { AuthModule } from './auth/auth.module';

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
  ],
  controllers: [HealthController],
})
export class AppModule {}

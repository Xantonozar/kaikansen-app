import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { QuizHeadsController } from './quiz-heads.controller';
import { QuizHeadCacheService } from './quiz-heads.service';

/**
 * Phase 2 head cache (2026-11-12) — deliberately NOT the
 * register(withDatabase) shape of the data modules: the cache
 * has no database dependency at all (it must work, and warm,
 * entirely from the local disk), so it registers plainly and
 * AppModule imports it unconditionally. The service is
 * exported for the QuizModule, whose SoloQuizService consumes
 * it as the deal-time warmer.
 *
 * The throttler is scoped exactly like AuthModule's (the
 * module imports its own bucket set; the guard rides only on
 * this controller): one named bucket, IP-keyed, sized to the
 * auth baseline — a game needs ~11 fills plus a handful of
 * player range requests, so 300/min per IP is generous for
 * players and useless for scraping the catalogue through us.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'quiz-heads', ttl: 60_000, limit: 300 },
    ]),
  ],
  controllers: [QuizHeadsController],
  providers: [QuizHeadCacheService],
  exports: [QuizHeadCacheService],
})
export class QuizHeadsModule {}

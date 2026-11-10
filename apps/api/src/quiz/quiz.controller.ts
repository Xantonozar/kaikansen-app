import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  CreateSoloGameRequest,
  QuizLeaderboardResponse,
  SoloAnswerRequest,
  SoloAnswerResponse,
  SoloGameState,
  SoloPlaybackStartedResponse,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { SoloQuizService } from './solo-quiz.service';

/**
 * Slice S4 — solo quiz over REST (see SoloQuizService for the web
 * port and its flagged trust-model change). The web's surface is
 * a stateless question fetch + an attempt submit; this API's
 * server-held game folds them into create → answer calls:
 *
 * - POST /quiz/solo/games            create a 10-question game (first question included)
 * - GET  /quiz/solo/games/:gameId    the live game state (question re-served, timer untouched)
 * - POST /quiz/solo/games/:gameId/playback-started  the client signals the question's audio actually started (or proved unplayable); the answer window opens there, not at the draw
 * - POST /quiz/solo/games/:gameId/answers  answer (or null to skip); scores + persists + advances
 * - GET  /quiz/leaderboard           public; the web's top-10 attempts board
 *
 * Multiplayer rooms are NOT here — they live on the Socket.IO
 * gateway (QuizGateway). When the API is booted without
 * MONGODB_URI the service answers 503; the guard still rejects
 * tokenless game calls with 401 first (it needs no DB).
 */
@ApiTags('quiz')
@Controller()
export class QuizController {
  constructor(private readonly solo: SoloQuizService) {}

  @Post('quiz/solo/games')
  @HttpCode(201)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Start a solo game (web: GET /api/quiz/question + QuizClient game loop).',
  })
  createGame(
    @Req() req: { user: TokenPayload },
    @Body() body: CreateSoloGameRequest,
  ): Promise<SoloGameState> {
    return this.solo.createGame(req.user.userId, body);
  }

  @Get('quiz/solo/games/:gameId')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({ description: 'The live state of one of your solo games.' })
  getGame(
    @Req() req: { user: TokenPayload },
    @Param('gameId') gameId: string,
  ): Promise<SoloGameState> {
    return this.solo.getGame(req.user.userId, gameId);
  }

  @Post('quiz/solo/games/:gameId/playback-started')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Signal that the live question’s audio actually started playing (or failed outright); the answer window is measured from there (idempotent per question).',
  })
  playbackStarted(
    @Req() req: { user: TokenPayload },
    @Param('gameId') gameId: string,
  ): Promise<SoloPlaybackStartedResponse> {
    return this.solo.markPlaybackStarted(req.user.userId, gameId);
  }

  @Post('quiz/solo/games/:gameId/answers')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Answer the live question (web: POST /api/quiz/submit, computed client-side there).',
  })
  answer(
    @Req() req: { user: TokenPayload },
    @Param('gameId') gameId: string,
    @Body() body: SoloAnswerRequest,
  ): Promise<SoloAnswerResponse> {
    return this.solo.submitAnswer(
      req.user.userId,
      gameId,
      body?.answer ?? null,
    );
  }

  @Get('quiz/leaderboard')
  @ApiOkResponse({
    description:
      'Top 10 solo attempts by score, optionally filtered by quiz type (public; web: GET /api/quiz/leaderboard).',
  })
  leaderboard(
    @Query('type') type?: string,
  ): Promise<QuizLeaderboardResponse> {
    return this.solo.leaderboard(type);
  }
}

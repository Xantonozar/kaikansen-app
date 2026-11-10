import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  PlayerRanksResponse,
  RankLeaderboardResponse,
  UserRankProfile,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { RankReadService } from './rank-read.service';

/**
 * Slice S6 — rank reads (see RankReadService for the web port).
 *
 * Route map (web → here):
 *   GET /api/rank/me       → GET /rank/me         (Bearer required)
 *   GET /api/leaderboard   → GET /rank/leaderboard (public)
 *   GET /api/rank/[userId] → GET /rank/:userId     (public)
 *
 * The web's leaderboard lives OUTSIDE /api/rank (at
 * /api/leaderboard) but is the rank surface's board — it is
 * grouped under /rank here, ahead of the :userId catch-all so
 * 'leaderboard' is never read as a user id. Both rank reads use
 * the web's find-or-create getUserRank: a missing rank document
 * is created with defaults (flagged on the service). When the
 * API is booted without MONGODB_URI the service answers 503 (the
 * guard still rejects tokenless /rank/me calls with 401 first).
 */
@ApiTags('rank')
@Controller('rank')
export class RankController {
  constructor(private readonly rank: RankReadService) {}

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'The caller’s rank document — created with defaults when none exists yet (the web’s getUserRank behaviour).',
  })
  myRank(@Req() req: { user: TokenPayload }): Promise<UserRankProfile> {
    return this.rank.getRank(req.user.userId);
  }

  @Get('leaderboard')
  @ApiOkResponse({
    description:
      'The RP top 100 — a fresh leaderboard snapshot when one exists, live aggregation otherwise. ?scope=weekly serves the weekly board (fix batch 2026-11-11): the week’s RankHistory rpChange sums since Monday 00:00 Asia/Dhaka, aggregated live; any other scope value is the all-time board.',
  })
  leaderboard(
    @Query('scope') scope?: string,
  ): Promise<RankLeaderboardResponse> {
    return this.rank.getLeaderboard(scope);
  }

  @Get('players')
  @ApiOkResponse({
    description:
      'Batched player rank standings for a room roster (?ids=<csv>) — read-only: players without a rank document report the academy / 0 RP defaults, nothing is created. Declared ahead of :userId so ‘players’ is never read as a user id.',
  })
  players(@Query('ids') ids?: string): Promise<PlayerRanksResponse> {
    return this.rank.getPlayerRanks((ids ?? '').split(','));
  }

  @Get(':userId')
  @ApiOkResponse({
    description:
      'Any user’s rank document by user id (public) — created with defaults when none exists yet (the web’s getUserRank behaviour).',
  })
  rankOf(@Param('userId') userId: string): Promise<UserRankProfile> {
    return this.rank.getRank(userId);
  }
}

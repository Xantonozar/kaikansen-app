import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  LiveStatsResponse,
  TopArtistsResponse,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { StatsService } from './stats.service';

/**
 * Slice S8 — the web's stats reads (see StatsService for the web
 * port). Route map (web → here):
 *   GET /api/stats/live        → GET /stats/live        (public)
 *   GET /api/stats/top-artists → GET /stats/top-artists (Bearer)
 *
 * Auth matches the web exactly: live is public, top-artists
 * requires a session (the web answers 401 without one). When the
 * API is booted without MONGODB_URI the service answers 503; the
 * guard still rejects tokenless top-artists requests with 401
 * first — it needs no database.
 */
@ApiTags('stats')
@Controller()
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('stats/live')
  @ApiOkResponse({
    description:
      'Live counters: total users, distinct listeners in the last 10 minutes (+ the web’s 0–4 noise), and up to 3 listener avatars (DiceBear fallbacks when none).',
  })
  live(): Promise<LiveStatsResponse> {
    return this.stats.getLiveStats();
  }

  @Get('stats/top-artists')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'The caller’s top artists by plays (top 20 themes folded into ≤6 artists, ArtistCache images joined in).',
  })
  topArtists(
    @Req() req: { user: TokenPayload },
  ): Promise<TopArtistsResponse> {
    return this.stats.getTopArtists(req.user.userId);
  }
}

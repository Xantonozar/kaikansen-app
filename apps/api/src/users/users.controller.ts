import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  UserHistoryResponse,
  UserMergedHistoryResponse,
  UserRatingsResponse,
} from '@kaikansen/contracts';
import { UsersService } from './users.service';

/**
 * Slice S6 — per-user history + ratings (see UsersService for the
 * web port).
 *
 * Route map (web → here):
 *   GET /api/users/[username]/history → GET /users/:username/history
 *   GET /api/users/[username]/ratings → GET /users/:username/ratings
 *
 * Both are PUBLIC, exactly like the web (no session is consulted
 * for the local data — the history route's OPTIONAL Bearer token
 * only unlocks the AniList half of its merged mode, for the owner
 * viewing their own profile; it never 401s). When the API is
 * booted without MONGODB_URI the service answers 503.
 */
@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users/:username/history')
  @ApiOkResponse({
    description:
      'The user’s 50 most recent watch/listen rows (public). ?includeMerged=1 merges in the owner’s AniList completed list (owner + token only); ?includeRemote=0 disables that fetch.',
  })
  history(
    @Param('username') username: string,
    @Headers('authorization') authorization?: string,
    @Query('includeMerged') includeMerged?: string,
    @Query('includeRemote') includeRemote?: string,
  ): Promise<UserHistoryResponse | UserMergedHistoryResponse> {
    return this.users.getHistory(
      authorization,
      username,
      includeMerged,
      includeRemote,
    );
  }

  @Get('users/:username/ratings')
  @ApiOkResponse({
    description:
      'The user’s 50 most recent ratings, newest first, themes joined in (public).',
  })
  ratings(@Param('username') username: string): Promise<UserRatingsResponse> {
    return this.users.getRatings(username);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  FollowState,
  FriendsActivityResponse,
  MarkNotificationsReadRequest,
  MarkNotificationsReadResponse,
  NetworkResponse,
  NotificationsResponse,
  UserActivityResponse,
  UserPublicProfile,
  UserSearchResponse,
  UserStats,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { SocialService } from './social.service';

/**
 * Slice S5 — social / network (see SocialService for the web port).
 *
 * Route map (web → here):
 *   GET    /api/users/[username]            → GET    /users/:username
 *   GET    /api/users/[username]/stats      → GET    /users/:username/stats
 *   GET    /api/users/[username]/network    → GET    /users/:username/network
 *     (the web's /friends route is a byte-identical duplicate of
 *      /network; only one endpoint exists here)
 *   GET    /api/users/[username]/activity   → GET    /users/:username/activity
 *   GET    /api/follow/[username]           → GET    /users/:username/follow
 *   POST   /api/follow/[username]           → POST   /users/:username/follow
 *   DELETE /api/follow/[username]           → DELETE /users/:username/follow
 *   GET    /api/social/friends-activity     → GET    /social/friends-activity
 *   GET    /api/search (USERS branch)       → GET    /social/users/search
 *   GET    /api/notifications               → GET    /notifications
 *   POST   /api/notifications (mark read)   → POST   /notifications/mark-read
 *
 * Profiles, stats, network lists and user search are public (the
 * web checks no session); follow writes and notifications sit
 * behind the Bearer guard; the follow-status check, the profile
 * activity and the friends feed take OPTIONAL auth exactly like
 * the web's session helpers (no/invalid session = anonymous, and
 * anonymous is a valid answer there, never a 401). When the API
 * is booted without MONGODB_URI the service answers 503; the
 * guard still rejects tokenless writes with 401 first.
 */
@ApiTags('social')
@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('users/:username')
  @ApiOkResponse({
    description:
      'Public profile by username (the web’s 9-field projection; 404 for unknown usernames).',
  })
  profile(@Param('username') username: string): Promise<UserPublicProfile> {
    return this.social.getProfile(username);
  }

  @Get('users/:username/stats')
  @ApiOkResponse({
    description: 'Public profile stats (followers / following / time / ratings).',
  })
  stats(@Param('username') username: string): Promise<UserStats> {
    return this.social.getStats(username);
  }

  @Get('users/:username/network')
  @ApiOkResponse({
    description:
      'Followers + following lists, fully populated, in the web’s unsorted, unpaginated order.',
  })
  network(@Param('username') username: string): Promise<NetworkResponse> {
    return this.social.getNetwork(username);
  }

  @Get('users/:username/activity')
  @ApiOkResponse({
    description:
      'The owner’s recent ratings + watches — only for the owner or an account the owner follows; everyone else gets an empty list.',
  })
  activity(
    @Param('username') username: string,
    @Headers('authorization') authorization?: string,
  ): Promise<UserActivityResponse> {
    return this.social.getUserActivity(authorization, username);
  }

  @Get('users/:username/follow')
  @ApiOkResponse({
    description:
      'Whether the caller follows this user. Anonymous callers always get isFollowing: false.',
  })
  followState(
    @Param('username') username: string,
    @Headers('authorization') authorization?: string,
  ): Promise<FollowState> {
    return this.social.getFollowState(authorization, username);
  }

  @Post('users/:username/follow')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Follow a user (idempotent). Applies the web’s counter increments and creates the follow notification.',
  })
  follow(
    @Req() req: { user: TokenPayload },
    @Param('username') username: string,
  ): Promise<FollowState> {
    return this.social.followUser(req.user.userId, username);
  }

  @Delete('users/:username/follow')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Unfollow a user (idempotent). Counters decrement only when a follow row existed.',
  })
  unfollow(
    @Req() req: { user: TokenPayload },
    @Param('username') username: string,
  ): Promise<FollowState> {
    return this.social.unfollowUser(req.user.userId, username);
  }

  @Get('social/friends-activity')
  @ApiOkResponse({
    description:
      'Recent watches + ratings by users the caller follows (default limit 3, max 50). Anonymous: empty feed.',
  })
  friendsActivity(
    @Headers('authorization') authorization?: string,
    @Query('limit') limit?: string,
  ): Promise<FriendsActivityResponse> {
    return this.social.getFriendsActivity(authorization, limit);
  }

  @Get('social/users/search')
  @ApiOkResponse({
    description:
      'Discover public accounts by username/display name (the USERS branch of the web search; min 2 characters, 20 per page).',
  })
  userSearch(
    @Query('q') q?: string,
    @Query('page') page?: string,
  ): Promise<UserSearchResponse> {
    return this.social.searchUsers(q, page);
  }

  @Get('notifications')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description: 'The caller’s 50 most recent notifications, newest first.',
  })
  notifications(
    @Req() req: { user: TokenPayload },
  ): Promise<NotificationsResponse> {
    return this.social.listNotifications(req.user.userId);
  }

  @Post('notifications/mark-read')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Mark notifications read: the given ids (own only), or all unread when no id list is sent.',
  })
  markRead(
    @Req() req: { user: TokenPayload },
    @Body() body: MarkNotificationsReadRequest,
  ): Promise<MarkNotificationsReadResponse> {
    return this.social.markNotificationsRead(
      req.user.userId,
      body?.notificationIds,
    );
  }
}

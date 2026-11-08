import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  CreateCommentRequest,
  ThemeComment,
  ThemeCommentsResponse,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { CommentsService } from './comments.service';

/**
 * Slice S3 — theme comments (see CommentsService for the web port).
 * The list is public (the web's GET checks no session); posting
 * sits behind the Bearer access-token guard. The web has no edit,
 * delete, reply or like routes for comments, so neither does this
 * controller. When the API is booted without MONGODB_URI the
 * service answers 503; the guard still rejects tokenless posts
 * with 401 first (it needs no DB).
 */
@ApiTags('comments')
@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('themes/:slug/comments')
  @ApiOkResponse({
    description:
      'A theme’s comments, newest first, capped at the 100 most recent (public).',
  })
  list(@Param('slug') slug: string): Promise<ThemeCommentsResponse> {
    return this.comments.listComments(slug);
  }

  @Post('themes/:slug/comments')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description: 'Post a comment on a theme (web: POST themes/[slug]/comments).',
  })
  create(
    @Req() req: { user: TokenPayload },
    @Param('slug') slug: string,
    @Body() body: CreateCommentRequest,
  ): Promise<ThemeComment> {
    return this.comments.createComment(req.user.userId, slug, body);
  }
}

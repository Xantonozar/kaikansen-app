import { Controller, Get, Headers, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { HistoryCheckResponse } from '@kaikansen/contracts';
import { AuthService } from '../auth/auth.service';
import { LibraryService } from './library.service';

/**
 * Slice S8 — GET /library/history/check (the web's
 * GET /api/history/check). Deliberately NOT behind the library
 * controller's Bearer guard and deliberately a separate
 * controller: the web route is OPTIONAL-auth — it resolves the
 * session when one is presented and answers `{ watched: false }`
 * for everyone else, never a 401. This controller resolves the
 * optional Bearer token the way the S5/S6 optional-auth routes do
 * (absent or invalid = anonymous) and hands the user id (or null)
 * to LibraryService.checkWatched, which preserves the web's
 * check order (session, then slug, then the exists query). When
 * the API is booted without MONGODB_URI the service answers 503.
 */
@ApiTags('library')
@Controller()
export class HistoryCheckController {
  constructor(
    private readonly library: LibraryService,
    private readonly auth: AuthService,
  ) {}

  @Get('library/history/check')
  @ApiOkResponse({
    description:
      'Whether the caller has watched the theme (anonymous callers: watched: false; a signed-in caller without ?slug gets the web’s 400).',
  })
  check(
    @Headers('authorization') authorization?: string,
    @Query('slug') slug?: string,
  ): Promise<HistoryCheckResponse> {
    return this.library.checkWatched(
      this.optionalUserId(authorization),
      slug,
    );
  }

  /**
   * The web's session helpers answer "no payload" for absent AND
   * invalid sessions alike; optional-auth endpoints mirror that
   * (the S5/S6 precedent).
   */
  private optionalUserId(authorization?: string): string | null {
    if (!authorization || !authorization.startsWith('Bearer ')) {
      return null;
    }
    const payload = this.auth.verifyAccessToken(
      authorization.slice('Bearer '.length),
    );
    return payload ? payload.userId : null;
  }
}

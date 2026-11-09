import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  AnilistEntriesResponse,
  FavoriteRequest,
  FavoriteState,
  FavoritesResponse,
  LibraryCountResponse,
  LibraryThemesResponse,
  RecordWatchRequest,
  RecordWatchResponse,
  SetRatingRequest,
  ThemeRatingState,
  WatchHistoryResponse,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { LibraryService } from './library.service';

/**
 * Slice S1 — the signed-in user's library: saved themes, watch history
 * and theme ratings (see LibraryService for the web ports). Every route
 * sits behind the Bearer access-token guard; when the API is booted
 * without MONGODB_URI the service answers 503 (the guard still rejects
 * tokenless requests with 401 first — it needs no database).
 */
@ApiTags('library')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller()
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('library/favorites')
  @ApiOkResponse({ description: 'The caller’s saved themes, paged.' })
  listFavorites(
    @Req() req: { user: TokenPayload },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ): Promise<FavoritesResponse> {
    const parsedPage = Number.parseInt(page ?? '', 10);
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    return this.library.listFavorites(
      req.user.userId,
      Number.isNaN(parsedPage) ? 1 : parsedPage,
      Number.isNaN(parsedLimit) ? 50 : parsedLimit,
      type,
    );
  }

  @Post('library/favorites')
  @HttpCode(200)
  @ApiOkResponse({
    description: 'Save a theme (idempotent — re-saving is a no-op success).',
  })
  addFavorite(
    @Req() req: { user: TokenPayload },
    @Body() body: FavoriteRequest,
  ): Promise<FavoriteState> {
    return this.library.addFavorite(req.user.userId, body);
  }

  @Get('library/favorites/:slug')
  @ApiOkResponse({ description: 'Whether the caller has saved this theme.' })
  favoriteState(
    @Req() req: { user: TokenPayload },
    @Param('slug') slug: string,
  ): Promise<FavoriteState> {
    return this.library.getFavoriteState(req.user.userId, slug);
  }

  @Delete('library/favorites/:slug')
  @ApiOkResponse({
    description: 'Unsave a theme (idempotent — unsaving twice succeeds).',
  })
  removeFavorite(
    @Req() req: { user: TokenPayload },
    @Param('slug') slug: string,
  ): Promise<FavoriteState> {
    return this.library.removeFavorite(req.user.userId, slug);
  }

  @Post('library/history')
  @HttpCode(200)
  @ApiOkResponse({
    description:
      'Record a watch/listen (moves the theme + user counters, web hook parity).',
  })
  recordWatch(
    @Req() req: { user: TokenPayload },
    @Body() body: RecordWatchRequest,
  ): Promise<RecordWatchResponse> {
    return this.library.recordWatch(req.user.userId, body);
  }

  @Get('library/history')
  @ApiOkResponse({
    description: 'The caller’s 50 most recent watch/listen events.',
  })
  listHistory(
    @Req() req: { user: TokenPayload },
  ): Promise<WatchHistoryResponse> {
    return this.library.listHistory(req.user.userId);
  }

  @Get('library/count')
  @ApiOkResponse({
    description:
      'How many themes with an audio source the caller’s library spans (watch history ∪ stored AniList completed ids — the web’s /api/user/library/count).',
  })
  libraryCount(
    @Req() req: { user: TokenPayload },
  ): Promise<LibraryCountResponse> {
    return this.library.getLibraryCount(req.user.userId);
  }

  @Get('library/themes')
  @ApiOkResponse({
    description:
      'The caller’s library themes, paged: watch history ∪ AniList completed (the web’s /api/themes/library, renamed onto this API’s /library prefix — the literal path would collide with GET /themes/:slug).',
  })
  libraryThemes(
    @Req() req: { user: TokenPayload },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ): Promise<LibraryThemesResponse> {
    const parsedPage = Number.parseInt(page ?? '', 10);
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    return this.library.listLibraryThemes(
      req.user.userId,
      Number.isNaN(parsedPage) ? 1 : parsedPage,
      Number.isNaN(parsedLimit) ? 50 : parsedLimit,
      type,
    );
  }

  @Get('library/anilist-entries')
  @ApiOkResponse({
    description:
      'The caller’s AniList Watching + Completed entries (progress, score, format, episodes) read from AniList with their stored token, grouped by status — the Library AniList segment’s entry list. Unlinked or unavailable degrades silently (linked/available flags), never an error.',
  })
  anilistEntries(
    @Req() req: { user: TokenPayload },
  ): Promise<AnilistEntriesResponse> {
    return this.library.getAnilistEntries(req.user.userId);
  }

  @Get('themes/:slug/rating')
  @ApiOkResponse({
    description: 'The caller’s rating for the theme + its aggregate.',
  })
  getRating(
    @Req() req: { user: TokenPayload },
    @Param('slug') slug: string,
  ): Promise<ThemeRatingState> {
    return this.library.getRatingState(req.user.userId, slug);
  }

  @Put('themes/:slug/rating')
  @ApiOkResponse({
    description:
      'Set (create or update) the caller’s 1–10 rating; theme aggregates follow the web hook.',
  })
  setRating(
    @Req() req: { user: TokenPayload },
    @Param('slug') slug: string,
    @Body() body: SetRatingRequest,
  ): Promise<ThemeRatingState> {
    return this.library.setRating(req.user.userId, slug, body);
  }

  @Delete('themes/:slug/rating')
  @ApiOkResponse({
    description:
      'Clear the caller’s rating (no web equivalent — aggregates are recomputed hook-faithfully).',
  })
  clearRating(
    @Req() req: { user: TokenPayload },
    @Param('slug') slug: string,
  ): Promise<ThemeRatingState> {
    return this.library.clearRating(req.user.userId, slug);
  }
}

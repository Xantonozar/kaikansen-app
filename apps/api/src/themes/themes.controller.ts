import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  AnimeDetailResponse,
  AnimeFranchiseResponse,
  ArtistDetailResponse,
  HomeResponse,
  RelatedAnimeResponse,
  SearchGroup,
  SearchResponse,
  SeasonResponse,
  SimilarThemesResponse,
  ThemeDetail,
} from '@kaikansen/contracts';
import { ThemesService } from './themes.service';

/**
 * Slice 1 read-path endpoints. All are reads against the shared production
 * catalogue; when the API runs without MONGODB_URI they answer 503 (see
 * ThemesService) while /health stays up.
 */
@ApiTags('themes')
@Controller()
export class ThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get('home')
  @ApiOkResponse({
    description:
      'Current-season rail + popular themes. When the current season has no themes yet, the rail falls back to the most recent earlier season that does, and `season` names the season actually served.',
  })
  home(): Promise<HomeResponse> {
    return this.themes.getHome();
  }

  @Get('season')
  @ApiOkResponse({
    description:
      'One season’s themes (the web’s /api/themes/seasonal port): ?season=SPRING&year=2026, optional ?type=OP|ED and ?page= (20 per page, sequence asc then avgRating desc). 400 when season/year are missing or invalid.',
  })
  season(
    @Query('season') season?: string,
    @Query('year') year?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
  ): Promise<SeasonResponse> {
    return this.themes.getSeasonThemes(season, year, type, page);
  }

  @Get('themes/:slug')
  @ApiOkResponse({ description: 'One theme by slug (404 when unknown).' })
  theme(@Param('slug') slug: string): Promise<ThemeDetail> {
    return this.themes.getThemeBySlug(slug);
  }

  @Get('search')
  @ApiOkResponse({
    description:
      'Catalogue search (Option B): themes/anime/artists match via MongoDB Search when its indexes are Active (searchType: atlas), else the web-parity two-stage regex (searchType: regex); the users group always uses the people search’s matching (public accounts, NetworkUser projection). ?group=all (default) is the preview — top 5 per group with per-group totals; group=themes|anime|artists|users serves that group’s full view, paginated at ?limit= (the app sends 15).',
  })
  search(
    @Query('q') q = '',
    @Query('page') page?: string,
    @Query('group') group?: string,
    @Query('limit') limit?: string,
  ): Promise<SearchResponse> {
    const parsed = Number.parseInt(page ?? '', 10);
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    return this.themes.search(
      q,
      Number.isNaN(parsed) ? 1 : parsed,
      (group ?? 'all') as SearchGroup,
      Number.isNaN(parsedLimit) ? undefined : parsedLimit,
    );
  }

  @Get('themes/:slug/similar')
  @ApiOkResponse({
    description:
      'Themes sharing this theme’s anime, artist, mood or first-entry tags (web order: totalRatings desc, avgRating desc; cap 20). 404 for an unknown slug.',
  })
  similar(@Param('slug') slug: string): Promise<SimilarThemesResponse> {
    return this.themes.getSimilarThemes(slug);
  }

  @Get('anime/:id/related')
  @ApiOkResponse({
    description:
      'Other anime in the same series as this AniList id (web order: seasonYear asc; cap 10). 404 for an unknown id.',
  })
  related(@Param('id') id: string): Promise<RelatedAnimeResponse> {
    return this.themes.getRelatedAnime(id);
  }

  @Get('anime/:id/franchise')
  @ApiOkResponse({
    description:
      'The anime’s whole franchise: every anime sharing a series name with this AniList id (itself included), grouped per anime in chronological order (seasonYear asc), each group carrying its themes in anime-page order (OP before ED, then sequence). Serves at most 25 groups / 200 themes; totalGroups/totalThemes count the full franchise and `truncated` flags a cap cut. 404 for an unknown id.',
  })
  franchise(@Param('id') id: string): Promise<AnimeFranchiseResponse> {
    return this.themes.getAnimeFranchise(id);
  }

  @Get('anime/:id')
  @ApiOkResponse({
    description:
      'One anime’s detail: metadata header (AnimeCache, synthesized from its first theme when uncached) plus all of its themes. 404 when the id has neither a cache document nor any theme.',
  })
  animeDetail(@Param('id') id: string): Promise<AnimeDetailResponse> {
    return this.themes.getAnimeDetail(id);
  }

  @Get('artists/:slug')
  @ApiOkResponse({
    description:
      'One artist’s detail: header (ArtistCache, synthesized from the first matching theme when uncached) plus all themes carrying the artist slug. 404 when the slug has neither.',
  })
  artistDetail(@Param('slug') slug: string): Promise<ArtistDetailResponse> {
    return this.themes.getArtistDetail(slug);
  }
}

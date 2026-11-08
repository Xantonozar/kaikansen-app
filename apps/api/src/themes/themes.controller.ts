import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  AnimeDetailResponse,
  ArtistDetailResponse,
  HomeResponse,
  RelatedAnimeResponse,
  SearchResponse,
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

  @Get('themes/:slug')
  @ApiOkResponse({ description: 'One theme by slug (404 when unknown).' })
  theme(@Param('slug') slug: string): Promise<ThemeDetail> {
    return this.themes.getThemeBySlug(slug);
  }

  @Get('search')
  @ApiOkResponse({
    description: 'Two-stage regex theme search (web parity, searchType: regex).',
  })
  search(
    @Query('q') q = '',
    @Query('page') page?: string,
  ): Promise<SearchResponse> {
    const parsed = Number.parseInt(page ?? '', 10);
    return this.themes.search(q, Number.isNaN(parsed) ? 1 : parsed);
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

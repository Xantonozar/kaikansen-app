import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type {
  AddPlaylistItemRequest,
  CreatePlaylistRequest,
  PlaylistDeletedResponse,
  PlaylistDetail,
  PlaylistsResponse,
  UpdatePlaylistRequest,
} from '@kaikansen/contracts';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { TokenPayload } from '../auth/auth.service';
import { PlaylistsService } from './playlists.service';

/**
 * Slice S2 — playlists (see PlaylistsService for the web ports).
 * Every route except the two public reads sits behind the
 * Bearer access-token guard: the single-playlist read is public
 * because the web's GET /api/playlists/[id] is public (it checks
 * neither the session nor isPublic — mirrored and flagged in the
 * service), and the per-user listing GET /users/:username/playlists
 * is public like the profile read it feeds (it serves PUBLIC
 * playlists only — see the service). When the API is booted
 * without MONGODB_URI the service answers 503; the guard still
 * rejects tokenless writes with 401 first (it needs no DB).
 */
@ApiTags('playlists')
@Controller()
export class PlaylistsController {
  constructor(private readonly playlists: PlaylistsService) {}

  @Post('playlists')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({ description: 'Create a playlist (web: POST /playlists).' })
  create(
    @Req() req: { user: TokenPayload },
    @Body() body: CreatePlaylistRequest,
  ): Promise<PlaylistDetail> {
    return this.playlists.createPlaylist(req.user.userId, body);
  }

  @Get('playlists')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description: 'The caller’s playlists, most recently updated first.',
  })
  listMine(@Req() req: { user: TokenPayload }): Promise<PlaylistsResponse> {
    return this.playlists.listMyPlaylists(req.user.userId);
  }

  @Get('users/:username/playlists')
  @ApiOkResponse({
    description:
      'The named user’s PUBLIC playlists for their profile, most recently updated first. Public like the profile read; private playlists are never listed. Unknown username 404s.',
  })
  listUserPublic(
    @Param('username') username: string,
  ): Promise<PlaylistsResponse> {
    return this.playlists.listUserPublicPlaylists(username);
  }

  @Get('playlists/:id')
  @ApiOkResponse({
    description:
      'Read one playlist with items resolved — public, mirroring the web (no auth, no isPublic check there).',
  })
  getOne(@Param('id') id: string): Promise<PlaylistDetail> {
    return this.playlists.getPlaylist(id);
  }

  @Patch('playlists/:id')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description: 'Edit playlist metadata (owner only; others get a 404).',
  })
  update(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
    @Body() body: UpdatePlaylistRequest,
  ): Promise<PlaylistDetail> {
    return this.playlists.updatePlaylist(req.user.userId, id, body);
  }

  @Delete('playlists/:id')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description: 'Delete a playlist (owner only; others get a 404).',
  })
  remove(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
  ): Promise<PlaylistDeletedResponse> {
    return this.playlists.deletePlaylist(req.user.userId, id);
  }

  @Post('playlists/:id/items')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Add a theme by slug (owner only; already-stored is a success no-op, as on the web).',
  })
  addItem(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
    @Body() body: AddPlaylistItemRequest,
  ): Promise<PlaylistDetail> {
    return this.playlists.addItem(req.user.userId, id, body);
  }

  @Delete('playlists/:id/items/:slug')
  @ApiBearerAuth()
  @UseGuards(AccessTokenGuard)
  @ApiOkResponse({
    description:
      'Remove a theme by slug (owner only; not-stored is a success no-op, as on the web).',
  })
  removeItem(
    @Req() req: { user: TokenPayload },
    @Param('id') id: string,
    @Param('slug') slug: string,
  ): Promise<PlaylistDetail> {
    return this.playlists.removeItem(req.user.userId, id, slug);
  }
}

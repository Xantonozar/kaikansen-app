import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type {
  AddPlaylistItemRequest,
  CreatePlaylistRequest,
  PlaylistDeletedResponse,
  PlaylistDetail,
  PlaylistSummary,
  PlaylistsResponse,
  UpdatePlaylistRequest,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { toThemeSummary, type ThemeDoc } from '../themes/theme.mapper';
import { Playlist, type PlaylistDocument } from './playlist.schema';
import {
  PlaylistActivity,
  type PlaylistActivityDocument,
} from './playlist-activity.schema';

/** The web schema's caps (lib/models/index.ts Playlist). */
const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 300;

/** Lean shape of a playlists document as it comes back from Mongoose. */
type PlaylistDoc = Playlist & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

interface PlaylistModels {
  playlists: Model<PlaylistDocument>;
  themes: Model<ThemeCacheDocument>;
}

function iso(value: Date | string | null | undefined): string {
  if (value == null) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Playlists (Slice S2): create / list / read / edit / delete named
 * theme lists over the shared production `playlists` collection.
 *
 * A port of the web's `app/api/playlists/route.ts` and
 * `app/api/playlists/[id]/route.ts`, semantics for semantics:
 *
 * - Storage is the web's ordered `themes` ObjectId array on the
 *   playlist document — insertion order is the playlist order, and
 *   its length is the item count. The web model has NO hooks and no
 *   per-user totals exist anywhere, so there are no counters to
 *   maintain beyond the array itself.
 * - Owner operations (edit / delete / add / remove) are scoped by
 *   { _id, userId } exactly like the web: a playlist that is not
 *   yours answers the same 404 as one that does not exist
 *   ('Playlist not found or access denied').
 * - Adding a theme that is already stored is a success no-op (the
 *   web answers 200 'Theme already in playlist'); removing one that
 *   is not stored is likewise a no-op success (the web's filter).
 * - Reorder: THE WEB HAS NO REORDER OPERATION — no endpoint, no
 *   action — so this API has none either; order changes only by
 *   remove + re-add, exactly as on the web.
 *
 * Two deliberate tightenings, both following the Slice S1 precedent
 * (the library service's slug resolution):
 * - Items are addressed by theme SLUG and resolved against the
 *   catalogue; an unknown slug is a 404 (`Theme not found: <slug>`).
 *   The web trusts the client's ObjectId blindly (a dangling id is
 *   stored and silently dropped again by its own populate).
 * - Inputs the web lets die as Mongoose 500s (missing/blank name,
 *   over-length fields, malformed playlist ids) are clean 400/404s
 *   here. The state written to the shared DB is unaffected.
 *
 * The models are OPTIONAL like everywhere else in this API: booted
 * without MONGODB_URI, every method answers 503 while /health works.
 *
 * Owner identity (Slice 3 data gap): the detail additionally
 * resolves the owner's displayName + username from the user
 * document — the design's header reads "by <owner>", and the
 * payload previously carried only the owner's id. Only the two
 * public fields the profile endpoint projects are read; the
 * resolution is best-effort decoration (a deleted owner, or no
 * user model, yields nulls — the playlist read never fails over
 * it), so the User model is NOT part of requireModels.
 */
@Injectable()
export class PlaylistsService {
  constructor(
    @Optional()
    @InjectModel(Playlist.name)
    private readonly playlistModel?: Model<PlaylistDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    /**
     * Playlist-add activity records (the friends-activity feed's
     * 'playlist_add' events). Written best-effort at add time —
     * kept out of requireModels on purpose: the record is a feed
     * side effect, and playlist behaviour must not depend on it.
     */
    @Optional()
    @InjectModel(PlaylistActivity.name)
    private readonly playlistActivityModel?: Model<PlaylistActivityDocument>,
  ) {}

  private requireModels(): PlaylistModels {
    if (!this.playlistModel || !this.themeModel) {
      throw new ServiceUnavailableException(
        'Playlists unavailable — API booted without MONGODB_URI',
      );
    }
    return { playlists: this.playlistModel, themes: this.themeModel };
  }

  /* ---------------------------------------------------------------- */
  /* Validation — the web's POST check + its schema caps.              */
  /* ---------------------------------------------------------------- */

  private validateName(name: unknown): string {
    // The web's POST: `if (!name)` → 400 'Name is required'. A
    // whitespace-only name slips past that check there and then dies
    // in Mongoose (trim → '' → required) as a 500; it is the same 400
    // here.
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new BadRequestException('Name is required');
    }
    if (name.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(
        `Name must be at most ${NAME_MAX_LENGTH} characters`,
      );
    }
    return name;
  }

  private validateDescription(description: unknown): string {
    if (typeof description !== 'string') {
      throw new BadRequestException('Description must be a string');
    }
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(
        `Description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
      );
    }
    return description;
  }

  /* ---------------------------------------------------------------- */
  /* Lookups                                                           */
  /* ---------------------------------------------------------------- */

  /** Theme lookup by slug — this API's 404 convention (Slice S1). */
  private async findThemeOr404(
    models: PlaylistModels,
    slug: string,
  ): Promise<ThemeCacheDocument> {
    const theme = await models.themes.findOne({ slug }).exec();
    if (!theme) {
      throw new NotFoundException(`Theme not found: ${slug}`);
    }
    return theme;
  }

  /**
   * Owner-scoped lookup for the write operations. The web folds
   * "not yours" and "does not exist" into one 404 ('Playlist not
   * found or access denied'); a malformed id folds in too (the web
   * CastErrors it to a 500).
   */
  private async findOwnedOr404(
    models: PlaylistModels,
    userId: string,
    id: string,
  ): Promise<PlaylistDoc> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Playlist not found or access denied');
    }
    const doc = await models.playlists
      .findOne({ _id: id, userId })
      .lean()
      .exec();
    if (!doc) {
      throw new NotFoundException('Playlist not found or access denied');
    }
    return doc as PlaylistDoc;
  }

  /** Resolve stored theme ids to documents, keyed by string id. */
  private async resolveThemes(
    models: PlaylistModels,
    ids: unknown[],
  ): Promise<Map<string, ThemeDoc>> {
    if (ids.length === 0) {
      return new Map();
    }
    const filter: Record<string, unknown> = { _id: { $in: ids } };
    const docs = await models.themes.find(filter).lean().exec();
    return new Map(
      (docs as ThemeDoc[]).map((t) => [String(t._id), t]),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Projections                                                       */
  /* ---------------------------------------------------------------- */

  private toSummary(
    doc: PlaylistDoc,
    themesById: Map<string, ThemeDoc>,
  ): PlaylistSummary {
    const ids = (doc.themes ?? []).map((t) => String(t));
    const first = ids
      .map((id) => themesById.get(id))
      .find((t) => t !== undefined);
    const firstSummary = first ? toThemeSummary(first) : null;
    return {
      id: String(doc._id),
      name: doc.name,
      description: doc.description ?? '',
      isPublic: doc.isPublic ?? true,
      themeCount: ids.length,
      coverImage: firstSummary
        ? (firstSummary.animeCoverImage ??
          firstSummary.animeCoverImageSmall)
        : null,
      createdAt: iso(doc.createdAt),
      updatedAt: iso(doc.updatedAt),
    };
  }

  private toDetail(
    doc: PlaylistDoc,
    themesById: Map<string, ThemeDoc>,
    owner: { displayName: string | null; username: string | null },
  ): PlaylistDetail {
    const ids = (doc.themes ?? []).map((t) => String(t));
    return {
      ...this.toSummary(doc, themesById),
      userId: String(doc.userId),
      ownerDisplayName: owner.displayName,
      ownerUsername: owner.username,
      // Stored order; dangling ids drop out, like the web's populate.
      items: ids
        .map((id) => themesById.get(id))
        .filter((t): t is ThemeDoc => t !== undefined)
        .map(toThemeSummary),
    };
  }

  /**
   * The owner's public identity (displayName + username — the
   * profile endpoint's projection discipline, nothing private).
   * Best-effort: no user model, an unresolvable id or a deleted
   * owner all yield nulls rather than failing the playlist read.
   */
  private async resolveOwner(
    userId: unknown,
  ): Promise<{ displayName: string | null; username: string | null }> {
    const none = { displayName: null, username: null };
    if (!this.userModel) {
      return none;
    }
    try {
      const doc = await this.userModel.findById(String(userId)).lean().exec();
      if (!doc) {
        return none;
      }
      const user = doc as { displayName?: string; username?: string };
      return {
        displayName: user.displayName ?? null,
        username: user.username ?? null,
      };
    } catch {
      // A malformed stored id CastErrors in Mongoose — decoration
      // must never take the read down with it.
      return none;
    }
  }

  private async detailFor(
    models: PlaylistModels,
    doc: PlaylistDoc,
  ): Promise<PlaylistDetail> {
    const themesById = await this.resolveThemes(models, doc.themes ?? []);
    const owner = await this.resolveOwner(doc.userId);
    return this.toDetail(doc, themesById, owner);
  }

  /** Re-read a playlist after a write and serve its detail. */
  private async freshDetail(
    models: PlaylistModels,
    id: string,
  ): Promise<PlaylistDetail> {
    const doc = await models.playlists.findById(id).lean().exec();
    if (!doc) {
      throw new NotFoundException('Playlist not found');
    }
    return this.detailFor(models, doc as PlaylistDoc);
  }

  /* ---------------------------------------------------------------- */
  /* Endpoints                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * POST /playlists — the web's POST: create with an empty item
   * list; isPublic defaults to true when not sent.
   */
  async createPlaylist(
    userId: string,
    dto: CreatePlaylistRequest,
  ): Promise<PlaylistDetail> {
    const models = this.requireModels();
    const body = dto ?? ({} as CreatePlaylistRequest);
    const name = this.validateName(body.name);
    const description =
      body.description === undefined
        ? ''
        : this.validateDescription(body.description);

    const created = await models.playlists.create({
      userId,
      name,
      description,
      isPublic: body.isPublic !== undefined ? Boolean(body.isPublic) : true,
      themes: [],
    });
    return this.detailFor(models, created as unknown as PlaylistDoc);
  }

  /**
   * GET /playlists — the web's GET: the caller's playlists, most
   * recently updated first.
   */
  async listMyPlaylists(userId: string): Promise<PlaylistsResponse> {
    const models = this.requireModels();
    const docs = (await models.playlists
      .find({ userId })
      .sort({ updatedAt: -1 })
      .lean()
      .exec()) as PlaylistDoc[];

    const allIds = docs.flatMap((d) => d.themes ?? []);
    const themesById = await this.resolveThemes(models, allIds);
    return {
      playlists: docs.map((d) => this.toSummary(d, themesById)),
    };
  }

  /**
   * GET /playlists/:id — the web's GET, mirrored INCLUDING its
   * visibility quirk: the web route performs no auth and no
   * isPublic check (its own comment floats private-playlist auth
   * but never implements it), so ANY playlist — public or private —
   * is readable by anyone who knows its id. Mirrored deliberately
   * per the parity rule; flagged in the slice report. Not found
   * (or a malformed id) is the web's 404 'Playlist not found'.
   */
  async getPlaylist(id: string): Promise<PlaylistDetail> {
    const models = this.requireModels();
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Playlist not found');
    }
    const doc = await models.playlists.findById(id).lean().exec();
    if (!doc) {
      throw new NotFoundException('Playlist not found');
    }
    return this.detailFor(models, doc as PlaylistDoc);
  }

  /**
   * PATCH /playlists/:id — the web PATCH's metadata branch (owner
   * only): fields sent replace, fields omitted keep their values.
   */
  async updatePlaylist(
    userId: string,
    id: string,
    dto: UpdatePlaylistRequest,
  ): Promise<PlaylistDetail> {
    const models = this.requireModels();
    await this.findOwnedOr404(models, userId, id);

    const body = dto ?? ({} as UpdatePlaylistRequest);
    const set: Record<string, unknown> = {};
    if (body.name !== undefined) {
      set.name = this.validateName(body.name);
    }
    if (body.description !== undefined) {
      set.description = this.validateDescription(body.description);
    }
    if (body.isPublic !== undefined) {
      set.isPublic = Boolean(body.isPublic);
    }

    // A content-free PATCH writes nothing (the web's save() would
    // still bump updatedAt; an empty $set is not a valid update, and
    // the difference is unobservable outside list ordering).
    if (Object.keys(set).length > 0) {
      await models.playlists
        .findOneAndUpdate({ _id: id, userId }, { $set: set }, { new: true })
        .exec();
    }
    return this.freshDetail(models, id);
  }

  /**
   * DELETE /playlists/:id — the web's DELETE (owner only): a miss
   * on the owner-scoped delete is the same folded 404.
   */
  async deletePlaylist(
    userId: string,
    id: string,
  ): Promise<PlaylistDeletedResponse> {
    const models = this.requireModels();
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Playlist not found or access denied');
    }
    const result = await models.playlists
      .deleteOne({ _id: id, userId })
      .exec();
    if (!result || result.deletedCount === 0) {
      throw new NotFoundException('Playlist not found or access denied');
    }
    return { id, deleted: true };
  }

  /**
   * POST /playlists/:id/items — the web PATCH's 'add' action (owner
   * only), with the slug resolution noted in the class doc. A theme
   * already stored is a success no-op returning the current detail
   * (the web: 200 + 'Theme already in playlist', nothing written).
   *
   * A REAL add additionally records a PlaylistActivity row — the
   * friends-activity feed's 'playlist_add' event. The web records
   * nothing (its themes array carries no per-item timestamp), so
   * this is an API-side addition with no backfill: events exist
   * only from adds made here. The no-op path records nothing (no
   * add happened); a remove + re-add records a fresh event. The
   * record is best-effort, the follow-notification precedent: the
   * add stands even if the write fails.
   */
  async addItem(
    userId: string,
    id: string,
    dto: AddPlaylistItemRequest,
  ): Promise<PlaylistDetail> {
    const models = this.requireModels();
    const slug = dto?.slug;
    if (!slug) {
      throw new BadRequestException('slug is required');
    }
    const playlist = await this.findOwnedOr404(models, userId, id);
    const theme = await this.findThemeOr404(models, slug);

    const stored = (playlist.themes ?? []).map((t) => String(t));
    if (stored.includes(String(theme._id))) {
      return this.detailFor(models, playlist);
    }

    await models.playlists
      .findOneAndUpdate(
        { _id: id, userId },
        { $push: { themes: theme._id } },
        { new: true },
      )
      .exec();
    await this.recordPlaylistAdd(userId, playlist, theme);
    return this.freshDetail(models, id);
  }

  /** The add-time activity record (see addItem). */
  private async recordPlaylistAdd(
    userId: string,
    playlist: PlaylistDoc,
    theme: ThemeCacheDocument,
  ): Promise<void> {
    if (!this.playlistActivityModel) {
      return;
    }
    try {
      await this.playlistActivityModel.create({
        userId,
        playlistId: playlist._id as Types.ObjectId,
        playlistName: playlist.name,
        themeId: theme._id,
        themeSlug: theme.slug,
      });
    } catch (err) {
      // The add itself already succeeded — the feed record must
      // not take it down (the follow-notification precedent).
      console.error('Failed to record playlist-add activity:', err);
    }
  }

  /**
   * DELETE /playlists/:id/items/:slug — the web PATCH's 'remove'
   * action (owner only): filtering a theme that is not stored is a
   * no-op success, exactly like the web's array filter.
   */
  async removeItem(
    userId: string,
    id: string,
    slug: string,
  ): Promise<PlaylistDetail> {
    const models = this.requireModels();
    const playlist = await this.findOwnedOr404(models, userId, id);
    const theme = await this.findThemeOr404(models, slug);

    const stored = (playlist.themes ?? []).map((t) => String(t));
    if (!stored.includes(String(theme._id))) {
      return this.detailFor(models, playlist);
    }

    await models.playlists
      .findOneAndUpdate(
        { _id: id, userId },
        { $pull: { themes: theme._id } },
        { new: true },
      )
      .exec();
    return this.freshDetail(models, id);
  }
}

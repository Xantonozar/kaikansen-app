import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type {
  CommentAuthor,
  CreateCommentRequest,
  ThemeComment,
  ThemeCommentsResponse,
} from '@kaikansen/contracts';
import { User, type UserDocument } from '../auth/user.schema';
import {
  ThemeCache,
  type ThemeCacheDocument,
} from '../themes/theme-cache.schema';
import { FollowerActivityService } from '../social/follower-activity.service';
import { Comment, type CommentDocument } from './comment.schema';

/** The web schema's cap (lib/models/index.ts Comment). */
const CONTENT_MAX_LENGTH = 1000;

/**
 * Comments paging (fix batch 2026-11-11 — owner-ordered load
 * more, replacing the web's silent 100 cap): default page size
 * 50, hard cap 100 (a `limit=100` no-page call reproduces the
 * web's exact old single-shot answer).
 */
const COMMENTS_DEFAULT_LIMIT = 50;
const COMMENTS_MAX_LIMIT = 100;

/** 1-based page parsing in the codebase idiom: garbage → 1. */
function parseCommentsPage(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

/** Page-size parsing: garbage → the default, capped at the max. */
function parseCommentsLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed) || parsed < 1) return COMMENTS_DEFAULT_LIMIT;
  return Math.min(parsed, COMMENTS_MAX_LIMIT);
}

/** Lean shapes of the documents as they come back from Mongoose. */
type CommentDoc = Comment & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

type UserDoc = Pick<User, 'username' | 'displayName' | 'avatarUrl'> & {
  _id: unknown;
};

interface CommentModels {
  comments: Model<CommentDocument>;
  themes: Model<ThemeCacheDocument>;
  users: Model<UserDocument>;
}

function iso(value: Date | string | null | undefined): string {
  if (value == null) return '';
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Theme comments (Slice S3): list and post over the shared
 * production `comments` collection.
 *
 * A port of the web's `app/api/themes/[slug]/comments/route.ts`,
 * semantics for semantics:
 *
 * - The web's ENTIRE comment surface is these two operations. The
 *   model has no parent field, so there are no replies/threading;
 *   there are no likes, no edit and no delete routes anywhere on
 *   the web, and no hooks or counters (no comment total is kept on
 *   the theme or the user). This API therefore has exactly the same
 *   surface — nothing was added and there are no counters to
 *   maintain. (The web creates no 'comment' notification — the
 *   enum type is dead vocabulary there. This API DOES create
 *   them, as an owner-approved divergence: posting a comment
 *   notifies the commenter's followers — see
 *   FollowerActivityService and createComment below.)
 * - List: public, newest first (createdAt desc), hard-capped at
 *   the 100 most recent — the web takes no pagination parameters.
 *   Each comment's author is the web populate's projection
 *   (username, displayName, avatarUrl); a comment whose author
 *   account is gone serves author null, like the web's populate.
 *   FIX BATCH 2026-11-11 (owner order): the silent cap becomes
 *   honest paging on THIS API — page/limit + total/hasMore meta
 *   (see listComments). The website is untouched (its own route
 *   keeps the cap); on this API a limit=100 call still answers
 *   exactly the web's old 100.
 * - Post: authenticated; the web's validation verbatim — content
 *   must be a non-blank string ('Comment content is required') and
 *   at most 1000 characters ('Comment is too long (max 1000
 *   chars)'), the length measured on the UNTRIMMED string, which
 *   is then stored trimmed.
 *
 * Mirrored quirks, deliberately kept:
 * - The list query filters by themeSlug even though the model's
 *   compound index leads with themeId — that is the web's query.
 *
 * One deliberate tightening, following the Slice S1/S2 existence-
 * check precedent:
 * - The web's GET never checks the theme exists (an unknown slug
 *   answers an empty list). Here BOTH operations resolve the slug
 *   first and answer this API's 404 convention (`Theme not found:
 *   <slug>`); the web's own POST already 404s unknown themes.
 *
 * The models are OPTIONAL like everywhere else in this API: booted
 * without MONGODB_URI, every method answers 503 while /health
 * works.
 */
@Injectable()
export class CommentsService {
  constructor(
    @Optional()
    @InjectModel(Comment.name)
    private readonly commentModel?: Model<CommentDocument>,
    @Optional()
    @InjectModel(ThemeCache.name)
    private readonly themeModel?: Model<ThemeCacheDocument>,
    @Optional()
    @InjectModel(User.name)
    private readonly userModel?: Model<UserDocument>,
    /**
     * The follower-activity notification fan-out (owner-approved
     * divergence — see FollowerActivityService). Optional so
     * model-only constructions (unit specs) keep working: without
     * it, comments simply notify nobody, which is also the
     * website's behaviour.
     */
    @Optional()
    private readonly followerActivity?: FollowerActivityService,
  ) {}

  private requireModels(): CommentModels {
    if (!this.commentModel || !this.themeModel || !this.userModel) {
      throw new ServiceUnavailableException(
        'Comments unavailable — API booted without MONGODB_URI',
      );
    }
    return {
      comments: this.commentModel,
      themes: this.themeModel,
      users: this.userModel,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Validation — the web's POST checks, verbatim.                     */
  /* ---------------------------------------------------------------- */

  private validateContent(content: unknown): string {
    if (
      typeof content !== 'string' ||
      content.trim().length === 0
    ) {
      throw new BadRequestException('Comment content is required');
    }
    // The web measures the untrimmed string; a comment that only
    // fits after trimming is still too long there. Mirrored.
    if (content.length > CONTENT_MAX_LENGTH) {
      throw new BadRequestException(
        `Comment is too long (max ${CONTENT_MAX_LENGTH} chars)`,
      );
    }
    return content.trim();
  }

  /* ---------------------------------------------------------------- */
  /* Lookups                                                           */
  /* ---------------------------------------------------------------- */

  /** Theme lookup by slug — this API's 404 convention (Slice S1). */
  private async findThemeOr404(
    models: CommentModels,
    slug: string,
  ): Promise<ThemeCacheDocument> {
    const theme = await models.themes.findOne({ slug }).exec();
    if (!theme) {
      throw new NotFoundException(`Theme not found: ${slug}`);
    }
    return theme;
  }

  /**
   * Batch-resolve comment authors (the web populate's projection:
   * username, displayName, avatarUrl), keyed by string user id.
   * Ids with no user document are simply absent from the map.
   */
  private async resolveAuthors(
    models: CommentModels,
    userIds: unknown[],
  ): Promise<Map<string, CommentAuthor>> {
    const unique = [...new Set(userIds.map((id) => String(id)))];
    if (unique.length === 0) {
      return new Map();
    }
    const filter: Record<string, unknown> = { _id: { $in: unique } };
    const docs = (await models.users
      .find(filter)
      .lean()
      .exec()) as UserDoc[];
    return new Map(
      docs.map((u) => [
        String(u._id),
        {
          id: String(u._id),
          username: u.username,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl ?? null,
        },
      ]),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Projections                                                       */
  /* ---------------------------------------------------------------- */

  private toComment(
    doc: CommentDoc,
    authorsById: Map<string, CommentAuthor>,
  ): ThemeComment {
    return {
      id: String(doc._id),
      themeSlug: doc.themeSlug,
      content: doc.content,
      // The web's populate replaces userId and yields null when
      // the author account no longer exists; mirrored.
      author: authorsById.get(String(doc.userId)) ?? null,
      createdAt: iso(doc.createdAt),
      updatedAt: iso(doc.updatedAt),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Endpoints                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * GET /themes/:slug/comments — the web's GET (newest first),
   * paged (fix batch 2026-11-11): `page`/`limit` query params in
   * the Network-pagination idiom, page size defaulting to 50 and
   * capping at 100, with `total`/`hasMore` meta. The sort gains
   * an `_id` tie-break so the order is TOTAL and stable across
   * pages (no dupes/gaps when two comments share a createdAt
   * millisecond); distinct timestamps order exactly as before.
   * Public.
   */
  async listComments(
    slug: string,
    paging: { page?: string; limit?: string } = {},
  ): Promise<ThemeCommentsResponse> {
    const models = this.requireModels();
    await this.findThemeOr404(models, slug);

    const page = parseCommentsPage(paging.page);
    const limit = parseCommentsLimit(paging.limit);
    const filter = { themeSlug: slug };

    const [total, docs] = await Promise.all([
      models.comments.countDocuments(filter).exec(),
      models.comments
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
    ]);

    const authorsById = await this.resolveAuthors(
      models,
      (docs as CommentDoc[]).map((d) => d.userId),
    );
    return {
      comments: (docs as CommentDoc[]).map((d) =>
        this.toComment(d, authorsById),
      ),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    };
  }

  /**
   * POST /themes/:slug/comments — the web's POST: validate (the
   * web checks content before it looks the theme up), create with
   * the trimmed content, answer the created comment with its
   * author resolved — the web re-reads it populated.
   */
  async createComment(
    userId: string,
    slug: string,
    dto: CreateCommentRequest,
  ): Promise<ThemeComment> {
    const models = this.requireModels();
    const content = this.validateContent(dto?.content);
    const theme = await this.findThemeOr404(models, slug);

    const created = await models.comments.create({
      userId,
      themeId: theme._id,
      themeSlug: slug,
      content,
    });
    // Owner-approved divergence (the web creates no such
    // notification): a new comment notifies the commenter's
    // followers. The fan-out never throws, so the comment stands
    // even if the notification write fails.
    await this.followerActivity?.notifyFollowers({
      actorId: userId,
      type: 'comment',
      entityId: theme._id,
      entityMeta: { themeTitle: theme.songTitle },
    });
    const authorsById = await this.resolveAuthors(models, [
      created.userId,
    ]);
    return this.toComment(
      created as unknown as CommentDoc,
      authorsById,
    );
  }
}

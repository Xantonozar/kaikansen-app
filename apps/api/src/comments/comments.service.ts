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
import { Comment, type CommentDocument } from './comment.schema';

/** The web schema's cap (lib/models/index.ts Comment). */
const CONTENT_MAX_LENGTH = 1000;

/** The web's list cap: GET returns at most the 100 newest comments. */
const LIST_LIMIT = 100;

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
 *   maintain. (The web's Notification type enum lists a 'comment'
 *   type and its notifications page renders one, but no code path
 *   ever creates such a notification — dead vocabulary, not
 *   behaviour; not ported.)
 * - List: public, newest first (createdAt desc), hard-capped at
 *   the 100 most recent — the web takes no pagination parameters.
 *   Each comment's author is the web populate's projection
 *   (username, displayName, avatarUrl); a comment whose author
 *   account is gone serves author null, like the web's populate.
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
   * GET /themes/:slug/comments — the web's GET: the theme's
   * comments, newest first, capped at the 100 most recent. Public.
   */
  async listComments(slug: string): Promise<ThemeCommentsResponse> {
    const models = this.requireModels();
    await this.findThemeOr404(models, slug);

    const docs = (await models.comments
      .find({ themeSlug: slug })
      .sort({ createdAt: -1 })
      .limit(LIST_LIMIT)
      .lean()
      .exec()) as CommentDoc[];

    const authorsById = await this.resolveAuthors(
      models,
      docs.map((d) => d.userId),
    );
    return {
      comments: docs.map((d) => this.toComment(d, authorsById)),
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
    const authorsById = await this.resolveAuthors(models, [
      created.userId,
    ]);
    return this.toComment(
      created as unknown as CommentDoc,
      authorsById,
    );
  }
}

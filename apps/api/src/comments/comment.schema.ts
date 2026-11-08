import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `comments` collection — a user's text comment
 * on a theme.
 *
 * Field-for-field port of the web app's Comment schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { userId, themeId,
 * themeSlug, content } + timestamps. The web model carries NO parent
 * field (so no replies/threading), NO likes array or like count, NO
 * edited/deleted flags, and NO middleware hooks — and nothing
 * anywhere keeps a comment counter on the theme or the user, so
 * this port has no counters to maintain either.
 *
 * The web's index set is { themeId: 1, createdAt: -1 } and
 * { userId: 1 }. `autoIndex: false` as everywhere in this API: the
 * shared production collection already carries them. (Noted for the
 * record: the web's list query filters by themeSlug, not by the
 * indexed themeId — mirrored in the service, as the web does it.)
 */

export type CommentDocument = HydratedDocument<Comment>;

@Schema({ collection: 'comments', timestamps: true, autoIndex: false })
export class Comment {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ThemeCache',
    required: true,
  })
  themeId: Types.ObjectId;

  @Prop({ type: String, required: true })
  themeSlug: string;

  @Prop({ type: String, required: true, maxlength: 1000 })
  content: string;
}

export const CommentSchema = SchemaFactory.createForClass(Comment);

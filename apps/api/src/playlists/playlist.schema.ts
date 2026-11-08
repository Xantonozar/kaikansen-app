import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the shared `playlists` collection — a user's named,
 * ordered list of themes.
 *
 * Field-for-field port of the web app's Playlist schema
 * (ZadidSalman/Kaisen `lib/models/index.ts`): { userId, name,
 * description, themes, isPublic } + timestamps, with an index on
 * userId in the web's index set. `themes` is an ordered array of
 * ThemeCache ObjectIds — insertion order IS the playlist order; the
 * web has no reorder operation.
 *
 * The web model carries NO middleware hooks and nothing anywhere
 * keeps a per-user playlist total, so this port has no counters to
 * maintain either: the themes array itself is the only state (its
 * length is the item count). `autoIndex: false` as everywhere in
 * this API: the shared production collection already carries the
 * web's indexes.
 */

export type PlaylistDocument = HydratedDocument<Playlist>;

@Schema({ collection: 'playlists', timestamps: true, autoIndex: false })
export class Playlist {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 100 })
  name: string;

  @Prop({ type: String, default: '', maxlength: 300 })
  description: string;

  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'ThemeCache' }],
    default: [],
  })
  themes: Types.ObjectId[];

  @Prop({ type: Boolean, default: true })
  isPublic: boolean;
}

export const PlaylistSchema = SchemaFactory.createForClass(Playlist);

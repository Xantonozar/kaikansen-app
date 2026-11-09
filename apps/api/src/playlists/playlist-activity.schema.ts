import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Model for the `playlistactivities` collection — one row per
 * theme-added-to-playlist event, written by PlaylistsService at
 * add time and read ONLY by the friends-activity feed
 * (SocialService) as its 'playlist_add' event kind.
 *
 * This collection is NEW — it is not a port of anything. The web
 * has no playlist-add activity at all: its Playlist model stores
 * a bare, timestamp-less array of theme ids, so no truthful
 * history of adds exists anywhere in the shared database, and
 * none is backfilled. Rows exist only for adds made through this
 * API after this recording shipped; adds made on the website
 * create no row (the website neither writes nor reads this
 * collection, so the shared-DB rules hold: purely additive, no
 * field the web depends on is touched).
 *
 * `playlistName` and `themeSlug` are denormalised snapshots, the
 * WatchHistory/Rating precedent: the feed renders "added <theme>
 * to <playlist>" even after the playlist is renamed or deleted,
 * and a theme row's stored slug is the fallback when the theme
 * has left the catalogue. `createdAt` (timestamps) is the event
 * time the feed sorts by. `autoIndex: false` as everywhere in
 * this API.
 */

export type PlaylistActivityDocument = HydratedDocument<PlaylistActivity>;

@Schema({
  collection: 'playlistactivities',
  timestamps: true,
  autoIndex: false,
})
export class PlaylistActivity {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Playlist',
    required: true,
  })
  playlistId: Types.ObjectId;

  /** The playlist's name at the moment of the add (snapshot). */
  @Prop({ type: String, required: true })
  playlistName: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ThemeCache',
    required: true,
  })
  themeId: Types.ObjectId;

  @Prop({ type: String, required: true })
  themeSlug: string;
}

export const PlaylistActivitySchema =
  SchemaFactory.createForClass(PlaylistActivity);

import { useMemo } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Heart, Play, X } from 'lucide-react-native';
import type { ThemeSummary } from '@kaikansen/contracts';
import { fontFamilies, radii, spacing, typeStyles, type Theme } from '../theme';
import { useTheme } from '../theme-context';
import { ThemeRowMenu } from './ThemeRowMenu';

/**
 * Theme row — the shared list unit for Popular Themes, search results
 * and the Library. Row anatomy per the design polish pass (the
 * fidelity audit's consolidated search-results anatomy, applied to
 * every row per design law #8): cover, wrapping song title, a meta
 * line carrying the ARTIST only with the OP/ED chip INLINE after it
 * (lavender pill, ED in tertiary), and one right-side cluster —
 * [duration?] [× remove?] [heart save] [play disc] [bare ⋮]. The
 * aggregate rating lives on the detail screen's fact card, not in
 * rows.
 *
 * Consolidation note: the playlist mock's rows (duration + filled
 * heart + ⋮, no chip/play disc) and the Library mock's (play disc +
 * heart, no ⋮/chip) differ in detail; the search anatomy wins
 * because law #8 gives every song row a ⋮ and dropping the play
 * disc or chip per-screen would fork this shared unit. The
 * Playlist detail screen has since been rebuilt against its own
 * mock (owner-ordered), so it opts into the mock's anatomy through
 * the `playlist` prop below — the same opt-in pattern as `compact`
 * and `typeChip`; every other consumer keeps the search anatomy.
 *
 * Actions are opt-in per screen, so a screen only ever draws controls
 * it has wired (Slice M2):
 * - the play disc targets onPlay when given (Library rows open the
 *   player) and falls back to the row's own onPress (the pre-M2
 *   behaviour on Home/Search — opening the theme);
 * - the heart renders only with onToggleSave, filled accent when
 *   the theme is saved, and spins while that slug's toggle is in
 *   flight (state comes from the shared favorites store);
 * - the remove (×) renders only with onRemove (playlist owner).
 * An optional `detail` caption sits under the meta line (watch
 * history's mode · relative time). An optional `durationText`
 * ("1:30") leads the cluster; screens pass it only when the item's
 * duration is known.
 * - the bare ⋮ (design law #8, Slice 5) closes the cluster and
 *   opens the shared ThemeRowMenu (Play / View theme / Save / Add
 *   to playlist / Download, all wired). It renders unless
 *   `menu={false}`.
 *
 * Three opt-in deviations (owner's design pass, measured from the
 * mocks): `typeChip={false}` drops the OP/ED chip — the Theme
 * Detail mock's meta line is the artist alone, and the Library
 * mock (kaikansen-library-realimg.png) draws NO OP chip on any of
 * its rows, so every Library usage opts out too — `compact`
 * (Theme Detail Similar rows, measured from
 * kaikansen-detail-realimg.png — that mock's rows are a more
 * compact cut of the row than the Library mock's) shrinks the
 * thumb to ≈46, the play disc to ≈44, the row's vertical padding
 * to 10, and orders the cluster the mock's way — play disc, then
 * heart, then ⋮ — and `playlist` (Playlist detail rows, measured
 * from kaikansen-playlist.html: 48pt thumb at radii.base, 10px
 * padding, radii.md card, no play disc and no type chip; the
 * cluster is duration · remove? · heart · ⋮, and playing a row
 * lives in the ⋮ menu's Play and the header's Play All). Every
 * other consumer keeps the defaults above.
 *
 * A fourth opt-in, `season` (Season browse rows, measured from
 * season.html), restyles the row to that screen's cut: radii.md
 * card at 10px padding with a 10px bottom margin, a 50pt thumb at
 * radii.base, the OP/ED chip moved up beside the title (a small
 * 4px-radius lavender tag reading just OP or ED — no sequence —
 * in the accent for both types), the artist alone under it in the
 * mauve secondary at 12pt, and a cluster of only the play disc
 * (36pt, 20pt glyph) and the ⋮ (whose trigger glyph the menu
 * draws at 20pt in the secondary for this variant). Saving lives
 * in the ⋮ menu here — the mock draws no heart. One deliberate
 * deviation from this component's law #9: season.html truncates
 * its titles to one line beside the chip, so this variant does
 * too; the flag is recorded in the Season slice report.
 *
 * A fifth opt-in, `anime` (Anime detail rows, measured from
 * anime-detail.html), is the same family cut at that screen's
 * measurements: radii.md card at 12px padding with an 8px bottom
 * margin, a 48pt thumb at radii.base, the OP/ED tag beside the
 * title carrying the REAL type + sequence ("OP 1" — the screen's
 * HTML draws the OP tag numbered; where a stored sequence is 0
 * the tag falls back to the bare type), the artist alone under
 * it in the mauve secondary at 12pt, and a cluster of only the
 * play disc (36pt, 18pt glyph) and the ⋮ (18pt in the secondary
 * for this variant). Saving lives in the ⋮ menu — the mock draws
 * no heart. anime-detail.html truncates its titles to one line
 * beside the tag, so this variant shares the `season` variant's
 * recorded law-#9 deviation.
 *
 * A sixth opt-in, `artist` (Artist detail rows, measured from
 * artist-detail.html), is the same family at that screen's cut:
 * radii.md card at 14px padding with a 12px bottom margin, a 48pt
 * thumb at radii.base, the title 14pt bold on one line (the HTML
 * truncates — the same recorded law-#9 deviation) with the ANIME
 * title alone beneath it at 12pt medium in the secondary (the
 * screen passes it as `metaText`), and the right cluster in the
 * HTML's order — the bare OP/ED tag (11pt semibold accent on the
 * lavender chip, 6px radius, NO sequence), the play disc (36pt,
 * 20pt glyph), then the ⋮ (19pt in the secondary). Saving lives
 * in the ⋮ menu — the mock draws no heart.
 */
export function ThemeRow({
  item,
  onPress,
  onPlay,
  saved,
  savePending,
  onToggleSave,
  onRemove,
  detail,
  metaText,
  durationText,
  menu = true,
  typeChip = true,
  compact = false,
  playlist = false,
  season = false,
  anime = false,
  artist = false,
}: {
  item: ThemeSummary;
  onPress?: () => void;
  onPlay?: () => void;
  saved?: boolean;
  savePending?: boolean;
  onToggleSave?: () => void;
  onRemove?: () => void;
  detail?: string;
  /**
   * Replacement for the default artist-only meta line — the
   * Artist detail design shows the ANIME title alone on its rows.
   */
  metaText?: string;
  durationText?: string;
  menu?: boolean;
  /** Draw the OP/ED chip after the meta line (default true). */
  typeChip?: boolean;
  /** The Theme Detail Similar rows' compact cut (see header). */
  compact?: boolean;
  /** The Playlist detail rows' mock anatomy (see header). */
  playlist?: boolean;
  /** The Season browse rows' mock anatomy (see header). */
  season?: boolean;
  /** The Anime detail rows' mock anatomy (see header). */
  anime?: boolean;
  /** The Artist detail rows' mock anatomy (see header). */
  artist?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = item.animeCoverImageSmall ?? item.animeCoverImage;
  const artistText = item.artistName ?? item.allArtists.join(', ');

  const playButton = (
    <Pressable
      onPress={onPlay ?? onPress}
      hitSlop={7}
      accessibilityRole="button"
      accessibilityLabel={`Play ${item.songTitle}`}
      style={({ pressed }) => [
        styles.playDisc,
        compact && styles.playDiscCompact,
        pressed && styles.pressed,
      ]}
    >
      <Play
        size={artist || season ? 20 : anime ? 18 : compact ? 17 : 15}
        color={theme.accent}
        fill={theme.accent}
        strokeWidth={2}
      />
    </Pressable>
  );
  const heartButton = onToggleSave ? (
    <Pressable
      onPress={onToggleSave}
      hitSlop={7}
      accessibilityRole="button"
      accessibilityLabel={
        saved ? `Unsave ${item.songTitle}` : `Save ${item.songTitle}`
      }
      accessibilityState={{ selected: !!saved }}
      style={({ pressed }) => [
        styles.bareAction,
        pressed && styles.pressed,
      ]}
    >
      {savePending ? (
        <ActivityIndicator size="small" color={theme.muted} />
      ) : (
        <Heart
          size={compact ? 20 : 17}
          color={saved ? theme.accent : theme.muted}
          fill={saved ? theme.accent : 'transparent'}
          strokeWidth={2}
        />
      )}
    </Pressable>
  ) : null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        compact && styles.rowCompact,
        playlist && styles.rowPlaylist,
        season && styles.rowSeason,
        anime && styles.rowAnime,
        artist && styles.rowArtist,
        pressed && styles.pressed,
      ]}
    >
      {cover ? (
        <Image
          source={{ uri: cover }}
          style={[
            styles.thumb,
            compact && styles.thumbCompact,
            playlist && styles.thumbPlaylist,
            season && styles.thumbSeason,
            anime && styles.thumbAnime,
            artist && styles.thumbArtist,
          ]}
        />
      ) : (
        <View
          style={[
            styles.thumb,
            compact && styles.thumbCompact,
            playlist && styles.thumbPlaylist,
            season && styles.thumbSeason,
            anime && styles.thumbAnime,
            artist && styles.thumbArtist,
            styles.placeholder,
          ]}
        />
      )}
      <View style={styles.main}>
        {artist ? (
          <>
            {/* Artist detail anatomy (artist-detail.html): the
                song title on one line, the ANIME title alone
                beneath (passed as metaText) — the OP/ED tag lives
                in the right cluster on this screen, not here. The
                title/meta measurements are the season variant's. */}
            <Text style={styles.songSeason} numberOfLines={1}>
              {item.songTitle}
            </Text>
            <Text style={styles.metaSeason} numberOfLines={1}>
              {metaText ?? artistText}
            </Text>
          </>
        ) : anime ? (
          <>
            {/* Anime detail anatomy (anime-detail.html): the OP/ED
                tag beside the title carries the real sequence, the
                artist alone beneath. */}
            <View style={styles.titleLineAnime}>
              <Text style={styles.songAnime} numberOfLines={1}>
                {item.songTitle}
              </Text>
              <View style={styles.typeChipAnime}>
                <Text style={styles.typeAnime}>
                  {item.sequence > 0
                    ? `${item.type} ${item.sequence}`
                    : item.type}
                </Text>
              </View>
            </View>
            <Text style={styles.metaAnime} numberOfLines={1}>
              {metaText ?? artistText}
            </Text>
          </>
        ) : season ? (
          <>
            {/* Season browse anatomy (season.html): the OP/ED tag
                sits beside the title, the artist alone beneath. */}
            <View style={styles.titleLineSeason}>
              <Text style={styles.songSeason} numberOfLines={1}>
                {item.songTitle}
              </Text>
              <View style={styles.typeChipSeason}>
                <Text style={styles.typeSeason}>{item.type}</Text>
              </View>
            </View>
            <Text style={styles.metaSeason} numberOfLines={1}>
              {metaText ?? artistText}
            </Text>
          </>
        ) : (
          <>
            {/* Design law #9: long titles wrap (2 lines), never
                ellipsis-truncate next to the row's chips/tiles. */}
            <Text style={styles.song} numberOfLines={2}>
              {item.songTitle}
            </Text>
            <View style={styles.metaRow}>
              <Text style={styles.meta} numberOfLines={1}>
                {metaText ?? artistText}
              </Text>
              {typeChip && !playlist && (
                <View style={styles.typeChip}>
                  <Text
                    style={[
                      styles.type,
                      {
                        color:
                          item.type === 'ED' ? theme.tertiary : theme.accent,
                      },
                    ]}
                  >
                    {item.type} {item.sequence}
                  </Text>
                </View>
              )}
            </View>
          </>
        )}
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      <View style={styles.tiles}>
        {durationText && !season && !anime && !artist ? (
          <Text style={styles.duration}>{durationText}</Text>
        ) : null}
        {onRemove && !season && !anime && !artist && (
          <Pressable
            onPress={onRemove}
            hitSlop={7}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.songTitle} from playlist`}
            style={({ pressed }) => [
              styles.bareAction,
              pressed && styles.pressed,
            ]}
          >
            <X size={15} color={theme.muted} strokeWidth={2} />
          </Pressable>
        )}
        {artist ? (
          // Artist detail cluster (artist-detail.html): the bare
          // OP/ED tag, then the play disc, then the ⋮.
          <>
            <View style={styles.typeChipArtist}>
              <Text style={styles.typeArtist}>{item.type}</Text>
            </View>
            {playButton}
          </>
        ) : season || anime ? (
          // Season browse / Anime detail cluster (season.html /
          // anime-detail.html): play disc + ⋮ only.
          playButton
        ) : playlist ? (
          heartButton
        ) : compact ? (
          <>
            {playButton}
            {heartButton}
          </>
        ) : (
          <>
            {heartButton}
            {playButton}
          </>
        )}
        {menu && (
          <ThemeRowMenu
            item={item}
            onPlay={onPlay}
            onOpen={onPress}
            triggerIconSize={artist ? 19 : anime ? 18 : season ? 20 : undefined}
            triggerColor={artist || anime || season ? theme.secondary : undefined}
          />
        )}
      </View>
    </Pressable>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  row: {
    // Lavender Dusk rows: white cards, not hairline-separated lines.
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    minHeight: 56,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.card,
    marginBottom: spacing.sm,
  },
  pressed: {
    opacity: 0.7,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
    backgroundColor: theme.surface,
  },
  rowCompact: {
    // Detail mock rows measure ≈131px tall @2x ≈ 65.5pt with a
    // ≈46pt thumb: vertical padding 10 around the compact thumb.
    paddingVertical: 10,
  },
  rowPlaylist: {
    // Playlist mock rows (kaikansen-playlist.html): p-2.5 (10)
    // padding, rounded-2xl (16) card corners.
    padding: 10,
    borderRadius: radii.md,
  },
  thumbPlaylist: {
    // Playlist mock thumb: w-12 h-12 (48), rounded-xl (12).
    width: 48,
    height: 48,
    borderRadius: radii.base,
  },
  thumbCompact: {
    width: 46,
    height: 46,
    borderRadius: radii.base,
  },
  rowSeason: {
    // Season mock rows (season.html): p-2.5 (10) padding,
    // rounded-2xl (16) card corners, space-y-2.5 (10) between rows.
    padding: 10,
    borderRadius: radii.md,
    marginBottom: 10,
  },
  thumbSeason: {
    // Season mock thumb: 50x50, rounded-xl (12).
    width: 50,
    height: 50,
    borderRadius: radii.base,
  },
  titleLineSeason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  songSeason: {
    // season.html: text-sm bold, tracking-tight.
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 14,
    letterSpacing: -0.2,
    color: theme.text,
    flexShrink: 1,
  },
  typeChipSeason: {
    backgroundColor: theme.accentContainer,
    // season.html rounds the tag at 4px — off the radii scale, a
    // literal citing the screen's HTML (prior slices' pattern).
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  typeSeason: {
    // season.html: 10px bold, accent for OP and ED alike.
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 10,
    color: theme.accent,
  },
  metaSeason: {
    // season.html: the artist at 12px medium in the mauve.
    fontFamily: fontFamilies.caption,
    fontSize: 12,
    color: theme.secondary,
  },
  rowAnime: {
    // Anime detail mock rows (anime-detail.html): p-3 (12)
    // padding, rounded-2xl (16) card corners, gap-2 (8) between
    // the section's rows.
    padding: 12,
    borderRadius: radii.md,
    marginBottom: 8,
  },
  thumbAnime: {
    // Anime detail mock thumb: w-12 h-12 (48), rounded-xl (12).
    width: 48,
    height: 48,
    borderRadius: radii.base,
  },
  titleLineAnime: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  songAnime: {
    // anime-detail.html: text-sm bold, tracking-tight.
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 14,
    letterSpacing: -0.2,
    color: theme.text,
    flexShrink: 1,
  },
  typeChipAnime: {
    backgroundColor: theme.accentContainer,
    // anime-detail.html rounds the tag at 4px (rounded) — off the
    // radii scale, a literal citing the screen's HTML.
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  typeAnime: {
    // anime-detail.html: 10px bold in the deep mauve, for OP and
    // ED alike.
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 10,
    color: theme.accent,
  },
  metaAnime: {
    // anime-detail.html: the artist at 12px medium in the mauve.
    fontFamily: fontFamilies.caption,
    fontSize: 12,
    color: theme.secondary,
  },
  rowArtist: {
    // Artist detail mock rows (artist-detail.html): p-3.5 (14)
    // padding, rounded-2xl (16) card corners, space-y-3 (12)
    // between rows.
    padding: 14,
    borderRadius: radii.md,
    marginBottom: 12,
  },
  thumbArtist: {
    // Artist detail mock thumb: w-12 h-12 (48), rounded-xl (12).
    width: 48,
    height: 48,
    borderRadius: radii.base,
  },
  typeChipArtist: {
    backgroundColor: theme.accentContainer,
    // artist-detail.html rounds the tag at 6px (rounded-md) — off
    // the radii scale, a literal citing the screen's HTML.
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  typeArtist: {
    // artist-detail.html: 11px semibold in the deep mauve, bare
    // OP or ED (no sequence on this screen).
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 11,
    color: theme.accent,
  },
  playDiscCompact: {
    // Detail + Library mocks both draw the disc at ≈86-88px @2x.
    width: 44,
    height: 44,
  },
  placeholder: {
    backgroundColor: theme.raised,
  },
  main: {
    flex: 1,
    gap: 2,
  },
  song: {
    ...typeStyles.body,
    fontSize: 14,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  meta: {
    ...typeStyles.caption,
    color: theme.muted,
    flexShrink: 1,
  },
  detail: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  tiles: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  duration: {
    ...typeStyles.caption,
    color: theme.muted,
    marginRight: spacing.xs,
  },
  typeChip: {
    backgroundColor: theme.accentContainer,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  type: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    letterSpacing: 0.3,
  },
  bareAction: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playDisc: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

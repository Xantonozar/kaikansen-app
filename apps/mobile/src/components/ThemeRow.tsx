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
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const cover = item.animeCoverImageSmall ?? item.animeCoverImage;
  const artist = item.artistName ?? item.allArtists.join(', ');

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
        size={compact ? 17 : 15}
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
          ]}
        />
      ) : (
        <View
          style={[
            styles.thumb,
            compact && styles.thumbCompact,
            playlist && styles.thumbPlaylist,
            styles.placeholder,
          ]}
        />
      )}
      <View style={styles.main}>
        {/* Design law #9: long titles wrap (2 lines), never
            ellipsis-truncate next to the row's chips/tiles. */}
        <Text style={styles.song} numberOfLines={2}>
          {item.songTitle}
        </Text>
        <View style={styles.metaRow}>
          <Text style={styles.meta} numberOfLines={1}>
            {metaText ?? artist}
          </Text>
          {typeChip && !playlist && (
            <View style={styles.typeChip}>
              <Text
                style={[
                  styles.type,
                  { color: item.type === 'ED' ? theme.tertiary : theme.accent },
                ]}
              >
                {item.type} {item.sequence}
              </Text>
            </View>
          )}
        </View>
        {detail ? (
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      <View style={styles.tiles}>
        {durationText ? (
          <Text style={styles.duration}>{durationText}</Text>
        ) : null}
        {onRemove && (
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
        {playlist ? (
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
          <ThemeRowMenu item={item} onPlay={onPlay} onOpen={onPress} />
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

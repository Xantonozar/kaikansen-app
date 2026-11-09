import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Bookmark,
  Check,
  ChevronLeft,
  Download,
  Headphones,
  Info,
  ListPlus,
  MonitorPlay,
  MoreVertical,
  Play,
  Trash2,
  X,
} from 'lucide-react-native';
import type {
  PlaybackMode,
  ThemeDetail,
  ThemeEntry,
  ThemeSummary,
} from '@kaikansen/contracts';
import { fetchThemeBySlug, fixtureMode } from '../api';
import { useFavorites } from '../favoritesStore';
import {
  entryHasAudio,
  isPlausibleUrl,
  resolvePlaybackUrl,
} from '../playback';
import {
  downloadId,
  downloadsSupported,
  formatBytes,
  useDownloads,
} from '../downloads';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';
import { AddToPlaylistSheet } from './AddToPlaylistSheet';

type SheetView = 'none' | 'actions' | 'download';

/**
 * The ⋮ menu on song rows (Slice 5, design law #8 — "every song row
 * gets a ⋮ menu"). Rendered by ThemeRow as the last, bare element
 * of the row's right-side cluster, so it
 * appears in Library (all segments), Search, Playlist detail,
 * Favourites, profiles and the Season/Anime/Artist lists with no
 * per-screen wiring. PopularCard on Home is the one row variant
 * WITHOUT it: the Home design draws play + heart only there, and
 * design law #3 strips Popular cards of extra buttons.
 *
 * Every action is wired to existing machinery — the app only draws
 * controls that work:
 * - Play — the row's own play action (the host screen's queue claim
 *   of its list context; falls back to opening the theme, exactly
 *   like the row's play tile);
 * - View theme — the row's onPress (or the theme route);
 * - Save / Unsave — the shared favorites store (same state as the
 *   row's bookmark tile);
 * - Add to playlist — the shared AddToPlaylistSheet (extracted from
 *   the theme detail; one picker implementation);
 * - Download — a per-mode page mirroring the detail's download
 *   sheet: it fetches the theme detail, targets the primary entry
 *   (the 'Standard' version, else the first — the detail screen's
 *   own default), and drives the downloads store with the same
 *   availability rules (watch needs a plausible video URL, listen
 *   needs a stored or derivable audio source).
 * Share is deliberately absent: nothing in the app shares yet, so
 * the menu does not draw it.
 */
export function ThemeRowMenu({
  item,
  onPlay,
  onOpen,
}: {
  item: ThemeSummary;
  onPlay?: () => void;
  onOpen?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const downloads = useDownloads();

  const [view, setView] = useState<SheetView>('none');
  const [pickerOpen, setPickerOpen] = useState(false);

  /* Download page state: the detail is fetched lazily when the page
     opens (rows only carry a ThemeSummary). */
  const [dlDetail, setDlDetail] = useState<ThemeDetail | null>(null);
  const [dlLoading, setDlLoading] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);

  const saved = favorites.isFavorite(item.slug);
  const savePending = favorites.isPending(item.slug);

  useEffect(() => {
    if (view !== 'download' || dlDetail || fixtureMode) return;
    let cancelled = false;
    setDlLoading(true);
    setDlError(null);
    fetchThemeBySlug(item.slug)
      .then((detail) => {
        if (!cancelled) setDlDetail(detail);
      })
      .catch(() => {
        if (!cancelled) {
          setDlError('Could not load this theme. Try again.');
        }
      })
      .finally(() => {
        if (!cancelled) setDlLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, dlDetail, item.slug]);

  const close = () => setView('none');

  const play = () => {
    close();
    (onPlay ?? onOpen)?.();
  };

  const openTheme = () => {
    close();
    if (onOpen) onOpen();
    else router.push(`/theme/${item.slug}`);
  };

  const toggleSave = () => {
    void favorites.toggle(item.slug);
    close();
  };

  const openPicker = () => {
    close();
    // Let the menu's Modal finish closing before the picker opens
    // (stacked Modals in the same tick glitch on Android).
    setTimeout(() => setPickerOpen(true), 80);
  };

  const primaryEntry: ThemeEntry | null = dlDetail
    ? (dlDetail.entries.find((e) => e.version === 'Standard') ??
      dlDetail.entries[0] ??
      null)
    : null;

  const dlRow = (mode: PlaybackMode) => {
    if (!dlDetail || !primaryEntry) return null;
    const id = downloadId(dlDetail.slug, primaryEntry.atEntryId, mode);
    const record = downloads.find(
      dlDetail.slug,
      primaryEntry.atEntryId,
      mode,
    );
    const progress = downloads.progressFor(id);
    const downloading = progress !== undefined && progress !== null;
    const error = downloads.errorFor(id);
    const stored = record !== undefined && !record.fileMissing;
    const available =
      mode === 'watch'
        ? isPlausibleUrl(resolvePlaybackUrl(dlDetail, primaryEntry, 'watch'))
        : entryHasAudio(dlDetail, primaryEntry);
    const Icon = mode === 'watch' ? MonitorPlay : Headphones;
    return (
      <View key={mode}>
        <View style={styles.actionRow}>
          <Pressable
            onPress={() => {
              if (available && !stored && !downloading) {
                void downloads.start(dlDetail, primaryEntry, mode);
              }
            }}
            disabled={!available || stored || downloading}
            accessibilityRole="button"
            accessibilityLabel={
              mode === 'watch'
                ? 'Download watch video'
                : 'Download listen audio'
            }
            accessibilityState={{
              disabled: !available || stored || downloading,
            }}
            style={({ pressed }) => [
              styles.actionMain,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.actionIcon}>
              <Icon size={18} color={theme.accent} strokeWidth={2} />
            </View>
            <View style={styles.actionText}>
              <Text style={styles.actionLabel}>
                {mode === 'watch' ? 'Watch video' : 'Listen audio'}
              </Text>
              <Text style={styles.actionMeta} numberOfLines={1}>
                {downloading
                  ? 'Downloading…'
                  : stored
                    ? `Saved · ${formatBytes(record.size)}`
                    : record?.fileMissing
                      ? 'File missing — download again'
                      : available
                        ? 'Tap to download'
                        : 'Not available for this theme'}
              </Text>
            </View>
          </Pressable>
          {downloading ? (
            <Text style={styles.percent}>
              {Math.round(progress * 100)}%
            </Text>
          ) : stored ? (
            <>
              <Check size={17} color={theme.accent} strokeWidth={2.25} />
              <Pressable
                onPress={() => void downloads.remove(id)}
                hitSlop={7}
                accessibilityRole="button"
                accessibilityLabel="Delete download"
                style={({ pressed }) => [
                  styles.deleteTile,
                  pressed && styles.pressed,
                ]}
              >
                <Trash2 size={15} color={theme.muted} strokeWidth={2} />
              </Pressable>
            </>
          ) : null}
        </View>
        {error && <Text style={styles.dlError}>{error}</Text>}
      </View>
    );
  };

  return (
    <>
      <Pressable
        onPress={() => setView('actions')}
        hitSlop={7}
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${item.songTitle}`}
        style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
      >
        <MoreVertical size={15} color={theme.muted} strokeWidth={2} />
      </Pressable>

      <Modal
        visible={view !== 'none'}
        transparent
        animationType="slide"
        onRequestClose={close}
      >
        <View style={styles.backdrop}>
          <Pressable
            style={styles.dismiss}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={styles.sheet}>
            {view === 'actions' ? (
              <>
                <View style={styles.header}>
                  <View style={styles.headerMain}>
                    <Text style={styles.titleText} numberOfLines={1}>
                      {item.songTitle}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {item.animeTitle}
                      {item.artistName ? ` · ${item.artistName}` : ''}
                    </Text>
                  </View>
                  <Pressable
                    onPress={close}
                    accessibilityRole="button"
                    accessibilityLabel="Close menu"
                    style={({ pressed }) => [
                      styles.closeButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <X size={18} color={theme.text} strokeWidth={2} />
                  </Pressable>
                </View>

                <Pressable
                  onPress={play}
                  accessibilityRole="button"
                  accessibilityLabel={`Play ${item.songTitle}`}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.actionIcon}>
                    <Play
                      size={18}
                      color={theme.accent}
                      fill={theme.accent}
                      strokeWidth={2}
                    />
                  </View>
                  <Text style={styles.actionLabel}>Play</Text>
                </Pressable>

                <Pressable
                  onPress={openTheme}
                  accessibilityRole="button"
                  accessibilityLabel={`View ${item.songTitle}`}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.actionIcon}>
                    <Info size={18} color={theme.accent} strokeWidth={2} />
                  </View>
                  <Text style={styles.actionLabel}>View theme</Text>
                </Pressable>

                <Pressable
                  onPress={toggleSave}
                  disabled={savePending}
                  accessibilityRole="button"
                  accessibilityLabel={
                    saved
                      ? `Unsave ${item.songTitle}`
                      : `Save ${item.songTitle}`
                  }
                  accessibilityState={{ disabled: savePending }}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.actionIcon}>
                    {savePending ? (
                      <ActivityIndicator size="small" color={theme.accent} />
                    ) : (
                      <Bookmark
                        size={18}
                        color={theme.accent}
                        fill={saved ? theme.accent : 'transparent'}
                        strokeWidth={2}
                      />
                    )}
                  </View>
                  <Text style={styles.actionLabel}>
                    {saved ? 'Unsave' : 'Save'}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={openPicker}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${item.songTitle} to a playlist`}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.actionIcon}>
                    <ListPlus size={18} color={theme.accent} strokeWidth={2} />
                  </View>
                  <Text style={styles.actionLabel}>Add to playlist</Text>
                </Pressable>

                <Pressable
                  onPress={() => setView('download')}
                  accessibilityRole="button"
                  accessibilityLabel={`Download ${item.songTitle}`}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.actionIcon}>
                    <Download size={18} color={theme.accent} strokeWidth={2} />
                  </View>
                  <Text style={styles.actionLabel}>Download</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.header}>
                  <Pressable
                    onPress={() => setView('actions')}
                    accessibilityRole="button"
                    accessibilityLabel="Back to actions"
                    style={({ pressed }) => [
                      styles.closeButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <ChevronLeft size={18} color={theme.text} strokeWidth={2} />
                  </Pressable>
                  <View style={styles.headerMain}>
                    <Text style={styles.titleText}>Download</Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {item.songTitle}
                      {primaryEntry ? ` · ${primaryEntry.version}` : ''}
                    </Text>
                  </View>
                  <Pressable
                    onPress={close}
                    accessibilityRole="button"
                    accessibilityLabel="Close downloads"
                    style={({ pressed }) => [
                      styles.closeButton,
                      pressed && styles.pressed,
                    ]}
                  >
                    <X size={18} color={theme.text} strokeWidth={2} />
                  </Pressable>
                </View>

                {fixtureMode ? (
                  <Text style={styles.note}>
                    Downloads are not available in demo mode.
                  </Text>
                ) : !downloadsSupported ? (
                  <Text style={styles.note}>
                    Downloads are not available on web.
                  </Text>
                ) : dlLoading || (dlDetail === null && dlError === null) ? (
                  <View style={styles.center}>
                    <ActivityIndicator color={theme.accent} />
                  </View>
                ) : dlError ? (
                  <Text style={styles.note}>{dlError}</Text>
                ) : dlDetail && primaryEntry ? (
                  <>
                    <Text style={styles.note}>
                      Downloads the {primaryEntry.version} version — other
                      versions live on the theme page.
                    </Text>
                    {dlRow('watch')}
                    {dlRow('listen')}
                  </>
                ) : (
                  <Text style={styles.note}>
                    This theme has no versions to download.
                  </Text>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>

      <AddToPlaylistSheet
        slug={item.slug}
        title={item.songTitle}
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    tile: {
      // Bare ⋮ (design polish pass): the mocks draw the dots with
      // no disc behind them; the 32px box is only the hit area.
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backdrop: {
      flex: 1,
      backgroundColor: withOpacity(theme.background, 0.72),
      justifyContent: 'flex-end',
    },
    dismiss: {
      flex: 1,
    },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: radii.cardLg,
      borderTopRightRadius: radii.cardLg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.md,
      paddingBottom: spacing.xl,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    headerMain: {
      flex: 1,
      gap: 2,
    },
    titleText: {
      ...typeStyles.heading,
      color: theme.text,
    },
    subtitle: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    actionMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    actionIcon: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionText: {
      flex: 1,
      gap: 2,
    },
    actionLabel: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    actionMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    percent: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    deleteTile: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dlError: {
      ...typeStyles.caption,
      color: theme.accent,
      marginTop: 2,
      lineHeight: 16,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
      paddingVertical: spacing.md,
    },
    center: {
      paddingVertical: spacing.xxl,
      alignItems: 'center',
    },
    pressed: {
      opacity: 0.65,
    },
  });

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Bookmark,
  Check,
  ChevronLeft,
  Download,
  Eye,
  Headphones,
  Layers,
  ListMusic,
  Mic,
  Play,
  Plus,
  RotateCcw,
  Share2,
  Star,
  Trash2,
  X,
} from 'lucide-react-native';
import type {
  PlaybackMode,
  PlaylistSummary,
  ThemeDetail,
  ThemeRatingState,
  ThemeSummary,
} from '@kaikansen/contracts';
import {
  fetchSimilarThemes,
  fetchThemeBySlug,
  fixtureMode,
} from '../../../src/api';
import { PosterCard } from '../../../src/components/PosterCard';
import { ThemeComments } from '../../../src/components/ThemeComments';
import { useAuth } from '../../../src/auth';
import {
  applyFavoriteState,
  useFavorites,
} from '../../../src/favoritesStore';
import {
  addPlaylistItem,
  clearRating as deleteRating,
  createPlaylist,
  fetchFavoriteState,
  fetchPlaylist,
  fetchPlaylists,
  fetchRatingState,
  setRating as putRating,
} from '../../../src/libraryApi';
import {
  entryHasAudio,
  isPlausibleUrl,
  resolvePlaybackUrl,
} from '../../../src/playback';
import {
  downloadId,
  downloadsSupported,
  formatBytes,
  useDownloads,
} from '../../../src/downloads';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

/**
 * Theme detail (DESIGN.md §6.7), compact/icon-led treatment (approved
 * mockup v1): the artwork leads full-bleed with glass icon buttons
 * overlaid (back; bookmark; share — still visual only, no share
 * behaviour exists yet) and an accent play FAB straddling its bottom
 * edge. Below: song title, one meta line (anime · artist), the chips,
 * ONE labelled action pill (Watch) with icon squares beside it
 * (Listen; Add), a fact card of icon-led rows (artist / rating /
 * watches / listens / versions), and version tiles drawn from the
 * real entries when there is more than one.
 *
 * Playback is REAL (Slice M1): Watch, the FAB and a version tile open
 * the player in watch mode for the selected entry; Listen opens it in
 * audio mode (disabled when the entry has no audio source, like the
 * web's toggle). Version tiles also select the entry the Watch/Listen
 * actions target.
 *
 * Library actions are REAL (Slice M2): the bookmark is the shared
 * save toggle (exact per-slug state fetched on load, then kept in the
 * favorites store), Add opens the add-to-playlist sheet, and the
 * rating card under the facts carries the caller's own 1–10 rating
 * (aggregate shown in the fact row, refreshed from every rating
 * response).
 *
 * Downloads are REAL (Slice M3): the download square opens a
 * per-entry sheet (Watch video / Listen audio, each with its own
 * state — download, progress, downloaded, delete) backed by
 * src/downloads.ts. Downloads are local, so they work signed-out;
 * demo mode and web answer with the honest note instead.
 *
 * Comments are REAL (Slice M5): the section under Similar is the
 * shared ThemeComments component (list + composer over
 * GET/POST /themes/:slug/comments).
 *
 * The Similar themes rail (Slice S8) closes the screen: a
 * horizontal PosterCard rail fed by GET /themes/:slug/similar,
 * cards routing to their own detail. It renders only when the API
 * returns something — an empty result, a failed fetch and fixture
 * mode (whose client resolves [] by design) all hide it.
 */
export default function ThemeDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { status: authStatus } = useAuth();
  const favorites = useFavorites();
  const downloads = useDownloads();
  const signedIn = authStatus === 'signedIn';
  const [selectedEntryIndex, setSelectedEntryIndex] = useState(0);
  const [detail, setDetail] = useState<ThemeDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>(
    'loading',
  );

  /* Slice M2 — library state for this theme. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [ratingState, setRatingState] = useState<ThemeRatingState | null>(
    null,
  );
  const [ratingBusy, setRatingBusy] = useState(false);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetMessage, setSheetMessage] = useState<string | null>(null);
  const [myPlaylists, setMyPlaylists] = useState<PlaylistSummary[] | null>(
    null,
  );
  const [containedIds, setContainedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [sheetBusyId, setSheetBusyId] = useState<string | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingInSheet, setCreatingInSheet] = useState(false);
  const [dlSheetOpen, setDlSheetOpen] = useState(false);

  /* Slice S8 — the similar-themes rail's data ([] hides the rail). */
  const [similar, setSimilar] = useState<ThemeSummary[]>([]);

  useEffect(() => {
    let live = true;
    setState('loading');
    setSelectedEntryIndex(0);
    setSimilar([]);
    fetchThemeBySlug(slug)
      .then((data) => {
        if (!live) return;
        if (data) {
          setDetail(data);
          setState('ready');
        } else {
          setState('missing');
        }
      })
      .catch(() => {
        if (live) setState('error');
      });
    return () => {
      live = false;
    };
  }, [slug]);

  /* Exact library state for this theme (Slice M2): the per-slug
     favorite check reconciles the shared store, and the rating state
     seeds the rating card. Live API + signed-in only — signed-out and
     demo renders derive from the detail data alone. */
  useEffect(() => {
    setRatingState(null);
    setRatingError(null);
    setActionError(null);
    if (state !== 'ready' || !detail || !signedIn || fixtureMode) return;
    let live = true;
    fetchFavoriteState(detail.slug)
      .then((s) => {
        if (live) applyFavoriteState(s.slug, s.isFavorite);
      })
      .catch(() => {
        // The store's set stands; a failed check is not user-facing.
      });
    fetchRatingState(detail.slug)
      .then((r) => {
        if (live) setRatingState(r);
      })
      .catch(() => {
        if (live) setRatingState(null);
      });
    return () => {
      live = false;
    };
  }, [state, detail, signedIn]);

  /* Similar themes (Slice S8): fetched once the detail is ready.
     Fixture mode resolves [] from the client, so the rail stays
     hidden there; a failed fetch hides it too — the rail is a
     bonus read, never an error surface. */
  useEffect(() => {
    if (state !== 'ready' || !detail) return;
    let live = true;
    fetchSimilarThemes(detail.slug)
      .then((list) => {
        if (live) setSimilar(list);
      })
      .catch(() => {
        if (live) setSimilar([]);
      });
    return () => {
      live = false;
    };
  }, [state, detail]);

  /** Rounded-square back button; `glass` floats it over the artwork. */
  const backTile = (glass: boolean) => (
    <Pressable
      onPress={() => router.back()}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={styles.backHit}
    >
      <View style={[styles.tile, glass ? styles.tileGlass : styles.tileSolid]}>
        <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
      </View>
    </Pressable>
  );

  /** Visual-only glass action over the artwork (no behaviour this slice). */
  const glassAction = (Icon: IconComponent, label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.backHit,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.tile, styles.tileGlass]}>
        <Icon size={19} color={theme.text} strokeWidth={2} />
      </View>
    </Pressable>
  );

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {backTile(false)}
        </View>
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      </View>
    );
  }

  if (state !== 'ready' || !detail) {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {backTile(false)}
        </View>
        <View style={styles.center}>
          <Text style={styles.message}>
            {state === 'missing'
              ? 'That theme could not be found.'
              : 'Could not load this theme.'}
          </Text>
        </View>
      </View>
    );
  }

  const cover = detail.animeGrillImage ?? detail.animeCoverImage;
  const artists = detail.artistName ?? detail.allArtists.join(', ') ?? '';
  const chips: string[] = [`${detail.type} ${detail.sequence}`];
  if (detail.animeSeason && detail.animeSeasonYear) {
    chips.push(`${detail.animeSeason} ${detail.animeSeasonYear}`);
  }
  for (const mood of detail.mood) chips.push(mood);

  const factRow = (
    Icon: IconComponent,
    label: string,
    value: string,
    last: boolean,
  ) => (
    <View style={[styles.factRow, last && styles.factRowLast]}>
      <Icon size={16} color={theme.muted} strokeWidth={2} />
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );

  const hasMultipleVersions = detail.entries.length > 1;
  const selectedEntry = detail.entries[selectedEntryIndex] ?? null;
  const listenAvailable = selectedEntry !== null && entryHasAudio(detail, selectedEntry);

  /** Open the player for an entry (defaults to the selected one). */
  const openPlayer = (mode: PlaybackMode, entryIndex = selectedEntryIndex) => {
    const entry = detail.entries[entryIndex];
    if (!entry) return;
    setSelectedEntryIndex(entryIndex);
    router.push({
      pathname: '/player',
      params: { slug: detail.slug, mode, entry: String(entry.atEntryId) },
    });
  };

  /* ---------------- Slice M2: save / rating / playlists ---------------- */

  const saved = favorites.isFavorite(detail.slug);
  const savePending = favorites.isPending(detail.slug);

  const onToggleSave = () => {
    setActionError(null);
    void favorites.toggle(detail.slug).then((err) => {
      if (err) setActionError(err);
    });
  };

  const onRate = (score: number) => {
    if (ratingBusy) return;
    setRatingBusy(true);
    setRatingError(null);
    putRating(detail.slug, score)
      .then((r) => setRatingState(r))
      .catch((e: unknown) =>
        setRatingError(
          e instanceof Error ? e.message : 'Could not save your rating.',
        ),
      )
      .finally(() => setRatingBusy(false));
  };

  const onClearRating = () => {
    if (ratingBusy) return;
    setRatingBusy(true);
    setRatingError(null);
    deleteRating(detail.slug)
      .then((r) => setRatingState(r))
      .catch((e: unknown) =>
        setRatingError(
          e instanceof Error ? e.message : 'Could not clear your rating.',
        ),
      )
      .finally(() => setRatingBusy(false));
  };

  const openSheet = () => {
    if (fixtureMode) {
      setActionError('Playlists are not available in demo mode.');
      return;
    }
    if (!signedIn) {
      setActionError('Log in to add themes to playlists.');
      return;
    }
    setActionError(null);
    setSheetOpen(true);
    setSheetMessage(null);
    setSheetError(null);
    setSheetLoading(true);
    setMyPlaylists(null);
    setContainedIds(new Set());
    fetchPlaylists()
      .then(async (res) => {
        setMyPlaylists(res.playlists);
        // Membership lives on each playlist's items, so resolve the
        // details in parallel; a failed detail leaves that row
        // addable (the API's add is a no-op for duplicates anyway).
        const details = await Promise.all(
          res.playlists.map((p) => fetchPlaylist(p.id).catch(() => null)),
        );
        const contained = new Set<string>();
        for (const d of details) {
          if (d && d.items.some((i) => i.slug === detail.slug)) {
            contained.add(d.id);
          }
        }
        setContainedIds(contained);
      })
      .catch((e: unknown) =>
        setSheetError(
          e instanceof Error ? e.message : 'Could not load your playlists.',
        ),
      )
      .finally(() => setSheetLoading(false));
  };

  const addToPlaylist = (playlist: PlaylistSummary) => {
    if (sheetBusyId) return;
    if (containedIds.has(playlist.id)) {
      setSheetMessage(`Already in “${playlist.name}”.`);
      return;
    }
    setSheetBusyId(playlist.id);
    setSheetMessage(null);
    addPlaylistItem(playlist.id, detail.slug)
      .then(() => {
        setContainedIds((prev) => new Set(prev).add(playlist.id));
        setSheetMessage(`Added to “${playlist.name}”.`);
      })
      .catch((e: unknown) =>
        setSheetMessage(
          e instanceof Error ? e.message : 'Could not add the theme.',
        ),
      )
      .finally(() => setSheetBusyId(null));
  };

  const createAndAdd = () => {
    if (creatingInSheet) return;
    const name = newPlaylistName.trim();
    if (name.length === 0) {
      setSheetMessage('Give the playlist a name.');
      return;
    }
    setCreatingInSheet(true);
    setSheetMessage(null);
    createPlaylist({ name })
      .then(async (created) => {
        setMyPlaylists((prev) => [created, ...(prev ?? [])]);
        setNewPlaylistName('');
        await addPlaylistItem(created.id, detail.slug);
        setContainedIds((prev) => new Set(prev).add(created.id));
        setSheetMessage(`Added to “${created.name}”.`);
      })
      .catch((e: unknown) =>
        setSheetMessage(
          e instanceof Error ? e.message : 'Could not create the playlist.',
        ),
      )
      .finally(() => setCreatingInSheet(false));
  };

  /** Aggregate shown in the fact row — the rating state's copy is
      the freshest (every rating response carries it). */
  const aggAvg = ratingState?.avgRating ?? detail.avgRating;
  const aggTotal = ratingState?.totalRatings ?? detail.totalRatings;
  const myScore = ratingState?.myScore ?? null;

  /* ---------------- Slice M3: downloads (per selected entry) -------- */

  const dlModes: PlaybackMode[] = ['watch', 'listen'];
  const dlRecord = (mode: PlaybackMode) =>
    selectedEntry
      ? downloads.find(detail.slug, selectedEntry.atEntryId, mode)
      : undefined;
  const dlProgress = (mode: PlaybackMode) =>
    selectedEntry
      ? downloads.progressFor(
          downloadId(detail.slug, selectedEntry.atEntryId, mode),
        )
      : undefined;
  const anyDlProgress = dlModes
    .map(dlProgress)
    .find((p) => p !== undefined);
  const anyDlDownloaded = dlModes.some((m) => {
    const r = dlRecord(m);
    return r !== undefined && !r.fileMissing;
  });

  const openDlSheet = () => {
    if (fixtureMode) {
      setActionError('Downloads are not available in demo mode.');
      return;
    }
    if (!downloadsSupported) {
      setActionError('Downloads are not available on web.');
      return;
    }
    setActionError(null);
    setDlSheetOpen(true);
  };

  return (
    <>
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.column}>
        <View style={styles.artWrap}>
          {cover ? (
            <Image source={{ uri: cover }} style={styles.cover} />
          ) : (
            <View style={[styles.cover, styles.coverPlaceholder]} />
          )}
          <View
            style={[styles.overlay, { top: insets.top + spacing.sm }]}
          >
            {backTile(true)}
            <View style={styles.overlayActions}>
              <Pressable
                onPress={onToggleSave}
                accessibilityRole="button"
                accessibilityLabel={saved ? 'Unsave theme' : 'Save theme'}
                accessibilityState={{ selected: saved }}
                style={({ pressed }) => [
                  styles.backHit,
                  pressed && styles.pressed,
                ]}
              >
                <View style={[styles.tile, styles.tileGlass]}>
                  {savePending ? (
                    <ActivityIndicator size="small" color={theme.text} />
                  ) : (
                    <Bookmark
                      size={19}
                      color={saved ? theme.accent : theme.text}
                      fill={saved ? theme.accent : 'transparent'}
                      strokeWidth={2}
                    />
                  )}
                </View>
              </Pressable>
              {glassAction(Share2, 'Share theme')}
            </View>
          </View>
          <Pressable
            onPress={() => openPlayer('watch')}
            accessibilityRole="button"
            accessibilityLabel="Play"
            style={({ pressed }) => [
              styles.fab,
              pressed && styles.pressed,
            ]}
          >
            <Play size={24} color={theme.onAccent} strokeWidth={2} />
          </Pressable>
        </View>

        <View style={styles.body}>
          <Text style={styles.song}>{detail.songTitle}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {detail.animeTitle}
            {artists.length > 0 ? ` · ${artists}` : ''}
          </Text>

          <View style={styles.chipRow}>
            {chips.map((chip, i) => (
              <View
                key={`${chip}-${i}`}
                style={[
                  styles.chip,
                  i === 0 && {
                    backgroundColor:
                      detail.type === 'ED' ? theme.tertiary : theme.accent,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    i === 0 && { color: theme.onAccent },
                  ]}
                >
                  {chip}
                </Text>
              </View>
            ))}
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={() => openPlayer('watch')}
              accessibilityRole="button"
              accessibilityLabel="Watch"
              style={({ pressed }) => [
                styles.watchButton,
                pressed && styles.pressed,
              ]}
            >
              <Play size={19} color={theme.onAccent} strokeWidth={2} />
              <Text style={styles.watchText}>Watch</Text>
            </Pressable>
            <Pressable
              onPress={() => openPlayer('listen')}
              disabled={!listenAvailable}
              accessibilityRole="button"
              accessibilityLabel="Listen"
              accessibilityState={{ disabled: !listenAvailable }}
              style={({ pressed }) => [
                styles.squareAction,
                !listenAvailable && styles.squareActionDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Headphones
                size={20}
                color={listenAvailable ? theme.text : theme.muted}
                strokeWidth={2}
              />
            </Pressable>
            <Pressable
              onPress={openSheet}
              accessibilityRole="button"
              accessibilityLabel="Add to playlist"
              style={({ pressed }) => [
                styles.squareAction,
                pressed && styles.pressed,
              ]}
            >
              <Plus size={20} color={theme.text} strokeWidth={2} />
            </Pressable>
            <Pressable
              onPress={openDlSheet}
              accessibilityRole="button"
              accessibilityLabel={
                anyDlProgress !== undefined
                  ? 'Downloading'
                  : anyDlDownloaded
                    ? 'Downloaded — manage downloads'
                    : 'Download for offline playback'
              }
              style={({ pressed }) => [
                styles.squareAction,
                pressed && styles.pressed,
              ]}
            >
              {anyDlProgress !== undefined ? (
                anyDlProgress !== null ? (
                  <Text style={styles.dlPercent}>
                    {Math.floor(anyDlProgress * 100)}%
                  </Text>
                ) : (
                  <ActivityIndicator size="small" color={theme.text} />
                )
              ) : anyDlDownloaded ? (
                <Check size={20} color={theme.accent} strokeWidth={2} />
              ) : (
                <Download size={20} color={theme.text} strokeWidth={2} />
              )}
            </Pressable>
          </View>

          {actionError && (
            <Text style={styles.actionError}>{actionError}</Text>
          )}

          <View style={styles.factCard}>
            {artists.length > 0 &&
              factRow(Mic, 'Artist', artists, false)}
            {factRow(
              Star,
              'Rating',
              `${aggAvg.toFixed(1)} · ${aggTotal}`,
              false,
            )}
            {factRow(Eye, 'Watches', `${detail.totalWatches}`, false)}
            {factRow(
              Headphones,
              'Listens',
              `${detail.totalListens}`,
              !hasMultipleVersions,
            )}
            {hasMultipleVersions &&
              factRow(
                Layers,
                'Versions',
                `${detail.entries.length}`,
                true,
              )}
          </View>

          <View style={styles.ratingCard}>
            <View style={styles.ratingHeader}>
              <Star size={16} color={theme.muted} strokeWidth={2} />
              <Text style={styles.ratingLabel}>Your rating</Text>
              {myScore !== null && (
                <Text style={styles.ratingValue}>{myScore} / 10</Text>
              )}
              {myScore !== null && signedIn && !fixtureMode && (
                <Pressable
                  onPress={onClearRating}
                  disabled={ratingBusy}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Clear your rating"
                  style={({ pressed }) => [
                    styles.clearRating,
                    pressed && styles.pressed,
                  ]}
                >
                  <X size={13} color={theme.muted} strokeWidth={2} />
                  <Text style={styles.clearRatingText}>Clear</Text>
                </Pressable>
              )}
            </View>
            {fixtureMode ? (
              <Text style={styles.ratingNote}>
                Rating is not available in demo mode.
              </Text>
            ) : !signedIn ? (
              <View style={styles.ratePrompt}>
                <Text style={styles.ratingNote}>
                  Log in to rate this theme.
                </Text>
                <Pressable
                  onPress={() => router.push('/login')}
                  accessibilityRole="button"
                  accessibilityLabel="Log in"
                  style={({ pressed }) => [
                    styles.loginChip,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.loginChipText}>Log in</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.scoreRow}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
                  const active = myScore === n;
                  return (
                    <Pressable
                      key={n}
                      onPress={() => onRate(n)}
                      disabled={ratingBusy}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Rate ${n} out of 10`}
                      style={({ pressed }) => [
                        styles.scoreChip,
                        active && styles.scoreChipActive,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.scoreChipText,
                          active && styles.scoreChipTextActive,
                        ]}
                      >
                        {n}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {ratingError && (
              <Text style={styles.ratingErrorText}>{ratingError}</Text>
            )}
          </View>

          {hasMultipleVersions && (
            <View style={styles.versionRow}>
              {detail.entries.map((entry, i) => (
                <Pressable
                  key={`${entry.atEntryId}-${i}`}
                  onPress={() => openPlayer('watch', i)}
                  accessibilityRole="button"
                  accessibilityLabel={`Play version ${entry.version}`}
                  style={({ pressed }) => [
                    styles.versionTile,
                    i === selectedEntryIndex && styles.versionTileActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.versionText,
                      i === selectedEntryIndex && styles.versionTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {entry.version}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          {similar.length > 0 && (
            <>
              <View style={styles.similarHeader}>
                <Text style={styles.similarHeading}>Similar themes</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.similarRail}
              >
                {similar.map((item) => (
                  <PosterCard
                    key={item.slug}
                    item={item}
                    onPress={() => router.push(`/theme/${item.slug}`)}
                  />
                ))}
              </ScrollView>
            </>
          )}

          <ThemeComments slug={detail.slug} />
        </View>
      </View>
    </ScrollView>

    <Modal
      visible={sheetOpen}
      transparent
      animationType="slide"
      onRequestClose={() => setSheetOpen(false)}
    >
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={styles.sheetDismiss}
          onPress={() => setSheetOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Add to playlist</Text>
            <Pressable
              onPress={() => setSheetOpen(false)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [
                styles.sheetClose,
                pressed && styles.pressed,
              ]}
            >
              <X size={18} color={theme.text} strokeWidth={2} />
            </Pressable>
          </View>

          {sheetLoading ? (
            <View style={styles.sheetCenter}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : sheetError ? (
            <Text style={styles.sheetNote}>{sheetError}</Text>
          ) : (
            <ScrollView
              style={styles.sheetList}
              showsVerticalScrollIndicator={false}
            >
              {(myPlaylists ?? []).map((p) => {
                const contained = containedIds.has(p.id);
                const busyRow = sheetBusyId === p.id;
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => addToPlaylist(p)}
                    disabled={busyRow}
                    accessibilityRole="button"
                    accessibilityLabel={
                      contained
                        ? `${p.name}, already contains this theme`
                        : `Add to ${p.name}`
                    }
                    style={({ pressed }) => [
                      styles.sheetRow,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.sheetRowIcon}>
                      <ListMusic size={17} color={theme.muted} strokeWidth={2} />
                    </View>
                    <View style={styles.sheetRowMain}>
                      <Text style={styles.sheetRowName} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text style={styles.sheetRowMeta} numberOfLines={1}>
                        {p.themeCount}{' '}
                        {p.themeCount === 1 ? 'theme' : 'themes'}
                      </Text>
                    </View>
                    {busyRow ? (
                      <ActivityIndicator size="small" color={theme.muted} />
                    ) : contained ? (
                      <Check size={18} color={theme.accent} strokeWidth={2} />
                    ) : (
                      <Plus size={18} color={theme.muted} strokeWidth={2} />
                    )}
                  </Pressable>
                );
              })}
              {(myPlaylists ?? []).length === 0 && (
                <Text style={styles.sheetNote}>
                  No playlists yet — create one below and this theme goes
                  straight in.
                </Text>
              )}
            </ScrollView>
          )}

          <View style={styles.sheetCreate}>
            <TextInput
              style={styles.sheetInput}
              value={newPlaylistName}
              onChangeText={setNewPlaylistName}
              placeholder="New playlist name"
              placeholderTextColor={theme.muted}
              maxLength={100}
              returnKeyType="done"
              onSubmitEditing={createAndAdd}
            />
            <Pressable
              onPress={createAndAdd}
              disabled={creatingInSheet}
              accessibilityRole="button"
              accessibilityLabel="Create playlist and add theme"
              style={({ pressed }) => [
                styles.sheetCreateButton,
                pressed && styles.pressed,
                creatingInSheet && styles.disabledButton,
              ]}
            >
              {creatingInSheet ? (
                <ActivityIndicator size="small" color={theme.onAccent} />
              ) : (
                <Text style={styles.sheetCreateText}>Create & add</Text>
              )}
            </Pressable>
          </View>

          {sheetMessage && (
            <Text style={styles.sheetMessage}>{sheetMessage}</Text>
          )}
        </View>
      </View>
    </Modal>

    <Modal
      visible={dlSheetOpen}
      transparent
      animationType="slide"
      onRequestClose={() => setDlSheetOpen(false)}
    >
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={styles.sheetDismiss}
          onPress={() => setDlSheetOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Download</Text>
            <Pressable
              onPress={() => setDlSheetOpen(false)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [
                styles.sheetClose,
                pressed && styles.pressed,
              ]}
            >
              <X size={18} color={theme.text} strokeWidth={2} />
            </Pressable>
          </View>
          <Text style={styles.dlSheetNote}>
            {selectedEntry
              ? `Version ${selectedEntry.version} — files stay on this device for offline playback.`
              : 'Files stay on this device for offline playback.'}
          </Text>

          {selectedEntry &&
            dlModes.map((mode) => {
              const id = downloadId(
                detail.slug,
                selectedEntry.atEntryId,
                mode,
              );
              const record = downloads.find(
                detail.slug,
                selectedEntry.atEntryId,
                mode,
              );
              const progress = downloads.progressFor(id);
              const downloading = progress !== undefined;
              const error = downloads.errorFor(id);
              const available =
                mode === 'listen'
                  ? listenAvailable
                  : isPlausibleUrl(
                      resolvePlaybackUrl(detail, selectedEntry, 'watch'),
                    );
              const ModeIcon = mode === 'watch' ? Play : Headphones;
              return (
                <View key={mode} style={styles.sheetRow}>
                  <View style={styles.sheetRowIcon}>
                    <ModeIcon size={17} color={theme.muted} strokeWidth={2} />
                  </View>
                  <View style={styles.sheetRowMain}>
                    <Text style={styles.sheetRowName}>
                      {mode === 'watch' ? 'Watch' : 'Listen'}
                    </Text>
                    <Text style={styles.sheetRowMeta} numberOfLines={1}>
                      {!available
                        ? mode === 'watch'
                          ? 'No video source for this version'
                          : 'No audio source for this version'
                        : downloading
                          ? 'Downloading…'
                          : record && !record.fileMissing
                            ? `${formatBytes(record.size)} · Saved on this device`
                            : record
                              ? 'File missing — download it again'
                              : mode === 'watch'
                                ? 'Video file'
                                : 'Audio file'}
                    </Text>
                    {error && !downloading && (
                      <Text style={styles.dlError}>{error}</Text>
                    )}
                  </View>
                  {downloading ? (
                    <View style={styles.dlTile}>
                      {progress !== null ? (
                        <Text style={styles.dlPercent}>
                          {Math.floor(progress * 100)}%
                        </Text>
                      ) : (
                        <ActivityIndicator size="small" color={theme.muted} />
                      )}
                    </View>
                  ) : record && !record.fileMissing ? (
                    <Pressable
                      onPress={() => void downloads.remove(id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete the ${mode === 'watch' ? 'video' : 'audio'} download`}
                      style={({ pressed }) => [
                        styles.dlTile,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Trash2 size={17} color={theme.muted} strokeWidth={2} />
                    </Pressable>
                  ) : available ? (
                    <Pressable
                      onPress={() => {
                        void downloads.start(detail, selectedEntry, mode);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={
                        record || error
                          ? `Download the ${mode === 'watch' ? 'video' : 'audio'} again`
                          : `Download the ${mode === 'watch' ? 'video' : 'audio'}`
                      }
                      style={({ pressed }) => [
                        styles.dlTile,
                        pressed && styles.pressed,
                      ]}
                    >
                      {record || error ? (
                        <RotateCcw
                          size={17}
                          color={theme.text}
                          strokeWidth={2}
                        />
                      ) : (
                        <Download
                          size={17}
                          color={theme.text}
                          strokeWidth={2}
                        />
                      )}
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
        </View>
      </View>
    </Modal>
    </>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.background,
  },
  column: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  topRow: {
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.sm,
  },
  backHit: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tile: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileSolid: {
    backgroundColor: theme.raised,
  },
  tileGlass: {
    // Translucent fill stands in for backdrop blur (no blur dependency
    // in this slice); both are derived from the active token set.
    backgroundColor: withOpacity(theme.background, 0.62),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: withOpacity(theme.text, 0.14),
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  message: {
    ...typeStyles.body,
    color: theme.muted,
    textAlign: 'center',
  },
  artWrap: {
    position: 'relative',
  },
  cover: {
    width: '100%',
    aspectRatio: 3 / 2,
    backgroundColor: theme.surface,
  },
  coverPlaceholder: {
    backgroundColor: theme.raised,
  },
  overlay: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 5,
  },
  overlayActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  fab: {
    position: 'absolute',
    right: spacing.screenEdge,
    bottom: -26,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.accent,
    borderWidth: 4,
    borderColor: theme.background,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 6,
    elevation: 6,
  },
  body: {
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.xl + 6, // clears the straddling FAB
    paddingBottom: spacing.xxxl,
  },
  song: {
    ...typeStyles.display,
    fontSize: 24,
    color: theme.text,
  },
  meta: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    marginTop: spacing.xs + 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  chip: {
    backgroundColor: theme.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  chipText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  watchButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: theme.accent,
    borderRadius: 14,
    minHeight: 46,
  },
  watchText: {
    ...typeStyles.sectionLabel,
    color: theme.onAccent,
  },
  squareAction: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  squareActionDisabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.85,
  },
  factCard: {
    marginTop: spacing.lg,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  factRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  factRowLast: {
    borderBottomWidth: 0,
  },
  factLabel: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  factValue: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    marginLeft: 'auto',
    flexShrink: 1,
    textAlign: 'right',
  },
  versionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  versionTile: {
    flex: 1,
    backgroundColor: theme.raised,
    borderRadius: radii.base,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
  },
  versionTileActive: {
    backgroundColor: withOpacity(theme.accent, 0.16),
  },
  versionText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  versionTextActive: {
    color: theme.onAccentContainer,
  },
  similarHeader: {
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  similarHeading: {
    ...typeStyles.heading,
    color: theme.text,
  },
  similarRail: {
    gap: spacing.sm,
  },
  actionError: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    marginTop: spacing.md,
    lineHeight: 18,
  },
  ratingCard: {
    marginTop: spacing.md,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  ratingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
  },
  ratingLabel: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  ratingValue: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  clearRating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 'auto',
    paddingVertical: 4,
    paddingHorizontal: spacing.xs,
  },
  clearRatingText: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  ratingNote: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    lineHeight: 18,
  },
  ratingErrorText: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    lineHeight: 18,
  },
  ratePrompt: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  loginChip: {
    backgroundColor: theme.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  loginChipText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccent,
  },
  scoreRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  scoreChip: {
    flex: 1,
    minHeight: 38,
    borderRadius: radii.base,
    backgroundColor: theme.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreChipActive: {
    backgroundColor: theme.accent,
    borderColor: 'transparent',
  },
  scoreChipText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  scoreChipTextActive: {
    color: theme.onAccent,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: withOpacity(theme.background, 0.72),
    justifyContent: 'flex-end',
  },
  sheetDismiss: {
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
    maxHeight: '82%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  sheetTitle: {
    ...typeStyles.heading,
    color: theme.text,
  },
  sheetClose: {
    width: 36,
    height: 36,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCenter: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  sheetList: {
    flexGrow: 0,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  sheetRowIcon: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetRowMain: {
    flex: 1,
    gap: 2,
  },
  sheetRowName: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  sheetRowMeta: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  sheetNote: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    lineHeight: 18,
    paddingVertical: spacing.md,
  },
  sheetCreate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  sheetInput: {
    flex: 1,
    ...typeStyles.body,
    color: theme.text,
    backgroundColor: theme.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.base,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    paddingVertical: 0,
  },
  sheetCreateButton: {
    backgroundColor: theme.accent,
    borderRadius: radii.base,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCreateText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccent,
  },
  disabledButton: {
    opacity: 0.5,
  },
  sheetMessage: {
    ...typeStyles.bodySmall,
    color: theme.onAccentContainer,
    marginTop: spacing.md,
    lineHeight: 18,
  },
  dlPercent: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  dlSheetNote: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  dlError: {
    ...typeStyles.caption,
    color: theme.accent,
    marginTop: 2,
    lineHeight: 16,
  },
  dlTile: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    backgroundColor: theme.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

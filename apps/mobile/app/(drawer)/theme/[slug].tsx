import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
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
import { VideoView } from 'expo-video';
import {
  Bookmark,
  Check,
  ChevronLeft,
  Download,
  Headphones,
  LayoutGrid,
  ListMusic,
  Maximize,
  Music,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Share2,
  Star,
  Trash2,
  Users,
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
import { ThemeComments } from '../../../src/components/ThemeComments';
import { ThemeRow } from '../../../src/components/ThemeRow';
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
  formatTime,
  isPlausibleUrl,
  resolvePlaybackUrl,
} from '../../../src/playback';
import { usePlayback } from '../../../src/usePlayback';
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
 * Theme detail — layout mirrors the WEBSITE's theme page
 * (ZadidSalman/Kaisen `app/theme/[slug]/ThemePageClient.tsx`) section
 * for section, in the app's own design system (DESIGN.md §6.7,
 * compact/icon-led):
 *
 *   1. Media hero — like the web, the player is EMBEDDED here:
 *      before play it is the artwork hero (grill/cover, glass
 *      back + save, accent play FAB); pressing Watch/Listen turns
 *      the hero itself into the player (video surface for watch,
 *      artwork + hidden surface for listen) with the control
 *      strip inside the hero — the page never navigates away.
 *      Playback runs on src/usePlayback.ts, shared with the
 *      player route the Library/playlists still open.
 *   2. Info header — anime title as a small accent eyebrow, the
 *      song title large, the artists line, one muted meta line
 *      (type/sequence · season · moods).
 *   3. Action bar — Watch/Listen segmented toggle (starts inline
 *      playback in that mode; Listen disabled when the selected
 *      entry has no audio, like the web's), then Download
 *      (primary, opens the download sheet) + add-to-playlist and
 *      share squares.
 *   4. Version Select — pill switcher, only when entries > 1.
 *      Like the web's VersionSwitcher it SELECTS the entry the
 *      Watch/Listen/download actions target — and while playing
 *      it switches the inline player's source, as the web's does.
 *      The default selection mirrors the web: the 'Standard'
 *      version when one exists, else the first entry.
 *   5. Stats bar — Score · Rates · Views · Plays, counts compacted
 *      with the web's formatCount.
 *   6. Rating card — the caller's own 1–10 rating (Slice M2).
 *   7. Comments — the shared ThemeComments section (Slice M5).
 *   8. Related themes — the web's categorised lists (Same Anime
 *      Themes / Franchise & Seasons / More by this Artist /
 *      Recommended for You) as ThemeRow lists, with the web's
 *      empty state when there is nothing related.
 *
 * Loading (the fix): every read this screen needs is keyed by the
 * slug alone, so ALL of them fire in parallel the moment the slug
 * is known — detail, similar, comments (mounted eagerly; the
 * component fetches on mount) and, when signed in, the favorite +
 * rating state. The page frame renders immediately: the detail
 * zone shows a spinner until the detail payload lands, and the
 * comments/related sections show their own local loading states
 * and fill in progressively — nothing waits on the slowest call.
 * (Before: detail first, similar + favorite/rating only after it
 * landed, comments only after first render.)
 *
 * Library/downloads behaviour is unchanged (Slices M2/M3): the save
 * toggle is the shared favorites store, Add opens the playlist
 * sheet, the download sheet is per selected entry, and downloads
 * work signed-out while demo mode and web answer honestly.
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

  /* Inline playback: null until the user presses Watch/Listen —
     the hero then becomes the player (see usePlayback). */
  const [playMode, setPlayMode] = useState<PlaybackMode | null>(null);
  const [barWidth, setBarWidth] = useState(0);
  const videoRef = useRef<VideoView>(null);

  /* Similar themes (Slice S8): 'loading' until the read settles;
     a failed fetch resolves to an empty list (the web's empty
     state), never an error surface. */
  const [similarState, setSimilarState] = useState<
    'loading' | 'done'
  >('loading');
  const [similar, setSimilar] = useState<ThemeSummary[]>([]);

  /* The detail read — fires immediately on slug, in parallel with
     everything below. */
  useEffect(() => {
    let live = true;
    setState('loading');
    setDetail(null);
    setSelectedEntryIndex(0);
    setPlayMode(null);
    fetchThemeBySlug(slug)
      .then((data) => {
        if (!live) return;
        if (data) {
          setDetail(data);
          // Web parity: the 'Standard' version is the default
          // selection when the theme has one.
          const standard = data.entries.findIndex(
            (e) => e.version === 'Standard',
          );
          setSelectedEntryIndex(standard >= 0 ? standard : 0);
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

  /* Similar themes — fired in parallel with the detail read (it
     only ever needed the slug). Fixture mode resolves [] from the
     client by design. */
  useEffect(() => {
    let live = true;
    setSimilarState('loading');
    setSimilar([]);
    fetchSimilarThemes(slug)
      .then((list) => {
        if (live) {
          setSimilar(list);
          setSimilarState('done');
        }
      })
      .catch(() => {
        if (live) {
          setSimilar([]);
          setSimilarState('done');
        }
      });
    return () => {
      live = false;
    };
  }, [slug]);

  /* Exact library state for this theme (Slice M2) — also keyed by
     the slug alone, so it fires in parallel with the detail read
     instead of waiting for it. Live API + signed-in only — signed-
     out and demo renders derive from the detail data alone. */
  useEffect(() => {
    setRatingState(null);
    setRatingError(null);
    setActionError(null);
    if (!signedIn || fixtureMode) return;
    let live = true;
    fetchFavoriteState(slug)
      .then((s) => {
        if (live) applyFavoriteState(s.slug, s.isFavorite);
      })
      .catch(() => {
        // The store's set stands; a failed check is not user-facing.
      });
    fetchRatingState(slug)
      .then((r) => {
        if (live) setRatingState(r);
      })
      .catch(() => {
        if (live) setRatingState(null);
      });
    return () => {
      live = false;
    };
  }, [slug, signedIn]);

  const selectedEntry = detail
    ? (detail.entries[selectedEntryIndex] ?? null)
    : null;
  const listenAvailable =
    detail !== null &&
    selectedEntry !== null &&
    entryHasAudio(detail, selectedEntry);

  /* Inline playback engine (src/usePlayback) — inactive until the
     user presses Watch/Listen; then the hero below is the player.
     Switching the selected entry while playing switches the source,
     like the web's VersionSwitcher driving its inline player. */
  const playback = usePlayback({
    slug: detail?.slug ?? slug,
    detail,
    entry: selectedEntry,
    mode: playMode ?? 'watch',
    active: playMode !== null && detail !== null,
  });

  /** Start (or switch to) inline playback in a mode, for an entry
      (defaults to the selected one). */
  const startPlayback = (
    mode: PlaybackMode,
    entryIndex = selectedEntryIndex,
  ) => {
    if (!detail) return;
    const entry = detail.entries[entryIndex];
    if (!entry) return;
    setSelectedEntryIndex(entryIndex);
    setPlayMode(mode);
  };

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

  if (state === 'missing' || state === 'error') {
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

  const ready = state === 'ready' && detail !== null;

  const cover = detail
    ? (detail.animeGrillImage ?? detail.animeCoverImage)
    : null;
  const artists = detail
    ? detail.allArtists.length > 0
      ? detail.allArtists.join(' / ')
      : (detail.artistName ?? '')
    : '';
  const metaParts: string[] = detail ? [`${detail.type} ${detail.sequence}`] : [];
  if (detail?.animeSeason && detail?.animeSeasonYear) {
    metaParts.push(`${detail.animeSeason} ${detail.animeSeasonYear}`);
  }
  if (detail) {
    for (const mood of detail.mood) metaParts.push(mood);
  }

  const hasMultipleVersions = (detail?.entries.length ?? 0) > 1;

  /* ---------------- Slice M2: save / rating / playlists ---------------- */

  const saved = detail ? favorites.isFavorite(detail.slug) : false;
  const savePending = detail ? favorites.isPending(detail.slug) : false;

  const onToggleSave = () => {
    if (!detail) return;
    setActionError(null);
    void favorites.toggle(detail.slug).then((err) => {
      if (err) setActionError(err);
    });
  };

  const onRate = (score: number) => {
    if (!detail || ratingBusy) return;
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
    if (!detail || ratingBusy) return;
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
    if (!detail) return;
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
    if (!detail || sheetBusyId) return;
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
    if (!detail || creatingInSheet) return;
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

  /** Aggregates shown in the stats bar — the rating state's copy is
      the freshest (every rating response carries it). */
  const aggAvg = ratingState?.avgRating ?? detail?.avgRating ?? 0;
  const aggTotal = ratingState?.totalRatings ?? detail?.totalRatings ?? 0;
  const myScore = ratingState?.myScore ?? null;

  /* ---------------- Related themes (web categorisation) ------------ */

  /** The web's buckets, in the web's order and with its tests:
      exact anime title → franchise/seasons (first-word match) →
      same artist (name or shared allArtists) → the rest. */
  const relatedGroups = useMemo(() => {
    if (!detail || similarState !== 'done') return [];
    const baseFirstWord = detail.animeTitle
      .split(':')[0]
      .split(' ')[0]
      .toLowerCase();
    const buckets: Record<string, ThemeSummary[]> = {
      sameAnime: [],
      otherSeasons: [],
      sameArtist: [],
      others: [],
    };
    for (const t of similar) {
      if (t.animeTitle === detail.animeTitle) {
        buckets.sameAnime.push(t);
      } else if (t.animeTitle.toLowerCase().includes(baseFirstWord)) {
        buckets.otherSeasons.push(t);
      } else if (
        (t.artistName &&
          detail.artistName &&
          t.artistName === detail.artistName) ||
        t.allArtists.some((a) => detail.allArtists.includes(a))
      ) {
        buckets.sameArtist.push(t);
      } else {
        buckets.others.push(t);
      }
    }
    const defs: { key: string; label: string; Icon: IconComponent }[] = [
      { key: 'sameAnime', label: 'Same Anime Themes', Icon: Music },
      { key: 'otherSeasons', label: 'Franchise & Seasons', Icon: LayoutGrid },
      { key: 'sameArtist', label: 'More by this Artist', Icon: Users },
      { key: 'others', label: 'Recommended for You', Icon: Star },
    ];
    return defs
      .map((d) => ({ ...d, items: buckets[d.key] }))
      .filter((g) => g.items.length > 0);
  }, [detail, similar, similarState]);

  /* ---------------- Slice M3: downloads (per selected entry) -------- */

  const dlModes: PlaybackMode[] = ['watch', 'listen'];
  const dlRecord = (mode: PlaybackMode) =>
    detail && selectedEntry
      ? downloads.find(detail.slug, selectedEntry.atEntryId, mode)
      : undefined;
  const dlProgress = (mode: PlaybackMode) =>
    detail && selectedEntry
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

  const statCell = (value: string, label: string) => (
    <View key={label} style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );

  const onStripSeek = (locationX: number) => {
    if (barWidth <= 0) return;
    playback.seekToRatio(locationX / barWidth);
  };

  /* The inline player's control strip — lives INSIDE the hero,
     along its bottom edge, in both modes (the design rule: the
     hero card IS the player; controls sit in the card, not in a
     separate surface). Play/pause (replay once ended), tap-to-
     seek with time labels, fullscreen in watch mode. */
  const playerStrip = (
    <View style={styles.playerStrip}>
      <Pressable
        onPress={playback.toggleMain}
        accessibilityRole="button"
        accessibilityLabel={
          playback.ended ? 'Replay' : playback.isPlaying ? 'Pause' : 'Play'
        }
        style={({ pressed }) => [
          styles.stripButton,
          pressed && styles.pressed,
        ]}
      >
        {playback.ended ? (
          <RotateCcw size={18} color={theme.onAccent} strokeWidth={2} />
        ) : playback.isPlaying ? (
          <Pause size={18} color={theme.onAccent} strokeWidth={2} />
        ) : (
          <Play size={18} color={theme.onAccent} strokeWidth={2} />
        )}
      </Pressable>
      <Pressable
        onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}
        onPress={(e) => onStripSeek(e.nativeEvent.locationX)}
        accessibilityRole="adjustable"
        accessibilityLabel="Seek"
        style={styles.stripSeekHit}
      >
        <View style={styles.seekTrack}>
          <View
            style={[
              styles.seekFill,
              { width: `${playback.fraction * 100}%` },
            ]}
          />
          <View
            style={[
              styles.seekKnob,
              { left: `${playback.fraction * 100}%` },
            ]}
          />
        </View>
      </Pressable>
      <Text style={styles.stripTime}>
        {formatTime(playback.progress.current)} /{' '}
        {formatTime(playback.progress.duration)}
      </Text>
      {playMode === 'watch' && (
        <Pressable
          onPress={() => {
            void videoRef.current?.enterFullscreen();
          }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Fullscreen"
          style={styles.stripIconButton}
        >
          <Maximize size={18} color={theme.text} strokeWidth={2} />
        </Pressable>
      )}
    </View>
  );

  return (
    <>
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.column}>
        {!ready || !detail ? (
          /* Detail zone placeholder — the frame (and the sections
             below, which fetch on their own) render immediately;
             only this zone waits for the detail payload. */
          <View>
            <View style={styles.coverPlaceholder}>
              <View
                style={[styles.overlay, { top: insets.top + spacing.sm }]}
              >
                {backTile(true)}
              </View>
            </View>
            <View style={styles.loadingZone}>
              <ActivityIndicator color={theme.accent} />
            </View>
          </View>
        ) : (
          <>
            {/* 1 — Media hero (the player, once playing) */}
            <View style={styles.artWrap}>
              {playMode === 'watch' ? (
                <View style={styles.heroPlayer}>
                  <VideoView
                    ref={videoRef}
                    player={playback.player}
                    style={styles.heroVideo}
                    contentFit="contain"
                    nativeControls={false}
                  />
                  {playback.buffering && (
                    <View style={styles.heroCenter}>
                      <ActivityIndicator color={theme.accent} size="large" />
                    </View>
                  )}
                  {playerStrip}
                </View>
              ) : (
                <>
                  {cover ? (
                    <Image source={{ uri: cover }} style={styles.cover} />
                  ) : (
                    <View style={[styles.cover, styles.coverEmpty]} />
                  )}
                  {playMode === 'listen' && (
                    <>
                      {/* Audio plays through the player; the surface
                          stays mounted but invisible, so listen mode
                          keeps the artwork as its face. */}
                      <VideoView
                        player={playback.player}
                        style={styles.hiddenSurface}
                        nativeControls={false}
                      />
                      {playerStrip}
                    </>
                  )}
                </>
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
                </View>
              </View>
              {playMode === null && (
                <Pressable
                  onPress={() => startPlayback('watch')}
                  accessibilityRole="button"
                  accessibilityLabel="Play"
                  style={({ pressed }) => [
                    styles.fab,
                    pressed && styles.pressed,
                  ]}
                >
                  <Play size={24} color={theme.onAccent} strokeWidth={2} />
                </Pressable>
              )}
            </View>

            <View style={styles.body}>
              {/* 2 — Info header */}
              <Text style={styles.eyebrow} numberOfLines={1}>
                {detail.animeTitle.toUpperCase()}
              </Text>
              <Text style={styles.song}>{detail.songTitle}</Text>
              {artists.length > 0 && (
                <Text style={styles.artists} numberOfLines={2}>
                  {artists}
                </Text>
              )}
              <Text style={styles.meta} numberOfLines={1}>
                {metaParts.join(' · ')}
              </Text>

              {/* Inline playback problems surface here, under the
                  hero — the strip stays clean. */}
              {playMode !== null && playback.unavailable ? (
                <Text style={styles.playerNote}>
                  {fixtureMode
                    ? 'Playback is not available in demo mode for this theme.'
                    : 'No playable source is available for this version.'}
                </Text>
              ) : playMode !== null && playback.playerError ? (
                <View style={styles.playerErrorRow}>
                  <Text style={[styles.playerNote, styles.playerNoteFlex]}>
                    {playback.playerError}
                  </Text>
                  <Pressable
                    onPress={playback.retry}
                    accessibilityRole="button"
                    accessibilityLabel="Try again"
                    style={({ pressed }) => [
                      styles.retryChip,
                      pressed && styles.pressed,
                    ]}
                  >
                    <RotateCcw size={13} color={theme.onAccent} strokeWidth={2} />
                    <Text style={styles.retryChipText}>Try again</Text>
                  </Pressable>
                </View>
              ) : null}

              {/* 3 — Action bar */}
              <View style={styles.modeToggle}>
                <Pressable
                  onPress={() => startPlayback('watch')}
                  accessibilityRole="button"
                  accessibilityLabel="Watch"
                  accessibilityState={{ selected: playMode !== 'listen' }}
                  style={({ pressed }) => [
                    styles.modeSegment,
                    playMode !== 'listen' && styles.modeSegmentActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Play
                    size={17}
                    color={
                      playMode !== 'listen' ? theme.onAccent : theme.text
                    }
                    strokeWidth={2}
                  />
                  <Text
                    style={
                      playMode !== 'listen'
                        ? styles.modeSegmentTextActive
                        : styles.modeSegmentText
                    }
                  >
                    Watch
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => startPlayback('listen')}
                  disabled={!listenAvailable}
                  accessibilityRole="button"
                  accessibilityLabel="Listen"
                  accessibilityState={{
                    disabled: !listenAvailable,
                    selected: playMode === 'listen',
                  }}
                  style={({ pressed }) => [
                    styles.modeSegment,
                    playMode === 'listen' && styles.modeSegmentActive,
                    !listenAvailable && styles.modeSegmentDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Headphones
                    size={17}
                    color={
                      !listenAvailable
                        ? theme.muted
                        : playMode === 'listen'
                          ? theme.onAccent
                          : theme.text
                    }
                    strokeWidth={2}
                  />
                  <Text
                    style={[
                      playMode === 'listen'
                        ? styles.modeSegmentTextActive
                        : styles.modeSegmentText,
                      !listenAvailable && { color: theme.muted },
                    ]}
                  >
                    Listen
                  </Text>
                </Pressable>
              </View>

              <View style={styles.actions}>
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
                    styles.downloadButton,
                    pressed && styles.pressed,
                  ]}
                >
                  {anyDlProgress !== undefined ? (
                    anyDlProgress !== null ? (
                      <Text style={styles.downloadButtonText}>
                        {Math.floor(anyDlProgress * 100)}%
                      </Text>
                    ) : (
                      <ActivityIndicator
                        size="small"
                        color={theme.onAccent}
                      />
                    )
                  ) : (
                    <>
                      {anyDlDownloaded ? (
                        <Check
                          size={19}
                          color={theme.onAccent}
                          strokeWidth={2}
                        />
                      ) : (
                        <Download
                          size={19}
                          color={theme.onAccent}
                          strokeWidth={2}
                        />
                      )}
                      <Text style={styles.downloadButtonText}>Download</Text>
                    </>
                  )}
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
                  <ListMusic size={20} color={theme.text} strokeWidth={2} />
                </Pressable>
                {/* Share stays visual-only, exactly as before — no
                    share behaviour exists in the app yet; the web
                    copies the page link. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Share theme"
                  style={({ pressed }) => [
                    styles.squareAction,
                    pressed && styles.pressed,
                  ]}
                >
                  <Share2 size={19} color={theme.text} strokeWidth={2} />
                </Pressable>
              </View>

              {actionError && (
                <Text style={styles.actionError}>{actionError}</Text>
              )}

              {/* 4 — Version Select (web VersionSwitcher semantics:
                  selects the entry the actions above target) */}
              {hasMultipleVersions && (
                <View style={styles.versionSection}>
                  <Text style={styles.sectionEyebrow}>Version Select</Text>
                  <View style={styles.versionRow}>
                    {detail.entries.map((entry, i) => (
                      <Pressable
                        key={`${entry.atEntryId}-${i}`}
                        onPress={() => setSelectedEntryIndex(i)}
                        accessibilityRole="button"
                        accessibilityLabel={`Select version ${entry.version}`}
                        accessibilityState={{
                          selected: i === selectedEntryIndex,
                        }}
                        style={({ pressed }) => [
                          styles.versionTile,
                          i === selectedEntryIndex &&
                            styles.versionTileActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.versionText,
                            i === selectedEntryIndex &&
                              styles.versionTextActive,
                          ]}
                          numberOfLines={1}
                        >
                          {entry.version}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

              {/* 5 — Stats bar */}
              <View style={styles.statsBar}>
                {statCell(aggAvg.toFixed(1), 'Score')}
                {statCell(formatCount(aggTotal), 'Rates')}
                {statCell(formatCount(detail.totalWatches), 'Views')}
                {statCell(formatCount(detail.totalListens), 'Plays')}
              </View>

              {/* 6 — Rating card */}
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
            </View>
          </>
        )}

        {/* 7 — Comments (mounted eagerly: its fetch fires in
            parallel with the detail read, and the component
            carries its own loading state) */}
        <View style={styles.lowerBody}>
          <ThemeComments slug={slug} />

          {/* 8 — Related themes, the web's categorised lists */}
          {!fixtureMode && (
            <View style={styles.relatedSection}>
              {!ready || similarState === 'loading' ? (
                <View style={styles.relatedLoading}>
                  <ActivityIndicator color={theme.accent} />
                </View>
              ) : similar.length === 0 ? (
                <Text style={styles.relatedEmpty}>
                  No related themes found for this track.
                </Text>
              ) : (
                relatedGroups.map((group) => (
                  <View key={group.key} style={styles.relatedGroup}>
                    <View style={styles.relatedHeader}>
                      <group.Icon
                        size={15}
                        color={theme.accent}
                        strokeWidth={2}
                      />
                      <Text style={styles.relatedHeading}>
                        {group.label}
                      </Text>
                    </View>
                    {group.items.map((item) => (
                      <ThemeRow
                        key={item.slug}
                        item={item}
                        onPress={() => router.push(`/theme/${item.slug}`)}
                      />
                    ))}
                  </View>
                ))
              )}
            </View>
          )}
        </View>
      </View>
    </ScrollView>

    {detail && (
      <>
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
    )}
    </>
  );
}

/** The web's formatCount (lib/utils), ported verbatim. */
function formatCount(n: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.floor(n).toString();
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
  coverEmpty: {
    backgroundColor: theme.raised,
  },
  coverPlaceholder: {
    width: '100%',
    aspectRatio: 3 / 2,
    backgroundColor: theme.surface,
    position: 'relative',
  },
  loadingZone: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
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
  heroPlayer: {
    position: 'relative',
    backgroundColor: '#000',
  },
  heroVideo: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
  },
  hiddenSurface: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  heroCenter: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playerStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: withOpacity(theme.background, 0.72),
    zIndex: 4,
  },
  stripButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripIconButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripSeekHit: {
    flex: 1,
    paddingVertical: spacing.sm,
  },
  seekTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.raised,
    justifyContent: 'center',
  },
  seekFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.accent,
  },
  seekKnob: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    backgroundColor: theme.accent,
  },
  stripTime: {
    ...typeStyles.mono,
    color: theme.text,
  },
  playerNote: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    marginTop: spacing.md,
    lineHeight: 18,
  },
  playerNoteFlex: {
    flex: 1,
    marginTop: 0,
  },
  playerErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  retryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: theme.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  retryChipText: {
    ...typeStyles.caption,
    color: theme.onAccent,
  },
  body: {
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.xl + 6, // clears the straddling FAB
  },
  lowerBody: {
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.xxxl,
  },
  eyebrow: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.accent,
    letterSpacing: 1.6,
  },
  song: {
    ...typeStyles.display,
    fontSize: 26,
    color: theme.text,
    marginTop: spacing.xs,
  },
  artists: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
    marginTop: spacing.sm,
  },
  meta: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    marginTop: spacing.xs + 2,
  },
  modeToggle: {
    flexDirection: 'row',
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 14,
    padding: 3,
    gap: 3,
    marginTop: spacing.lg,
  },
  modeSegment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 40,
    borderRadius: 11,
  },
  modeSegmentActive: {
    backgroundColor: theme.accent,
  },
  modeSegmentDisabled: {
    opacity: 0.45,
  },
  modeSegmentText: {
    ...typeStyles.sectionLabel,
    fontSize: 13,
    color: theme.text,
  },
  modeSegmentTextActive: {
    ...typeStyles.sectionLabel,
    fontSize: 13,
    color: theme.onAccent,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
    marginTop: spacing.sm + 2,
  },
  downloadButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: theme.accent,
    borderRadius: 14,
    minHeight: 46,
  },
  downloadButtonText: {
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
  pressed: {
    opacity: 0.85,
  },
  actionError: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    marginTop: spacing.md,
    lineHeight: 18,
  },
  sectionEyebrow: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  versionSection: {
    marginTop: spacing.lg,
  },
  versionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  versionTile: {
    backgroundColor: theme.raised,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
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
  statsBar: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  statValue: {
    ...typeStyles.heading,
    color: theme.text,
  },
  statLabel: {
    ...typeStyles.caption,
    color: theme.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
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
  relatedSection: {
    marginTop: spacing.xl,
  },
  relatedLoading: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  relatedEmpty: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  relatedGroup: {
    marginBottom: spacing.lg,
  },
  relatedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  relatedHeading: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
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

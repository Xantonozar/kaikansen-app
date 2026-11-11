import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from 'expo-router';
import { VideoView } from 'expo-video';
import {
  Check,
  ChevronLeft,
  Download,
  Headphones,
  Heart,
  LayoutGrid,
  ListPlus,
  Music,
  Play,
  RotateCcw,
  Share2,
  Star,
  Trash2,
  Users,
  X,
} from 'lucide-react-native';
import type {
  PlaybackMode,
  ThemeDetail,
  ThemeRatingState,
  ThemeSummary,
} from '@kaikansen/contracts';
import {
  cacheKeyFor,
  fetchSimilarThemes,
  fetchThemeBySlug,
  fixtureMode,
  subscribeCache,
} from '../../../src/api';
import { ThemeComments } from '../../../src/components/ThemeComments';
import {
  SkeletonBlock,
  SkeletonThemeRow,
} from '../../../src/components/Skeleton';
import { ThemeRow } from '../../../src/components/ThemeRow';
import { ThemeRowMenu } from '../../../src/components/ThemeRowMenu';
import { AddToPlaylistSheet } from '../../../src/components/AddToPlaylistSheet';
import { DetailListenHero } from '../../../src/components/DetailListenHero';
import { DetailWatchHero } from '../../../src/components/DetailWatchHero';
import { AppImage } from '../../../src/components/AppImage';
import { detailBackendForMode } from '../../../src/detailPlayer';
import { useAuth } from '../../../src/auth';
import {
  applyFavoriteState,
  useFavorites,
} from '../../../src/favoritesStore';
import {
  clearRating as deleteRating,
  fetchFavoriteState,
  fetchRatingState,
  setRating as putRating,
} from '../../../src/libraryApi';
import {
  entryHasAudio,
  isPlausibleUrl,
  resolvePlaybackUrl,
} from '../../../src/playback';
import {
  queueItemFromSummary,
  queueItemsFromSummaries,
  usePlaybackSlowSession,
  type QueueItem,
} from '../../../src/playback-context';
import { useOpenThemesAs } from '../../../src/playbackSettings';
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
 *      the hero itself into the player (video surface for watch;
 *      for listen, the design's lavender card — centred artwork,
 *      corner play/pause disc, waveform row, time row) with the
 *      control strip inside the hero — the page never navigates
 *      away.
 *      Playback runs on the shared session (src/playback-context
 *      .tsx): Watch/Listen claims it, and it keeps playing under
 *      the mini player after leaving — the player route the
 *      Library/playlists still open binds to the same session.
 *      Perf problem 12: the hero's two backends are separate
 *      components (DetailWatchHero / DetailListenHero) and only
 *      the ACTIVE mode's is mounted; progress renders inside
 *      their progress components off the progress channel, so a
 *      progress tick never re-renders this page body.
 *      Per-mode surfaces (2026-11-11 restructure): each backend
 *      mounts its OWN video surface in its mode's form (watch
 *      born visible, listen born hidden) — the pre-fix shape
 *      that worked in the field, restored after the interim
 *      always-mounted style-flipped page surface shipped in
 *      1.0.0/1.0.1 and the owner's field reports indicted it
 *      (audio fine, video dead or dying seconds in). The
 *      pause/detach/resume discipline lives in the engine
 *      (usePlayback surfaceDetach + the readiness gate).
 *   2. Watch/Listen segmented toggle — directly under the hero
 *      (starts inline playback in that mode; Listen disabled when
 *      the selected entry has no audio, like the web's).
 *   3. Info header — the song title large, the artists line, then
 *      the meta row: anime title · season pill ("FALL 1995").
 *   4. Action row — the design's four lavender discs (design law
 *      #6): favourite (heart — the shared favorites store, the
 *      hero-overlay bookmark's replacement), add-to-playlist,
 *      download (opens the download sheet; shows % while a
 *      download runs and a check once downloaded), share (the
 *      system share sheet with the theme's web URL — the web
 *      copies that same link).
 *   5. Version Select — pill switcher, only when entries > 1.
 *      Like the web's VersionSwitcher it SELECTS the entry the
 *      Watch/Listen/download actions target — and while playing
 *      it switches the inline player's source, as the web's does.
 *      The default selection mirrors the web: the 'Standard'
 *      version when one exists, else the first entry.
 *   6. Rating card — one white card per the v7 design: the
 *      Community score (big, with its star) + Rates + Plays on
 *      top (counts compacted with the web's formatCount), a
 *      divider, then "Your rating" with the caller's score as a
 *      mauve "N / 10" pill and 10 tappable stars (design law #5;
 *      Slice M2's rating behaviour). The old separate stats bar's
 *      Views cell is not in the v7 card — totalWatches stays in
 *      the payload, just not drawn here (Slice 6, measured).
 *   7. Comments — the shared ThemeComments section (Slice M5).
 *   8. Related themes — the web's categorised lists (Same Anime
 *      Themes / Franchise & Seasons / More by this Artist /
 *      Recommended for You) as ThemeRow lists, with the web's
 *      empty state when there is nothing related. (Owner's ruling
 *      2026-11-09: Comments above Similar — Slice 6's v7 order
 *      reversed.)
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
/** Bar count of the Listen hero's waveform (the mock's row). */
const WAVE_BAR_COUNT = 22;

/**
 * Waveform bar heights for the Listen hero — DECORATIVE. The API
 * carries no per-theme waveform data, so the bars are a
 * deterministic pseudo-random pattern seeded by the theme slug
 * (same theme, same shape, every visit); only the played/unplayed
 * COLOUR split is real, driven by the playback fraction. Heights
 * span the mock's measured ≈6–27pt.
 */
function waveBarHeights(seed: string): number[] {
  let state = 0;
  for (let i = 0; i < seed.length; i++) {
    state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const heights: number[] = [];
  for (let i = 0; i < WAVE_BAR_COUNT; i++) {
    // mulberry32 — tiny deterministic PRNG.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    heights.push(Math.round(6 + r * 21));
  }
  return heights;
}

export default function ThemeDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { status: authStatus } = useAuth();
  const favorites = useFavorites();
  const downloads = useDownloads();
  /* Shared playback session (src/playback-context.tsx): this screen
     claims it via Watch/Listen; `playback` below is the provider's
     one engine, not a private hook instance. Perf problem 12: the
     page reads the session through the SLOW channel
     (usePlaybackSlowSession) — the engine's slow object, stable
     across progress ticks — so a progress tick never re-renders
     this page body; the ticks are consumed inside the heroes'
     progress components (src/components/DetailProgress.tsx). */
  const { playback, session, startSession, updateSession, endSession } =
    usePlaybackSlowSession();
  const sessionSlugRef = useRef<string | null>(session.slug);
  useEffect(() => {
    sessionSlugRef.current = session.slug;
  }, [session.slug]);
  /* Single-owner video surface (2026-11-11 fix): the page owns
     the hero zone's ONE surface view + its fullscreen ref; the
     heroes render chrome around it and never mount a surface
     (see the hero zone below). */
  const videoRef = useRef<VideoView>(null);
  const enterFullscreen = useCallback(() => {
    void videoRef.current?.enterFullscreen();
  }, []);
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
  /* The add-to-playlist picker is the shared AddToPlaylistSheet
     (Slice 5 extraction) — this screen only tracks its visibility. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dlSheetOpen, setDlSheetOpen] = useState(false);

  /* Inline playback: null until the user presses Watch/Listen —
     the hero then becomes the player (the shared session, see
     src/playback-context.tsx). */
  const [playMode, setPlayMode] = useState<PlaybackMode | null>(null);
  /* Playback plan (2026-11-10): the page OPENS on the saved
     "Open themes as" side (Settings → Playback; default Listen).
     The toggle shows that side selected from the first paint,
     and the engine preloads that mode's media in the background
     (preload only — NO autoplay) so the eventual tap starts
     near-instantly. The toggle's selected side is therefore
     `playMode ?? openMode` everywhere below. */
  const { mode: openMode } = useOpenThemesAs();
  const shownMode: PlaybackMode = playMode ?? openMode;

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
    /* Landing on a different theme ends any live session held for
       another slug — the old per-screen hook unloaded on slug
       change; the shared session keeps that reset deliberately. */
    if (sessionSlugRef.current !== slug) endSession();
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

  /* Silent swap for the similar rail (perf problem 5): a
     background revalidation of the CATALOGUE-cached read replaces
     the rail in place. */
  useEffect(() => {
    if (fixtureMode) return;
    return subscribeCache<ThemeSummary[]>(
      cacheKeyFor(`/themes/${encodeURIComponent(slug)}/similar`),
      (fresh) => {
        setSimilar(fresh);
        setSimilarState('done');
      },
    );
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
  /* While this screen's PASSIVE claim is live (inactive, this
     slug), switching versions retargets the preload at the new
     entry — the same direct claim the passive effect made, with
     the new entry's key + chain. While PLAYING, the version
     tiles' existing updateSession path owns the switch. */
  const retargetPreload = (entryIndex: number) => {
    if (!detail) return;
    const entry = detail.entries[entryIndex];
    if (!entry) return;
    if (session.active || session.slug !== detail.slug) return;
    startSession(
      {
        slug: detail.slug,
        detail,
        entry,
        entryIdOverride: null,
        mode: shownMode,
        active: false,
        watchAudioFallback: true,
        preloadKey: `${detail.slug}:${entry.atEntryId}:${shownMode}`,
      },
      {
        items: [
          { ...queueItemFromSummary(detail), atEntryId: entry.atEntryId },
        ],
        index: 0,
      },
    );
  };
  const listenAvailable =
    detail !== null &&
    selectedEntry !== null &&
    entryHasAudio(detail, selectedEntry);

  /** Start (or switch to) inline playback in a mode, for an entry
      (defaults to the selected one) — claims the shared session;
      the hero below then renders the provider's engine, and the
      session keeps playing under the mini player after leaving.
      Switching the selected entry while playing switches the
      session's entry (see the Version Select tiles), like the
      web's VersionSwitcher driving its inline player. */
  const startPlayback = (
    mode: PlaybackMode,
    entryIndex = selectedEntryIndex,
  ) => {
    if (!detail) return;
    const entry = detail.entries[entryIndex];
    if (!entry) return;
    setSelectedEntryIndex(entryIndex);
    setPlayMode(mode);
    /* Queue claim (Slice 2.5): [this theme, ...the similar/
       related themes already fetched for this screen], current
       theme at index 0 carrying its selected entry; similar
       items are entry-less (each resolves to its first entry).
       If similar hasn't loaded yet — or came back empty — the
       queue is just this theme, and Next simply has nowhere to
       go. The similar list is snapshotted at press time; a list
       that lands later does not rewrite a live queue. */
    const currentItem: QueueItem = {
      ...queueItemFromSummary(detail),
      atEntryId: entry.atEntryId,
    };
    const seen = new Set<string>([detail.slug]);
    const related: QueueItem[] = [];
    for (const item of queueItemsFromSummaries(similar)) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      related.push(item);
    }
    startSession(
      {
        slug: detail.slug,
        detail,
        entry,
        entryIdOverride: null,
        mode,
        active: true,
        // W2: a Watch claim from this screen degrades to the
        // audio chain when every video candidate fails — the
        // hero below renders the artwork + audio-only note off
        // playback.audioFallback instead of a dead black frame.
        watchAudioFallback: true,
        // Playback plan: the claim key matches the passive
        // preload's key (below), so activating adopts the
        // preloaded source instead of loading it again.
        preloadKey: `${detail.slug}:${entry.atEntryId}:${mode}`,
      },
      { items: [currentItem, ...related], index: 0 },
    );
  };

  /* Passive preload claim (playback plan, 2026-11-10): when the
     detail lands and NO live session is playing another slug,
     claim the session INACTIVE in the open mode — the provider
     turns that into the mode-matched preload (Listen: the whole
     .ogg through expo-audio; Watch: the video through
     expo-video), with no autoplay. The Watch/Listen tap then
     activates through startPlayback above and adopts the
     preload. Leaving for another slug ends the session as
     before (the detail effect's endSession), which drops the
     preload with it. A passive claim never disturbs a live
     session for THIS slug (it is already playing) and never
     claims while the screen is still loading. */
  useEffect(() => {
    if (state !== 'ready' || !detail || !selectedEntry) return;
    if (session.active) return;
    if (session.slug !== null && session.slug !== detail.slug) return;
    startSession(
      {
        slug: detail.slug,
        detail,
        entry: selectedEntry,
        entryIdOverride: null,
        mode: shownMode,
        active: false,
        watchAudioFallback: true,
        preloadKey: `${detail.slug}:${selectedEntry.atEntryId}:${shownMode}`,
      },
      {
        items: [
          {
            ...queueItemFromSummary(detail),
            atEntryId: selectedEntry.atEntryId,
          },
        ],
        index: 0,
      },
    );
    // shownMode is read live on purpose: the effect re-fires on
    // the inputs that change WHAT should preload (detail, entry);
    // a mode flip is handled by the toggle arms below, which
    // re-claim directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, detail, selectedEntry, session.active, session.slug]);

  /* Re-attach on focus: if the shared session is live for THIS
     theme (started here, or on the player route), the hero shows
     it playing, with the version selection synced to the
     session's entry; if the session moved on to another theme
     while this screen was away, the stale playing state clears
     back to the artwork hero. */
  useFocusEffect(
    useCallback(() => {
      if (session.active && session.slug === slug) {
        if (playMode === null) setPlayMode(session.mode);
        if (detail && session.entry) {
          const entryId = session.entry.atEntryId;
          const idx = detail.entries.findIndex(
            (e) => e.atEntryId === entryId,
          );
          if (idx >= 0) setSelectedEntryIndex(idx);
        }
      } else if (playMode !== null) {
        setPlayMode(null);
      }
    }, [
      session.active,
      session.slug,
      session.mode,
      session.entry,
      slug,
      detail,
      playMode,
    ]),
  );

  /* The hero FAB / mode toggle's inactive arm (playback plan):
     while nothing is playing, tapping the mode that is NOT shown
     just flips the shown side and retargets the preload — no
     playback starts (preload follows the mode). Tapping the
     shown side activates it through startPlayback. While
     playing, both arms keep today's behaviour (startPlayback in
     that mode — the mid-page switch loads the other file). */
  const onModeArm = (mode: PlaybackMode) => {
    if (playMode !== null || (session.active && session.slug === slug)) {
      startPlayback(mode);
      return;
    }
    if (mode !== shownMode && detail && selectedEntry) {
      startSession(
        {
          slug: detail.slug,
          detail,
          entry: selectedEntry,
          entryIdOverride: null,
          mode,
          active: false,
          watchAudioFallback: true,
          preloadKey: `${detail.slug}:${selectedEntry.atEntryId}:${mode}`,
        },
        {
          items: [
            {
              ...queueItemFromSummary(detail),
              atEntryId: selectedEntry.atEntryId,
            },
          ],
          index: 0,
        },
      );
      return;
    }
    startPlayback(mode);
  };

  /** Rounded-square back button — now only the error/missing
      state's; the ready screen's back lives in the header row
      above the hero (detailHeader below). */
  const backTile = () => (
    <Pressable
      onPress={() => router.back()}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={styles.backHit}
    >
      <View style={[styles.tile, styles.tileSolid]}>
        <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
      </View>
    </Pressable>
  );

  if (state === 'missing' || state === 'error') {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {backTile()}
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
  const hasMultipleVersions = (detail?.entries.length ?? 0) > 1;

  /* Listen hero waveform (decorative bars, real played split —
     see waveBarHeights). Stable per theme via the slug seed. */
  const waveHeights = useMemo(
    () => waveBarHeights(detail?.slug ?? slug),
    [detail?.slug, slug],
  );

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

  /**
   * Share (Slice 6) — the design's fourth action disc, made real:
   * the system share sheet carrying the theme's WEB page URL. The
   * web's own share affordance copies exactly this link
   * (kaiseen.vercel.app/theme/<slug> — the web theme route), so
   * the app shares what the web would. A dismissed sheet resolves
   * (no error); a genuine failure is swallowed quietly — sharing
   * is best-effort chrome, never an error surface.
   */
  const onShare = () => {
    if (!detail) return;
    void Share.share({
      title: `${detail.songTitle} — ${detail.animeTitle}`,
      message: `${detail.songTitle} (${detail.animeTitle}) on Kaikansen: https://kaiseen.vercel.app/theme/${detail.slug}`,
    }).catch(() => {});
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
    setActionError(null);
    setSheetOpen(true);
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

  /* Perf problem 12 — the player-backend split: exactly ONE
     backend hero mounts, the active mode's (detailPlayer.ts).
     The Watch/Listen heroes are separate components
     (DetailWatchHero / DetailListenHero) rendering the shared
     engine's slow channel; their progress halves consume the
     progress channel internally, so no tick reaches this page.
     Per-mode surfaces (2026-11-11 restructure): each hero
     mounts its OWN surface in its mode's form (detailPlayer
     .detailSurfaceMount — watch born visible, listen born
     hidden); the page owns no surface. The swap runs under the
     engine's pause/detach/resume-gate discipline. */
  const backend = detailBackendForMode(playMode);

  /* Screen header (design polish pass): the mock draws a header
     row ABOVE the hero — bare back chevron left, the share / ⋮
     pair right — instead of a glass back tile floating over the
     artwork. The ⋮ is the shared ThemeRowMenu (Play / View theme
     / Save / Add to playlist / Download, all wired); its Play
     starts watch playback here. While the detail loads, the row
     carries the back chevron alone. */
  const detailHeader = (
    <View
      style={[styles.detailHeader, { paddingTop: insets.top + spacing.sm }]}
    >
      <Pressable
        onPress={() => router.back()}
        hitSlop={3}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.backHit}
      >
        <ChevronLeft size={24} color={theme.text} strokeWidth={2} />
      </Pressable>
      {ready && detail ? (
        <View style={styles.headerActions}>
          <Pressable
            onPress={onShare}
            hitSlop={3}
            accessibilityRole="button"
            accessibilityLabel="Share theme"
            style={styles.headerActionHit}
          >
            <Share2 size={20} color={theme.text} strokeWidth={2} />
          </Pressable>
          <ThemeRowMenu
            item={detail}
            onPlay={() => startPlayback('watch')}
          />
        </View>
      ) : null}
    </View>
  );

  return (
    <>
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.column}>
        {!ready || !detail ? (
          /* Detail zone placeholder — the frame (and the sections
             below, which fetch on their own) render immediately;
             only this zone waits for the detail payload. Skeleton
             in the page's shape (speed batch skeleton sweep): the
             hero block already stands via coverPlaceholder; below
             it, the meta lines + theme-row shapes the loaded page
             carries. No page spinner. */
          <View>
            {detailHeader}
            <View style={styles.coverPlaceholder} />
            <View style={styles.skeletonMeta}>
              <SkeletonBlock width="68%" height={18} radius={6} />
              <SkeletonBlock width="42%" height={13} radius={5} />
              <SkeletonBlock width="54%" height={13} radius={5} />
            </View>
            <View style={styles.skeletonRows}>
              <SkeletonThemeRow />
              <SkeletonThemeRow />
              <SkeletonThemeRow />
            </View>
          </View>
        ) : (
          <>
            {detailHeader}
            {/* 1 — Media hero (the player, once playing) */}
            <View style={styles.artWrap}>
              {backend === 'watch' ? (
                /* Perf problem 12: the Watch backend component —
                   mounted only in watch mode; it renders the
                   watch chrome AND its own born-visible surface
                   (2026-11-11 restructure — per-mode surfaces,
                   detailPlayer.detailSurfaceMount). The Listen
                   backend is unmounted, not hidden. */
                <DetailWatchHero
                  playback={playback}
                  cover={cover}
                  videoSources={selectedEntry?.videoSources ?? []}
                  onFullscreenRef={(ref) => {
                    videoRef.current = ref;
                  }}
                />
              ) : backend === 'listen' ? (
                /* Perf problem 12: the Listen backend component —
                   mounted only in listen mode; it renders the
                   listen card AND its own hidden surface, which
                   the hidden-video fallback plays through, sound
                   only (the untouchable fallback — see
                   DetailListenHero's header). */
                <DetailListenHero
                  playback={playback}
                  cover={cover}
                  waveHeights={waveHeights}
                />
              ) : (
                <>
                  {cover ? (
                    <AppImage source={cover} style={styles.cover} />
                  ) : (
                    <View style={[styles.cover, styles.coverEmpty]} />
                  )}
                </>
              )}
              {playMode === null && (
                <>
                  {/* The v7 hero's bottom-left type chip ("OP 1",
                      plum-deep glass pill) — paused state only;
                      while playing, the control strip owns the
                      hero's bottom edge. */}
                  <View style={styles.heroChip}>
                    <Text style={styles.heroChipText}>
                      {detail.type} {detail.sequence}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => onModeArm(shownMode)}
                    accessibilityRole="button"
                    accessibilityLabel="Play"
                    style={({ pressed }) => [
                      styles.fab,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Play size={24} color={theme.onAccent} strokeWidth={2} />
                  </Pressable>
                </>
              )}
            </View>

            <View style={styles.body}>
              {/* 2 — Watch/Listen toggle: directly under the hero,
                  as the v7 design orders it (hero → toggle → title
                  block → action row → rating card). */}
              <View style={styles.modeToggle}>
                <Pressable
                  onPress={() => onModeArm('watch')}
                  accessibilityRole="button"
                  accessibilityLabel="Watch"
                  accessibilityState={{ selected: shownMode !== 'listen' }}
                  style={({ pressed }) => [
                    styles.modeSegment,
                    playMode === 'watch' || (playMode === null && shownMode === 'watch') ? styles.modeSegmentActive : undefined,
                    pressed && styles.pressed,
                  ]}
                >
                  <Play
                    size={15}
                    color={
                      shownMode !== 'listen' ? theme.onAccent : theme.secondary
                    }
                    strokeWidth={2}
                  />
                  <Text
                    style={
                      shownMode !== 'listen'
                        ? styles.modeSegmentTextActive
                        : styles.modeSegmentText
                    }
                  >
                    Watch
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => onModeArm('listen')}
                  disabled={!listenAvailable}
                  accessibilityRole="button"
                  accessibilityLabel="Listen"
                  accessibilityState={{
                    disabled: !listenAvailable,
                    selected: shownMode === 'listen',
                  }}
                  style={({ pressed }) => [
                    styles.modeSegment,
                    playMode === 'listen' || (playMode === null && shownMode === 'listen') ? styles.modeSegmentActive : undefined,
                    !listenAvailable && styles.modeSegmentDisabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Headphones
                    size={15}
                    color={
                      !listenAvailable
                        ? theme.muted
                        : playMode === 'listen'
                          ? theme.onAccent
                          : theme.secondary
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

              {/* 3 — Info header (v7 TitleBlock): song title, the
                  artists line, then the meta row. The anime title
                  opens the Anime detail screen (§6.8) and each
                  artist name opens the Artist detail screen (§6.9)
                  when its slug is known. */}
              <Text style={styles.song}>{detail.songTitle}</Text>
              {detail.allArtists.length > 0 &&
              detail.artistSlugs.length === detail.allArtists.length ? (
                <View style={styles.artistsRow}>
                  {detail.allArtists.map((name, i) => (
                    <View key={name} style={styles.artistItem}>
                      {i > 0 && <Text style={styles.artists}> / </Text>}
                      <Pressable
                        onPress={() =>
                          router.push(`/artist/${detail.artistSlugs[i]}`)
                        }
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${name}`}
                        hitSlop={4}
                      >
                        <Text style={styles.artists}>{name}</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : (
                artists.length > 0 && (
                  <Text style={styles.artists} numberOfLines={2}>
                    {artists}
                  </Text>
                )
              )}
              {/* Meta row (v7): anime title · season pill. The
                  title flexes and wraps rather than truncating
                  next to the pill (design law #9); the OP/ED +
                  sequence the old meta line led with now lives on
                  the hero's type chip, and the mood tags the old
                  line trailed are not part of the v7 header. */}
              <View style={styles.metaRow}>
                <Pressable
                  onPress={() =>
                    detail.anilistId != null &&
                    router.push(`/anime/${detail.anilistId}`)
                  }
                  disabled={detail.anilistId == null}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${detail.animeTitle}`}
                  hitSlop={4}
                  style={styles.metaAnime}
                >
                  <Text style={styles.metaAnimeText}>
                    {detail.animeTitle}
                  </Text>
                </Pressable>
                {detail.animeSeason && detail.animeSeasonYear && (
                  <>
                    <View style={styles.metaDot} />
                    <View style={styles.seasonPill}>
                      <Text style={styles.seasonPillText}>
                        {detail.animeSeason} {detail.animeSeasonYear}
                      </Text>
                    </View>
                  </>
                )}
              </View>

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
              ) : playMode === 'watch' && playback.audioFallback ? (
                /* W2: the video chain failed and the audio chain
                   is playing instead — say so honestly, in the
                   same note voice as the other playback states. */
                <Text style={styles.playerNote}>
                  The video could not be played, so you are hearing
                  the audio only.
                </Text>
              ) : null}

              {/* 4 — Action row (design law #6): four 48px lavender
                  discs spread across the row — favourite, add to
                  playlist, download, share. Every disc is wired:
                  the heart is the favorites store (the hero-overlay
                  bookmark's replacement), download opens the sheet
                  and reports % / downloaded state in place, share
                  opens the system sheet with the web URL. */}
              <View style={styles.actions}>
                <Pressable
                  onPress={onToggleSave}
                  accessibilityRole="button"
                  accessibilityLabel={saved ? 'Unsave theme' : 'Save theme'}
                  accessibilityState={{ selected: saved }}
                  style={({ pressed }) => [
                    styles.actionDisc,
                    pressed && styles.pressed,
                  ]}
                >
                  {savePending ? (
                    <ActivityIndicator size="small" color={theme.secondary} />
                  ) : (
                    <Heart
                      size={24}
                      color={theme.secondary}
                      fill={saved ? theme.secondary : 'transparent'}
                      strokeWidth={2}
                    />
                  )}
                </Pressable>
                <Pressable
                  onPress={openSheet}
                  accessibilityRole="button"
                  accessibilityLabel="Add to playlist"
                  style={({ pressed }) => [
                    styles.actionDisc,
                    pressed && styles.pressed,
                  ]}
                >
                  <ListPlus size={24} color={theme.text} strokeWidth={2} />
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
                    styles.actionDisc,
                    pressed && styles.pressed,
                  ]}
                >
                  {anyDlProgress !== undefined ? (
                    anyDlProgress !== null ? (
                      <Text style={styles.discPercent}>
                        {Math.floor(anyDlProgress * 100)}%
                      </Text>
                    ) : (
                      <ActivityIndicator size="small" color={theme.text} />
                    )
                  ) : anyDlDownloaded ? (
                    <Check size={24} color={theme.secondary} strokeWidth={2} />
                  ) : (
                    <Download size={24} color={theme.text} strokeWidth={2} />
                  )}
                </Pressable>
                <Pressable
                  onPress={onShare}
                  accessibilityRole="button"
                  accessibilityLabel="Share theme"
                  style={({ pressed }) => [
                    styles.actionDisc,
                    pressed && styles.pressed,
                  ]}
                >
                  <Share2 size={22} color={theme.text} strokeWidth={2} />
                </Pressable>
              </View>

              {actionError && (
                <Text style={styles.actionError}>{actionError}</Text>
              )}

              {/* 5 — Version Select (web VersionSwitcher semantics:
                  selects the entry the actions above target) */}
              {hasMultipleVersions && (
                <View style={styles.versionSection}>
                  <Text style={styles.sectionEyebrow}>Version Select</Text>
                  <View style={styles.versionRow}>
                    {detail.entries.map((entry, i) => (
                      <Pressable
                        key={`${entry.atEntryId}-${i}`}
                        onPress={() => {
                          setSelectedEntryIndex(i);
                          /* While this screen owns the live session,
                             switching versions switches its source —
                             the old private hook took the entry
                             straight from this selection. */
                          if (
                            playMode !== null &&
                            session.active &&
                            session.slug === detail.slug
                          ) {
                            updateSession({
                              entry: detail.entries[i] ?? null,
                            });
                          } else if (
                            !session.active &&
                            session.slug === detail.slug
                          ) {
                            /* The passive preload claim is live:
                               retarget its preload at the new
                               version (playback plan). */
                            retargetPreload(i);
                          }
                        }}
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

              {/* 6 — Rating card (v7 composition): Community score
                  + Rates + Plays across the top, a divider, then
                  Your rating — the score as a mauve pill and 10
                  tappable stars (design law #5). */}
              <View style={styles.ratingCard}>
                <View style={styles.communityRow}>
                  <View style={styles.communityMain}>
                    <View style={styles.communityScoreRow}>
                      <Text style={styles.communityScore}>
                        {aggAvg.toFixed(1)}
                      </Text>
                      <Star
                        size={20}
                        color="#FBBF24"
                        fill="#FBBF24"
                        strokeWidth={2}
                      />
                    </View>
                    <Text style={styles.communityLabel}>Community</Text>
                  </View>
                  <View style={styles.communityStats}>
                    <View style={styles.communityStat}>
                      <Text style={styles.communityStatValue}>
                        {formatCount(aggTotal)}
                      </Text>
                      <Text style={styles.communityStatLabel}>Rates</Text>
                    </View>
                    <View style={styles.communityStat}>
                      <Text style={styles.communityStatValue}>
                        {formatCount(detail.totalListens)}
                      </Text>
                      <Text style={styles.communityStatLabel}>Plays</Text>
                    </View>
                  </View>
                </View>
                <View style={styles.cardDivider} />
                <View style={styles.ratingHeader}>
                  <Text style={styles.ratingLabel}>Your rating</Text>
                  {myScore !== null && (
                    <View style={styles.scorePill}>
                      <Text style={styles.scorePillText}>{myScore} / 10</Text>
                    </View>
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
                  <View style={styles.starRow}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
                      const filled = myScore !== null && n <= myScore;
                      return (
                        <Pressable
                          key={n}
                          onPress={() => onRate(n)}
                          disabled={ratingBusy}
                          accessibilityRole="button"
                          accessibilityState={{ selected: filled }}
                          accessibilityLabel={`Rate ${n} out of 10`}
                          style={({ pressed }) => [
                            styles.starHit,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Star
                            size={24}
                            color={theme.secondary}
                            fill={filled ? theme.secondary : 'transparent'}
                            strokeWidth={2}
                          />
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

        {/* 7 — Comments, then 8 — Related themes (owner's ruling,
            2026-11-09: Comments above Similar — reversing the v7 /
            Slice 6 order. The comments component still mounts
            eagerly in the same pass — its fetch fires in parallel
            with the detail read, and it carries its own loading
            state.) */}
        <View style={styles.lowerBody}>
          {/* 7 — Comments */}
          <ThemeComments slug={slug} />

          {/* 8 — Related themes, the web's categorised lists */}
          {!fixtureMode && (
            <View style={styles.relatedSection}>
              {!ready || similarState === 'loading' ? (
                /* Section loading (skeleton sweep): theme-row
                   shapes, the section's own content shape. */
                <View style={styles.relatedSkeleton}>
                  <SkeletonThemeRow />
                  <SkeletonThemeRow />
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
                        compact
                        typeChip={false}
                        saved={favorites.isFavorite(item.slug)}
                        savePending={favorites.isPending(item.slug)}
                        onToggleSave={() => void favorites.toggle(item.slug)}
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
    <AddToPlaylistSheet
      slug={detail.slug}
      title={detail.songTitle}
      visible={sheetOpen}
      onClose={() => setSheetOpen(false)}
    />

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
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.sm,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  headerActionHit: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
    // The hero zone (2026-11-11 restructure): a plain relative
    // container again — it owns NO surface; each backend hero
    // mounts its own (DetailWatchHero / DetailListenHero).
    position: 'relative',
  },
  cover: {
    // 16:9 in BOTH states (design polish pass): the paused
    // hero's 3:2 was the audit's delta — the mock's paused hero
    // matches the playing surface's 16:9.
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: theme.surface,
  },
  coverEmpty: {
    backgroundColor: theme.raised,
  },
  coverPlaceholder: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: theme.surface,
    position: 'relative',
  },
  loadingZone: {
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },
  skeletonMeta: {
    // The detail skeleton's meta lines (skeleton sweep): the
    // loaded page's title + subline rhythm under the hero.
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
    gap: 8,
  },
  skeletonRows: {
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.lg,
  },
  relatedSkeleton: {
    paddingTop: spacing.xs,
  },
  fab: {
    // The v7 hero's centre play disc: 56px, centred on the
    // artwork (it straddled the hero's bottom-right corner in
    // the pre-fidelity build). Glass fill (design polish pass):
    // the mock's disc is translucent mauveDeep, matching the
    // hero chip's withOpacity(accent, 0.85).
    position: 'absolute',
    left: '50%',
    top: '50%',
    marginLeft: -28,
    marginTop: -28,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: withOpacity(theme.accent, 0.85),
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 6,
    elevation: 6,
  },
  heroChip: {
    // v7: plum-deep glass pill, bottom-left of the hero.
    position: 'absolute',
    left: spacing.md,
    bottom: spacing.md,
    backgroundColor: withOpacity(theme.accent, 0.85),
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 1,
    zIndex: 5,
  },
  heroChipText: {
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 11,
    letterSpacing: 0.8,
    color: theme.onAccent,
    textTransform: 'uppercase',
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
    paddingTop: spacing.lg,
  },
  lowerBody: {
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.xxxl,
  },
  song: {
    ...typeStyles.display,
    fontSize: 26,
    color: theme.text,
    marginTop: spacing.md,
  },
  artists: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.secondary,
    marginTop: spacing.xs + 2,
  },
  artistsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  artistItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  metaAnime: {
    flexShrink: 1,
  },
  metaAnimeText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  metaDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: withOpacity(theme.secondary, 0.5),
    flexShrink: 0,
  },
  seasonPill: {
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 2,
    flexShrink: 0,
  },
  seasonPillText: {
    fontSize: 10,
    fontFamily: fontFamilies.bodyStrong,
    letterSpacing: 0.6,
    color: theme.secondary,
    textTransform: 'uppercase',
  },
  modeToggle: {
    // v7: full-width pill track in disc lavender, segments are
    // pills themselves (active = mauveDeep fill, white bold text).
    flexDirection: 'row',
    backgroundColor: theme.raised,
    borderRadius: radii.pill,
    padding: 4,
    gap: 4,
  },
  modeSegment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 36,
    borderRadius: radii.pill,
  },
  modeSegmentActive: {
    backgroundColor: theme.accent,
  },
  modeSegmentDisabled: {
    opacity: 0.45,
  },
  modeSegmentText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.secondary,
  },
  modeSegmentTextActive: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccent,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  actionDisc: {
    // v7 action discs: 48px, disc-lavender fill (the `raised`
    // token), 24px icons.
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discPercent: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
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
  ratingCard: {
    // v7: one white card, radius ~24, generous padding.
    marginTop: spacing.lg,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.cardLg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.md,
  },
  communityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  communityMain: {
    gap: 2,
  },
  communityScoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  communityScore: {
    fontFamily: fontFamilies.display,
    fontSize: 30,
    color: theme.text,
  },
  communityLabel: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  communityStats: {
    flexDirection: 'row',
    gap: spacing.xl,
  },
  communityStat: {
    alignItems: 'flex-end',
    gap: 2,
  },
  communityStatValue: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  communityStatLabel: {
    fontSize: 11,
    fontFamily: fontFamilies.caption,
    color: theme.muted,
  },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.raised,
  },
  ratingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
  },
  ratingLabel: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  scorePill: {
    backgroundColor: theme.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 2,
  },
  scorePillText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccent,
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
  starRow: {
    // v7: the 10 stars spread across the card's full width.
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  starHit: {
    padding: 2,
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

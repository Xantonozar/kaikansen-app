import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Clock,
  Globe,
  Headphones,
  Library as LibraryIcon,
  Link2,
  ListMusic,
  Lock,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react-native';
import type {
  FavoritesResponse,
  LibraryThemesResponse,
  PlaylistDetail,
  PlaylistSummary,
  ThemeSummary,
  WatchHistoryEntry,
} from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import {
  syncFavoriteSlugs,
  useFavorites,
} from '../../../src/favoritesStore';
import {
  createPlaylist,
  deletePlaylist,
  fetchFavorites,
  fetchHistory,
  fetchLibraryThemes,
  fetchPlaylists,
  updatePlaylist,
} from '../../../src/libraryApi';
import {
  downloadsSupported,
  formatBytes,
  recheckDownloads,
  useDownloads,
} from '../../../src/downloads';
import { ThemeRow } from '../../../src/components/ThemeRow';
import { ThemeRowMenu } from '../../../src/components/ThemeRowMenu';
import {
  queueItemFromSummary,
  queueItemsFromSummaries,
  usePlaybackSession,
  type QueueItem,
} from '../../../src/playback-context';
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

type Section = 'saved' | 'recent' | 'playlists' | 'anilist' | 'offline';

type TypeFilter = 'ALL' | 'OP' | 'ED';

/**
 * The segment order follows the MOCK IMAGES — Saved · Playlists ·
 * Recent · Offline · AniList (owner ruling 2026-11-09, superseding
 * the handoff pack's text order that Slice 6 shipped). The pills
 * are TEXT-ONLY on one row, as every Library mock draws them.
 */
const SECTIONS: { key: Section; label: string }[] = [
  { key: 'saved', label: 'Saved' },
  { key: 'playlists', label: 'Playlists' },
  { key: 'recent', label: 'Recent' },
  { key: 'offline', label: 'Offline' },
  { key: 'anilist', label: 'AniList' },
];

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * The Recent mock's played-line voice (library-recent.html):
 * "Played 24 min ago", "Played 2h ago", "Played yesterday",
 * "Played 3 days ago" — computed from the entry's REAL viewedAt.
 * Ladder: under a minute "just now"; under an hour whole minutes;
 * under a day whole hours; under two days "yesterday"; under a
 * week whole days; older falls back to the date. Null when the
 * timestamp is unparseable — the row then omits the line rather
 * than inventing one.
 */
function playedAgo(iso: string): string | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'Played just now';
  if (mins < 60) return `Played ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Played ${hours}h ago`;
  if (hours < 48) return 'Played yesterday';
  const days = Math.floor(hours / 24);
  if (days < 7) return `Played ${days} days ago`;
  return `Played ${new Date(iso).toLocaleDateString()}`;
}

/**
 * Library (Slice M2) — the real tab: Saved (favorites), Recent
 * (watch history) and Playlists behind one segmented control (the
 * approved mockup's library treatment). Every list is fetched on
 * focus, so returning from the player or detail screen shows fresh
 * state; mutations update rows locally on top of that.
 *
 * Slice M3 adds the fourth segment, Offline: the device's downloads
 * (src/downloads.ts) — local state, so unlike the account sections
 * it renders signed-out too; the account sections keep their log-in
 * prompt as a body state. Tapping a download opens the player on the
 * local file.
 *
 * The AniList segment shows THEMES from the caller's AniList
 * anime (owner ruling 2026-11-10, Option B — superseding the
 * polish pass's poster/progress ENTRY list, which is gone): the
 * segment's only read is GET /library/themes?source=anilist,
 * the AniList side of the library-themes union served alone —
 * catalogue themes whose anime is on the caller's AniList
 * COMPLETED + CURRENT (watching) lists (the stored media-id set
 * merges the two statuses, so the list is one merged scroll;
 * the API widens the web's completed-only read) — grouped
 * per-anime by the summary's real anilistId, with an All / OP /
 * ED filter, and group headers that open the anime's detail
 * screen. No watch-history themes are mixed in. Signed-in but
 * unlinked gets a prompt to link AniList in Settings; the link
 * state comes from the session profile's `anilist` field (with
 * the session-local link username as a fallback for a link made
 * moments ago), never guessed.
 *
 * Honest states throughout: signed-out gets a log-in prompt, fixture
 * mode gets clearly-labelled demo empties (a demo library stores
 * nothing), and each section carries its own loading / error /
 * empty rendering — no fabricated content anywhere.
 *
 * Library Playlists design pass: the shared chrome follows the
 * Library HTML's frame (28px title + search disc, 44px segment
 * pills, the HTML's +8/+4 inner insets) and the Playlists segment
 * follows its mock — the full-width mauveDeep New Playlist button,
 * white cards with the 2×2 cover mosaic (the summary's new
 * coverImages), the "N themes · M min" line (the detail header's
 * runtime rule over the summary's totalDurationSeconds) and the
 * visibility pill under the meta, plus a ⋮ opening the Playlist
 * Detail owner sheet's actions (Rename / visibility / Delete).
 * The header's old "+" create shortcut is gone — the mock's
 * chrome carries search instead; creation lives in the segment.
 *
 * Library Recent design pass: the segment follows its mock — the
 * muted "N recent themes" count (the entries actually rendered)
 * over individual white cards (library-recent.html:
 * rounded-[20px], 10px padding, the 56px cover at rounded-2xl),
 * each carrying the song title, the artist alone, and a clock +
 * "Played …" line from the entry's real viewedAt (the playedAgo
 * ladder below — the mock's line drops the old "Watched/Listened
 * ·" prefix; the entry's mode still drives playback). The play
 * disc is two-state: mauve with a white pause glyph while this
 * entry is the live session and playing, pale with a play glyph
 * otherwise; the disc toggles the engine for the live entry and
 * claims the segment's queue for any other, and the shared ⋮ menu
 * closes the row (no heart — saving lives in the menu, as on the
 * Season/Anime/Artist rows). The HTML truncates its titles to
 * one line, so these cards share those variants' recorded
 * law-#9 deviation.
 */
export default function LibraryScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status, user, anilistUsername } = useAuth();
  const favorites = useFavorites();
  const downloads = useDownloads();

  const [section, setSection] = useState<Section>('saved');

  /* Deep-link segment (Slice 4): the Profile menu's "Listening
     History" lands here with ?segment=recent. Each distinct param
     value is applied once — the user's own segment taps are never
     fought by a stale param. */
  const { segment } = useLocalSearchParams<{ segment?: string }>();
  const appliedSegment = useRef<string | null>(null);
  useEffect(() => {
    const valid: Section[] = [
      'saved',
      'recent',
      'playlists',
      'anilist',
      'offline',
    ];
    if (
      segment &&
      segment !== appliedSegment.current &&
      valid.includes(segment as Section)
    ) {
      appliedSegment.current = segment;
      setSection(segment as Section);
    }
  }, [segment]);

  const [fav, setFav] = useState<FavoritesResponse | null>(null);
  const [favPage, setFavPage] = useState(1);
  const [favError, setFavError] = useState<string | null>(null);
  const [favBusy, setFavBusy] = useState(false);

  const [history, setHistory] = useState<WatchHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);

  const [libThemes, setLibThemes] = useState<LibraryThemesResponse | null>(
    null,
  );
  const [libError, setLibError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPublic, setNewPublic] = useState(true);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  /* Playlist ⋮ menu + rename (Library Playlists design): the
     card's ⋮ opens the same owner actions the Playlist Detail
     header sheet carries — Rename (through the segment's form),
     the visibility toggle and Delete with a two-tap confirm —
     wired to the same mutations, patching the list locally from
     each mutation's returned detail. */
  const [editing, setEditing] = useState<PlaylistSummary | null>(null);
  const [menuPlaylist, setMenuPlaylist] = useState<PlaylistSummary | null>(
    null,
  );
  const [menuBusy, setMenuBusy] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(
    null,
  );
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const signedIn = status === 'signedIn';

  /* AniList link state: the session profile's `anilist` field is
     the durable signal (GET /auth/me and the login responses carry
     it); the context's session-local username covers a link made
     moments ago in this session, before any profile refresh. The
     endpoint's own `anilistUser` meta is a third, post-fetch
     confirmation used only for the header label. */
  const anilistLinked = Boolean(user?.anilist || anilistUsername);
  const anilistName =
    user?.anilist?.username ??
    anilistUsername ??
    libThemes?.anilistUser ??
    null;

  /* Load all account sections; each lands (or fails) independently. */
  const loadAll = useCallback(() => {
    if (!signedIn || fixtureMode) return;
    fetchFavorites(1)
      .then((res) => {
        setFav(res);
        setFavPage(1);
        setFavError(null);
        syncFavoriteSlugs(res.themes);
      })
      .catch((e: unknown) =>
        setFavError(e instanceof Error ? e.message : 'Could not load saves.'),
      );
    fetchHistory()
      .then((res) => {
        setHistory(res.entries);
        setHistoryError(null);
      })
      .catch((e: unknown) =>
        setHistoryError(
          e instanceof Error ? e.message : 'Could not load history.',
        ),
      );
    fetchPlaylists()
      .then((res) => {
        setPlaylists(res.playlists);
        setPlaylistsError(null);
      })
      .catch((e: unknown) =>
        setPlaylistsError(
          e instanceof Error ? e.message : 'Could not load playlists.',
        ),
      );
    /* The AniList read is only fetched when a link is known to
       exist — unlinked, the segment renders its link prompt and
       there is nothing AniList-side to load. The read is the
       AniList-source themes (Option B): AniList-pure, no watch
       history, grouped per-anime by the segment below. */
    if (anilistLinked) {
      fetchLibraryThemes('anilist')
        .then((res) => {
          setLibThemes(res);
          setLibError(null);
          syncFavoriteSlugs(res.themes);
        })
        .catch((e: unknown) =>
          setLibError(
            e instanceof Error
              ? e.message
              : 'Could not load your AniList themes.',
          ),
        );
    }
  }, [signedIn, anilistLinked]);

  /* Refetch on focus — the tab stays mounted, so freshness is
     focus-driven (returning from a play shows the new history
     entry; an unsave elsewhere drops out of Saved). Downloads are
     local store state, but a focus pass re-verifies their files so
     an externally deleted file flips to broken here, not at play. */
  useFocusEffect(
    useCallback(() => {
      loadAll();
      recheckDownloads();
    }, [loadAll]),
  );

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );

  /* Where a claimed play navigates (owner ruling 2026-11-10,
     recorded in app/(drawer)/player.tsx): the player route opens
     ONLY for Offline (downloads) playback in this screen — every
     other segment lands on the theme detail, whose hero renders
     the claimed session inline. */
  type PlayDestination = 'theme' | 'player';

  const playTheme = useCallback(
    (
      slug: string,
      mode: 'watch' | 'listen',
      atEntryId?: number | null,
      destination: PlayDestination = 'theme',
    ) => {
      if (destination === 'player') {
        router.push({
          pathname: '/player',
          params: {
            slug,
            mode,
            ...(atEntryId != null ? { entry: String(atEntryId) } : {}),
          },
        });
      } else {
        router.push(`/theme/${slug}`);
      }
    },
    [router],
  );

  /* Queue claims (Slice 2.5): a segment's rows play as a queue —
     the segment's loaded list becomes the provider queue at the
     tapped row, then navigation follows the ruling above (theme
     detail by default; the Offline segment passes 'player'). The
     mode claimed is the mode that row would have opened with.
     The queue's origin tag mirrors the destination: only the
     Offline segment's claim is 'offline' — every other segment
     is 'other', so the mini player follows the same ruling. */
  const { session, playback, startQueue } = usePlaybackSession();
  const playWithQueue = useCallback(
    (
      items: QueueItem[],
      index: number,
      slug: string,
      mode: 'watch' | 'listen',
      atEntryId?: number | null,
      destination?: PlayDestination,
    ) => {
      if (items.length > 0 && index >= 0) {
        startQueue(
          items,
          index,
          mode,
          destination === 'player' ? 'offline' : 'other',
        );
      }
      playTheme(slug, mode, atEntryId, destination);
    },
    [startQueue, playTheme],
  );

  const unsave = useCallback(
    (slug: string) => {
      void favorites.toggle(slug).then((err) => {
        if (err) return;
        setFav((prev) =>
          prev
            ? {
                ...prev,
                themes: prev.themes.filter((t) => t.slug !== slug),
                total: Math.max(0, prev.total - 1),
              }
            : prev,
        );
      });
    },
    [favorites],
  );

  const loadMoreFavorites = useCallback(() => {
    if (!fav || !fav.hasMore || favBusy) return;
    setFavBusy(true);
    fetchFavorites(favPage + 1)
      .then((res) => {
        setFav((prev) =>
          prev
            ? { ...res, themes: [...prev.themes, ...res.themes] }
            : res,
        );
        setFavPage(favPage + 1);
        syncFavoriteSlugs(res.themes);
      })
      .catch((e: unknown) =>
        setFavError(
          e instanceof Error ? e.message : 'Could not load more saves.',
        ),
      )
      .finally(() => setFavBusy(false));
  }, [fav, favBusy, favPage]);

  /* A mutation's returned detail replaces its list entry (the
     service resolves the summary server-side, so the card's
     mosaic/runtime stay truthful after an edit). */
  const patchPlaylist = useCallback((detail: PlaylistDetail) => {
    setPlaylists((prev) =>
      prev ? prev.map((p) => (p.id === detail.id ? detail : p)) : prev,
    );
  }, []);

  const closeForm = useCallback(() => {
    setCreating(false);
    setEditing(null);
    setNewName('');
    setNewPublic(true);
    setCreateError(null);
  }, []);

  const submitForm = useCallback(() => {
    const name = newName.trim();
    if (name.length === 0) {
      setCreateError('Give the playlist a name.');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    const done = (detail: PlaylistDetail) => {
      if (editing) {
        patchPlaylist(detail);
      } else {
        setPlaylists((prev) => [detail, ...(prev ?? [])]);
      }
      closeForm();
    };
    const fail = (e: unknown) =>
      setCreateError(
        e instanceof Error
          ? e.message
          : editing
            ? 'Could not save the playlist.'
            : 'Could not create the playlist.',
      );
    const request = editing
      ? updatePlaylist(editing.id, { name, isPublic: newPublic })
      : createPlaylist({ name, isPublic: newPublic });
    request.then(done).catch(fail).finally(() => setCreateBusy(false));
  }, [newName, newPublic, editing, patchPlaylist, closeForm]);

  const openMenu = useCallback((p: PlaylistSummary) => {
    setMenuPlaylist(p);
    setMenuError(null);
    setConfirmDeleteId(null);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuPlaylist(null);
    setMenuError(null);
    setConfirmDeleteId(null);
  }, []);

  const startEdit = useCallback(
    (p: PlaylistSummary) => {
      closeMenu();
      setCreating(false);
      setEditing(p);
      setNewName(p.name);
      setNewPublic(p.isPublic);
      setCreateError(null);
    },
    [closeMenu],
  );

  const toggleMenuVisibility = useCallback(
    (p: PlaylistSummary) => {
      setMenuBusy(true);
      setMenuError(null);
      updatePlaylist(p.id, { isPublic: !p.isPublic })
        .then((detail) => {
          patchPlaylist(detail);
          closeMenu();
        })
        .catch((e: unknown) =>
          setMenuError(
            e instanceof Error ? e.message : 'Could not update the playlist.',
          ),
        )
        .finally(() => setMenuBusy(false));
    },
    [patchPlaylist, closeMenu],
  );

  const deleteFromMenu = useCallback(
    (p: PlaylistSummary) => {
      /* Two-tap confirm, the detail sheet's pattern: the first
         tap arms the row (and starts its reset timer), the
         second deletes. */
      if (confirmDeleteId !== p.id) {
        setConfirmDeleteId(p.id);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), 3000);
        return;
      }
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setMenuBusy(true);
      setMenuError(null);
      deletePlaylist(p.id)
        .then(() => {
          setPlaylists((prev) =>
            prev ? prev.filter((x) => x.id !== p.id) : prev,
          );
          closeMenu();
        })
        .catch((e: unknown) =>
          setMenuError(
            e instanceof Error ? e.message : 'Could not delete the playlist.',
          ),
        )
        .finally(() => setMenuBusy(false));
    },
    [confirmDeleteId, closeMenu],
  );

  /* AniList segment: group the flat AniList-source list by anime,
     keyed by the summary's REAL anilistId (owner ruling
     2026-11-10) — same-title anime (remakes, split seasons) stay
     separate groups, which the old title-string key merged. A
     summary without an id cannot come back from the anilist
     source (the API filters on the id), but the title-keyed
     fallback keeps such a row visible rather than dropped. The
     endpoint's order (newest season first, then title) fixes the
     group order; inside a group, OPs come before EDs, each by
     sequence. The All / OP / ED filter applies before grouping,
     so a group only ever shows the filtered types. */
  const anilistGroups = useMemo(() => {
    if (!libThemes) return [];
    const filtered =
      typeFilter === 'ALL'
        ? libThemes.themes
        : libThemes.themes.filter((t) => t.type === typeFilter);
    const groups: {
      key: string;
      anilistId: number | null;
      title: string;
      year: number | null;
      cover: string | null;
      themes: ThemeSummary[];
    }[] = [];
    const byKey = new Map<string, (typeof groups)[number]>();
    for (const item of filtered) {
      const title = item.animeTitleEnglish ?? item.animeTitle;
      const key =
        item.anilistId != null
          ? `anilist-${item.anilistId}`
          : `title-${title.toLowerCase()}`;
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          anilistId: item.anilistId,
          title,
          year: item.animeSeasonYear,
          cover: item.animeCoverImageSmall ?? item.animeCoverImage,
          themes: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }
      group.themes.push(item);
    }
    for (const group of groups) {
      group.themes.sort(
        (a, b) =>
          (a.type === b.type ? 0 : a.type === 'OP' ? -1 : 1) ||
          a.sequence - b.sequence,
      );
    }
    return groups;
  }, [libThemes, typeFilter]);

  /* ---------------- early states ---------------- */

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  /* Account sections render this as their body when signed out;
     the Offline segment is local and stays reachable (Slice M3). */
  const renderLoginPrompt = () => (
    <View style={styles.promptBody}>
      <View style={styles.tile}>
        <LibraryIcon size={26} color={theme.accent} strokeWidth={2} />
      </View>
      <Text style={styles.centerTitle}>Your library</Text>
      <Text style={styles.centerNote}>
        Log in to see your saved themes, watch history and playlists.
      </Text>
      <Pressable
        onPress={() => router.push('/login')}
        accessibilityRole="button"
        accessibilityLabel="Log in"
        style={({ pressed }) => [
          styles.primaryButton,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.primaryButtonText}>Log in</Text>
      </Pressable>
    </View>
  );

  /* ---------------- section bodies ---------------- */

  const sectionError = (message: string) => (
    <View style={styles.sectionState}>
      <Text style={styles.emptyText}>{message}</Text>
      <Pressable
        onPress={loadAll}
        accessibilityRole="button"
        accessibilityLabel="Retry"
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        <Text style={styles.retryText}>Retry</Text>
      </Pressable>
    </View>
  );

  const renderSaved = () => {
    if (!fixtureMode && !signedIn) return renderLoginPrompt();
    if (fixtureMode) {
      return (
        <Text style={styles.emptyText}>
          Demo mode — saved themes live in your account on the live API.
          Nothing is stored here.
        </Text>
      );
    }
    if (favError && !fav) return sectionError(favError);
    if (!fav) {
      return (
        <View style={styles.sectionState}>
          <ActivityIndicator color={theme.accent} />
        </View>
      );
    }
    return (
      <>
        {fav.themes.length > 0 && (
          <View style={styles.viewAllRow}>
            <Text style={styles.viewAllCount}>
              {fav.total} favourite {fav.total === 1 ? 'theme' : 'themes'}
            </Text>
            <Pressable
              onPress={() => router.push('/favourites')}
              accessibilityRole="button"
              accessibilityLabel="View all favourites"
              hitSlop={6}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text style={styles.viewAllText}>View all</Text>
            </Pressable>
          </View>
        )}
        {fav.themes.map((item, index) => (
          <ThemeRow
            typeChip={false}
            key={item.slug}
            item={item}
            onPress={() => openTheme(item.slug)}
            onPlay={() =>
              playWithQueue(
                queueItemsFromSummaries(fav.themes),
                index,
                item.slug,
                'watch',
              )
            }
            saved
            savePending={favorites.isPending(item.slug)}
            onToggleSave={() => unsave(item.slug)}
          />
        ))}
        {fav.themes.length === 0 && (
          <Text style={styles.emptyText}>
            Nothing saved yet — tap the bookmark on any theme to keep it
            here.
          </Text>
        )}
        {favError && <Text style={styles.inlineError}>{favError}</Text>}
        {fav.hasMore && (
          <Pressable
            onPress={loadMoreFavorites}
            accessibilityRole="button"
            accessibilityLabel="Load more saved themes"
            style={({ pressed }) => [
              styles.loadMore,
              pressed && styles.pressed,
            ]}
          >
            {favBusy ? (
              <ActivityIndicator size="small" color={theme.muted} />
            ) : (
              <Text style={styles.loadMoreText}>Load more</Text>
            )}
          </Pressable>
        )}
      </>
    );
  };

  const renderRecent = () => {
    if (!fixtureMode && !signedIn) return renderLoginPrompt();
    if (fixtureMode) {
      return (
        <Text style={styles.emptyText}>
          Demo mode — playback in the demo writes no history. Your real
          history appears here on the live API.
        </Text>
      );
    }
    if (historyError && !history) return sectionError(historyError);
    if (!history) {
      return (
        <View style={styles.sectionState}>
          <ActivityIndicator color={theme.accent} />
        </View>
      );
    }
    /* The live-session identity for a history row (the Downloads
       screen's rule): the session's slug + mode + entry must all
       match the row's. A row whose stored atEntryId is null names
       the theme's primary entry, which the session resolves to a
       concrete id — slug + mode is the honest match there. */
    const sessionEntryId =
      session.entry?.atEntryId ?? session.entryIdOverride;
    return (
      <>
        {history.length > 0 && (
          <Text style={styles.recentCount}>
            {history.length} recent{' '}
            {history.length === 1 ? 'theme' : 'themes'}
          </Text>
        )}
        {history.map((entry) => {
          if (!entry.theme) {
            // Tombstone: the theme left the catalogue — the
            // segment's card clothing, the honest text kept.
            return (
              <View key={entry.id} style={styles.recentGoneCard}>
                <Text style={styles.goneText} numberOfLines={1}>
                  A theme that has left the catalogue ·{' '}
                  {relativeTime(entry.viewedAt)}
                </Text>
              </View>
            );
          }
          const item = entry.theme;
          const cover = item.animeCoverImageSmall ?? item.animeCoverImage;
          const played = playedAgo(entry.viewedAt);
          const isCurrent =
            session.active &&
            session.slug === item.slug &&
            session.mode === entry.mode &&
            (entry.atEntryId == null ||
              sessionEntryId === entry.atEntryId);
          const showPause = isCurrent && playback.isPlaying;
          const playEntry = () => {
            // Queue = the segment's playable history, in shown
            // order; entries whose theme left the catalogue
            // render as tombstones and can't be queued.
            const playable = history.filter((e) => e.theme !== null);
            const items = playable.map((e) => ({
              ...queueItemFromSummary(e.theme!),
              atEntryId: e.atEntryId,
            }));
            const index = playable.findIndex((e) => e.id === entry.id);
            playWithQueue(
              items,
              index,
              item.slug,
              entry.mode,
              entry.atEntryId,
            );
          };
          return (
            <Pressable
              key={entry.id}
              onPress={() => openTheme(item.slug)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.songTitle}`}
              style={({ pressed }) => [
                styles.recentCard,
                pressed && styles.pressed,
              ]}
            >
              {cover ? (
                <Image
                  source={{ uri: cover }}
                  style={styles.recentCover}
                />
              ) : (
                <View
                  style={[styles.recentCover, styles.plCoverEmpty]}
                />
              )}
              <View style={styles.recentMain}>
                <Text style={styles.recentTitle} numberOfLines={1}>
                  {item.songTitle}
                </Text>
                <Text style={styles.recentArtist} numberOfLines={1}>
                  {item.artistName ?? item.allArtists.join(', ')}
                </Text>
                {played && (
                  <View style={styles.recentPlayedRow}>
                    <Clock
                      size={13}
                      color={theme.muted}
                      strokeWidth={2}
                    />
                    <Text style={styles.recentPlayed}>{played}</Text>
                  </View>
                )}
              </View>
              <View style={styles.recentCluster}>
                <Pressable
                  onPress={() =>
                    isCurrent ? playback.toggleMain() : playEntry()
                  }
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={
                    showPause
                      ? `Pause ${item.songTitle}`
                      : isCurrent
                        ? `Resume ${item.songTitle}`
                        : `Play ${item.songTitle}`
                  }
                  style={({ pressed }) => [
                    styles.recentDisc,
                    showPause && styles.recentDiscPlaying,
                    pressed && styles.pressed,
                  ]}
                >
                  {showPause ? (
                    <Pause
                      size={19}
                      color={theme.onAccent}
                      fill={theme.onAccent}
                      strokeWidth={2}
                    />
                  ) : (
                    <Play
                      size={20}
                      color={theme.secondary}
                      fill={theme.secondary}
                      strokeWidth={2}
                    />
                  )}
                </Pressable>
                <ThemeRowMenu
                  item={item}
                  onPlay={playEntry}
                  onOpen={() => openTheme(item.slug)}
                  triggerIconSize={20}
                  triggerColor={theme.secondary}
                />
              </View>
            </Pressable>
          );
        })}
        {history.length === 0 && (
          <Text style={styles.emptyText}>
            Nothing here yet — themes you watch or listen to will show up.
          </Text>
        )}
        {historyError && (
          <Text style={styles.inlineError}>{historyError}</Text>
        )}
      </>
    );
  };

  /* The card's 2×2 cover mosaic — the Playlist Detail header
     grid's derivation and geometry, at this card's scale: the
     summary's distinct covers in stored order; a lone cover fills
     the square; missing cells are tinted tiles (an empty playlist
     carries the ListMusic glyph in its first cell). */
  const renderMosaic = (covers: string[]) => {
    if (covers.length === 1) {
      return (
        <Image source={{ uri: covers[0] }} style={styles.plGridSingle} />
      );
    }
    return (
      <View style={styles.plGrid}>
        {[0, 1, 2, 3].map((i) =>
          covers[i] ? (
            <Image
              key={i}
              source={{ uri: covers[i] }}
              style={styles.plGridCell}
            />
          ) : (
            <View
              key={i}
              style={[styles.plGridCell, styles.plGridCellEmpty]}
            >
              {covers.length === 0 && i === 0 ? (
                <ListMusic size={16} color={theme.muted} strokeWidth={2} />
              ) : null}
            </View>
          ),
        )}
      </View>
    );
  };

  const renderPlaylists = () => {
    if (!fixtureMode && !signedIn) return renderLoginPrompt();
    if (fixtureMode) {
      return (
        <Text style={styles.emptyText}>
          Demo mode — playlists live in your account on the live API.
          Nothing can be created here.
        </Text>
      );
    }
    return (
      <>
        {!creating && !editing ? (
          <Pressable
            onPress={() => {
              setCreating(true);
              setCreateError(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="New playlist"
            style={({ pressed }) => [
              styles.newPlaylistButton,
              pressed && styles.pressed,
            ]}
          >
            <Plus size={20} color={theme.onAccent} strokeWidth={2} />
            <Text style={styles.newPlaylistText}>New Playlist</Text>
          </Pressable>
        ) : (
          <View style={styles.createForm}>
            <TextInput
              style={styles.input}
              value={newName}
              onChangeText={setNewName}
              placeholder="Playlist name"
              placeholderTextColor={theme.muted}
              autoFocus
              maxLength={100}
              returnKeyType="done"
              onSubmitEditing={submitForm}
            />
            <View style={styles.createOptions}>
              <View style={styles.segmented}>
                {(
                  [
                    { value: true, label: 'Public' },
                    { value: false, label: 'Private' },
                  ] as const
                ).map((opt) => {
                  const active = newPublic === opt.value;
                  return (
                    <Pressable
                      key={opt.label}
                      onPress={() => setNewPublic(opt.value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Visibility: ${opt.label}`}
                      style={[
                        styles.segment,
                        active && { backgroundColor: theme.accent },
                      ]}
                    >
                      <Text
                        style={[
                          styles.segmentText,
                          active && { color: theme.onAccent },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.createButtons}>
                <Pressable
                  onPress={closeForm}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  style={({ pressed }) => [
                    styles.ghostButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.ghostButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submitForm}
                  disabled={createBusy}
                  accessibilityRole="button"
                  accessibilityLabel={
                    editing ? 'Save playlist' : 'Create playlist'
                  }
                  style={({ pressed }) => [
                    styles.smallPrimary,
                    pressed && styles.pressed,
                    createBusy && styles.disabled,
                  ]}
                >
                  {createBusy ? (
                    <ActivityIndicator size="small" color={theme.onAccent} />
                  ) : (
                    <Text style={styles.smallPrimaryText}>
                      {editing ? 'Save' : 'Create'}
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
            {createError && (
              <Text style={styles.inlineError}>{createError}</Text>
            )}
          </View>
        )}

        {playlistsError && !playlists
          ? sectionError(playlistsError)
          : !playlists ? (
              <View style={styles.sectionState}>
                <ActivityIndicator color={theme.accent} />
              </View>
            ) : (
              <>
                {playlists.map((p) => {
                  /* The detail header's runtime rule: the summed
                     KNOWN durations, rounded to minutes; the
                     segment is omitted when none is known. */
                  const runtimeMin =
                    p.totalDurationSeconds != null
                      ? Math.round(p.totalDurationSeconds / 60)
                      : null;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => router.push(`/playlist/${p.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open playlist ${p.name}`}
                      style={({ pressed }) => [
                        styles.plCard2,
                        pressed && styles.pressed,
                      ]}
                    >
                      {renderMosaic(p.coverImages)}
                      <View style={styles.plCardMain}>
                        <Text style={styles.plCardName} numberOfLines={1}>
                          {p.name}
                        </Text>
                        <Text style={styles.plCardMeta} numberOfLines={1}>
                          {p.themeCount}{' '}
                          {p.themeCount === 1 ? 'theme' : 'themes'}
                          {runtimeMin !== null
                            ? ` · ${runtimeMin} min`
                            : ''}
                        </Text>
                        <View
                          style={[
                            styles.plVisPill,
                            p.isPublic
                              ? styles.plVisPublic
                              : styles.plVisPrivate,
                          ]}
                        >
                          <Text
                            style={[
                              styles.plVisText,
                              {
                                color: p.isPublic
                                  ? theme.success
                                  : theme.secondary,
                              },
                            ]}
                          >
                            {p.isPublic ? 'Public' : 'Private'}
                          </Text>
                        </View>
                      </View>
                      <Pressable
                        onPress={() => openMenu(p)}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={`Actions for playlist ${p.name}`}
                        style={({ pressed }) => [
                          styles.plMenuButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <MoreVertical
                          size={20}
                          color={theme.muted}
                          strokeWidth={2}
                        />
                      </Pressable>
                    </Pressable>
                  );
                })}
                {playlists.length === 0 && (
                  <Text style={styles.emptyText}>
                    No playlists yet — create your first one above.
                  </Text>
                )}
                {playlistsError && (
                  <Text style={styles.inlineError}>{playlistsError}</Text>
                )}
              </>
            )}
      </>
    );
  };

  const renderAnilist = () => {
    if (!fixtureMode && !signedIn) return renderLoginPrompt();
    if (fixtureMode) {
      return (
        <Text style={styles.emptyText}>
          Demo mode — themes from your AniList completed and
          watching lists live in your account on the live API.
          Nothing is stored here.
        </Text>
      );
    }
    if (!anilistLinked) {
      return (
        <View style={styles.promptBody}>
          <View style={styles.tile}>
            <Link2 size={26} color={theme.accent} strokeWidth={2} />
          </View>
          <Text style={styles.centerTitle}>AniList not linked</Text>
          <Text style={styles.centerNote}>
            Link your AniList account to fill this list with the
            openings and endings of anime you have completed or
            are watching on AniList.
          </Text>
          <Pressable
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
            accessibilityLabel="Open Settings to link AniList"
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Open Settings</Text>
          </Pressable>
        </View>
      );
    }
    /* The themes view is the segment's only content (Option B).
       A failed read surfaces the segment's error state; while
       the read is in flight the segment waits on the spinner. */
    if (libError && !libThemes) return sectionError(libError);
    if (!libThemes) {
      return (
        <View style={styles.sectionState}>
          <ActivityIndicator color={theme.accent} />
        </View>
      );
    }
    const filteredCount = anilistGroups.reduce(
      (n, g) => n + g.themes.length,
      0,
    );
    return (
      <>
        <Text style={styles.dlTotal}>
          {anilistName ? `AniList · ${anilistName} · ` : ''}
          {libThemes.total}{' '}
          {libThemes.total === 1 ? 'theme' : 'themes'} from anime on
          your AniList completed and watching lists
        </Text>
        <View style={styles.filterRow}>
          {(['ALL', 'OP', 'ED'] as const).map((f) => {
            const active = typeFilter === f;
            return (
              <Pressable
                key={f}
                onPress={() => setTypeFilter(f)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show ${f === 'ALL' ? 'all themes' : `${f}s`}`}
                style={[
                  styles.filterChip,
                  active && { backgroundColor: theme.accent },
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    active && { color: theme.onAccent },
                  ]}
                >
                  {f === 'ALL' ? 'All' : f}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {anilistGroups.map((group) => (
          <View key={group.key}>
            <Pressable
              onPress={
                group.anilistId != null
                  ? () => router.push(`/anime/${group.anilistId}`)
                  : undefined
              }
              disabled={group.anilistId == null}
              accessibilityRole="button"
              accessibilityLabel={`Open ${group.title}`}
              style={({ pressed }) => [
                styles.groupHeader,
                pressed && styles.pressed,
              ]}
            >
              {group.cover ? (
                <Image
                  source={{ uri: group.cover }}
                  style={styles.groupCover}
                />
              ) : (
                <View style={[styles.groupCover, styles.plCoverEmpty]} />
              )}
              <View style={styles.plMain}>
                <Text style={styles.plName} numberOfLines={1}>
                  {group.title}
                </Text>
                <Text style={styles.plMeta} numberOfLines={1}>
                  {group.year ? `${group.year} · ` : ''}
                  {group.themes.length}{' '}
                  {group.themes.length === 1 ? 'theme' : 'themes'}
                </Text>
              </View>
            </Pressable>
            {group.themes.map((item) => (
              <ThemeRow
                typeChip={false}
                key={item.slug}
                item={item}
                onPress={() => openTheme(item.slug)}
                onPlay={() => {
                  // Queue = the segment's groups flattened in
                  // display order.
                  const flat = anilistGroups.flatMap((g) => g.themes);
                  const index = flat.findIndex((t) => t.slug === item.slug);
                  playWithQueue(
                    queueItemsFromSummaries(flat),
                    index,
                    item.slug,
                    'watch',
                  );
                }}
                saved={favorites.isFavorite(item.slug)}
                savePending={favorites.isPending(item.slug)}
                onToggleSave={() => void favorites.toggle(item.slug)}
              />
            ))}
          </View>
        ))}
        {libThemes.total === 0 && (
          <Text style={styles.emptyText}>
            No themes found yet — when anime from your AniList
            completed or watching lists are in the catalogue, their
            openings and endings will show up here.
          </Text>
        )}
        {libThemes.total > 0 && filteredCount === 0 && (
          <Text style={styles.emptyText}>
            No {typeFilter === 'OP' ? 'openings' : 'endings'} in this
            list.
          </Text>
        )}
        {libError && <Text style={styles.inlineError}>{libError}</Text>}
      </>
    );
  };

  const renderOffline = () => {
    if (fixtureMode) {
      return (
        <Text style={styles.emptyText}>
          Demo mode — downloads are switched off in the demo. On the
          live build, themes you keep for offline use appear here.
        </Text>
      );
    }
    if (!downloadsSupported) {
      return (
        <Text style={styles.emptyText}>
          Downloads are not available on web — downloaded files live on
          a device.
        </Text>
      );
    }
    if (!downloads.hydrated) {
      return (
        <View style={styles.sectionState}>
          <ActivityIndicator color={theme.accent} />
        </View>
      );
    }
    const items = downloads.records;
    return (
      <>
        {items.length > 0 && (
          <Text style={styles.dlTotal}>
            {items.length} {items.length === 1 ? 'download' : 'downloads'}{' '}
            · {formatBytes(downloads.totalBytes)} on this device
          </Text>
        )}
        {items.map((record) => {
          const ModeIcon = record.mode === 'watch' ? Play : Headphones;
          return (
            <View key={record.id} style={styles.dlRow}>
              <Pressable
                onPress={() => {
                  if (record.fileMissing) return;
                  // Queue = the playable downloads, in list order;
                  // broken records (missing files) can't be queued.
                  const playable = items.filter((r) => !r.fileMissing);
                  const queueItems: QueueItem[] = playable.map((r) => ({
                    slug: r.slug,
                    atEntryId: r.atEntryId,
                    title: r.songTitle,
                    artistLine: r.artistName ?? r.animeTitle,
                    coverUrl: r.coverImage,
                  }));
                  const index = playable.findIndex(
                    (r) => r.id === record.id,
                  );
                  // 'player' destination: Offline playback is one
                  // of the two surfaces allowed to open the player
                  // route (owner ruling 2026-11-10).
                  playWithQueue(
                    queueItems,
                    index,
                    record.slug,
                    record.mode,
                    record.atEntryId,
                    'player',
                  );
                }}
                accessibilityRole="button"
                accessibilityLabel={
                  record.fileMissing
                    ? `${record.songTitle}, file missing`
                    : `Play ${record.songTitle} offline`
                }
                style={({ pressed }) => [
                  styles.dlRowMain,
                  pressed && styles.pressed,
                ]}
              >
                {record.coverImage ? (
                  <Image
                    source={{ uri: record.coverImage }}
                    style={styles.dlThumb}
                  />
                ) : (
                  <View style={[styles.dlThumb, styles.plCoverEmpty]} />
                )}
                <View style={styles.plMain}>
                  <Text style={styles.plName} numberOfLines={1}>
                    {record.songTitle}
                  </Text>
                  <Text style={styles.plMeta} numberOfLines={1}>
                    {record.animeTitle} · {record.version}
                    {record.artistName ? ` · ${record.artistName}` : ''}
                  </Text>
                  {record.fileMissing ? (
                    <Text style={styles.dlBroken} numberOfLines={1}>
                      File missing — remove it and download again
                    </Text>
                  ) : (
                    <Text style={styles.plMeta} numberOfLines={1}>
                      {formatBytes(record.size)} ·{' '}
                      {relativeTime(record.downloadedAt)}
                    </Text>
                  )}
                </View>
              </Pressable>
              <View style={styles.plChip}>
                <ModeIcon size={11} color={theme.muted} strokeWidth={2} />
                <Text style={styles.plChipText}>
                  {record.mode === 'watch' ? 'Watch' : 'Listen'}
                </Text>
              </View>
              <Pressable
                onPress={() => void downloads.remove(record.id)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Delete the download of ${record.songTitle}`}
                style={({ pressed }) => [
                  styles.dlDelete,
                  pressed && styles.pressed,
                ]}
              >
                <Trash2 size={17} color={theme.muted} strokeWidth={2} />
              </Pressable>
            </View>
          );
        })}
        {items.length === 0 && (
          <Text style={styles.emptyText}>
            Nothing downloaded yet — open a theme and tap the download
            button to keep a version on this device.
          </Text>
        )}
      </>
    );
  };

  /* The playlist ⋮ bottom sheet — the bottom-sheet pattern of
     ThemeRowMenu / the Playlist Detail owner sheet, with that
     sheet's rows: Rename (through the segment's form), the
     visibility toggle and Delete with its two-tap confirm. */
  const renderPlaylistMenu = () => {
    const p = menuPlaylist;
    if (!p) return null;
    const confirming = confirmDeleteId === p.id;
    return (
      <Modal
        visible
        transparent
        animationType="slide"
        onRequestClose={closeMenu}
      >
        <View style={styles.menuBackdrop}>
          <Pressable
            style={styles.menuDismiss}
            onPress={closeMenu}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View style={styles.menuSheet}>
            <View style={styles.menuHeader}>
              <View style={styles.menuHeaderMain}>
                <Text style={styles.menuTitle} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={styles.menuSubtitle}>
                  {p.isPublic ? 'Public playlist' : 'Private playlist'}
                  {' · '}
                  {p.themeCount}{' '}
                  {p.themeCount === 1 ? 'theme' : 'themes'}
                </Text>
              </View>
              <Pressable
                onPress={closeMenu}
                accessibilityRole="button"
                accessibilityLabel="Close menu"
                style={({ pressed }) => [
                  styles.menuClose,
                  pressed && styles.pressed,
                ]}
              >
                <X size={18} color={theme.text} strokeWidth={2} />
              </Pressable>
            </View>

            <Pressable
              onPress={() => startEdit(p)}
              disabled={menuBusy}
              accessibilityRole="button"
              accessibilityLabel="Rename playlist"
              style={({ pressed }) => [
                styles.menuRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.menuIcon}>
                <Pencil size={18} color={theme.accent} strokeWidth={2} />
              </View>
              <Text style={styles.menuLabel}>Rename</Text>
            </Pressable>

            <Pressable
              onPress={() => toggleMenuVisibility(p)}
              disabled={menuBusy}
              accessibilityRole="button"
              accessibilityLabel={
                p.isPublic ? 'Make playlist private' : 'Make playlist public'
              }
              style={({ pressed }) => [
                styles.menuRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.menuIcon}>
                {p.isPublic ? (
                  <Lock size={18} color={theme.accent} strokeWidth={2} />
                ) : (
                  <Globe size={18} color={theme.accent} strokeWidth={2} />
                )}
              </View>
              <Text style={styles.menuLabel}>
                {p.isPublic ? 'Make private' : 'Make public'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => deleteFromMenu(p)}
              disabled={menuBusy}
              accessibilityRole="button"
              accessibilityLabel={
                confirming ? 'Confirm delete playlist' : 'Delete playlist'
              }
              style={({ pressed }) => [
                styles.menuRow,
                pressed && styles.pressed,
              ]}
            >
              <View
                style={[
                  styles.menuIcon,
                  confirming && styles.menuIconDanger,
                ]}
              >
                <Trash2
                  size={18}
                  color={confirming ? theme.onAccent : theme.danger}
                  strokeWidth={2}
                />
              </View>
              <Text
                style={[
                  styles.menuLabel,
                  { color: confirming ? theme.danger : theme.text },
                ]}
              >
                {confirming ? 'Tap again to delete' : 'Delete playlist'}
              </Text>
            </Pressable>

            {menuError && (
              <Text style={styles.inlineError}>{menuError}</Text>
            )}
          </View>
        </View>
      </Modal>
    );
  };

  /* ---------------- chrome ---------------- */

  return (
    <View style={styles.screen}>
      <View style={styles.column}>
        <View style={styles.header}>
          <Text style={styles.title}>Library</Text>
          <Pressable
            onPress={() => router.push('/search')}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Search"
            style={({ pressed }) => [
              styles.searchButton,
              pressed && styles.pressed,
            ]}
          >
            <Search size={24} color={theme.text} strokeWidth={2} />
          </Pressable>
        </View>

        <View style={styles.segmentedBar}>
          {SECTIONS.map(({ key, label }) => {
            const active = section === key;
            return (
              <Pressable
                key={key}
                onPress={() => setSection(key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={label}
                style={[
                  styles.barSegment,
                  active && {
                    backgroundColor: theme.accent,
                    borderColor: theme.accent,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.barSegmentText,
                    active && { color: theme.onAccent },
                  ]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {fixtureMode && (
          <Text style={styles.fixtureNote}>
            Demo mode — the library needs the live API; nothing here is
            stored.
          </Text>
        )}
        {!fixtureMode && favorites.lastError && (
          <Pressable
            onPress={favorites.clearError}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.inlineError}>{favorites.lastError}</Text>
          </Pressable>
        )}

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {section === 'saved' && renderSaved()}
          {section === 'recent' && renderRecent()}
          {section === 'playlists' && renderPlaylists()}
          {section === 'anilist' && renderAnilist()}
          {section === 'offline' && renderOffline()}
        </ScrollView>
        {renderPlaylistMenu()}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.background,
  },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  center: {
    flex: 1,
    backgroundColor: theme.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.xxxl,
  },
  tile: {
    width: 56,
    height: 56,
    borderRadius: radii.md,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  centerTitle: {
    ...typeStyles.heading,
    color: theme.text,
    textAlign: 'center',
  },
  centerNote: {
    ...typeStyles.body,
    color: theme.muted,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 320,
  },
  primaryButton: {
    marginTop: spacing.md,
    backgroundColor: theme.accent,
    borderRadius: 14,
    minHeight: 46,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    ...typeStyles.sectionLabel,
    color: theme.onAccent,
  },
  header: {
    // The shared Library HTML's frame: the title row sits 8px
    // inside the screen edge (px-4 main + px-2 header).
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.screenEdge + 8,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  title: {
    // The HTML's 28px extrabold screen title.
    fontFamily: fontFamilies.wordmark,
    fontSize: 28,
    letterSpacing: -0.7,
    color: theme.text,
  },
  searchButton: {
    // The HTML's 40px circular search hit area (icon 24).
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentedBar: {
    // Lavender Dusk mock: the Library segments are separate
    // TEXT-ONLY pills on ONE row — lavender inactive, mauveDeep
    // filled active — not one bar, no icons, never wrapping.
    // The HTML measures them 44 tall with a 6px gap, inset 4px
    // inside the screen edge (px-4 main + px-1 nav).
    flexDirection: 'row',
    gap: 6,
    marginHorizontal: spacing.screenEdge + 4,
    paddingTop: spacing.xs,
  },
  barSegment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 44,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: theme.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  barSegmentText: {
    // The HTML's 12px medium chip label.
    fontFamily: fontFamilies.caption,
    fontSize: 12,
    color: theme.muted,
  },
  fixtureNote: {
    ...typeStyles.caption,
    color: theme.muted,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.md,
  },
  scroll: {
    flex: 1,
  },
  content: {
    // The shared Library HTML's section inset: 4px inside the
    // screen edge (px-4 main + px-1 section).
    paddingHorizontal: spacing.screenEdge + 4,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  sectionState: {
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.xxl,
  },
  emptyText: {
    ...typeStyles.body,
    color: theme.muted,
    lineHeight: 20,
    paddingTop: spacing.sm,
  },
  inlineError: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    paddingTop: spacing.sm,
    lineHeight: 18,
  },
  retry: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: radii.base,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: {
    ...typeStyles.body,
    color: theme.text,
  },
  loadMore: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  loadMoreText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  viewAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  viewAllCount: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  viewAllText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.accent,
  },
  goneText: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  recentCount: {
    // library-recent.html: the count line at 12.5px medium in
    // the muted plum, inset 4px past the rows (its px-2 against
    // the section's px-1) with 10 below it.
    fontFamily: fontFamilies.caption,
    fontSize: 12.5,
    color: theme.muted,
    paddingHorizontal: spacing.xs,
    paddingBottom: 10,
  },
  recentCard: {
    // library-recent.html: rounded-[20px] cards (a literal —
    // 20 sits between radii.md and radii.card), p-2.5 (10),
    // stacked with a gap-2.5 (10) rhythm.
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 20,
    padding: 10,
    marginBottom: 10,
  },
  recentGoneCard: {
    // The tombstone row in the segment's card clothing.
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 20,
    padding: 10,
    marginBottom: 10,
  },
  recentCover: {
    // library-recent.html: w-14 h-14 (56), rounded-2xl (16).
    width: 56,
    height: 56,
    borderRadius: radii.md,
    backgroundColor: theme.surface,
    flexShrink: 0,
  },
  recentMain: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  recentTitle: {
    // library-recent.html: text-[14.5px] bold, truncated to
    // one line — the recorded law-#9 deviation the season /
    // anime / artist row variants carry.
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 14.5,
    color: theme.text,
  },
  recentArtist: {
    // library-recent.html: 12px medium in the muted plum.
    fontFamily: fontFamilies.caption,
    fontSize: 12,
    color: theme.muted,
  },
  recentPlayedRow: {
    // library-recent.html: the 13px schedule glyph + 11px
    // line, gap-1, mt-0.5.
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 2,
  },
  recentPlayed: {
    fontFamily: fontFamilies.body,
    fontSize: 11,
    color: theme.muted,
  },
  recentCluster: {
    // library-recent.html: the play disc + ⋮ cluster, gap-1.
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  recentDisc: {
    // library-recent.html: the w-9 h-9 (36) disc — pale
    // lavender (theme.raised is the HTML's exact #EDE3F2) with
    // the mauve play glyph.
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentDiscPlaying: {
    // The mock's playing disc: filled in the mauve family
    // (the HTML's #7B5368, and its mini player's #8A5D84, both
    // map to the token mauve — theme.secondary) under a white
    // pause glyph.
    backgroundColor: theme.secondary,
  },
  newPlaylistButton: {
    // The mock's full-width mauveDeep create button (~50 tall,
    // measured from the mock; radii.md corners).
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 50,
    borderRadius: radii.md,
    backgroundColor: theme.accent,
    marginBottom: spacing.md,
  },
  newPlaylistText: {
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 17,
    color: theme.onAccent,
  },
  createForm: {
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  input: {
    ...typeStyles.body,
    color: theme.text,
    backgroundColor: theme.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.base,
    paddingHorizontal: spacing.md,
    minHeight: 46,
    paddingVertical: 0,
  },
  createOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 3,
    borderRadius: radii.pill,
    backgroundColor: theme.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  segment: {
    minWidth: 62,
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  segmentText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  createButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  ghostButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.base,
  },
  ghostButtonText: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  smallPrimary: {
    backgroundColor: theme.accent,
    borderRadius: radii.base,
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallPrimaryText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccent,
  },
  disabled: {
    opacity: 0.5,
  },
  plCard2: {
    // The Playlists mock's white card: measured ~91 tall (its
    // content sizes it), 14 padding, cards stacked with a ~15
    // gap (spacing.lg).
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.card,
    padding: 14,
    marginBottom: spacing.lg,
  },
  plCardMain: {
    flex: 1,
    gap: 3,
  },
  plCardName: {
    // The mock's card name: display face at a measured ~18.
    fontFamily: fontFamilies.display,
    fontSize: 18,
    color: theme.text,
  },
  plCardMeta: {
    // The mock's count line: 14 medium muted.
    fontFamily: fontFamilies.caption,
    fontSize: 14,
    color: theme.muted,
  },
  plVisPill: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 3,
  },
  plVisPrivate: {
    backgroundColor: theme.accentContainer,
  },
  plVisPublic: {
    backgroundColor: theme.successContainer,
  },
  plVisText: {
    fontFamily: fontFamilies.bodyStrong,
    fontSize: 12,
  },
  plMenuButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plGrid: {
    // The detail header's collage at this card's scale: 64
    // square, 2 padding + 2 gutters, cells rounded 3.
    width: 64,
    height: 64,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    padding: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    overflow: 'hidden',
  },
  plGridCell: {
    width: 29,
    height: 29,
    borderRadius: 3,
    backgroundColor: theme.surface,
  },
  plGridCellEmpty: {
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plGridSingle: {
    width: 64,
    height: 64,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  /* Playlist ⋮ sheet — the Playlist Detail sheet's geometry. */
  menuBackdrop: {
    flex: 1,
    backgroundColor: withOpacity(theme.background, 0.72),
    justifyContent: 'flex-end',
  },
  menuDismiss: {
    flex: 1,
  },
  menuSheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: radii.cardLg,
    borderTopRightRadius: radii.cardLg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  menuHeaderMain: {
    flex: 1,
    gap: 2,
  },
  menuTitle: {
    ...typeStyles.heading,
    color: theme.text,
  },
  menuSubtitle: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  menuClose: {
    width: 36,
    height: 36,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  menuIcon: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuIconDanger: {
    backgroundColor: theme.danger,
  },
  menuLabel: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  plCoverEmpty: {
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plMain: {
    flex: 1,
    gap: 2,
  },
  plName: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
  },
  plMeta: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  plChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: theme.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  plChipPrivate: {
    backgroundColor: theme.raised,
  },
  plChipText: {
    ...typeStyles.caption,
    color: theme.muted,
  },
  promptBody: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.screenEdge,
  },
  dlTotal: {
    ...typeStyles.caption,
    color: theme.muted,
    paddingBottom: spacing.sm,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 3,
    borderRadius: radii.pill,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    marginBottom: spacing.md,
  },
  filterChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  filterChipText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  groupCover: {
    width: 38,
    height: 48,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  dlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  dlRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  dlThumb: {
    width: 42,
    height: 52,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  dlBroken: {
    ...typeStyles.caption,
    color: theme.accent,
  },
  dlDelete: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.85,
  },
});

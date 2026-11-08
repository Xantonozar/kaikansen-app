import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Bookmark,
  ChevronRight,
  Clock,
  Download,
  Headphones,
  Library as LibraryIcon,
  Link2,
  ListMusic,
  Lock,
  Play,
  Plus,
  Trash2,
} from 'lucide-react-native';
import type {
  FavoritesResponse,
  LibraryThemesResponse,
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
  fetchFavorites,
  fetchHistory,
  fetchLibraryThemes,
  fetchPlaylists,
} from '../../../src/libraryApi';
import {
  downloadsSupported,
  formatBytes,
  recheckDownloads,
  useDownloads,
} from '../../../src/downloads';
import { ThemeRow } from '../../../src/components/ThemeRow';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

type Section = 'saved' | 'recent' | 'playlists' | 'anilist' | 'offline';

type TypeFilter = 'ALL' | 'OP' | 'ED';

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  strokeWidth?: number;
}>;

const SECTIONS: { key: Section; label: string; Icon: IconComponent }[] = [
  { key: 'saved', label: 'Saved', Icon: Bookmark },
  { key: 'recent', label: 'Recent', Icon: Clock },
  { key: 'playlists', label: 'Playlists', Icon: ListMusic },
  { key: 'anilist', label: 'AniList', Icon: Link2 },
  { key: 'offline', label: 'Offline', Icon: Download },
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
 * The AniList segment reads GET /library/themes — the union
 * of the caller's watch history and the themes of anime on their
 * AniList COMPLETED + CURRENT (watching) lists (the API widens
 * the web's completed-only read) — grouped by anime with an
 * All / OP / ED filter. Signed-in
 * but unlinked gets a prompt to link AniList in Settings; the link
 * state comes from the session profile's `anilist` field (with the
 * session-local link username as a fallback for a link made moments
 * ago), never guessed.
 *
 * Honest states throughout: signed-out gets a log-in prompt, fixture
 * mode gets clearly-labelled demo empties (a demo library stores
 * nothing), and each section carries its own loading / error /
 * empty rendering — no fabricated content anywhere.
 */
export default function LibraryScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const { status, user, anilistUsername } = useAuth();
  const favorites = useFavorites();
  const downloads = useDownloads();

  const [section, setSection] = useState<Section>('saved');

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
    /* The AniList union is only fetched when a link is known to
       exist — unlinked, the segment renders its link prompt and
       there is nothing AniList-side to load. */
    if (anilistLinked) {
      fetchLibraryThemes()
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
     focus-driven (returning from the player shows the new history
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

  const playTheme = useCallback(
    (slug: string, mode: 'watch' | 'listen', atEntryId?: number | null) =>
      router.push({
        pathname: '/player',
        params: {
          slug,
          mode,
          ...(atEntryId != null ? { entry: String(atEntryId) } : {}),
        },
      }),
    [router],
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

  const submitCreate = useCallback(() => {
    const name = newName.trim();
    if (name.length === 0) {
      setCreateError('Give the playlist a name.');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    createPlaylist({ name, isPublic: newPublic })
      .then((detail) => {
        setPlaylists((prev) => [detail, ...(prev ?? [])]);
        setCreating(false);
        setNewName('');
        setNewPublic(true);
      })
      .catch((e: unknown) =>
        setCreateError(
          e instanceof Error ? e.message : 'Could not create the playlist.',
        ),
      )
      .finally(() => setCreateBusy(false));
  }, [newName, newPublic]);

  /* AniList segment: group the flat union by anime. The endpoint's
     order (newest season first, then title) fixes the group order;
     inside a group, OPs come before EDs, each by sequence. The
     All / OP / ED filter applies before grouping, so a group only
     ever shows the filtered types. */
  const anilistGroups = useMemo(() => {
    if (!libThemes) return [];
    const filtered =
      typeFilter === 'ALL'
        ? libThemes.themes
        : libThemes.themes.filter((t) => t.type === typeFilter);
    const groups: {
      key: string;
      title: string;
      year: number | null;
      cover: string | null;
      themes: ThemeSummary[];
    }[] = [];
    const byKey = new Map<string, (typeof groups)[number]>();
    for (const item of filtered) {
      const title = item.animeTitleEnglish ?? item.animeTitle;
      const key = title.toLowerCase();
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
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
        {fav.themes.map((item) => (
          <ThemeRow
            key={item.slug}
            item={item}
            onPress={() => openTheme(item.slug)}
            onPlay={() => playTheme(item.slug, 'watch')}
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
    return (
      <>
        {history.map((entry) =>
          entry.theme ? (
            <ThemeRow
              key={entry.id}
              item={entry.theme}
              detail={`${entry.mode === 'watch' ? 'Watched' : 'Listened'} · ${relativeTime(entry.viewedAt)}`}
              onPress={() => openTheme(entry.theme!.slug)}
              onPlay={() =>
                playTheme(entry.theme!.slug, entry.mode, entry.atEntryId)
              }
              saved={favorites.isFavorite(entry.theme.slug)}
              savePending={favorites.isPending(entry.theme.slug)}
              onToggleSave={() => void favorites.toggle(entry.theme!.slug)}
            />
          ) : (
            <View key={entry.id} style={styles.goneRow}>
              <Text style={styles.goneText} numberOfLines={1}>
                A theme that has left the catalogue ·{' '}
                {relativeTime(entry.viewedAt)}
              </Text>
            </View>
          ),
        )}
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
        {!creating ? (
          <Pressable
            onPress={() => {
              setCreating(true);
              setCreateError(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="New playlist"
            style={({ pressed }) => [
              styles.createRow,
              pressed && styles.pressed,
            ]}
          >
            <Plus size={18} color={theme.accent} strokeWidth={2} />
            <Text style={styles.createRowText}>New playlist</Text>
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
              onSubmitEditing={submitCreate}
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
                  onPress={() => setCreating(false)}
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
                  onPress={submitCreate}
                  disabled={createBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Create playlist"
                  style={({ pressed }) => [
                    styles.smallPrimary,
                    pressed && styles.pressed,
                    createBusy && styles.disabled,
                  ]}
                >
                  {createBusy ? (
                    <ActivityIndicator size="small" color={theme.onAccent} />
                  ) : (
                    <Text style={styles.smallPrimaryText}>Create</Text>
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
                {playlists.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => router.push(`/playlist/${p.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open playlist ${p.name}`}
                    style={({ pressed }) => [
                      styles.plCard,
                      pressed && styles.pressed,
                    ]}
                  >
                    {p.coverImage ? (
                      <Image
                        source={{ uri: p.coverImage }}
                        style={styles.plCover}
                      />
                    ) : (
                      <View style={[styles.plCover, styles.plCoverEmpty]}>
                        <ListMusic size={18} color={theme.muted} strokeWidth={2} />
                      </View>
                    )}
                    <View style={styles.plMain}>
                      <Text style={styles.plName} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text style={styles.plMeta} numberOfLines={1}>
                        {p.themeCount}{' '}
                        {p.themeCount === 1 ? 'theme' : 'themes'}
                        {p.description ? ` · ${p.description}` : ''}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.plChip,
                        !p.isPublic && styles.plChipPrivate,
                      ]}
                    >
                      {!p.isPublic && (
                        <Lock size={11} color={theme.muted} strokeWidth={2} />
                      )}
                      <Text style={styles.plChipText}>
                        {p.isPublic ? 'Public' : 'Private'}
                      </Text>
                    </View>
                    <ChevronRight size={18} color={theme.muted} strokeWidth={2} />
                  </Pressable>
                ))}
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
          {libThemes.total === 1 ? 'theme' : 'themes'} from your
          completed and watching anime and watch history
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
            <View style={styles.groupHeader}>
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
            </View>
            {group.themes.map((item) => (
              <ThemeRow
                key={item.slug}
                item={item}
                onPress={() => openTheme(item.slug)}
                onPlay={() => playTheme(item.slug, 'watch')}
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
                  playTheme(record.slug, record.mode, record.atEntryId);
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

  /* ---------------- chrome ---------------- */

  return (
    <View style={styles.screen}>
      <View style={styles.column}>
        <View style={styles.header}>
          <Text style={styles.title}>Library</Text>
          {!fixtureMode && signedIn && (
            <Pressable
              onPress={() => {
                setSection('playlists');
                setCreating(true);
                setCreateError(null);
              }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="New playlist"
              style={({ pressed }) => [
                styles.headerAction,
                pressed && styles.pressed,
              ]}
            >
              <Plus size={20} color={theme.text} strokeWidth={2} />
            </Pressable>
          )}
        </View>

        <View style={styles.segmentedBar}>
          {SECTIONS.map(({ key, label, Icon }) => {
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
                  active && { backgroundColor: theme.accent },
                ]}
              >
                <Icon
                  size={15}
                  color={active ? theme.onAccent : theme.onAccentContainer}
                  strokeWidth={2}
                />
                <Text
                  style={[
                    styles.barSegmentText,
                    active && { color: theme.onAccent },
                  ]}
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.screenEdge,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: {
    ...typeStyles.heading,
    color: theme.text,
  },
  headerAction: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentedBar: {
    // Lavender Dusk mock: the Library segments are separate chips in a
    // row — lavender inactive, mauveDeep filled active — not one bar.
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginHorizontal: spacing.screenEdge,
  },
  barSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs + 2,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: theme.accentContainer,
  },
  barSegmentText: {
    ...typeStyles.bodySmall,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccentContainer,
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
    paddingHorizontal: spacing.screenEdge,
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
  goneRow: {
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  goneText: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.base,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  createRowText: {
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.text,
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
  plCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  plCover: {
    width: 52,
    height: 52,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
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

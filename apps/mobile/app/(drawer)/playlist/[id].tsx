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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  Check,
  ChevronLeft,
  Download,
  Globe,
  ListMusic,
  Lock,
  MoreVertical,
  Pencil,
  Play,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react-native';
import type { PlaylistDetail } from '@kaikansen/contracts';
import {
  cacheKeyFor,
  fetchThemeBySlug,
  fixtureMode,
  subscribeCache,
} from '../../../src/api';
import { downloadsSupported, useDownloads } from '../../../src/downloads';
import { useAuth } from '../../../src/auth';
import { useFavorites } from '../../../src/favoritesStore';
import {
  deletePlaylist,
  fetchPlaylist,
  removePlaylistItem,
  updatePlaylist,
} from '../../../src/libraryApi';
import { ThemeRow } from '../../../src/components/ThemeRow';
import { formatTime } from '../../../src/playback';
import {
  queueItemsFromSummaries,
  usePlaybackSession,
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

/**
 * Playlist detail (Slice M2) — one playlist with its items in stored
 * order. The read is public (the API mirrors the web: no auth, no
 * isPublic gate), so a signed-out viewer sees the playlist and can
 * play from it; owner controls (rename, visibility toggle, item
 * removal, delete) appear only when the signed-in user owns it —
 * others' attempts would 404 at the API anyway.
 *
 * Mutations take the API's returned detail as the new truth (the
 * service resolves items server-side), except rename/visibility,
 * which patch the same way. Delete keeps its two-tap confirm, now
 * on its row in the header's ⋮ sheet.
 *
 * Header (Playlist mock rebuild — the Stitch screen's HTML is the
 * measurement truth): a glass-disc top bar (40px white circles —
 * back left, "Playlist" centred, and for the owner a ⋮ disc right
 * opening a bottom-sheet menu with the screen's owner actions:
 * Rename, the visibility toggle and Delete with its two-tap
 * confirm; a non-owner has no playlist-level actions, so the disc
 * is not drawn rather than drawn dead). Below it a white card —
 * 2×2 cover grid from the first items' covers (a lone cover fills
 * the square; empty cells are tinted tiles) beside the name, the
 * owner line and the count + Public/Private pill (display-only;
 * the toggle lives in the ⋮ menu), then a divided action row:
 * Play All (the playlist claimed as a queue, in order), Shuffle
 * (same queue, shuffled), Download (every item's audio through
 * the downloads store, sequentially — items already downloaded
 * no-op). The header's remaining design details are data-backed:
 * the count line's runtime ("12 themes · 18 min") sums the items'
 * summary durations (ThemeSummary.duration — the document's own
 * field; the segment is omitted when no item's duration is known,
 * never invented), rows carry their duration, and the
 * "by <owner>" line renders for every playlist from the detail
 * payload's resolved owner identity.
 */
export default function PlaylistDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status, user } = useAuth();
  const favorites = useFavorites();
  const { startQueue } = usePlaybackSession();
  const downloads = useDownloads();
  const [dlBusy, setDlBusy] = useState(false);

  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'missing' | 'error'
  >('loading');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Load the playlist. `silent` (focus refetches) never blanks a
   * screen that already has data: failures and vanished playlists
   * are ignored, fresh data replaces stale.
   */
  const load = useCallback(
    (
      apply: (p: PlaylistDetail | null) => void,
      opts?: { silent?: boolean },
    ) => {
      fetchPlaylist(id)
        .then((data) => {
          if (data) {
            apply(data);
            setLoadState('ready');
          } else if (!opts?.silent) {
            apply(null);
            setLoadState('missing');
          }
        })
        .catch(() => {
          if (!opts?.silent) setLoadState('error');
        });
    },
    [id],
  );

  /* Silent swap (perf problem 5): a background revalidation of
     the USER-cached playlist read replaces it in place — skipped
     while a rename draft is open so the draft survives (the
     editing ref lives with the focus handler below; the closure
     reads it live at notify time). */
  useEffect(() => {
    if (fixtureMode) return;
    return subscribeCache<PlaylistDetail>(
      cacheKeyFor(`/playlists/${encodeURIComponent(id)}`),
      (fresh) => {
        if (editingRef.current) return;
        setPlaylist(fresh);
        setLoadState('ready');
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    let live = true;
    setLoadState('loading');
    load((data) => {
      if (live) setPlaylist(data);
    });
    return () => {
      live = false;
    };
  }, [load]);

  /* Refetch on focus (an add from the theme detail lands here) —
     skipped while a rename is in progress so the draft survives. */
  const editingRef = useRef(false);
  editingRef.current = editingName;
  useFocusEffect(
    useCallback(() => {
      if (editingRef.current) return;
      load((data) => setPlaylist(data), { silent: true });
    }, [load]),
  );

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const owner =
    status === 'signedIn' && user !== null && playlist !== null &&
    user.id === playlist.userId;

  /* Header by-line + runtime: the by-line prefers the payload's
     resolved owner identity (so other people's playlists read
     "by <owner>" too), falling back to the signed-in profile for
     your own when the API could not resolve it. The runtime sums
     the items' KNOWN durations only; with none known, the header
     omits the segment rather than inventing a number. */
  const ownerLine = playlist
    ? playlist.ownerDisplayName ||
      playlist.ownerUsername ||
      (owner && user ? user.displayName || user.username : null)
    : null;
  const knownDurations = (playlist?.items ?? [])
    .map((i) => i.duration)
    .filter((d): d is number => d != null);
  const runtimeMin =
    knownDurations.length > 0
      ? Math.round(knownDurations.reduce((a, b) => a + b, 0) / 60)
      : null;

  /* Header cover grid: the first items' distinct covers, in
     playlist order (the design's 2×2 collage). */
  const gridCovers = useMemo(() => {
    if (!playlist) return [];
    const covers: string[] = [];
    for (const item of playlist.items) {
      const cover = item.animeCoverImage ?? item.animeCoverImageSmall;
      if (cover && !covers.includes(cover)) covers.push(cover);
      if (covers.length >= 4) break;
    }
    return covers;
  }, [playlist]);

  /** Play All: the playlist IS the queue, in order (Slice 2.5) —
      the mini player's Next walks it. Opens the player like a
      row play does. */
  const playAll = useCallback(() => {
    if (!playlist || playlist.items.length === 0) return;
    startQueue(queueItemsFromSummaries(playlist.items), 0, 'watch', 'playlist');
    router.push({
      pathname: '/player',
      params: { slug: playlist.items[0].slug, mode: 'watch' },
    });
  }, [playlist, startQueue, router]);

  /** Shuffle: the same queue claim, order shuffled first. */
  const shufflePlay = useCallback(() => {
    if (!playlist || playlist.items.length === 0) return;
    const shuffled = [...playlist.items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    startQueue(queueItemsFromSummaries(shuffled), 0, 'watch', 'playlist');
    router.push({
      pathname: '/player',
      params: { slug: shuffled[0].slug, mode: 'watch' },
    });
  }, [playlist, startQueue, router]);

  /** Download: every item's LISTEN file through the downloads
      store, one at a time (the store itself skips anything
      already downloaded or in flight, and per-item failures are
      counted, never hidden). */
  const downloadAll = useCallback(async () => {
    if (!playlist || dlBusy || playlist.items.length === 0) return;
    if (fixtureMode) {
      setActionError('Downloads are not available in demo mode.');
      return;
    }
    if (!downloadsSupported) {
      setActionError('Downloads are not available on web.');
      return;
    }
    setDlBusy(true);
    setActionError(null);
    let failures = 0;
    let firstError: string | null = null;
    for (const item of playlist.items) {
      try {
        const detail = await fetchThemeBySlug(item.slug);
        const entry = detail?.entries[0] ?? null;
        if (!detail || !entry) {
          failures += 1;
          continue;
        }
        const err = await downloads.start(detail, entry, 'listen');
        if (err) {
          failures += 1;
          if (firstError === null) firstError = err;
        }
      } catch {
        failures += 1;
      }
    }
    setDlBusy(false);
    if (failures === 1 && firstError) {
      setActionError(firstError);
    } else if (failures > 1) {
      setActionError(`${failures} downloads could not be started.`);
    }
  }, [playlist, dlBusy, downloads]);

  const runMutation = useCallback(
    (call: () => Promise<PlaylistDetail>) => {
      setBusy(true);
      setActionError(null);
      call()
        .then((detail) => setPlaylist(detail))
        .catch((e: unknown) =>
          setActionError(
            e instanceof Error ? e.message : 'Something went wrong.',
          ),
        )
        .finally(() => setBusy(false));
    },
    [],
  );

  const saveName = useCallback(() => {
    if (!playlist) return;
    const name = nameDraft.trim();
    if (name.length === 0) {
      setActionError('Give the playlist a name.');
      return;
    }
    setEditingName(false);
    runMutation(() => updatePlaylist(playlist.id, { name }));
  }, [playlist, nameDraft, runMutation]);

  const toggleVisibility = useCallback(() => {
    if (!playlist) return;
    runMutation(() =>
      updatePlaylist(playlist.id, { isPublic: !playlist.isPublic }),
    );
  }, [playlist, runMutation]);

  const removeItem = useCallback(
    (slug: string) => {
      if (!playlist) return;
      runMutation(() => removePlaylistItem(playlist.id, slug));
    },
    [playlist, runMutation],
  );

  const onDelete = useCallback(() => {
    if (!playlist) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setBusy(true);
    deletePlaylist(playlist.id)
      .then(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/');
      })
      .catch((e: unknown) => {
        setBusy(false);
        setConfirmDelete(false);
        setActionError(
          e instanceof Error ? e.message : 'Could not delete the playlist.',
        );
      });
  }, [playlist, confirmDelete, router]);

  const backTile = (
    <Pressable
      onPress={() => router.back()}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={styles.backHit}
    >
      <View style={styles.glassDisc}>
        <ChevronLeft size={20} color={theme.text} strokeWidth={2.2} />
      </View>
    </Pressable>
  );

  /* The header's ⋮ disc (owner only — see the header note): opens
     the sheet holding Rename / visibility / Delete. */
  const menuTile = (
    <Pressable
      onPress={() => setMenuOpen(true)}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityLabel="Playlist options"
      style={styles.backHit}
    >
      <View style={styles.glassDisc}>
        <MoreVertical size={20} color={theme.text} strokeWidth={2} />
      </View>
    </Pressable>
  );

  if (loadState === 'loading') {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {backTile}
        </View>
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      </View>
    );
  }

  if (loadState !== 'ready' || !playlist) {
    return (
      <View style={styles.screen}>
        <View style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}>
          {backTile}
        </View>
        <View style={styles.center}>
          <Text style={styles.message}>
            {fixtureMode
              ? 'Playlists are not available in demo mode.'
              : loadState === 'missing'
                ? 'That playlist could not be found.'
                : 'Could not load this playlist.'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <>
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.column}>
        <View
          style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}
        >
          {backTile}
          <Text style={styles.topTitle}>Playlist</Text>
          {owner ? menuTile : <View style={styles.backHit} />}
        </View>

        <View style={styles.body}>
          <View style={styles.headerCard}>
            <View style={styles.headerTop}>
              {gridCovers.length === 1 ||
              (gridCovers.length === 0 && playlist.coverImage) ? (
                <Image
                  source={{
                    uri: gridCovers[0] ?? playlist.coverImage ?? undefined,
                  }}
                  style={styles.gridSingle}
                />
              ) : (
                <View style={styles.grid}>
                  {[0, 1, 2, 3].map((i) =>
                    gridCovers[i] ? (
                      <Image
                        key={i}
                        source={{ uri: gridCovers[i] }}
                        style={styles.gridCell}
                      />
                    ) : (
                      <View
                        key={i}
                        style={[styles.gridCell, styles.gridCellEmpty]}
                      >
                        {gridCovers.length === 0 && i === 0 ? (
                          <ListMusic
                            size={16}
                            color={theme.muted}
                            strokeWidth={2}
                          />
                        ) : null}
                      </View>
                    ),
                  )}
                </View>
              )}

              <View style={styles.headerInfo}>
                {editingName ? (
                  <View style={styles.nameEdit}>
                    <TextInput
                      style={styles.editInput}
                      value={nameDraft}
                      onChangeText={setNameDraft}
                      placeholder="Playlist name"
                      placeholderTextColor={theme.muted}
                      autoFocus
                      maxLength={100}
                      returnKeyType="done"
                      onSubmitEditing={saveName}
                    />
                    <View style={styles.nameEditButtons}>
                      <Pressable
                        onPress={saveName}
                        accessibilityRole="button"
                        accessibilityLabel="Save name"
                        style={({ pressed }) => [
                          styles.iconButton,
                          styles.iconButtonAccent,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Check size={18} color={theme.onAccent} strokeWidth={2} />
                      </Pressable>
                      <Pressable
                        onPress={() => setEditingName(false)}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel rename"
                        style={({ pressed }) => [
                          styles.iconButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <X size={18} color={theme.text} strokeWidth={2} />
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <>
                    <View style={styles.nameRow}>
                      <Text style={styles.name} numberOfLines={2}>
                        {playlist.name}
                      </Text>
                    </View>
                    {ownerLine ? (
                      <Text style={styles.byLine}>by {ownerLine}</Text>
                    ) : null}
                    <View style={styles.metaLine}>
                      <Text style={styles.meta}>
                        {playlist.themeCount}{' '}
                        {playlist.themeCount === 1 ? 'theme' : 'themes'}
                        {runtimeMin !== null ? ` · ${runtimeMin} min` : ''}
                      </Text>
                      {/* Display-only pill (the mock's); the owner
                          toggles visibility from the ⋮ menu. */}
                      <View
                        style={[
                          styles.chip,
                          playlist.isPublic && styles.chipPublic,
                        ]}
                      >
                        {playlist.isPublic ? (
                          <Globe size={10} color={theme.success} strokeWidth={2.5} />
                        ) : (
                          <Lock size={10} color={theme.onAccentContainer} strokeWidth={2.5} />
                        )}
                        <Text
                          style={[
                            styles.chipText,
                            playlist.isPublic && styles.chipTextPublic,
                          ]}
                        >
                          {playlist.isPublic ? 'Public' : 'Private'}
                        </Text>
                      </View>
                    </View>
                  </>
                )}
              </View>
            </View>

            <View style={styles.actionRow}>
              <Pressable
                onPress={playAll}
                disabled={playlist.items.length === 0}
                accessibilityRole="button"
                accessibilityLabel="Play all"
                style={({ pressed }) => [
                  styles.playAllButton,
                  playlist.items.length === 0 && styles.actionDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Play
                  size={16}
                  color={theme.onAccent}
                  fill={theme.onAccent}
                  strokeWidth={2}
                />
                <Text style={styles.playAllText}>Play All</Text>
              </Pressable>
              <Pressable
                onPress={shufflePlay}
                disabled={playlist.items.length === 0}
                accessibilityRole="button"
                accessibilityLabel="Shuffle play"
                style={({ pressed }) => [
                  styles.roundButton,
                  playlist.items.length === 0 && styles.actionDisabled,
                  pressed && styles.pressed,
                ]}
              >
                <Shuffle size={20} color={theme.onAccentContainer} strokeWidth={2} />
              </Pressable>
              <Pressable
                onPress={() => void downloadAll()}
                disabled={dlBusy || playlist.items.length === 0}
                accessibilityRole="button"
                accessibilityLabel="Download all themes as audio"
                style={({ pressed }) => [
                  styles.roundButton,
                  playlist.items.length === 0 && styles.actionDisabled,
                  pressed && styles.pressed,
                ]}
              >
                {dlBusy ? (
                  <ActivityIndicator size="small" color={theme.onAccentContainer} />
                ) : (
                  <Download size={20} color={theme.onAccentContainer} strokeWidth={2} />
                )}
              </Pressable>
            </View>
          </View>

          {playlist.description ? (
            <Text style={styles.description}>{playlist.description}</Text>
          ) : null}

          {actionError && <Text style={styles.error}>{actionError}</Text>}
          {favorites.lastError && (
            <Text style={styles.error}>{favorites.lastError}</Text>
          )}

          <View style={styles.items}>
            {playlist.items.map((item, index) => (
              <ThemeRow
                key={item.slug}
                item={item}
                playlist
                durationText={
                  item.duration != null ? formatTime(item.duration) : undefined
                }
                onPress={() => router.push(`/theme/${item.slug}`)}
                onPlay={() => {
                  // The playlist IS the queue (Slice 2.5): playing a
                  // row claims the whole list at that row, so the
                  // mini player's Next and the player's prev/next +
                  // Up Next walk the playlist in order.
                  startQueue(
                    queueItemsFromSummaries(playlist.items),
                    index,
                    'watch',
                    'playlist',
                  );
                  router.push({
                    pathname: '/player',
                    params: { slug: item.slug, mode: 'watch' },
                  });
                }}
                saved={favorites.isFavorite(item.slug)}
                savePending={favorites.isPending(item.slug)}
                onToggleSave={() => void favorites.toggle(item.slug)}
                onRemove={owner ? () => removeItem(item.slug) : undefined}
              />
            ))}
            {playlist.items.length === 0 && (
              <Text style={styles.emptyText}>
                No themes yet — add some from a theme’s detail page.
              </Text>
            )}
          </View>
        </View>
      </View>
    </ScrollView>

    {/* Owner ⋮ sheet — the header disc's menu (same bottom-sheet
        pattern as ThemeRowMenu): Rename, the visibility toggle
        and Delete with its existing two-tap confirm, all wired to
        the mutations above. */}
    <Modal
      visible={menuOpen}
      transparent
      animationType="slide"
      onRequestClose={() => setMenuOpen(false)}
    >
      <View style={styles.menuBackdrop}>
        <Pressable
          style={styles.menuDismiss}
          onPress={() => setMenuOpen(false)}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={styles.menuSheet}>
          <View style={styles.menuHeader}>
            <View style={styles.menuHeaderMain}>
              <Text style={styles.menuTitle} numberOfLines={1}>
                {playlist.name}
              </Text>
              <Text style={styles.menuSubtitle}>
                {playlist.isPublic ? 'Public playlist' : 'Private playlist'}
                {' · '}
                {playlist.themeCount}{' '}
                {playlist.themeCount === 1 ? 'theme' : 'themes'}
              </Text>
            </View>
            <Pressable
              onPress={() => setMenuOpen(false)}
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
            onPress={() => {
              setMenuOpen(false);
              setNameDraft(playlist.name);
              setEditingName(true);
              setActionError(null);
            }}
            disabled={busy}
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
            onPress={() => {
              setMenuOpen(false);
              toggleVisibility();
            }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={
              playlist.isPublic ? 'Make playlist private' : 'Make playlist public'
            }
            style={({ pressed }) => [
              styles.menuRow,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.menuIcon}>
              {playlist.isPublic ? (
                <Lock size={18} color={theme.accent} strokeWidth={2} />
              ) : (
                <Globe size={18} color={theme.accent} strokeWidth={2} />
              )}
            </View>
            <Text style={styles.menuLabel}>
              {playlist.isPublic ? 'Make private' : 'Make public'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              if (confirmDelete) setMenuOpen(false);
              onDelete();
            }}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={
              confirmDelete ? 'Confirm delete playlist' : 'Delete playlist'
            }
            style={({ pressed }) => [
              styles.menuRow,
              pressed && styles.pressed,
            ]}
          >
            <View
              style={[
                styles.menuIcon,
                confirmDelete && styles.menuIconDanger,
              ]}
            >
              <Trash2
                size={18}
                color={confirmDelete ? theme.onAccent : theme.danger}
                strokeWidth={2}
              />
            </View>
            <Text
              style={[
                styles.menuLabel,
                { color: confirmDelete ? theme.danger : theme.text },
              ]}
            >
              {confirmDelete ? 'Tap again to delete' : 'Delete playlist'}
            </Text>
          </Pressable>
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
    // The mock's bar sits 14px above the header card (mb-3.5).
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  topTitle: {
    flex: 1,
    // The mock's centred title: 15px semibold, tracking wide.
    ...typeStyles.sectionLabel,
    color: theme.muted,
    textAlign: 'center',
    letterSpacing: 0.4,
  },
  backHit: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassDisc: {
    // The mock's header discs: plain WHITE 40px circles (w-10
    // h-10), fully round, hairline edge — the Profile slice's
    // gear-disc treatment.
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
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
    lineHeight: 20,
  },
  body: {
    paddingHorizontal: spacing.screenEdge,
    paddingBottom: spacing.xxxl,
  },
  headerCard: {
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    // The mock's card: rounded-2xl (16) corners, p-3.5 (14).
    borderRadius: radii.md,
    padding: 14,
    marginBottom: spacing.md,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    // The mock's collage-to-text gap: gap-3.5 (14).
    gap: 14,
  },
  grid: {
    // The mock's collage: 96px square (w-24), rounded-xl (12),
    // 2px padding and 2px gutters, cells rounded 3px.
    width: 96,
    height: 96,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    padding: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    overflow: 'hidden',
  },
  gridCell: {
    width: 45,
    height: 45,
    borderRadius: 3,
    backgroundColor: theme.surface,
  },
  gridCellEmpty: {
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridSingle: {
    width: 96,
    height: 96,
    borderRadius: radii.base,
    backgroundColor: theme.surface,
  },
  headerInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  byLine: {
    ...typeStyles.bodySmall,
    // The mock's by-line: 13px at medium weight.
    fontSize: 13,
    fontFamily: fontFamilies.caption,
    color: theme.muted,
    marginTop: 2,
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // The mock's action row: gap-2.5 (10), mt-3 (12), pt-2.5 (10)
    // above its hairline.
    gap: 10,
    marginTop: spacing.md,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  playAllButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: theme.accent,
  },
  playAllText: {
    // The mock's label: 14px bold on the deep-mauve pill.
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.onAccent,
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: theme.accentContainer,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionDisabled: {
    opacity: 0.45,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  name: {
    ...typeStyles.display,
    // The mock's playlist name: 19px bold, tight leading.
    fontSize: 19,
    color: theme.text,
    flexShrink: 1,
  },
  nameEdit: {
    gap: spacing.sm,
  },
  nameEditButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  editInput: {
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
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonAccent: {
    backgroundColor: theme.accent,
  },
  description: {
    ...typeStyles.bodySmall,
    color: theme.muted,
    marginTop: spacing.xs + 2,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  meta: {
    ...typeStyles.bodySmall,
    color: theme.muted,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    // The mock's visibility pill: lavender fill, hairline edge,
    // 11px medium text (px-2 py-0.5 in the HTML).
    backgroundColor: theme.accentContainer,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  chipPublic: {
    // Design: Public playlists wear the sage pill; Private stays lavender.
    backgroundColor: theme.successContainer,
    borderColor: 'transparent',
  },
  chipText: {
    ...typeStyles.caption,
    color: theme.onAccentContainer,
  },
  chipTextPublic: {
    color: theme.success,
  },
  error: {
    ...typeStyles.bodySmall,
    color: theme.accent,
    marginTop: spacing.md,
    lineHeight: 18,
  },
  items: {
    marginTop: spacing.lg,
  },
  emptyText: {
    ...typeStyles.body,
    color: theme.muted,
    lineHeight: 20,
    paddingTop: spacing.sm,
  },
  /* Owner ⋮ sheet — ThemeRowMenu's bottom-sheet pattern. */
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
  pressed: {
    opacity: 0.85,
  },
});

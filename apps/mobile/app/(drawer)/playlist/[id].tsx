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
  Pencil,
  Play,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react-native';
import type { PlaylistDetail } from '@kaikansen/contracts';
import { fetchThemeBySlug, fixtureMode } from '../../../src/api';
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
 * which patch the same way. Delete is a two-tap in-place confirm —
 * no modal, works identically on native and web.
 *
 * Header (Lavender Dusk final `95ebcfa4a4b940d5a625f5582431652b`):
 * a white card — 2×2 cover grid from the first items' covers (a
 * lone cover fills the square; empty cells are tinted tiles) beside
 * the name, the owner line and the count + Public/Private pill,
 * then a divided action row: Play All (the playlist claimed as a
 * queue, in order), Shuffle (same queue, shuffled), Download (every
 * item's audio through the downloads store, sequentially — items
 * already downloaded no-op). The header's remaining design details
 * are data-backed: the count line's runtime ("12 themes · 18 min")
 * sums the items' summary durations (ThemeSummary.duration — the
 * document's own field; the segment is omitted when no item's
 * duration is known, never invented), rows carry their duration,
 * and the "by <owner>" line renders for every playlist from the
 * detail payload's resolved owner identity.
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
    startQueue(queueItemsFromSummaries(playlist.items), 0, 'watch');
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
    startQueue(queueItemsFromSummaries(shuffled), 0, 'watch');
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
      <View style={styles.tile}>
        <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
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
    <ScrollView style={styles.screen} showsVerticalScrollIndicator={false}>
      <View style={styles.column}>
        <View
          style={[styles.topRow, { paddingTop: insets.top + spacing.sm }]}
        >
          {backTile}
          <Text style={styles.topTitle}>Playlist</Text>
          <View style={styles.backHit} />
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
                      <Text style={styles.name}>{playlist.name}</Text>
                      {owner && (
                        <Pressable
                          onPress={() => {
                            setNameDraft(playlist.name);
                            setEditingName(true);
                            setActionError(null);
                          }}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel="Rename playlist"
                          style={({ pressed }) => [
                            styles.iconButton,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Pencil size={16} color={theme.muted} strokeWidth={2} />
                        </Pressable>
                      )}
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
                      {owner ? (
                        <Pressable
                          onPress={toggleVisibility}
                          disabled={busy}
                          accessibilityRole="button"
                          accessibilityLabel={
                            playlist.isPublic
                              ? 'Make playlist private'
                              : 'Make playlist public'
                          }
                          accessibilityState={{ selected: playlist.isPublic }}
                          style={({ pressed }) => [
                            styles.chip,
                            playlist.isPublic && styles.chipPublic,
                            pressed && styles.pressed,
                          ]}
                        >
                          {playlist.isPublic ? (
                            <Globe size={12} color={theme.onAccentContainer} strokeWidth={2} />
                          ) : (
                            <Lock size={12} color={theme.muted} strokeWidth={2} />
                          )}
                          <Text
                            style={[
                              styles.chipText,
                              playlist.isPublic && styles.chipTextPublic,
                            ]}
                          >
                            {playlist.isPublic ? 'Public' : 'Private'}
                          </Text>
                        </Pressable>
                      ) : (
                        <View style={[styles.chip, playlist.isPublic && styles.chipPublic]}>
                          {playlist.isPublic ? (
                            <Globe size={12} color={theme.onAccentContainer} strokeWidth={2} />
                          ) : (
                            <Lock size={12} color={theme.muted} strokeWidth={2} />
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
                      )}
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
                <Shuffle size={18} color={theme.text} strokeWidth={2} />
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
                  <ActivityIndicator size="small" color={theme.text} />
                ) : (
                  <Download size={18} color={theme.text} strokeWidth={2} />
                )}
              </Pressable>
            </View>
          </View>

          {playlist.description ? (
            <Text style={styles.description}>{playlist.description}</Text>
          ) : null}

          {owner && (
            <View style={styles.ownerTools}>
              <Pressable
                onPress={onDelete}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={
                  confirmDelete ? 'Confirm delete playlist' : 'Delete playlist'
                }
                style={({ pressed }) => [
                  styles.chip,
                  confirmDelete && styles.chipDanger,
                  pressed && styles.pressed,
                ]}
              >
                <Trash2
                  size={12}
                  color={confirmDelete ? theme.onAccent : theme.muted}
                  strokeWidth={2}
                />
                <Text
                  style={[
                    styles.chipText,
                    confirmDelete && { color: theme.onAccent },
                  ]}
                >
                  {confirmDelete ? 'Tap again to delete' : 'Delete'}
                </Text>
              </Pressable>
            </View>
          )}

          {actionError && <Text style={styles.error}>{actionError}</Text>}
          {favorites.lastError && (
            <Text style={styles.error}>{favorites.lastError}</Text>
          )}

          <View style={styles.items}>
            {playlist.items.map((item, index) => (
              <ThemeRow
                key={item.slug}
                item={item}
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
    flexDirection: 'row',
    alignItems: 'center',
  },
  topTitle: {
    flex: 1,
    ...typeStyles.body,
    fontFamily: fontFamilies.bodyStrong,
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
  tile: {
    width: 38,
    height: 38,
    borderRadius: radii.base,
    backgroundColor: theme.raised,
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
    borderRadius: radii.card,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  grid: {
    width: 100,
    height: 100,
    borderRadius: radii.md,
    backgroundColor: theme.raised,
    padding: 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    overflow: 'hidden',
  },
  gridCell: {
    width: 47,
    height: 47,
    backgroundColor: theme.surface,
  },
  gridCellEmpty: {
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridSingle: {
    width: 100,
    height: 100,
    borderRadius: radii.md,
    backgroundColor: theme.surface,
  },
  headerInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  byLine: {
    ...typeStyles.bodySmall,
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
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
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
    ...typeStyles.sectionLabel,
    color: theme.onAccent,
  },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: theme.accentContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionDisabled: {
    opacity: 0.45,
  },
  ownerTools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  name: {
    ...typeStyles.display,
    fontSize: 22,
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
    backgroundColor: theme.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
  },
  chipPublic: {
    // Design: Public playlists wear the sage pill; Private stays lavender.
    backgroundColor: theme.successContainer,
    borderColor: 'transparent',
  },
  chipDanger: {
    backgroundColor: theme.danger,
    borderColor: 'transparent',
  },
  chipText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
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
  pressed: {
    opacity: 0.85,
  },
});

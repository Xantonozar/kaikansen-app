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
  Globe,
  ListMusic,
  Lock,
  Pencil,
  Trash2,
  X,
} from 'lucide-react-native';
import type { PlaylistDetail } from '@kaikansen/contracts';
import { fixtureMode } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { useFavorites } from '../../../src/favoritesStore';
import {
  deletePlaylist,
  fetchPlaylist,
  removePlaylistItem,
  updatePlaylist,
} from '../../../src/libraryApi';
import { ThemeRow } from '../../../src/components/ThemeRow';
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
 */
export default function PlaylistDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status, user } = useAuth();
  const favorites = useFavorites();

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
        </View>

        <View style={styles.body}>
          <View style={styles.coverWrap}>
            {playlist.coverImage ? (
              <Image
                source={{ uri: playlist.coverImage }}
                style={styles.cover}
              />
            ) : (
              <View style={[styles.cover, styles.coverEmpty]}>
                <ListMusic size={30} color={theme.muted} strokeWidth={2} />
              </View>
            )}
          </View>

          {editingName ? (
            <View style={styles.nameEdit}>
              <TextInput
                style={styles.input}
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder="Playlist name"
                placeholderTextColor={theme.muted}
                autoFocus
                maxLength={100}
                returnKeyType="done"
                onSubmitEditing={saveName}
              />
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
          ) : (
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
          )}

          {playlist.description ? (
            <Text style={styles.description}>{playlist.description}</Text>
          ) : null}

          <View style={styles.metaRow}>
            <Text style={styles.meta}>
              {playlist.themeCount}{' '}
              {playlist.themeCount === 1 ? 'theme' : 'themes'}
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
            {owner && (
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
            )}
          </View>

          {actionError && <Text style={styles.error}>{actionError}</Text>}
          {favorites.lastError && (
            <Text style={styles.error}>{favorites.lastError}</Text>
          )}

          <View style={styles.items}>
            {playlist.items.map((item) => (
              <ThemeRow
                key={item.slug}
                item={item}
                onPress={() => router.push(`/theme/${item.slug}`)}
                onPlay={() =>
                  router.push({
                    pathname: '/player',
                    params: { slug: item.slug, mode: 'watch' },
                  })
                }
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
  coverWrap: {
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  cover: {
    width: 112,
    height: 112,
    borderRadius: radii.md,
    backgroundColor: theme.surface,
  },
  coverEmpty: {
    backgroundColor: theme.raised,
    alignItems: 'center',
    justifyContent: 'center',
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    ...typeStyles.body,
    color: theme.text,
    backgroundColor: theme.surface,
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
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    flexWrap: 'wrap',
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
    backgroundColor: withOpacity(theme.accent, 0.16),
    borderColor: 'transparent',
  },
  chipDanger: {
    backgroundColor: theme.accent,
    borderColor: 'transparent',
  },
  chipText: {
    ...typeStyles.caption,
    fontFamily: fontFamilies.bodyStrong,
    color: theme.muted,
  },
  chipTextPublic: {
    color: theme.onAccentContainer,
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

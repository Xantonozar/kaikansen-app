import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Check, ListMusic, Plus, X } from 'lucide-react-native';
import type { PlaylistSummary } from '@kaikansen/contracts';
import { fixtureMode } from '../api';
import { useAuth } from '../auth';
import {
  addPlaylistItem,
  createPlaylist,
  fetchPlaylist,
  fetchPlaylists,
} from '../libraryApi';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../theme';
import { useTheme } from '../theme-context';

/**
 * Add-to-playlist bottom sheet (Slice 5, design law #8) — extracted
 * from the theme detail screen so the SAME picker serves the
 * detail's action bar and every song row's ⋮ menu; the picker logic
 * (membership check per playlist, add, create-&-add) lives in exactly
 * one place.
 *
 * Behaviour is the detail screen's, unchanged:
 * - opening loads the caller's playlists and resolves which ones
 *   already contain the theme (one detail fetch per playlist — the
 *   library API has no bulk membership call);
 * - tapping a playlist adds the theme (or reports "Already in …");
 * - the footer creates a new playlist and adds the theme in one go;
 * - demo mode and signed-out opens render the honest note the detail
 *   screen's guards used to show ("Playlists are not available in
 *   demo mode." / "Log in to add themes to playlists.") — the sheet
 *   never draws a picker that cannot work.
 */
export function AddToPlaylistSheet({
  slug,
  title,
  visible,
  onClose,
}: {
  /** Theme slug to add; null keeps the sheet inert. */
  slug: string | null;
  /** Optional song title shown under the sheet heading. */
  title?: string;
  visible: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { status } = useAuth();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [containedIds, setContainedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const blocked = fixtureMode
    ? 'Playlists are not available in demo mode.'
    : status !== 'signedIn'
      ? 'Log in to add themes to playlists.'
      : null;

  /* Load the caller's playlists + membership each time the sheet
     opens for a theme (the detail screen's openSheet body, verbatim
     apart from the slug coming from props). */
  useEffect(() => {
    if (!visible || !slug || blocked) return;
    let cancelled = false;
    setMessage(null);
    setError(null);
    setLoading(true);
    setPlaylists(null);
    setContainedIds(new Set());
    fetchPlaylists()
      .then(async (res) => {
        if (cancelled) return;
        setPlaylists(res.playlists);
        // Membership lives on each playlist's items, so resolve the
        // details in parallel; a failed detail leaves that row
        // addable (the API's add is a no-op for duplicates anyway).
        const details = await Promise.all(
          res.playlists.map((p) => fetchPlaylist(p.id).catch(() => null)),
        );
        if (cancelled) return;
        const contained = new Set<string>();
        for (const d of details) {
          if (d && d.items.some((i) => i.slug === slug)) {
            contained.add(d.id);
          }
        }
        setContainedIds(contained);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(
            e instanceof Error
              ? e.message
              : 'Could not load your playlists.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, slug, blocked]);

  const addTo = (playlist: PlaylistSummary) => {
    if (!slug || busyId) return;
    if (containedIds.has(playlist.id)) {
      setMessage(`Already in “${playlist.name}”.`);
      return;
    }
    setBusyId(playlist.id);
    setMessage(null);
    addPlaylistItem(playlist.id, slug)
      .then(() => {
        setContainedIds((prev) => new Set(prev).add(playlist.id));
        setMessage(`Added to “${playlist.name}”.`);
      })
      .catch((e: unknown) =>
        setMessage(
          e instanceof Error ? e.message : 'Could not add the theme.',
        ),
      )
      .finally(() => setBusyId(null));
  };

  const createAndAdd = () => {
    if (!slug || creating) return;
    const name = newName.trim();
    if (name.length === 0) {
      setMessage('Give the playlist a name.');
      return;
    }
    setCreating(true);
    setMessage(null);
    createPlaylist({ name })
      .then(async (created) => {
        setPlaylists((prev) => [created, ...(prev ?? [])]);
        setNewName('');
        await addPlaylistItem(created.id, slug);
        setContainedIds((prev) => new Set(prev).add(created.id));
        setMessage(`Added to “${created.name}”.`);
      })
      .catch((e: unknown) =>
        setMessage(
          e instanceof Error ? e.message : 'Could not create the playlist.',
        ),
      )
      .finally(() => setCreating(false));
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={styles.dismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerMain}>
              <Text style={styles.titleText}>Add to playlist</Text>
              {title ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {title}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close playlists"
              style={({ pressed }) => [
                styles.close,
                pressed && styles.pressed,
              ]}
            >
              <X size={18} color={theme.text} strokeWidth={2} />
            </Pressable>
          </View>

          {blocked ? (
            <Text style={styles.note}>{blocked}</Text>
          ) : loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : error ? (
            <Text style={styles.note}>{error}</Text>
          ) : (
            <>
              <ScrollView
                style={styles.list}
                showsVerticalScrollIndicator={false}
              >
                {(playlists ?? []).map((p) => {
                  const contained = containedIds.has(p.id);
                  const busyRow = busyId === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => addTo(p)}
                      disabled={busyRow}
                      accessibilityRole="button"
                      accessibilityLabel={
                        contained
                          ? `${p.name}, already added`
                          : `Add to ${p.name}`
                      }
                      accessibilityState={{ disabled: busyRow }}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.rowIcon}>
                        <ListMusic
                          size={18}
                          color={theme.accent}
                          strokeWidth={2}
                        />
                      </View>
                      <View style={styles.rowMain}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {p.name}
                        </Text>
                        <Text style={styles.rowMeta}>
                          {p.themeCount}{' '}
                          {p.themeCount === 1 ? 'theme' : 'themes'} ·{' '}
                          {p.isPublic ? 'Public' : 'Private'}
                        </Text>
                      </View>
                      {busyRow ? (
                        <ActivityIndicator
                          size="small"
                          color={theme.accent}
                        />
                      ) : contained ? (
                        <Check
                          size={18}
                          color={theme.accent}
                          strokeWidth={2.25}
                        />
                      ) : (
                        <Plus
                          size={18}
                          color={theme.muted}
                          strokeWidth={2}
                        />
                      )}
                    </Pressable>
                  );
                })}
                {(playlists ?? []).length === 0 && (
                  <Text style={styles.note}>
                    No playlists yet — create your first one below.
                  </Text>
                )}
              </ScrollView>

              <View style={styles.createRow}>
                <TextInput
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="New playlist name"
                  placeholderTextColor={theme.muted}
                  maxLength={80}
                  style={styles.input}
                  accessibilityLabel="New playlist name"
                />
                <Pressable
                  onPress={createAndAdd}
                  disabled={creating}
                  accessibilityRole="button"
                  accessibilityLabel="Create playlist and add theme"
                  accessibilityState={{ disabled: creating }}
                  style={({ pressed }) => [
                    styles.createButton,
                    creating && styles.disabledButton,
                    pressed && styles.pressed,
                  ]}
                >
                  {creating ? (
                    <ActivityIndicator size="small" color={theme.onAccent} />
                  ) : (
                    <Text style={styles.createText}>Create & add</Text>
                  )}
                </Pressable>
              </View>
            </>
          )}

          {message && <Text style={styles.message}>{message}</Text>}
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
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
      maxHeight: '82%',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
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
    close: {
      width: 36,
      height: 36,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    center: {
      paddingVertical: spacing.xxl,
      alignItems: 'center',
    },
    list: {
      flexGrow: 0,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowIcon: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowMain: {
      flex: 1,
      gap: 2,
    },
    rowName: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    rowMeta: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    note: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 18,
      paddingVertical: spacing.md,
    },
    createRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    input: {
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
    createButton: {
      backgroundColor: theme.accent,
      borderRadius: radii.base,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    createText: {
      ...typeStyles.bodySmall,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccent,
    },
    disabledButton: {
      opacity: 0.5,
    },
    message: {
      ...typeStyles.bodySmall,
      color: theme.onAccentContainer,
      marginTop: spacing.md,
      lineHeight: 18,
    },
    pressed: {
      opacity: 0.65,
    },
  });

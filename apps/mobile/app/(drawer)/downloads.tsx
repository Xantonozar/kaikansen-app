import { useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ChevronLeft,
  Download,
  Pause,
  Play,
  Trash2,
  X,
} from 'lucide-react-native';
import type { DownloadRecord } from '../../src/downloads';
import {
  downloadsSupported,
  formatBytes,
  useDownloads,
} from '../../src/downloads';
import { fixtureMode } from '../../src/api';
import {
  usePlaybackSession,
  type QueueItem,
} from '../../src/playback-context';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Downloads (DESIGN.md §6.26, layout-fidelity Slice 4) — the
 * standalone screen over the downloads store (src/downloads.ts):
 * the summary card (count + bytes on this device), one row per
 * completed download (cover, title, artist · size, play disc,
 * delete with confirmation), and one row per download still in
 * flight (progress bar + percentage from the store's progress,
 * ✕ cancelling for real via the store's resumable handle).
 *
 * Playback claims the playable downloads as the queue and opens
 * the player, exactly like the Library's Offline segment; a row
 * that IS the live session shows the pause state instead and its
 * disc toggles the engine. Entered from Settings and the Profile
 * menu; the Library's Offline segment remains as the in-tab view
 * of the same store.
 */
export default function DownloadsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const downloads = useDownloads();
  const { startQueue, session, playback } = usePlaybackSession();

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const healthy = downloads.records.filter((r) => !r.fileMissing);
  const count = healthy.length + downloads.downloading.length;

  const playRecord = (record: DownloadRecord) => {
    const queueItems: QueueItem[] = healthy.map((r) => ({
      slug: r.slug,
      atEntryId: r.atEntryId,
      title: r.songTitle,
      artistLine: r.artistName ?? r.animeTitle,
      coverUrl: r.coverImage,
    }));
    const index = healthy.findIndex((r) => r.id === record.id);
    if (queueItems.length > 0 && index >= 0) {
      startQueue(queueItems, index, record.mode);
    }
    router.push({
      pathname: '/player',
      params: {
        slug: record.slug,
        mode: record.mode,
        entry: String(record.atEntryId),
      },
    });
  };

  const confirmRemove = (record: DownloadRecord) => {
    Alert.alert(
      'Delete download?',
      `"${record.songTitle}" will be removed from this device.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void downloads.remove(record.id),
        },
      ],
    );
  };

  const cover = (uri: string | null) =>
    uri ? (
      <Image source={{ uri }} style={styles.cover} />
    ) : (
      <View style={[styles.cover, styles.coverEmpty]} />
    );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          hitSlop={3}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backHit}
        >
          <View style={styles.backTile}>
            <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
          </View>
        </Pressable>
        <Text style={styles.title}>Downloads</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {fixtureMode ? (
          <Text style={styles.emptyText}>
            Demo mode — downloads are switched off in the demo. On the
            live build, themes you keep for offline use appear here.
          </Text>
        ) : !downloadsSupported ? (
          <Text style={styles.emptyText}>
            Downloads are not available on web — downloaded files live on
            a device.
          </Text>
        ) : !downloads.hydrated ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : (
          <>
            <View style={styles.summaryCard}>
              <View style={styles.summaryIcon}>
                <Download size={22} color={theme.success} strokeWidth={2} />
              </View>
              <View style={styles.summaryTexts}>
                <Text style={styles.summaryTitle}>
                  {count} {count === 1 ? 'theme' : 'themes'} on this device
                </Text>
                <Text style={styles.summarySub}>
                  {formatBytes(downloads.totalBytes)} downloaded · plays
                  offline, no connection needed
                </Text>
              </View>
            </View>

            {count === 0 && downloads.records.length === 0 && (
              <Text style={styles.emptyText}>
                Nothing downloaded yet — open a theme and tap Download to
                keep it here for offline listening.
              </Text>
            )}

            {(downloads.downloading.length > 0 ||
              downloads.records.length > 0) && (
              <View style={styles.card}>
                {downloads.downloading.map((pending, i) => {
                  const progress = downloads.progressFor(pending.id);
                  const pct =
                    progress != null
                      ? Math.round(Math.min(1, Math.max(0, progress)) * 100)
                      : null;
                  return (
                    <View
                      key={pending.id}
                      style={[
                        styles.row,
                        i > 0 && styles.rowDivider,
                      ]}
                    >
                      {cover(pending.coverImage)}
                      <View style={styles.rowMain}>
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {pending.songTitle}
                        </Text>
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {pending.artistName ?? pending.animeTitle}
                        </Text>
                        <View style={styles.progressTrack}>
                          <View
                            style={[
                              styles.progressFill,
                              {
                                width:
                                  progress != null
                                    ? `${Math.round(progress * 100)}%`
                                    : '12%',
                              },
                            ]}
                          />
                        </View>
                        <Text style={styles.rowSub}>
                          Downloading…{pct != null ? ` ${pct}%` : ''}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => void downloads.cancel(pending.id)}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={`Cancel the download of ${pending.songTitle}`}
                        style={({ pressed }) => [
                          styles.cancelButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <X size={16} color={theme.muted} strokeWidth={2} />
                      </Pressable>
                    </View>
                  );
                })}

                {downloads.records.map((record, i) => {
                  const isCurrent =
                    session.active &&
                    session.slug === record.slug &&
                    session.mode === record.mode &&
                    (session.entry?.atEntryId ?? session.entryIdOverride) ===
                      record.atEntryId;
                  const divider =
                    i > 0 || downloads.downloading.length > 0;
                  return (
                    <View
                      key={record.id}
                      style={[styles.row, divider && styles.rowDivider]}
                    >
                      {cover(record.coverImage)}
                      <View style={styles.rowMain}>
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {record.songTitle}
                        </Text>
                        {record.fileMissing ? (
                          <Text
                            style={[styles.rowSub, styles.brokenText]}
                            numberOfLines={1}
                          >
                            File missing — remove it and download again
                          </Text>
                        ) : (
                          <Text style={styles.rowSub} numberOfLines={1}>
                            {record.artistName ?? record.animeTitle} ·{' '}
                            {formatBytes(record.size)}
                          </Text>
                        )}
                      </View>
                      {!record.fileMissing && (
                        <Pressable
                          onPress={() =>
                            isCurrent
                              ? playback.toggleMain()
                              : playRecord(record)
                          }
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={
                            isCurrent
                              ? playback.isPlaying
                                ? `Pause ${record.songTitle}`
                                : `Resume ${record.songTitle}`
                              : `Play ${record.songTitle} offline`
                          }
                          style={({ pressed }) => [
                            styles.playDisc,
                            pressed && styles.pressed,
                          ]}
                        >
                          {isCurrent && playback.isPlaying ? (
                            <Pause
                              size={15}
                              color={theme.onAccentContainer}
                              strokeWidth={2}
                            />
                          ) : (
                            <Play
                              size={15}
                              color={theme.onAccentContainer}
                              strokeWidth={2}
                            />
                          )}
                        </Pressable>
                      )}
                      <Pressable
                        onPress={() => confirmRemove(record)}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete the download of ${record.songTitle}`}
                        style={({ pressed }) => [
                          styles.trashButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Trash2 size={17} color={theme.muted} strokeWidth={2} />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    backHit: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.base,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      ...typeStyles.heading,
      color: theme.text,
      flex: 1,
    },
    content: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    center: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xxl,
    },
    emptyText: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      lineHeight: 19,
      marginTop: spacing.md,
    },
    summaryCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      padding: spacing.md,
      marginTop: spacing.sm,
    },
    summaryIcon: {
      width: 46,
      height: 46,
      borderRadius: radii.pill,
      backgroundColor: theme.successContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    summaryTexts: {
      flex: 1,
      gap: 2,
    },
    summaryTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    summarySub: {
      ...typeStyles.caption,
      color: theme.muted,
      lineHeight: 16,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: radii.card,
      paddingHorizontal: spacing.md,
      marginTop: spacing.lg,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    cover: {
      width: 44,
      height: 44,
      borderRadius: radii.base,
      flexShrink: 0,
    },
    coverEmpty: {
      backgroundColor: theme.raised,
    },
    rowMain: {
      flex: 1,
      gap: 2,
    },
    rowTitle: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    rowSub: {
      ...typeStyles.caption,
      color: theme.muted,
    },
    brokenText: {
      color: theme.danger,
    },
    progressTrack: {
      height: 5,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      overflow: 'hidden',
      marginTop: spacing.xs,
      marginBottom: 2,
    },
    progressFill: {
      height: '100%',
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
    },
    playDisc: {
      width: 34,
      height: 34,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    trashButton: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    cancelButton: {
      width: 30,
      height: 30,
      borderRadius: radii.pill,
      backgroundColor: theme.raised,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    pressed: {
      opacity: 0.85,
    },
  });

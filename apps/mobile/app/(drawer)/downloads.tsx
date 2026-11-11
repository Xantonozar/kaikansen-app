import { useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ArrowLeft,
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
import { downloadFillPercent } from '../../src/polishRules';
import { AppImage } from '../../src/components/AppImage';
import { SkeletonThemeRow } from '../../src/components/Skeleton';
import {
  usePlaybackSession,
  type QueueItem,
} from '../../src/playback-context';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  withOpacity,
  type Theme,
} from '../../src/theme';
import { useTheme } from '../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../src/layout';

/**
 * Downloads — the standalone screen over the downloads store
 * (src/downloads.ts), matched to the Downloads design (mock +
 * downloads.html): circular glass back button + 24pt title, the
 * summary card (sage download disc, real on-device count and
 * bytes), then INDIVIDUAL white row cards — one per completed
 * download (52pt cover, title, artist · real file size, play disc,
 * trash) and one per download still in flight (spinner over the
 * cover, real progress bar + percentage, ✕ cancelling for real via
 * the store's resumable handle). Completed rows render first, the
 * in-flight rows after them, as the mock stacks them.
 *
 * Every number is the store's: the count is the completed records
 * whose file is actually on the device (fileMissing records are
 * shown broken, not counted), and the summary bytes are the
 * store's totalBytes — the summed real sizes of those same files.
 * (The earlier build counted in-flight downloads in the headline;
 * the design's headline is an on-device claim, so it now counts
 * completed downloads only — in-flight rows still list below.)
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
  const count = healthy.length;

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
      startQueue(queueItems, index, record.mode, 'offline');
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
      <AppImage source={uri} style={styles.cover} />
    ) : (
      <View style={[styles.cover, styles.coverEmpty]} />
    );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <Pressable
          onPress={goBack}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [
            styles.backDisc,
            pressed && styles.pressed,
          ]}
        >
          <ArrowLeft size={20} color={theme.text} strokeWidth={2.2} />
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
          /* Local-store hydration (skeleton sweep): the list's
             own shape — theme-row placeholders. */
          <>
            {[0, 1, 2, 3].map((i) => (
              <SkeletonThemeRow key={i} />
            ))}
          </>
        ) : (
          <>
            <View style={styles.summaryCard}>
              <View style={styles.summaryIcon}>
                <Download size={24} color={theme.success} strokeWidth={2.2} />
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

            {downloads.records.length === 0 &&
              downloads.downloading.length === 0 && (
                <Text style={styles.emptyText}>
                  Nothing downloaded yet — open a theme and tap Download to
                  keep it here for offline listening.
                </Text>
              )}

            {(downloads.records.length > 0 ||
              downloads.downloading.length > 0) && (
              <View style={styles.rows}>
                {downloads.records.map((record) => {
                  const isCurrent =
                    session.active &&
                    session.slug === record.slug &&
                    session.mode === record.mode &&
                    (session.entry?.atEntryId ?? session.entryIdOverride) ===
                      record.atEntryId;
                  return (
                    <View key={record.id} style={styles.rowCard}>
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
                          <View style={styles.subRow}>
                            <Text
                              style={[styles.rowSub, styles.artistText]}
                              numberOfLines={1}
                            >
                              {record.artistName ?? record.animeTitle}
                            </Text>
                            <View style={styles.subDot} />
                            <Text style={styles.sizeText}>
                              {formatBytes(record.size)}
                            </Text>
                          </View>
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
                              size={16}
                              color={theme.onAccentContainer}
                              fill={theme.onAccentContainer}
                              strokeWidth={2}
                            />
                          ) : (
                            <Play
                              size={16}
                              color={theme.onAccentContainer}
                              fill={theme.onAccentContainer}
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
                        <Trash2
                          size={16}
                          color={withOpacity(theme.secondary, 0.7)}
                          strokeWidth={1.9}
                        />
                      </Pressable>
                    </View>
                  );
                })}

                {downloads.downloading.map((pending) => {
                  const progress = downloads.progressFor(pending.id);
                  const pct = downloadFillPercent(progress);
                  return (
                    <View key={pending.id} style={styles.rowCard}>
                      <View style={styles.coverWrap}>
                        {cover(pending.coverImage)}
                        <View style={styles.coverOverlay}>
                          {/* On-media white — literal per the Player
                              slice's precedent (no token covers it). */}
                          <ActivityIndicator size={16} color="#FFFFFF" />
                        </View>
                      </View>
                      <View style={styles.rowMain}>
                        <Text style={styles.rowTitle} numberOfLines={1}>
                          {pending.songTitle}
                        </Text>
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {pending.artistName ?? pending.animeTitle}
                        </Text>
                        <View style={styles.progressBlock}>
                          <View style={styles.progressTrack}>
                            {/* Indeterminate (no fraction yet):
                                the track stays EMPTY — the old
                                hardcoded fill claimed progress
                                the app did not have (polish
                                batch). */}
                            {pct != null && (
                              <View
                                style={[
                                  styles.progressFill,
                                  { width: `${pct}%` },
                                ]}
                              />
                            )}
                          </View>
                          <Text style={styles.progressText}>
                            Downloading...{pct != null ? ` ${pct}%` : ''}
                          </Text>
                        </View>
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
                        <X
                          size={16}
                          color={withOpacity(theme.secondary, 0.8)}
                          strokeWidth={2.2}
                        />
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
      width: '100%' as const,
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
      gap: 14,
    },
    backDisc: {
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      backgroundColor: withOpacity(theme.surface, 0.7),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: {
      fontFamily: fontFamilies.display,
      fontSize: 24,
      letterSpacing: -0.4,
      color: theme.text,
      flex: 1,
    },
    content: {
      width: '100%' as const,
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
      gap: 14,
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.lg,
    },
    summaryIcon: {
      width: 48,
      height: 48,
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
      fontFamily: fontFamilies.bodyStrong,
      fontSize: 16,
      color: theme.text,
    },
    summarySub: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.secondary,
      lineHeight: 16,
    },
    rows: {
      gap: 10,
      marginTop: spacing.lg,
    },
    rowCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: theme.surface,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: spacing.md,
    },
    cover: {
      width: 52,
      height: 52,
      borderRadius: radii.base,
      flexShrink: 0,
    },
    coverEmpty: {
      backgroundColor: theme.raised,
    },
    coverWrap: {
      width: 52,
      height: 52,
      borderRadius: radii.base,
      overflow: 'hidden',
      flexShrink: 0,
    },
    coverOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: withOpacity(theme.accent, 0.2),
      alignItems: 'center',
      justifyContent: 'center',
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
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: theme.secondary,
    },
    subRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    artistText: {
      flexShrink: 1,
    },
    subDot: {
      width: 4,
      height: 4,
      borderRadius: radii.pill,
      backgroundColor: withOpacity(theme.secondary, 0.4),
      flexShrink: 0,
    },
    sizeText: {
      fontFamily: fontFamilies.caption,
      fontSize: 12,
      color: withOpacity(theme.secondary, 0.9),
      flexShrink: 0,
    },
    brokenText: {
      color: theme.danger,
    },
    progressBlock: {
      marginTop: spacing.sm,
      gap: spacing.xs,
    },
    progressTrack: {
      height: 6,
      borderRadius: radii.pill,
      backgroundColor: theme.accentContainer,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: radii.pill,
      backgroundColor: theme.accent,
    },
    progressText: {
      ...typeStyles.caption,
      color: theme.secondary,
    },
    playDisc: {
      width: 36,
      height: 36,
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
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    pressed: {
      opacity: 0.85,
    },
  });

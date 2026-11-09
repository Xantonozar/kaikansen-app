import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, ExternalLink } from 'lucide-react-native';
import type { AnimeDetailResponse, ThemeSummary } from '@kaikansen/contracts';
import { fetchAnimeDetail } from '../../../src/api';
import { useFavorites } from '../../../src/favoritesStore';
import { ThemeRow } from '../../../src/components/ThemeRow';
import {
  queueItemsFromSummaries,
  usePlaybackSession,
} from '../../../src/playback-context';
import {
  fontFamilies,
  radii,
  spacing,
  typeStyles,
  type Theme,
} from '../../../src/theme';
import { useTheme } from '../../../src/theme-context';
import { CONTENT_MAX_WIDTH } from '../../../src/layout';

/**
 * Anime detail (DESIGN.md §6.8) — layout-fidelity Slice 6 rebuilt
 * the header to the design's composition (measured in
 * anime-detail.html): a full-bleed 224dp banner (bannerImage,
 * falling back to the large cover — the web page's own chain minus
 * its picsum placeholder), a floating translucent back disc, and a
 * white info card overlapping the banner by 16dp carrying the
 * title, the meta line ("26 episodes · FALL 1995") and the genre
 * chips; then the anime's themes grouped Openings / Endings and a
 * "View on AniList" row.
 *
 * Data: GET /anime/:id (the web's anime page read, ported to the
 * API for this screen). The design's meta line has NO format
 * ("TV ·") prefix — ozar declined the anime-format backfill
 * (2026-11-09), and format is stored nowhere in the catalogue.
 * The card also omits the pre-fidelity build's score chip, studio
 * line and romaji subtitle: not in the design (the data stays in
 * the payload, undrawn) — flagged in the Slice 6 report.
 */
export default function AnimeDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const router = useRouter();
  const favorites = useFavorites();
  const { id } = useLocalSearchParams<{ id: string }>();
  const animeId = Number.parseInt(id ?? '', 10);

  const [data, setData] = useState<AnimeDetailResponse | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    if (Number.isNaN(animeId)) {
      setData(null);
      return;
    }
    fetchAnimeDetail(animeId)
      .then((res) => {
        if (live) setData(res);
      })
      .catch((e: unknown) => {
        if (live) {
          setError(
            e instanceof Error ? e.message : 'Could not load this anime.',
          );
        }
      });
    return () => {
      live = false;
    };
  }, [animeId]);

  const openTheme = useCallback(
    (slug: string) => router.push(`/theme/${slug}`),
    [router],
  );
  const { startQueue } = usePlaybackSession();
  const playTheme = useCallback(
    (slug: string) => {
      // The queue is the page's rows in display order: Openings
      // (by sequence), then Endings (by sequence) — the same order
      // renderRows draws them.
      if (data) {
        const ordered = (['OP', 'ED'] as const).flatMap((type) =>
          data.themes
            .filter((t) => t.type === type)
            .sort((a, b) => a.sequence - b.sequence),
        );
        const index = ordered.findIndex((t) => t.slug === slug);
        if (index >= 0) {
          startQueue(queueItemsFromSummaries(ordered), index, 'watch');
        }
      }
      router.push({ pathname: '/player', params: { slug, mode: 'watch' } });
    },
    [router, data, startQueue],
  );

  const renderRows = (rows: ThemeSummary[]) =>
    rows.map((item) => (
      <ThemeRow
        key={item.slug}
        item={item}
        onPress={() => openTheme(item.slug)}
        onPlay={() => playTheme(item.slug)}
        saved={favorites.isFavorite(item.slug)}
        savePending={favorites.isPending(item.slug)}
        onToggleSave={() => void favorites.toggle(item.slug)}
      />
    ));

  const metaLine = data
    ? [
        data.anime.totalEpisodes != null
          ? `${data.anime.totalEpisodes} episodes`
          : null,
        data.anime.season && data.anime.seasonYear
          ? `${data.anime.season} ${data.anime.seasonYear}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const bannerUri = data?.anime.bannerImage ?? data?.anime.coverImageLarge;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* Floating back disc over the banner (the design's only
          chrome on this screen — there is no title bar). */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.backFloat}
      >
        <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
      </Pressable>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Couldn’t load this anime.</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : data === undefined ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : data === null ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>Anime not found</Text>
          <Text style={styles.errorDetail}>
            This anime isn’t in the catalogue yet.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Full-bleed banner, 224dp (mock: h-56). */}
          {bannerUri ? (
            <Image source={{ uri: bannerUri }} style={styles.banner} />
          ) : (
            <View style={[styles.banner, styles.placeholder]} />
          )}
          <View style={styles.column}>
            {/* Info card overlapping the banner by 16dp (mock: -mt-4). */}
            <View style={styles.infoCard}>
              <Text style={styles.title}>
                {data.anime.titleEnglish ?? data.anime.titleRomaji}
              </Text>
              {metaLine.length > 0 && (
                <Text style={styles.metaLine}>{metaLine}</Text>
              )}
              {data.anime.genres.length > 0 && (
                <View style={styles.genreRow}>
                  {data.anime.genres.map((genre) => (
                    <View key={genre} style={styles.genreChip}>
                      <Text style={styles.genreText}>{genre}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {(['OP', 'ED'] as const).map((type) => {
              const rows = data.themes
                .filter((t) => t.type === type)
                .sort((a, b) => a.sequence - b.sequence);
              if (rows.length === 0) return null;
              return (
                <View key={type}>
                  <Text style={styles.sectionHeading}>
                    {type === 'OP' ? 'Openings' : 'Endings'}
                  </Text>
                  {renderRows(rows)}
                </View>
              );
            })}
            {data.themes.length === 0 && (
              <Text style={styles.emptyText}>
                No themes for this anime yet.
              </Text>
            )}

            {data.anime.anilistId != null && (
              <Pressable
                onPress={() =>
                  void Linking.openURL(
                    `https://anilist.co/anime/${data.anime.anilistId}`,
                  )
                }
                accessibilityRole="link"
                accessibilityLabel="View on AniList"
                style={({ pressed }) => [
                  styles.anilistRow,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.anilistText}>View on AniList</Text>
                <ExternalLink size={16} color={theme.muted} strokeWidth={2} />
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: theme.background,
    },
    backFloat: {
      // The mock's floating back disc: translucent white over the
      // banner (white/80 — the same fixed-colour precedent as the
      // scrims; token `surface` at 80% renders identically in the
      // light theme and follows the dark theme's surface).
      position: 'absolute',
      top: spacing.sm,
      left: spacing.screenEdge,
      zIndex: 2,
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      opacity: 0.9,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: {
      paddingBottom: spacing.xxxl,
    },
    banner: {
      width: '100%',
      height: 224,
      backgroundColor: theme.surface,
    },
    placeholder: {
      backgroundColor: theme.raised,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
      paddingHorizontal: spacing.screenEdge,
    },
    infoCard: {
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.cardLg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.lg,
      marginTop: -spacing.lg,
    },
    title: {
      ...typeStyles.display,
      fontSize: 20,
      lineHeight: 25,
      color: theme.text,
    },
    metaLine: {
      // Mock: 12px medium mauve, wide tracking, uppercase —
      // "26 episodes · FALL 1995".
      fontSize: 12,
      fontFamily: 'Inter_500Medium',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: theme.secondary,
      marginTop: spacing.xs + 2,
    },
    genreRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    genreChip: {
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 2,
    },
    genreText: {
      fontSize: 11,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.secondary,
    },
    anilistRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.card,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      marginTop: spacing.xl,
    },
    anilistText: {
      ...typeStyles.body,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
    },
    pressed: {
      opacity: 0.85,
    },
    sectionHeading: {
      // Mock section headings are 15px bold.
      ...typeStyles.body,
      fontSize: 15,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.text,
      marginTop: spacing.xl,
      marginBottom: spacing.md,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.screenEdge,
    },
    errorText: {
      ...typeStyles.heading,
      color: theme.text,
    },
    errorDetail: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      textAlign: 'center',
    },
    emptyText: {
      ...typeStyles.body,
      color: theme.muted,
      paddingTop: spacing.lg,
    },
  });

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Star } from 'lucide-react-native';
import type { AnimeDetailResponse, ThemeSummary } from '@kaikansen/contracts';
import { fetchAnimeDetail } from '../../../src/api';
import { useFavorites } from '../../../src/favoritesStore';
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

/**
 * Anime detail (DESIGN.md §6.8) — cover header, title, meta chips
 * (season · year, score, studio), genre chips, then the anime's
 * themes grouped Openings / Endings. Data: GET /anime/:id (the web's
 * anime page read, ported to the API for this screen).
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
  const playTheme = useCallback(
    (slug: string) =>
      router.push({ pathname: '/player', params: { slug, mode: 'watch' } }),
    [router],
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

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backTile}
        >
          <ChevronLeft size={22} color={theme.text} strokeWidth={2} />
        </Pressable>
        <Text style={styles.headerTitle}>Anime</Text>
      </View>

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
          <View style={styles.column}>
            <View style={styles.heroRow}>
              {data.anime.coverImageLarge ? (
                <Image
                  source={{ uri: data.anime.coverImageLarge }}
                  style={styles.cover}
                />
              ) : (
                <View style={[styles.cover, styles.placeholder]} />
              )}
              <View style={styles.heroMain}>
                <Text style={styles.title}>
                  {data.anime.titleEnglish ?? data.anime.titleRomaji}
                </Text>
                {data.anime.titleEnglish &&
                  data.anime.titleRomaji !== data.anime.titleEnglish && (
                    <Text style={styles.subtitle}>
                      {data.anime.titleRomaji}
                    </Text>
                  )}
                <View style={styles.metaChips}>
                  {data.anime.season && data.anime.seasonYear && (
                    <View style={styles.metaChip}>
                      <Text style={styles.metaChipText}>
                        {data.anime.season} {data.anime.seasonYear}
                      </Text>
                    </View>
                  )}
                  {data.anime.averageScore != null && (
                    <View style={styles.metaChip}>
                      <Star
                        size={12}
                        color={theme.onAccentContainer}
                        fill={theme.onAccentContainer}
                        strokeWidth={2}
                      />
                      <Text style={styles.metaChipText}>
                        {(data.anime.averageScore / 10).toFixed(1)}
                      </Text>
                    </View>
                  )}
                  {data.anime.totalEpisodes != null && (
                    <View style={styles.metaChip}>
                      <Text style={styles.metaChipText}>
                        {data.anime.totalEpisodes} episodes
                      </Text>
                    </View>
                  )}
                </View>
                {data.anime.studios.length > 0 && (
                  <Text style={styles.studio}>
                    {data.anime.studios.join(', ')}
                  </Text>
                )}
              </View>
            </View>

            {data.anime.genres.length > 0 && (
              <View style={styles.genreRow}>
                {data.anime.genres.map((genre) => (
                  <View key={genre} style={styles.genreChip}>
                    <Text style={styles.genreText}>{genre}</Text>
                  </View>
                ))}
              </View>
            )}

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
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.screenEdge,
      paddingVertical: spacing.sm,
    },
    backTile: {
      width: 38,
      height: 38,
      borderRadius: radii.pill,
      backgroundColor: theme.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      ...typeStyles.heading,
      color: theme.text,
    },
    content: {
      paddingHorizontal: spacing.screenEdge,
      paddingBottom: spacing.xxxl,
    },
    column: {
      width: '100%',
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: 'center',
    },
    heroRow: {
      flexDirection: 'row',
      gap: spacing.lg,
      paddingTop: spacing.sm,
    },
    cover: {
      width: 112,
      height: 158,
      borderRadius: radii.card,
      backgroundColor: theme.surface,
    },
    placeholder: {
      backgroundColor: theme.raised,
    },
    heroMain: {
      flex: 1,
      gap: spacing.xs,
      paddingTop: spacing.xs,
    },
    title: {
      ...typeStyles.display,
      fontSize: 22,
      lineHeight: 27,
      color: theme.text,
    },
    subtitle: {
      ...typeStyles.bodySmall,
      color: theme.muted,
    },
    metaChips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    metaChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: theme.accentContainer,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 5,
    },
    metaChipText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.onAccentContainer,
    },
    studio: {
      ...typeStyles.bodySmall,
      color: theme.muted,
      marginTop: spacing.xs,
    },
    genreRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.lg,
    },
    genreChip: {
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: radii.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
    },
    genreText: {
      ...typeStyles.caption,
      fontFamily: fontFamilies.bodyStrong,
      color: theme.muted,
    },
    sectionHeading: {
      ...typeStyles.heading,
      fontFamily: fontFamilies.sectionLabel,
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
